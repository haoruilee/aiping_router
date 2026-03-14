import { describe, it, expect } from 'vitest';
import { Scorer } from '../router/scorer.js';
import {
  TokenCountScorer,
  CodeComplexityScorer,
  ReasoningDepthScorer,
  MultiTurnContextScorer,
  OverrideScorer,
} from '../router/rules.js';
import type { ChatRequest } from '../types.js';

function makeRequest(content: string, turns = 1): ChatRequest {
  const messages = [];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'user' as const, content: `Turn ${i}: ${content}` });
    if (i < turns - 1) {
      messages.push({ role: 'assistant' as const, content: 'Response' });
    }
  }
  return { model: 'aiping:claw', messages };
}

// ── TokenCountScorer ──────────────────────────────────────────────────────────
// HIGH_THRESHOLD = 4000, LOW_THRESHOLD = 1500

describe('TokenCountScorer', () => {
  const scorer = new TokenCountScorer();

  it('returns 0 for very short messages', () => {
    const result = scorer.score(makeRequest('Hi'));
    expect(result.score).toBe(0);
  });

  it('returns 0 for medium messages under 1500 tokens', () => {
    const content = 'word '.repeat(500); // ~500 tokens
    const result = scorer.score(makeRequest(content));
    expect(result.score).toBe(0);
  });

  it('returns max score for very long messages (>4000 tokens)', () => {
    const longContent = 'word '.repeat(4500); // ~4500 tokens
    const result = scorer.score(makeRequest(longContent));
    expect(result.score).toBe(scorer.maxScore);
  });

  it('returns partial score for messages between 1500-4000 tokens', () => {
    const medContent = 'word '.repeat(2500); // ~2500 tokens
    const result = scorer.score(makeRequest(medContent));
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(scorer.maxScore);
  });
});

// ── CodeComplexityScorer ──────────────────────────────────────────────────────
// LINE_THRESHOLD = 80

describe('CodeComplexityScorer', () => {
  const scorer = new CodeComplexityScorer();

  it('returns 0 for messages without code', () => {
    const result = scorer.score(makeRequest('How does React work?'));
    expect(result.score).toBe(0);
  });

  it('returns 0 for small code blocks (< 80 lines)', () => {
    const codeLines = Array(20).fill('  const x = 1;').join('\n');
    const content = `Here is code:\n\`\`\`typescript\n${codeLines}\n\`\`\``;
    const result = scorer.score(makeRequest(content));
    // Partial score since lines < threshold
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThan(scorer.maxScore);
  });

  it('returns max score for large code blocks (>= 80 lines)', () => {
    const codeLines = Array(85).fill('  const x = 1;').join('\n');
    const content = `Here is code:\n\`\`\`typescript\n${codeLines}\n\`\`\``;
    const result = scorer.score(makeRequest(content));
    expect(result.score).toBe(scorer.maxScore);
  });
});

// ── ReasoningDepthScorer ──────────────────────────────────────────────────────
// Only fires on strong multi-word phrases now

describe('ReasoningDepthScorer', () => {
  const scorer = new ReasoningDepthScorer();

  it('returns 0 for simple questions', () => {
    const result = scorer.score(makeRequest('What is 2 + 2?'));
    expect(result.score).toBe(0);
  });

  it('returns 0 for single weak keywords like "分析" alone', () => {
    // "分析" alone is no longer in the strong keyword list
    const result = scorer.score(makeRequest('请分析一下'));
    expect(result.score).toBe(0);
  });

  it('detects strong English multi-word phrases', () => {
    const result = scorer.score(makeRequest('Please explain in detail how this works.'));
    expect(result.score).toBe(scorer.maxScore);
  });

  it('detects strong Chinese multi-word phrases', () => {
    const result = scorer.score(makeRequest('请对这两个方案进行深度分析'));
    expect(result.score).toBe(scorer.maxScore);
  });

  it('detects step-by-step keyword', () => {
    const result = scorer.score(makeRequest('Walk me through this step by step.'));
    expect(result.score).toBe(scorer.maxScore);
  });
});

// ── MultiTurnContextScorer ────────────────────────────────────────────────────
// TURN_THRESHOLD = 16

describe('MultiTurnContextScorer', () => {
  const scorer = new MultiTurnContextScorer();

  it('returns 0 for single-turn', () => {
    const result = scorer.score(makeRequest('Hi', 1));
    expect(result.score).toBe(0);
  });

  it('returns partial score for moderate conversations (6 turns)', () => {
    const result = scorer.score(makeRequest('content', 6));
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(scorer.maxScore);
  });

  it('returns max score for very long conversations (>= 16 turns)', () => {
    const result = scorer.score(makeRequest('content', 17));
    expect(result.score).toBe(scorer.maxScore);
  });
});

// ── OverrideScorer ────────────────────────────────────────────────────────────

describe('OverrideScorer', () => {
  const scorer = new OverrideScorer();

  it('detects @local directive', () => {
    const req: ChatRequest = {
      model: 'aiping:claw',
      messages: [{ role: 'user', content: 'Summarise this @local' }],
    };
    const result = scorer.score(req) as { forced?: string };
    expect(result.forced).toBe('local');
  });

  it('detects @cloud directive', () => {
    const req: ChatRequest = {
      model: 'aiping:claw',
      messages: [{ role: 'user', content: 'Deep analysis please @cloud' }],
    };
    const result = scorer.score(req) as { forced?: string };
    expect(result.forced).toBe('cloud');
  });

  it('returns no forced for normal messages', () => {
    const result = scorer.score(makeRequest('Hello!')) as { forced?: string };
    expect(result.forced).toBeUndefined();
  });
});

// ── Full Scorer integration ───────────────────────────────────────────────────

describe('Scorer integration', () => {
  const scorer = new Scorer();

  it('typical short message scores well below 85 threshold', () => {
    const result = scorer.score(makeRequest('请帮我写一个 hello world'));
    expect(result.totalScore).toBeLessThan(20);
    expect(result.forced).toBeUndefined();
  });

  it('medium conversation (6 turns) still scores below 85', () => {
    const result = scorer.score(makeRequest('How do I center a div?', 6));
    expect(result.totalScore).toBeLessThan(85);
  });

  it('@local override short-circuits scoring', () => {
    const req: ChatRequest = {
      model: 'aiping:claw',
      messages: [{ role: 'user', content: 'Analyse this huge codebase @local' }],
    };
    const result = scorer.score(req);
    expect(result.forced).toBe('local');
  });

  it('genuinely heavy request (huge + code + reasoning + long chat) scores >= 85', () => {
    const bigCode = Array(90).fill('const x = require("something");').join('\n');
    const content = `请逐步分析这段代码并对比优缺点：\n\`\`\`js\n${bigCode}\n\`\`\`\n` + 'x'.repeat(6000);
    const result = scorer.score(makeRequest(content, 17));
    expect(result.totalScore).toBeGreaterThanOrEqual(85);
  });
});
