import type { ChatRequest, ChatResponse, PluginConfig } from '../types.js';

const AIPING_BASE_URL = 'https://aiping.cn/api/v1';

/**
 * CloudAdapter forwards requests to the AIPing API (Kimi-K2.5 by default).
 * The AIPing API is OpenAI-compatible.
 */
export class CloudAdapter {
  private readonly config: PluginConfig;

  constructor(config: PluginConfig) {
    this.config = config;
  }

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.aipingApiKey}`,
    };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body = JSON.stringify({
      ...request,
      model: this.config.cloudModel,
      stream: false,
    });

    const res = await fetch(`${AIPING_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 401) {
        throw new CloudAdapterError(
          'Invalid AIPing API key. Get your key at https://aiping.cn/user/user-center',
          401
        );
      }
      if (res.status === 429) {
        throw new CloudAdapterError('AIPing rate limit exceeded. Please retry later.', 429);
      }
      throw new CloudAdapterError(`AIPing API returned ${res.status}: ${text}`, res.status);
    }

    const data = (await res.json()) as ChatResponse;
    // Normalise model field to the virtual model name
    return { ...data, model: request.model };
  }

  async *chatStream(request: ChatRequest): AsyncGenerator<string> {
    const body = JSON.stringify({
      ...request,
      model: this.config.cloudModel,
      stream: true,
    });

    const res = await fetch(`${AIPING_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 401) {
        throw new CloudAdapterError(
          'Invalid AIPing API key. Get your key at https://aiping.cn/user/user-center',
          401
        );
      }
      throw new CloudAdapterError(`AIPing API returned ${res.status}: ${text}`, res.status);
    }

    if (!res.body) throw new CloudAdapterError('Empty response body from AIPing', 500);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number; model: string; error?: string }> {
    const start = Date.now();
    try {
      // Use a minimal chat request to verify the key and model are valid
      const res = await fetch(`${AIPING_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          model: this.config.cloudModel,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        }),
        signal: AbortSignal.timeout(10000),
      });

      const latencyMs = Date.now() - start;

      if (res.status === 401) {
        return {
          ok: false,
          latencyMs,
          model: this.config.cloudModel,
          error: 'Invalid API key',
        };
      }

      if (!res.ok) {
        return {
          ok: false,
          latencyMs,
          model: this.config.cloudModel,
          error: `HTTP ${res.status}`,
        };
      }

      return { ok: true, latencyMs, model: this.config.cloudModel };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        model: this.config.cloudModel,
        error: (err as Error).message,
      };
    }
  }
}

export class CloudAdapterError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'CloudAdapterError';
  }
}
