import { describe, it, expect } from 'vitest';
import { Router } from '../router/router.js';
import type { ChatRequest, PluginConfig } from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';

const baseConfig: PluginConfig = {
  ...DEFAULT_CONFIG,
  aipingApiKey: 'test-key',
};

function makeRequest(content: string, turns = 1): ChatRequest {
  const messages = [];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'user' as const, content });
    if (i < turns - 1) {
      messages.push({ role: 'assistant' as const, content: 'ok' });
    }
  }
  return { model: 'aiping:claw', messages };
}

describe('Router.decide() — default threshold 85', () => {
  it('routes short simple message to local', () => {
    const router = new Router(baseConfig);
    const decision = router.decide(makeRequest('Hello!'));
    expect(decision.target).toBe('local');
    expect(decision.forced).toBe(false);
  });

  it('routes everyday coding questions to local', () => {
    const router = new Router(baseConfig);
    const decision = router.decide(makeRequest('如何用 Python 读取 CSV 文件？'));
    expect(decision.target).toBe('local');
  });

  it('routes moderate multi-turn (6 turns) to local', () => {
    const router = new Router(baseConfig);
    const decision = router.decide(makeRequest('What is React?', 6));
    expect(decision.target).toBe('local');
  });

  it('routes genuinely heavy request to cloud', () => {
    const bigCode = Array(90).fill('const x = require("dep");').join('\n');
    const content = `请逐步分析这段代码并对比优缺点：\n\`\`\`js\n${bigCode}\n\`\`\`\n` + 'x'.repeat(6000);
    const router = new Router(baseConfig);
    const decision = router.decide(makeRequest(content, 17));
    expect(decision.target).toBe('cloud');
  });

  it('honours @local override even for complex requests', () => {
    const router = new Router(baseConfig);
    const req: ChatRequest = {
      model: 'aiping:claw',
      messages: [
        {
          role: 'user',
          content: '请逐步分析 ' + 'x'.repeat(5000) + ' @local',
        },
      ],
    };
    const decision = router.decide(req);
    expect(decision.target).toBe('local');
    expect(decision.forced).toBe(true);
  });

  it('honours @cloud override for simple requests', () => {
    const router = new Router(baseConfig);
    const req: ChatRequest = {
      model: 'aiping:claw',
      messages: [{ role: 'user', content: 'Hi @cloud' }],
    };
    const decision = router.decide(req);
    expect(decision.target).toBe('cloud');
    expect(decision.forced).toBe(true);
  });

  it('respects custom threshold of 100 (everything local)', () => {
    const highThresholdConfig = { ...baseConfig, routingThreshold: 100 };
    const router = new Router(highThresholdConfig);
    const bigCode = Array(90).fill('const x = 1;').join('\n');
    const decision = router.decide(makeRequest(`\`\`\`js\n${bigCode}\n\`\`\``, 17));
    expect(decision.target).toBe('local');
  });

  it('respects custom threshold of 0 (everything cloud)', () => {
    const lowThresholdConfig = { ...baseConfig, routingThreshold: 0 };
    const router = new Router(lowThresholdConfig);
    const decision = router.decide(makeRequest('Hello!'));
    expect(decision.target).toBe('cloud');
  });

  it('includes reasons in decision', () => {
    const router = new Router(baseConfig);
    const decision = router.decide(makeRequest('Tell me a joke'));
    expect(decision.reasons.length).toBeGreaterThan(0);
  });
});
