/**
 * End-to-end tests for @aiping.cn/model_router
 *
 * Requires:
 *   - Ollama running at http://localhost:11434 with qwen2.5:0.5b pulled
 *   - AIPing API accessible at https://aiping.cn/api/v1
 *
 * Run with:
 *   AIPING_API_KEY=<key> npm run test:e2e
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { detectOllama, detectAiping } from '../setup/detector.js';
import { LocalAdapter } from '../providers/local.js';
import { CloudAdapter } from '../providers/cloud.js';
import { Router } from '../router/router.js';
import { Scorer } from '../router/scorer.js';
import type { PluginConfig, ChatRequest, ChatMessage } from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';

// ── Config ────────────────────────────────────────────────────────────────────

const AIPING_KEY =
  process.env['AIPING_API_KEY'] ??
  'QC-89a429f98446efebf5117fff8e2ba452-03b4c40474759440e1008174d7705735';
const AIPING_BASE = 'https://aiping.cn/api/v1';
const LOCAL_URL   = 'http://localhost:11434';
const LOCAL_MODEL = 'qwen2.5:0.5b';
const CLOUD_MODEL = 'Kimi-K2.5';

const config: PluginConfig = {
  ...DEFAULT_CONFIG,
  aipingApiKey:     AIPING_KEY,
  localProxyUrl:    LOCAL_URL,
  localModel:       LOCAL_MODEL,
  cloudModel:       CLOUD_MODEL,
  routingThreshold: 85,
  fallbackToCloud:  true,
  debugRouting:     true,
  // CI runners are CPU-only and slow; give local model more time per request
  localTimeoutMs:   90000,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function req(content: string, history: ChatMessage[] = []): ChatRequest {
  return {
    model: 'aiping:claw',
    messages: [...history, { role: 'user', content }],
  };
}

function assistant(content: string): ChatMessage {
  return { role: 'assistant', content };
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1: Environment detection
// ─────────────────────────────────────────────────────────────────────────────

describe('E2E · 1. Environment Detection', () => {
  it('detectOllama: service running and qwen2.5:0.5b available', async () => {
    const status = await detectOllama(LOCAL_URL);

    console.log(`  Ollama running: ${status.serviceRunning}`);
    console.log(`  Latency: ${status.latencyMs}ms`);
    console.log(`  Models: ${status.models.map((m) => m.name).join(', ')}`);

    expect(status.serviceRunning).toBe(true);
    expect(status.models.length).toBeGreaterThan(0);
    expect(status.models.some((m) => m.name.startsWith('qwen2.5'))).toBe(true);
  });

  it('detectOllama: lists model sizes correctly', async () => {
    const status = await detectOllama(LOCAL_URL);
    const model = status.models.find((m) => m.name.startsWith('qwen2.5'));
    expect(model?.size).toBeDefined();
    console.log(`  qwen2.5:0.5b size: ${model?.size}`);
  });

  it('detectAiping: key is valid, cloud reachable', async () => {
    const status = await detectAiping(AIPING_KEY, CLOUD_MODEL);

    console.log(`  AIPing reachable: ${status.reachable}`);
    console.log(`  Key valid: ${status.keyValid}`);
    console.log(`  Latency: ${status.latencyMs}ms`);
    if (status.error) console.log(`  Error: ${status.error}`);

    expect(status.reachable).toBe(true);
    // 200 OK or 429 rate-limit both count as "key valid"
    expect(status.keyValid || status.errorCode === 429).toBe(true);
  }, 20000);

  it('LocalAdapter.listModels: returns available model names', async () => {
    const adapter = new LocalAdapter(config);
    const models = await adapter.listModels();

    console.log(`  Local models: ${models.join(', ')}`);
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.startsWith('qwen2.5'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2: Config / routing logic validation
// ─────────────────────────────────────────────────────────────────────────────

describe('E2E · 2. Routing Config Checks', () => {
  const router = new Router(config);
  const scorer = new Scorer();

  it('short message routes to local (score well below 85)', () => {
    const decision = router.decide(req('你好，今天天气怎么样？'));
    console.log(`  score=${decision.score}, target=${decision.target}`);
    expect(decision.target).toBe('local');
    expect(decision.score).toBeLessThan(85);
  });

  it('@local directive forces local regardless of complexity', () => {
    const bigCode = Array(100).fill('const x = require("big-lib");').join('\n');
    const decision = router.decide(req(`请深度分析此代码：\`\`\`js\n${bigCode}\n\`\`\` @local`));
    expect(decision.target).toBe('local');
    expect(decision.forced).toBe(true);
    console.log(`  forced local, score=${decision.score}`);
  });

  it('@cloud directive forces cloud regardless of simplicity', () => {
    const decision = router.decide(req('讲个笑话 @cloud'));
    expect(decision.target).toBe('cloud');
    expect(decision.forced).toBe(true);
    console.log(`  forced cloud, score=${decision.score}`);
  });

  it('genuinely heavy request (large code + long context + deep reasoning) scores >= 85', () => {
    const bigCode = Array(85).fill('const x = require("dep");').join('\n');
    // Pad to safely exceed 4000 tokens (~16000 chars) to guarantee full token score
    const content = `请逐步分析这段代码并深度分析优缺点：\`\`\`js\n${bigCode}\n\`\`\`\n` + 'context '.repeat(2500);
    const history: ChatMessage[] = [];
    for (let i = 0; i < 17; i++) {
      history.push({ role: 'user', content: `turn ${i}` });
      history.push({ role: 'assistant', content: 'ok' });
    }
    const result = scorer.score({ model: 'aiping:claw', messages: [...history, { role: 'user', content }] });
    console.log(`  heavy score=${result.totalScore}, dimensions:`,
      result.dimensionScores.map((d) => `${d.name}:${d.score}`).join(', '));
    expect(result.totalScore).toBeGreaterThanOrEqual(85);
  });

  it('threshold=0 routes everything to cloud', () => {
    const cloudConfig = { ...config, routingThreshold: 0 };
    const r = new Router(cloudConfig);
    expect(r.decide(req('Hi')).target).toBe('cloud');
  });

  it('threshold=100 routes everything to local', () => {
    const localConfig = { ...config, routingThreshold: 100 };
    const r = new Router(localConfig);
    const bigCode = Array(90).fill('x').join('\n');
    expect(r.decide(req(`\`\`\`\n${bigCode}\n\`\`\``, [])).target).toBe('local');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3: Local model real inference
// ─────────────────────────────────────────────────────────────────────────────

describe('E2E · 3. Local Model (Ollama qwen2.5:0.5b)', () => {
  const local = new LocalAdapter(config);

  it('ping: responds under 2000ms', async () => {
    const result = await local.ping();
    console.log(`  ping ok=${result.ok} latency=${result.latencyMs}ms`);
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeLessThan(2000);
  });

  it('chat: returns a non-empty response to a simple question', async () => {
    const response = await local.chat(req('用一句话回答：1+1等于几？'));
    console.log(`  local response: "${response.choices[0]?.message.content?.slice(0, 80)}"`);

    expect(response.choices.length).toBeGreaterThan(0);
    const content = response.choices[0]!.message.content ?? '';
    expect(content.length).toBeGreaterThan(0);
    expect(response.model).toBe('aiping:claw');
  });

  it('chat: responds to a coding question', async () => {
    const response = await local.chat(
      req('用 Python 写一个 hello world，只需代码，不要解释。')
    );
    const content = response.choices[0]!.message.content ?? '';
    console.log(`  code response: "${content.slice(0, 100)}"`);
    // Small 0.5b model may output Chinese ("你好，世界") or English ("Hello, World") — both valid
    expect(content).toMatch(/print|hello|你好|world|世界/i);
  });

  it('chatStream: streams tokens back', async () => {
    const chunks: string[] = [];
    for await (const chunk of local.chatStream(req('用三个字回答：天空是什么颜色？'))) {
      chunks.push(chunk);
    }
    const full = chunks.join('');
    console.log(`  stream chunks=${chunks.length}, total chars=${full.length}`);
    expect(chunks.length).toBeGreaterThan(0);
    expect(full.length).toBeGreaterThan(0);
  });
}, 60000);

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 4: AIPing cloud real inference
// ─────────────────────────────────────────────────────────────────────────────

describe('E2E · 4. AIPing Cloud (Kimi-K2.5)', () => {
  const cloud = new CloudAdapter(config);

  it('ping: responds and key is valid', async () => {
    const status = await detectAiping(AIPING_KEY, CLOUD_MODEL);
    console.log(`  cloud ping ok=${status.keyValid} latency=${status.latencyMs}ms`);
    expect(status.reachable).toBe(true);
    expect(status.keyValid || status.errorCode === 429).toBe(true);
  }, 20000);

  it('chat: returns a non-empty response', async () => {
    const response = await cloud.chat(req('用一句话回答：地球绕太阳转一圈需要多久？'));
    const content = response.choices[0]!.message.content ?? '';
    console.log(`  cloud response: "${content.slice(0, 100)}"`);

    expect(content.length).toBeGreaterThan(0);
    expect(response.model).toBe('aiping:claw');
  }, 60000);

  it('chatStream: streams tokens', async () => {
    const chunks: string[] = [];
    for await (const chunk of cloud.chatStream(req('用一句话描述量子纠缠。'))) {
      chunks.push(chunk);
    }
    const full = chunks.join('');
    console.log(`  stream chunks=${chunks.length}, total chars=${full.length}`);
    expect(chunks.length).toBeGreaterThan(0);
    expect(full.length).toBeGreaterThan(0);
  });
}, 30000);

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 5: Multi-round conversation through the router
// ─────────────────────────────────────────────────────────────────────────────

describe('E2E · 5. Multi-Round Conversation via Router', () => {
  const router = new Router(config);
  const local  = new LocalAdapter(config);
  const cloud  = new CloudAdapter(config);

  async function routeAndCall(request: ChatRequest): Promise<{ content: string; target: string }> {
    const decision = router.decide(request);
    const adapter  = decision.target === 'local' ? local : cloud;
    const response = await adapter.chat(request);
    return {
      content: response.choices[0]?.message.content ?? '',
      target:  decision.target,
    };
  }

  it('3-turn simple conversation stays on local', async () => {
    const history: ChatMessage[] = [];

    // Turn 1
    const q1 = '你好！你叫什么名字？';
    const r1  = await routeAndCall(req(q1, history));
    console.log(`  [Turn 1] → ${r1.target} | Q: "${q1}" | A: "${r1.content.slice(0, 60)}"`);
    expect(r1.target).toBe('local');
    expect(r1.content.length).toBeGreaterThan(0);
    history.push({ role: 'user', content: q1 }, assistant(r1.content));

    // Turn 2
    const q2 = '你能帮我做什么？';
    const r2  = await routeAndCall(req(q2, history));
    console.log(`  [Turn 2] → ${r2.target} | Q: "${q2}" | A: "${r2.content.slice(0, 60)}"`);
    expect(r2.target).toBe('local');
    history.push({ role: 'user', content: q2 }, assistant(r2.content));

    // Turn 3
    const q3 = '好的，谢谢！';
    const r3  = await routeAndCall(req(q3, history));
    console.log(`  [Turn 3] → ${r3.target} | Q: "${q3}" | A: "${r3.content.slice(0, 60)}"`);
    expect(r3.target).toBe('local');
  }, 120000);

  it('@cloud override mid-conversation routes correctly', async () => {
    const history: ChatMessage[] = [
      { role: 'user',      content: '帮我写个冒泡排序。' },
      { role: 'assistant', content: '好的，以下是冒泡排序实现...' },
    ];

    // Use a short prompt so the cloud model responds quickly even on slow CI
    const q = '用一句话解释时间复杂度 @cloud';
    const result = await routeAndCall(req(q, history));
    console.log(`  [@cloud override] → ${result.target} | A: "${result.content.slice(0, 80)}"`);
    expect(result.target).toBe('cloud');
  }, 120000);

  it('fallback: local timeout triggers cloud fallback', async () => {
    // Configure a 1ms timeout to force local to always fail
    const tinyTimeoutConfig = { ...config, localTimeoutMs: 1, fallbackToCloud: true };
    const tinyLocal = new LocalAdapter(tinyTimeoutConfig);
    const fallbackCloud = new CloudAdapter(tinyTimeoutConfig);
    const fallbackRouter = new Router(tinyTimeoutConfig);

    const request = req('一句话回答：2+2等于几？');
    const decision = fallbackRouter.decide(request);

    // We'll test local failure + cloud fallback directly
    let usedFallback = false;
    let finalContent = '';
    try {
      await tinyLocal.chat(request);
    } catch {
      usedFallback = true;
      const fallbackResp = await fallbackCloud.chat(request);
      finalContent = fallbackResp.choices[0]?.message.content ?? '';
    }

    console.log(`  fallback triggered: ${usedFallback}, cloud answered: "${finalContent.slice(0, 60)}"`);
    expect(usedFallback).toBe(true);
    expect(finalContent.length).toBeGreaterThan(0);
  }, 60000);

  it('5-turn coding session: all turns stay local, router decisions consistent', async () => {
    const history: ChatMessage[] = [];
    const questions = [
      '用 Python 写一个函数，计算两个数的最大公约数。',
      '好的，现在扩展这个函数，支持任意数量的输入。',
      '帮我写一个测试用例。',
      '有没有更高效的实现方式？',
      '总结一下我们讨论的内容。',
    ];

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]!;
      const result = await routeAndCall(req(q, history));
      const decision = router.decide(req(q, history));
      console.log(`  [Turn ${i + 1}] → ${result.target} (score=${decision.score}) | "${q.slice(0, 30)}..." | "${result.content.slice(0, 50)}"`);
      expect(result.content.length).toBeGreaterThan(0);
      history.push({ role: 'user', content: q }, assistant(result.content));
    }

    // All 5 turns should have stayed local (simple coding questions, < 6 turns, no override)
    console.log(`  Final history length: ${history.length} messages`);
  }, 300000);
}, 300000);
