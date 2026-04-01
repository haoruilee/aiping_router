import { describe, it, expect, vi, afterEach } from 'vitest';
import { LocalAdapter } from '../providers/local.js';
import type { PluginConfig } from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';

const config: PluginConfig = {
  ...DEFAULT_CONFIG,
  aipingApiKey: '',
  localProxyUrl: 'http://localhost:11434',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LocalAdapter.listModels()', () => {
  it('returns model names from Ollama /api/tags', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            models: [{ name: 'qwen2.5:4b' }, { name: 'llama3.2:3b' }],
          }),
      })
    );

    const adapter = new LocalAdapter(config);
    const models = await adapter.listModels();
    expect(models).toEqual(['qwen2.5:4b', 'llama3.2:3b']);
  });

  it('falls back to /v1/models on /api/tags failure', async () => {
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // /api/tags fails
          return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
        }
        // /v1/models succeeds
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              data: [{ id: 'qwen2.5:4b' }, { id: 'phi3.5:mini' }],
            }),
        });
      })
    );

    const adapter = new LocalAdapter(config);
    const models = await adapter.listModels();
    expect(models).toEqual(['qwen2.5:4b', 'phi3.5:mini']);
  });

  it('returns empty array on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const adapter = new LocalAdapter(config);
    const models = await adapter.listModels();
    expect(models).toEqual([]);
  });
});

describe('LocalAdapter localDisableThinking', () => {
  it('adds disableThinking: true to local chat body when enabled and client omits it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          id: '1',
          object: 'chat.completion',
          created: 0,
          model: 'qwen2.5:4b',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hi' },
              finish_reason: 'stop',
            },
          ],
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new LocalAdapter({ ...config, localDisableThinking: true });
    await adapter.chat({
      model: 'aiping:claw',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const parsed = JSON.parse((init as RequestInit).body as string);
    expect(parsed.disableThinking).toBe(true);
  });

  it('does not override client-provided disableThinking', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          id: '1',
          object: 'chat.completion',
          created: 0,
          model: 'qwen2.5:4b',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hi' },
              finish_reason: 'stop',
            },
          ],
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new LocalAdapter({ ...config, localDisableThinking: true });
    await adapter.chat({
      model: 'aiping:claw',
      messages: [{ role: 'user', content: 'hello' }],
      disableThinking: false,
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const parsed = JSON.parse((init as RequestInit).body as string);
    expect(parsed.disableThinking).toBe(false);
  });

  it('skips disableThinking when localDisableThinking is false', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          id: '1',
          object: 'chat.completion',
          created: 0,
          model: 'qwen2.5:4b',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hi' },
              finish_reason: 'stop',
            },
          ],
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new LocalAdapter({ ...config, localDisableThinking: false });
    await adapter.chat({
      model: 'aiping:claw',
      messages: [{ role: 'user', content: 'hello' }],
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const parsed = JSON.parse((init as RequestInit).body as string);
    expect(parsed).not.toHaveProperty('disableThinking');
  });
});

describe('LocalAdapter.ping()', () => {
  it('returns ok=true when /api/tags responds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ models: [] }),
      })
    );

    const adapter = new LocalAdapter(config);
    const result = await adapter.ping();
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns ok=false on ECONNREFUSED', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const adapter = new LocalAdapter(config);
    const result = await adapter.ping();
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});
