import type { ChatRequest, ChatResponse, PluginConfig } from '../types.js';

/**
 * LocalAdapter forwards requests to an Ollama-compatible local server
 * using the OpenAI-compatible /v1/chat/completions endpoint.
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

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body = JSON.stringify({
      ...request,
      model: this.config.localModel,
      stream: false,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.config.localTimeoutMs
    );

    try {
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
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

      const data = (await res.json()) as ChatResponse;
      // Normalise the model field so the caller always sees the virtual model name
      return { ...data, model: request.model };
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

  async *chatStream(request: ChatRequest): AsyncGenerator<string> {
    const body = JSON.stringify({
      ...request,
      model: this.config.localModel,
      stream: true,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.config.localTimeoutMs
    );

    try {
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
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

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield decoder.decode(value, { stream: true });
      }
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
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      const latencyMs = Date.now() - start;
      if (!res.ok) {
        return { ok: false, latencyMs, error: `HTTP ${res.status}` };
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
