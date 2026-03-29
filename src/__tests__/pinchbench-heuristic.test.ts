import { describe, it, expect } from 'vitest';
import { Router } from '../router/router.js';
import { CloudHeuristicScorer, isImageGenTool, ToolCallScorer } from '../router/rules.js';
import type { ChatRequest, PluginConfig } from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';

const base: PluginConfig = {
  ...DEFAULT_CONFIG,
  aipingApiKey: 'test',
};

describe('CloudHeuristicScorer', () => {
  const h = new CloudHeuristicScorer();

  it('forces cloud on PinchBench image task phrasing', () => {
    const r = h.score({
      model: 'aiping:claw',
      messages: [
        {
          role: 'user',
          content:
            'Generate an image of a friendly robot sitting in a cozy coffee shop, reading a book. Save it as "robot_cafe.png" in the current directory.',
        },
      ],
    }) as { forced?: string };
    expect(r.forced).toBe('cloud');
  });

  it('forces cloud on second-brain MEMORY.md pattern', () => {
    const r = h.score({
      model: 'aiping:claw',
      messages: [
        {
          role: 'user',
          content:
            'Remember this for me. Save it to memory/MEMORY.md so a future session can recall it later.',
        },
      ],
    }) as { forced?: string };
    expect(r.forced).toBe('cloud');
  });

  it('forces cloud on email corpus + alpha_summary', () => {
    const r = h.score({
      model: 'aiping:claw',
      messages: [
        {
          role: 'user',
          content:
            'Search through all the emails in the emails/ folder about Project Alpha and save alpha_summary.md.',
        },
      ],
    }) as { forced?: string };
    expect(r.forced).toBe('cloud');
  });

  it('forces cloud on competitive landscape + pricing', () => {
    const r = h.score({
      model: 'aiping:claw',
      messages: [
        {
          role: 'user',
          content:
            'Create a competitive landscape analysis for the enterprise APM market segment. Include a comparison table and typical pricing models in market_research.md.',
        },
      ],
    }) as { forced?: string };
    expect(r.forced).toBe('cloud');
  });

  it('forces cloud on CSV + xlsx summary report', () => {
    const r = h.score({
      model: 'aiping:claw',
      messages: [
        {
          role: 'user',
          content:
            'Read quarterly_sales.csv and company_expenses.xlsx and write data_summary.md with a summary report.',
        },
      ],
    }) as { forced?: string };
    expect(r.forced).toBe('cloud');
  });

  it('forces cloud on ELI5 + PDF', () => {
    const r = h.score({
      model: 'aiping:claw',
      messages: [
        {
          role: 'user',
          content:
            'Read GPT4.pdf and write an ELI5 summary to eli5_summary.txt.',
        },
      ],
    }) as { forced?: string };
    expect(r.forced).toBe('cloud');
  });

  it('does not match arbitrary short chat', () => {
    const r = h.score({
      model: 'aiping:claw',
      messages: [{ role: 'user', content: 'Hello, fix this bug in app.ts' }],
    }) as { forced?: string };
    expect(r.forced).toBeUndefined();
    expect(r.score).toBe(0);
  });
});

describe('Router + pinchbenchHeuristics', () => {
  it('routes image task to cloud even at threshold 100', () => {
    const router = new Router({ ...base, routingThreshold: 100 });
    const decision = router.decide({
      model: 'aiping:claw',
      messages: [
        {
          role: 'user',
          content: 'Generate an image of a cat. Save it as out.png',
        },
      ],
    });
    expect(decision.target).toBe('cloud');
    expect(decision.forced).toBe(true);
  });

  it('@local overrides PinchBench image heuristic', () => {
    const router = new Router(base);
    const decision = router.decide({
      model: 'aiping:claw',
      messages: [
        {
          role: 'user',
          content: 'Generate an image of a cat. Save as cat.png @local',
        },
      ],
    });
    expect(decision.target).toBe('local');
    expect(decision.forced).toBe(true);
  });

  it('disabling pinchbenchHeuristics keeps image prompt local at high threshold', () => {
    const router = new Router({
      ...base,
      routingThreshold: 100,
      pinchbenchHeuristics: false,
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
});

describe('ToolCallScorer image tools', () => {
  const scorer = new ToolCallScorer('code');

  it('forces cloud when generate_image is in tools list', () => {
    const req: ChatRequest = {
      model: 'aiping:claw',
      messages: [{ role: 'user', content: 'Make a diagram' }],
      tools: [{ type: 'function', function: { name: 'generate_image' } }],
    };
    const r = scorer.score(req) as { forced?: string };
    expect(r.forced).toBe('cloud');
  });

  it('isImageGenTool detects common names', () => {
    expect(isImageGenTool('mcp_generate_image')).toBe(true);
    expect(isImageGenTool('read_file')).toBe(false);
  });
});
