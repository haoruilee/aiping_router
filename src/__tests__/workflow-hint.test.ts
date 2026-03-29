import { describe, it, expect } from 'vitest';
import { Router } from '../router/router.js';
import { WorkflowHintScorer, isImageGenTool, ToolCallScorer } from '../router/rules.js';
import type { ChatRequest, PluginConfig } from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';

const base: PluginConfig = {
  ...DEFAULT_CONFIG,
  aipingApiKey: 'test',
};

describe('WorkflowHintScorer', () => {
  const h = new WorkflowHintScorer();

  it('adds score on image-generation-style phrasing without forcing cloud', () => {
    const r = h.score({
      model: 'aiping:claw',
      messages: [
        {
          role: 'user',
          content:
            'Generate an image of a friendly robot sitting in a cozy coffee shop, reading a book. Save it as "robot_cafe.png" in the current directory.',
        },
      ],
    }) as { forced?: string; score: number };
    expect(r.forced).toBeUndefined();
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThanOrEqual(h.maxScore);
  });

  it('adds score on persistent memory file pattern', () => {
    const r = h.score({
      model: 'aiping:claw',
      messages: [
        {
          role: 'user',
          content:
            'Remember this for me. Save it to memory/MEMORY.md so a future session can recall it later.',
        },
      ],
    }) as { forced?: string; score: number };
    expect(r.forced).toBeUndefined();
    expect(r.score).toBeGreaterThan(0);
  });

  it('caps combined signals at maxScore', () => {
    const r = h.score({
      model: 'aiping:claw',
      messages: [
        {
          role: 'user',
          content:
            'Generate an image. Save to x.png. Also save notes to memory/MEMORY.md for later.',
        },
      ],
    });
    expect(r.score).toBeLessThanOrEqual(h.maxScore);
  });

  it('does not match arbitrary short chat', () => {
    const r = h.score({
      model: 'aiping:claw',
      messages: [{ role: 'user', content: 'Hello, fix this bug in app.ts' }],
    });
    expect(r.score).toBe(0);
  });
});

describe('Router defaults favor local', () => {
  it('image-style prompt stays local at threshold 100 when workflow hints off', () => {
    const router = new Router({
      ...base,
      routingThreshold: 100,
      workflowHintBoost: false,
    });
    const decision = router.decide({
      model: 'aiping:claw',
      messages: [
        {
          role: 'user',
          content: 'Generate an image of a cat. Save it as out.png',
        },
      ],
    });
    expect(decision.target).toBe('local');
  });

  it('workflow hints alone do not reach threshold 85', () => {
    const router = new Router({
      ...base,
      routingThreshold: 85,
      workflowHintBoost: true,
    });
    const decision = router.decide({
      model: 'aiping:claw',
      messages: [
        {
          role: 'user',
          content: 'Generate an image of a cat. Save it as out.png',
        },
      ],
    });
    expect(decision.target).toBe('local');
    expect(decision.score).toBeLessThan(85);
  });

  it('@local overrides remain first', () => {
    const router = new Router({ ...base, workflowHintBoost: true });
    const decision = router.decide({
      model: 'aiping:claw',
      messages: [
        {
          role: 'user',
          content:
            'Search all emails in emails/ and write alpha_summary.md @local',
        },
      ],
    });
    expect(decision.target).toBe('local');
    expect(decision.forced).toBe(true);
  });
});

describe('ToolCallScorer + image tools', () => {
  const scorer = new ToolCallScorer('code');

  it('does not force cloud for generate_image tool', () => {
    const req: ChatRequest = {
      model: 'aiping:claw',
      messages: [{ role: 'user', content: 'Make a diagram' }],
      tools: [{ type: 'function', function: { name: 'generate_image' } }],
    };
    const r = scorer.score(req) as { forced?: string; score: number };
    expect(r.forced).toBeUndefined();
    expect(r.score).toBe(0);
  });

  it('isImageGenTool excludes image tools from code-tool +20', () => {
    const req: ChatRequest = {
      model: 'aiping:claw',
      messages: [{ role: 'user', content: 'Draw something' }],
      tools: [{ type: 'function', function: { name: 'mcp_generate_image' } }],
    };
    const r = scorer.score(req) as { score: number };
    expect(r.score).toBe(0);
  });

  it('isImageGenTool detects common names', () => {
    expect(isImageGenTool('mcp_generate_image')).toBe(true);
    expect(isImageGenTool('read_file')).toBe(false);
  });
});
