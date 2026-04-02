import type { ChatMessage, ChatRequest, ChatResponse, PluginConfig } from '../types.js';

/** Ollama native `/api/chat` JSON line (streaming or single). */
interface OllamaChatLine {
  model?: string;
  created_at?: string;
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: ChatMessage['tool_calls'];
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * LocalAdapter forwards chat to Ollama using the native `/api/chat` endpoint
 * so `think: false` is honored (OpenAI-compatible `/v1/chat/completions` ignores it on Ollama 0.18.x).
 * Responses are mapped to OpenAI-style `ChatResponse` / SSE chunks for the plugin proxy.
 */
export class LocalAdapter {
  private readonly config: PluginConfig;

  constructor(config: PluginConfig) {
    this.config = config;
  }

  private get baseUrl(): string {
    return this.config.localProxyUrl.replace(/\/$/, '');
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.localProxyKey) {
      headers['Authorization'] = `Bearer ${this.config.localProxyKey}`;
    }
    return headers;
  }

  /**
   * Native `/api/chat` honors `think: false` to disable reasoning (e.g. Qwen3).
   * `disableThinking` alone is not a native field — we map it to `think` when appropriate.
   */
  private mergeLocalThinkingOptions(request: ChatRequest): ChatRequest {
    if (!this.config.localDisableThinking) return request;
    if (Object.prototype.hasOwnProperty.call(request, 'think')) return request;
    if (Object.prototype.hasOwnProperty.call(request, 'disableThinking')) {
      if (request.disableThinking === false) return request;
      return { ...request, think: false };
    }
    return { ...request, think: false };
  }

  private buildOllamaChatBody(
    request: ChatRequest,
    resolvedModel: string | undefined,
    stream: boolean
  ): string {
    const merged = this.mergeLocalThinkingOptions(request);
    const model = resolvedModel ?? this.config.localModel;
    const body: Record<string, unknown> = {
      model,
      messages: merged.messages,
      stream,
    };

    if (typeof merged.think === 'boolean') {
      body.think = merged.think;
    }

    const options: Record<string, unknown> = {};
    if (typeof merged.temperature === 'number') options.temperature = merged.temperature;
    if (typeof merged.top_p === 'number') options.top_p = merged.top_p;
    if (typeof merged.max_tokens === 'number') options.num_predict = merged.max_tokens;
    if (Object.keys(options).length > 0) {
      body.options = options;
    }

    if (merged.stop !== undefined) body.stop = merged.stop;
    if (merged.tools !== undefined) body.tools = merged.tools;
    if (merged.tool_choice !== undefined) body.tool_choice = merged.tool_choice;

    return JSON.stringify(body);
  }

  private static mapOllamaFinishReason(
    doneReason: string | undefined,
    hasToolCalls: boolean
  ): string | null {
    if (hasToolCalls) return 'tool_calls';
    if (!doneReason) return 'stop';
    if (doneReason === 'length') return 'length';
    return 'stop';
  }

  private static ollamaLineToOpenAIResponse(
    ollama: OllamaChatLine,
    virtualModel: string
  ): ChatResponse {
    const content = ollama.message?.content ?? '';
    const toolCalls = ollama.message?.tool_calls;
    const message: ChatMessage = {
      role: 'assistant',
      content,
      ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
    const hasToolCalls = Boolean(toolCalls && toolCalls.length > 0);
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: virtualModel,
      choices: [
        {
          index: 0,
          message,
          finish_reason: LocalAdapter.mapOllamaFinishReason(ollama.done_reason, hasToolCalls),
        },
      ],
      usage:
        ollama.prompt_eval_count != null || ollama.eval_count != null
          ? {
              prompt_tokens: ollama.prompt_eval_count ?? 0,
              completion_tokens: ollama.eval_count ?? 0,
              total_tokens: (ollama.prompt_eval_count ?? 0) + (ollama.eval_count ?? 0),
            }
          : undefined,
    };
  }

