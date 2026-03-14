import { describe, it, expect } from 'vitest';
import { ToolCallScorer } from '../router/rules.js';
import { Router } from '../router/router.js';
import type { ChatRequest, PluginConfig } from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';

const baseConfig: PluginConfig = {
  ...DEFAULT_CONFIG,
  aipingApiKey: 'test',
  preferCloudForTools: true,
};

// ── ToolCallScorer unit tests ─────────────────────────────────────────────────

describe('ToolCallScorer', () => {
  const scorer = new ToolCallScorer();

  it('returns no forced for plain text message', () => {
    const req: ChatRequest = {
      model: 'aiping:claw',
      messages: [{ role: 'user', content: 'How do I center a div?' }],
    };
    const result = scorer.score(req) as { forced?: string };
    expect(result.forced).toBeUndefined();
    expect(result.score).toBe(0);
  });

  it('forces cloud when tools array is present', () => {
    const req: ChatRequest = {
      model: 'aiping:claw',
      messages: [{ role: 'user', content: 'Write a Python script' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'write_file',
            description: 'Write content to a file',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
    };
    const result = scorer.score(req) as { forced?: string };
    expect(result.forced).toBe('cloud');
    expect(result.reason).toContain('write_file');
  });

  it('forces cloud when conversation has a tool result message', () => {
    const req: ChatRequest = {
      model: 'aiping:claw',
      messages: [
        { role: 'user', content: 'Run the tests' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"pytest"}' } }],
        },
        { role: 'tool', content: 'All tests passed', tool_call_id: 'call_1' },
        { role: 'user', content: 'Great, now fix the warnings' },
      ],
    };
    const result = scorer.score(req) as { forced?: string };
    expect(result.forced).toBe('cloud');
    expect(result.reason).toContain('tool-result-in-history');
  });

  it('forces cloud when assistant message contains tool_calls', () => {
    const req: ChatRequest = {
      model: 'aiping:claw',
      messages: [
        { role: 'user', content: 'Create a file' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{}' } }],
        },
      ],
    };
    const result = scorer.score(req) as { forced?: string };
    expect(result.forced).toBe('cloud');
    expect(result.reason).toContain('assistant-tool-call');
  });

  it('handles empty tools array as no tool use', () => {
    const req: ChatRequest = {
      model: 'aiping:claw',
      messages: [{ role: 'user', content: 'What is 2+2?' }],
      tools: [],
    };
    const result = scorer.score(req) as { forced?: string };
    expect(result.forced).toBeUndefined();
  });
});

// ── Router integration: preferCloudForTools ───────────────────────────────────

describe('Router.decide() with preferCloudForTools', () => {
  it('forces cloud for tool request when preferCloudForTools=true', () => {
    const router = new Router({ ...baseConfig, preferCloudForTools: true });
    const req: ChatRequest = {
      model: 'aiping:claw',
      messages: [{ role: 'user', content: 'Run the linter' }],
      tools: [{ type: 'function', function: { name: 'bash', description: 'Run shell command' } }],
    };
    const decision = router.decide(req);
    expect(decision.target).toBe('cloud');
    expect(decision.forced).toBe(true);
    expect(decision.reasons[0]).toContain('tool_call_detection');
  });

  it('does NOT force cloud for tool request when preferCloudForTools=false', () => {
    const router = new Router({ ...baseConfig, preferCloudForTools: false });
    const req: ChatRequest = {
      model: 'aiping:claw',
      messages: [{ role: 'user', content: 'Run the linter' }],
      tools: [{ type: 'function', function: { name: 'bash', description: 'Run shell command' } }],
    };
    const decision = router.decide(req);
    // Short message → local (no tool scorer active)
    expect(decision.target).toBe('local');
    expect(decision.forced).toBe(false);
  });

  it('plain text request is unaffected by preferCloudForTools', () => {
    const router = new Router({ ...baseConfig, preferCloudForTools: true });
    const decision = router.decide({
      model: 'aiping:claw',
      messages: [{ role: 'user', content: '你好' }],
    });
    expect(decision.target).toBe('local');
    expect(decision.forced).toBe(false);
  });

  it('tool-call routing cannot be overridden by @local directive', () => {
    // ToolCallScorer runs BEFORE OverrideScorer in the pipeline
    const router = new Router({ ...baseConfig, preferCloudForTools: true });
    const req: ChatRequest = {
      model: 'aiping:claw',
      messages: [{ role: 'user', content: 'Run tests @local' }],
      tools: [{ type: 'function', function: { name: 'bash', description: '' } }],
    };
    const decision = router.decide(req);
    // ToolCallScorer fires first and returns forced=cloud
    expect(decision.target).toBe('cloud');
    expect(decision.forced).toBe(true);
  });
});
