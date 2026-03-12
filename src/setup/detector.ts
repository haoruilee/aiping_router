import { execSync } from 'child_process';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface OllamaModel {
  name: string;        // e.g. "qwen2.5:4b"
  size?: string;       // e.g. "2.3 GB" (from ollama CLI, not always available via API)
  modifiedAt?: string; // ISO timestamp
}

export interface OllamaStatus {
  binaryFound: boolean;    // `ollama` is in PATH
  serviceRunning: boolean; // HTTP endpoint responds
  models: OllamaModel[];   // models currently pulled
  latencyMs?: number;      // ping latency when service is running
  error?: string;
}

export interface AipingStatus {
  reachable: boolean;      // can reach https://aiping.cn
  keyValid: boolean;       // provided key returns 200 (not 401/403)
  model: string;           // model name that was tested
  latencyMs?: number;
  error?: string;
  errorCode?: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Ollama detector
// ──────────────────────────────────────────────────────────────────────────────

export async function detectOllama(baseUrl = 'http://localhost:11434'): Promise<OllamaStatus> {
  const url = baseUrl.replace(/\/$/, '');

  // 1. Check if binary exists
  const binaryFound = isOllamaBinaryAvailable();

  // 2. Try to ping the REST endpoint
  const start = Date.now();
  let serviceRunning = false;
  let models: OllamaModel[] = [];
  let latencyMs: number | undefined;
  let error: string | undefined;

  try {
    const res = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(4000),
    });
    latencyMs = Date.now() - start;

    if (res.ok) {
      serviceRunning = true;
      const data = (await res.json()) as { models?: Array<{ name: string; size?: number; modified_at?: string }> };
      models = (data.models ?? []).map((m) => ({
        name: m.name,
        size: m.size ? formatBytes(m.size) : undefined,
        modifiedAt: m.modified_at,
      }));
    } else {
      error = `HTTP ${res.status}`;
    }
  } catch (e) {
    error = (e as Error).message;
    latencyMs = Date.now() - start;
  }

  // 3. If REST failed but binary exists, try `ollama list` as fallback
  if (!serviceRunning && binaryFound) {
    const cliModels = tryOllamaListCLI();
    if (cliModels.length > 0) {
      models = cliModels;
    }
  }

  return { binaryFound, serviceRunning, models, latencyMs, error };
}

function isOllamaBinaryAvailable(): boolean {
  try {
    execSync('ollama --version', { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function tryOllamaListCLI(): OllamaModel[] {
  try {
    const output = execSync('ollama list', { timeout: 5000, encoding: 'utf8' });
    // Output format: "NAME       ID        SIZE    MODIFIED\nqwen2.5:4b ..."
    const lines = output.split('\n').slice(1); // skip header
    return lines
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\s+/);
        const name = parts[0] ?? '';
        const size = parts[2] ? `${parts[2]} ${parts[3] ?? ''}`.trim() : undefined;
        return { name, size };
      })
      .filter((m) => m.name);
  } catch {
    return [];
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${bytes} B`;
}

// ──────────────────────────────────────────────────────────────────────────────
// AIPing detector
// ──────────────────────────────────────────────────────────────────────────────

const AIPING_BASE = 'https://aiping.cn/api/v1';

export async function detectAiping(apiKey: string, model = 'Kimi-K2.5'): Promise<AipingStatus> {
  if (!apiKey) {
    return { reachable: false, keyValid: false, model, error: '未提供 API Key' };
  }

  const start = Date.now();
  try {
    const res = await fetch(`${AIPING_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(10000),
    });

    const latencyMs = Date.now() - start;

    if (res.ok) {
      return { reachable: true, keyValid: true, model, latencyMs };
    }

    const body = await res.text().catch(() => '');

    if (res.status === 401 || res.status === 403) {
      return {
        reachable: true,
        keyValid: false,
        model,
        latencyMs,
        error: 'API Key 无效或已过期',
        errorCode: res.status,
      };
    }

    if (res.status === 429) {
      return {
        reachable: true,
        keyValid: true, // key itself is valid, just rate-limited
        model,
        latencyMs,
        error: '请求频率超限（Rate limited），请稍后重试',
        errorCode: 429,
      };
    }

    return {
      reachable: true,
      keyValid: false,
      model,
      latencyMs,
      error: `HTTP ${res.status}: ${body.slice(0, 120)}`,
      errorCode: res.status,
    };
  } catch (e) {
    const latencyMs = Date.now() - start;
    const msg = (e as Error).message;
    const isNetworkError =
      msg.includes('fetch') || msg.includes('ECONNREFUSED') ||
      msg.includes('ENOTFOUND') || msg.includes('timeout');

    return {
      reachable: !isNetworkError,
      keyValid: false,
      model,
      latencyMs,
      error: isNetworkError ? '网络不可达，请检查网络连接' : msg,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Recommended models (shown when user has no local models)
// ──────────────────────────────────────────────────────────────────────────────

export const RECOMMENDED_MODELS: Array<{ name: string; size: string; desc: string }> = [
  { name: 'qwen2.5:4b',   size: '~2.3 GB', desc: '推荐首选：阿里通义千问，中文能力强' },
  { name: 'qwen2.5:7b',   size: '~4.4 GB', desc: '质量更高，需要更多内存' },
  { name: 'llama3.2:3b',  size: '~2.0 GB', desc: 'Meta Llama，英文能力优秀' },
  { name: 'phi3.5:mini',  size: '~2.2 GB', desc: 'Microsoft Phi，推理能力强' },
  { name: 'gemma3:4b',    size: '~3.3 GB', desc: 'Google Gemma，均衡性能' },
];