  async chat(request: ChatRequest, resolvedModel?: string): Promise<ChatResponse> {
    const body = this.buildOllamaChatBody(request, resolvedModel, false);

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.config.localTimeoutMs
    );

    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new LocalAdapterError(
          `Local model returned ${res.status}: ${text}`,
          res.status
        );
      }

      const ollama = (await res.json()) as OllamaChatLine;
      const openai = LocalAdapter.ollamaLineToOpenAIResponse(ollama, request.model);
      return { ...openai, model: request.model };
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new LocalAdapterError(
          `Local model timed out after ${this.config.localTimeoutMs}ms`,
          408
        );
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async *chatStream(request: ChatRequest, resolvedModel?: string): AsyncGenerator<string> {
    const body = this.buildOllamaChatBody(request, resolvedModel, true);

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.config.localTimeoutMs
    );

    const virtualModel = request.model;
    const id = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new LocalAdapterError(
          `Local model returned ${res.status}: ${text}`,
          res.status
        );
      }

      if (!res.body) throw new LocalAdapterError('Empty response body', 500);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let toolCallsEmitted = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let obj: OllamaChatLine;
          try {
            obj = JSON.parse(trimmed) as OllamaChatLine;
          } catch {
            continue;
          }

          const piece = obj.message?.content;
          if (piece) {
            yield `data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model: virtualModel,
              choices: [
                {
                  index: 0,
                  delta: { content: piece },
                  finish_reason: null,
                },
              ],
            })}\n\n`;
          }

          const tc = obj.message?.tool_calls;
          if (tc && tc.length > 0 && !toolCallsEmitted) {
            toolCallsEmitted = true;
            yield `data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model: virtualModel,
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: tc },
                  finish_reason: null,
                },
              ],
            })}\n\n`;
          }

          if (obj.done) {
            const hasToolCalls =
              toolCallsEmitted || Boolean(tc && tc.length > 0);
            const finishReason = LocalAdapter.mapOllamaFinishReason(
              obj.done_reason,
              hasToolCalls
            );
            yield `data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model: virtualModel,
              choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            })}\n\n`;
          }
        }
      }

      const tail = buffer.trim();
      if (tail) {
        try {
          const obj = JSON.parse(tail) as OllamaChatLine;
          const piece = obj.message?.content;
          if (piece) {
            yield `data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model: virtualModel,
              choices: [
                {
                  index: 0,
                  delta: { content: piece },
                  finish_reason: null,
                },
              ],
            })}\n\n`;
          }
          const tc = obj.message?.tool_calls;
          if (tc && tc.length > 0 && !toolCallsEmitted) {
            toolCallsEmitted = true;
            yield `data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model: virtualModel,
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: tc },
                  finish_reason: null,
                },
              ],
            })}\n\n`;
          }
          if (obj.done) {
            const hasToolCalls =
              toolCallsEmitted || Boolean(tc && tc.length > 0);
            yield `data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model: virtualModel,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: LocalAdapter.mapOllamaFinishReason(
                    obj.done_reason,
                    hasToolCalls
                  ),
                },
              ],
            })}\n\n`;
          }
        } catch {
          // ignore trailing garbage
        }
      }

      yield 'data: [DONE]\n\n';
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new LocalAdapterError(
          `Local model stream timed out after ${this.config.localTimeoutMs}ms`,
          408
        );
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      const latencyMs = Date.now() - start;
      if (!res.ok) {
        // Fallback: also try OpenAI-compatible /v1/models
        const res2 = await fetch(`${this.baseUrl}/v1/models`, {
          method: 'GET',
          headers: this.buildHeaders(),
          signal: AbortSignal.timeout(5000),
        });
        if (!res2.ok) {
          return { ok: false, latencyMs, error: `HTTP ${res.status}` };
        }
        return { ok: true, latencyMs: Date.now() - start };
      }
      return { ok: true, latencyMs };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: (err as Error).message,
      };
    }
  }

  /** Returns list of model names available on the local server. */
  async listModels(): Promise<string[]> {
    try {
      // Try Ollama native endpoint first
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = (await res.json()) as { models?: Array<{ name: string }> };
        return (data.models ?? []).map((m) => m.name);
      }
      // Fallback: OpenAI-compatible /v1/models
      const res2 = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (res2.ok) {
        const data2 = (await res2.json()) as { data?: Array<{ id: string }> };
        return (data2.data ?? []).map((m) => m.id);
      }
    } catch {
      // ignored
    }
    return [];
  }
}

export class LocalAdapterError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'LocalAdapterError';
  }
}
