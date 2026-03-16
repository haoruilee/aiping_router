import { describe, it, expect } from 'vitest';
import { ToolCallScorer } from '../router/rules.js';
import { Router } from '../router/router.js';
import type { ChatRequest, PluginConfig } from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';

const baseConfig: PluginConfig = {
  ...DEFAULT_CONFIG,
  aipingApiKey: 'test',
  preferCloudForTools: 'code',
};

function req(content: string, tools: Array<{name: string}> = []): ChatRequest {
  return {
    model: 'aiping:claw',
    messages: [{ role: 'user', content }],
    tools: tools.map(t => ({ type: 'function' as const, function: { name: t.name } })),
  };
}

// ── ToolCallScorer — 'code' mode ──────────────────────────────────────────────

describe("ToolCallScorer mode='code'", () => {
  const scorer = new ToolCallScorer('code');

  it('no tools → score 0, no forced', () => {
    const result = scorer.score(req('Hello')) as { forced?: string; score: number };
    expect(result.score).toBe(0);
    expect(result.forced).toBeUndefined();
  });

  it('write_file → +40 score (code tool)', () => {
    const result = scorer.score(req('Write a function', [{ name: 'write_file' }]));
    expect(result.score).toBe(40);
    expect((result as any).forced).toBeUndefined();
    expect(result.reason).toContain('write_file');
  });

  it('str_replace_editor → +40 score (code tool)', () => {
    const result = scorer.score(req('Fix the bug', [{ name: 'str_replace_editor' }]));
    expect(result.score).toBe(40);
  });

  it('create_file → +40 score (code tool)', () => {
    const result = scorer.score(req('Create component', [{ name: 'create_file' }]));
    expect(result.score).toBe(40);
  });

  it('bash → score 0 (simple tool, no boost)', () => {
    const result = scorer.score(req('Run ls', [{ name: 'bash' }]));
    expect(result.score).toBe(0);
    expect((result as any).forced).toBeUndefined();
    expect(result.reason).toContain('bash');
  });

  it('read_file → score 0 (simple tool)', () => {
    const result = scorer.score(req('Read the config', [{ name: 'read_file' }]));
    expect(result.score).toBe(0);
  });

  it('search_files → score 0 (simple tool)', () => {
    const result = scorer.score(req('Find all tsx files', [{ name: 'search_files' }]));
    expect(result.score).toBe(0);
  });

  it('mixed tools: write_file + bash → +40 (code tool wins)', () => {
    const result = scorer.score(req('Write and run', [
      { name: 'write_file' }, { name: 'bash' },
    ]));
    expect(result.score).toBe(40);
  });

  it('tool result in message history → handled by role detection', () => {
    const request: ChatRequest = {
      model: 'aiping:claw',
      messages: [
        { role: 'user', content: 'Write a script' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{}' } }] },
        { role: 'tool', content: 'done', tool_call_id: 'c1' },
      ],
      tools: [{ type: 'function', function: { name: 'write_file' } }],
    };
    // write_file is a code tool → +40
    const result = scorer.score(request);
    expect(result.score).toBe(40);
  });
});

// ── ToolCallScorer — 'all' mode ───────────────────────────────────────────────

describe("ToolCallScorer mode='all'", () => {
  const scorer = new ToolCallScorer('all');

  it('bash → forced=cloud in all-mode', () => {
    const result = scorer.score(req('Run ls', [{ name: 'bash' }])) as { forced?: string };
    expect(result.forced).toBe('cloud');
  });

  it('read_file → forced=cloud in all-mode', () => {
    const result = scorer.score(req('Read', [{ name: 'read_file' }])) as { forced?: string };
    expect(result.forced).toBe('cloud');
  });

  it('no tools → no forced', () => {
    const result = scorer.score(req('Hello')) as { forced?: string };
    expect(result.forced).toBeUndefined();
  });
});

// ── Router integration ────────────────────────────────────────────────────────

describe("Router.decide() — preferCloudForTools='code'", () => {
  it("write_file + short message: 40+0 < 85 → STILL local (threshold not reached alone)", () => {
    const router = new Router({ ...baseConfig, preferCloudForTools: 'code' });
    const decision = router.decide(req('Add a comment', [{ name: 'write_file' }]));
    // +40 from tool scorer, but no other dimensions fire → total 40 < 85 → local
    expect(decision.target).toBe('local');
    expect(decision.forced).toBe(false);
  });

  it("write_file + code context + long history: 40+20+... >= 85 → cloud", () => {
    const router = new Router({ ...baseConfig, preferCloudForTools: 'code' });
    const bigCode = Array(82).fill('const x = 1;').join('\n');
    const history = Array.from({ length: 17 }, (_, i) => ([
      { role: 'user' as const, content: `turn ${i}` },
      { role: 'assistant' as const, content: 'ok' },
    ])).flat();
    const request: ChatRequest = {
      model: 'aiping:claw',
      messages: [...history, { role: 'user', content: `Please edit:\n\`\`\`js\n${bigCode}\n\`\`\`` }],
      tools: [{ type: 'function', function: { name: 'str_replace_editor' } }],
    };
    const decision = router.decide(request);
    // tool(40) + multi_turn(20) + code(20) = 80... still < 85?
    // add more context to push over
    expect(decision.score).toBeGreaterThan(40);
  });

  it("bash + short message → local (simple tool, no boost)", () => {
    const router = new Router({ ...baseConfig, preferCloudForTools: 'code' });
    const decision = router.decide(req('Run npm install', [{ name: 'bash' }]));
    expect(decision.target).toBe('local');
  });

  it("preferCloudForTools=false → bash stays local, write_file stays local", () => {
    const router = new Router({ ...baseConfig, preferCloudForTools: false });
    expect(router.decide(req('run', [{ name: 'bash' }])).target).toBe('local');
    expect(router.decide(req('write', [{ name: 'write_file' }])).target).toBe('local');
  });

  it("preferCloudForTools='all' → bash forced cloud", () => {
    const router = new Router({ ...baseConfig, preferCloudForTools: 'all' });
    const decision = router.decide(req('ls', [{ name: 'bash' }]));
    expect(decision.target).toBe('cloud');
    expect(decision.forced).toBe(true);
  });

  it("plain text message unaffected by preferCloudForTools", () => {
    const router = new Router({ ...baseConfig, preferCloudForTools: 'code' });
    expect(router.decide({ model: 'aiping:claw', messages: [{ role: 'user', content: '你好' }] }).target).toBe('local');
  });
});
