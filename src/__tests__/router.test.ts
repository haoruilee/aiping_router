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

describe('Router.decide()', () => {
  it('routes short simple messages to local', () => {
    const router = new Router(baseConfig);
    const decision = router.decide(makeRequest('Hello!'));
    expect(decision.target).toBe('local');
    expect(decision.forced).toBe(false);
  });

  it('routes high-complexity messages to cloud', () => {
    const longCode = Array(40).fill('const x = require("dep");').join('\n');
    const content = `Analyze:\n\`\`\`js\n${longCode}\n\`\`\``;
    const router = new Router(baseConfig);
    const decision = router.decide(makeRequest(content, 8));
    expect(decision.target).toBe('cloud');
  });

  it('honours @local override even for complex requests', () => {
    const router = new Router(baseConfig);
    const req: ChatRequest = {
      model: 'aiping:claw',
      messages: [
        {
          role: 'user',
          content: 'Please analyze ' + 'x'.repeat(3000) + ' @local',
        },
      ],
    };
    const decision = router.decide(req);
    expect(decision.target).toBe('local');
    expect(decision.forced).toBe(true);
  });

  it('honours @cloud override even for simple requests', () => {
    const router = new Router(baseConfig);
    const req: ChatRequest = {
      model: 'aiping:claw',
      messages: [{ role: 'user', content: 'Hi @cloud' }],
    };
    const decision = router.decide(req);
    expect(decision.target).toBe('cloud');
    expect(decision.forced).toBe(true);
  });

  it('respects custom threshold', () => {
    // With threshold=100 everything should go local (nothing scores 100)
    const highThresholdConfig = { ...baseConfig, routingThreshold: 100 };
    const router = new Router(highThresholdConfig);
    const longCode = Array(40).fill('const x = 1;').join('\n');
    const decision = router.decide(
      makeRequest(`\`\`\`js\n${longCode}\n\`\`\``, 8)
    );
    expect(decision.target).toBe('local');
  });

  it('includes reasons in decision', () => {
    const router = new Router(baseConfig);
    const decision = router.decide(makeRequest('Tell me a joke'));
    expect(decision.reasons.length).toBeGreaterThan(0);
  });
});
