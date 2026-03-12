import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectOllama, detectAiping, RECOMMENDED_MODELS } from '../setup/detector.js';

// Mock child_process so unit tests don't depend on real ollama binary
vi.mock('child_process', () => ({
  execSync: vi.fn().mockImplementation((cmd: string) => {
    if (cmd.includes('--version')) throw new Error('not found');
    if (cmd.includes('ollama list')) return '';
    return '';
  }),
}));

// ──────────────────────────────────────────────────────────────────────────────
// Helpers to mock fetch
// ──────────────────────────────────────────────────────────────────────────────

function mockFetch(responses: Array<{ ok: boolean; status: number; body: unknown }>) {
  let callIndex = 0;
  return vi.fn().mockImplementation(() => {
    const resp = responses[callIndex % responses.length]!;
    callIndex++;
    return Promise.resolve({
      ok: resp.ok,
      status: resp.status,
      json: () => Promise.resolve(resp.body),
      text: () => Promise.resolve(JSON.stringify(resp.body)),
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// detectOllama
// ──────────────────────────────────────────────────────────────────────────────

describe('detectOllama()', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns serviceRunning=true and lists models when /api/tags responds', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([
        {
          ok: true,
          status: 200,
          body: {
            models: [
              { name: 'qwen2.5:4b', size: 2300000000, modified_at: '2026-01-01T00:00:00Z' },
              { name: 'llama3.2:3b', size: 2000000000, modified_at: '2026-01-02T00:00:00Z' },
            ],
          },
        },
      ])
    );

    const result = await detectOllama('http://localhost:11434');
    expect(result.serviceRunning).toBe(true);
    expect(result.models).toHaveLength(2);
    expect(result.models[0]!.name).toBe('qwen2.5:4b');
    expect(result.models[0]!.size).toMatch(/GB/);
  });

  it('returns serviceRunning=false and empty models when fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    );

    const result = await detectOllama('http://localhost:11434');
    expect(result.serviceRunning).toBe(false);
    expect(result.models).toHaveLength(0);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('returns serviceRunning=false when /api/tags returns non-OK', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([{ ok: false, status: 404, body: 'not found' }])
    );

    const result = await detectOllama('http://localhost:11434');
    expect(result.serviceRunning).toBe(false);
  });

  it('handles empty model list gracefully', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([{ ok: true, status: 200, body: { models: [] } }])
    );

    const result = await detectOllama();
    expect(result.serviceRunning).toBe(true);
    expect(result.models).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// detectAiping
// ──────────────────────────────────────────────────────────────────────────────

describe('detectAiping()', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns keyValid=false immediately when apiKey is empty', async () => {
    const result = await detectAiping('', 'Kimi-K2.5');
    expect(result.keyValid).toBe(false);
    expect(result.reachable).toBe(false);
    expect(result.error).toContain('API Key');
  });

  it('returns reachable=true, keyValid=true on HTTP 200', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([
        {
          ok: true,
          status: 200,
          body: { id: 'chatcmpl-1', choices: [{ message: { content: 'pong' } }] },
        },
      ])
    );

    const result = await detectAiping('sk-valid-key', 'Kimi-K2.5');
    expect(result.reachable).toBe(true);
    expect(result.keyValid).toBe(true);
  });

  it('returns keyValid=false, reachable=true on HTTP 401', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([{ ok: false, status: 401, body: { error: 'invalid key' } }])
    );

    const result = await detectAiping('sk-bad-key', 'Kimi-K2.5');
    expect(result.reachable).toBe(true);
    expect(result.keyValid).toBe(false);
    expect(result.errorCode).toBe(401);
    expect(result.error).toMatch(/无效|过期/);
  });

  it('treats HTTP 429 as keyValid=true (rate limited, not invalid)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([{ ok: false, status: 429, body: { error: 'rate limited' } }])
    );

    const result = await detectAiping('sk-valid-key', 'Kimi-K2.5');
    expect(result.reachable).toBe(true);
    expect(result.keyValid).toBe(true);
    expect(result.errorCode).toBe(429);
  });

  it('returns reachable=false on network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('fetch failed: ENOTFOUND'))
    );

    const result = await detectAiping('sk-key', 'Kimi-K2.5');
    expect(result.reachable).toBe(false);
    expect(result.keyValid).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// RECOMMENDED_MODELS
// ──────────────────────────────────────────────────────────────────────────────

describe('RECOMMENDED_MODELS', () => {
  it('contains at least one qwen model', () => {
    const qwen = RECOMMENDED_MODELS.filter((m) => m.name.startsWith('qwen'));
    expect(qwen.length).toBeGreaterThan(0);
  });

  it('every model has name, size and desc', () => {
    for (const m of RECOMMENDED_MODELS) {
      expect(m.name).toBeTruthy();
      expect(m.size).toBeTruthy();
      expect(m.desc).toBeTruthy();
    }
  });
});
