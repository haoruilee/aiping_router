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

describe('TokenCountScorer', () => {
  const scorer = new TokenCountScorer();

  it('returns 0 for very short messages', () => {
    const result = scorer.score(makeRequest('Hi'));
    expect(result.score).toBe(0);
  });

  it('returns max score for long messages (>2000 tokens)', () => {
    const longContent = 'word '.repeat(2200); // ~2200 tokens
    const result = scorer.score(makeRequest(longContent));
    expect(result.score).toBe(scorer.maxScore);
  });

  it('returns partial score for medium messages', () => {
    const medContent = 'word '.repeat(900); // ~900 tokens estimated
    const result = scorer.score(makeRequest(medContent));
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(scorer.maxScore);
  });
});

// ── CodeComplexityScorer ──────────────────────────────────────────────────────

describe('CodeComplexityScorer', () => {
  const scorer = new CodeComplexityScorer();

  it('returns 0 for messages without code', () => {
    const result = scorer.score(makeRequest('How does React work?'));
    expect(result.score).toBe(0);
  });

  it('returns max score for large code blocks', () => {
    const codeLines = Array(35).fill('  const x = 1;').join('\n');
    const content = `Here is code:\n\`\`\`typescript\n${codeLines}\n\`\`\``;
    const result = scorer.score(makeRequest(content));
    expect(result.score).toBe(scorer.maxScore);
  });

  it('returns partial score for small code blocks', () => {
    const content = '```python\nprint("hello")\n```';
    const result = scorer.score(makeRequest(content));
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(scorer.maxScore);
  });
});

// ── ReasoningDepthScorer ──────────────────────────────────────────────────────

describe('ReasoningDepthScorer', () => {
  const scorer = new ReasoningDepthScorer();

  it('returns 0 for simple questions', () => {
    const result = scorer.score(makeRequest('What is 2 + 2?'));
    expect(result.score).toBe(0);
  });

  it('detects English reasoning keywords', () => {
    const result = scorer.score(makeRequest('Please analyze and compare these two approaches step by step.'));
    expect(result.score).toBe(scorer.maxScore);
  });

  it('detects Chinese reasoning keywords', () => {
    const result = scorer.score(makeRequest('请详细分析这两个方案的优缺点'));
    expect(result.score).toBe(scorer.maxScore);
  });
});

// ── MultiTurnContextScorer ────────────────────────────────────────────────────

describe('MultiTurnContextScorer', () => {
  const scorer = new MultiTurnContextScorer();

  it('returns 0 for single-turn', () => {
    const result = scorer.score(makeRequest('Hi', 1));
    expect(result.score).toBe(0);
  });

  it('returns max score for long conversations', () => {
    const result = scorer.score(makeRequest('content', 7));
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

  it('short simple message scores low', () => {
    const result = scorer.score(makeRequest('What time is it?'));
    expect(result.totalScore).toBeLessThan(20);
    expect(result.forced).toBeUndefined();
  });

  it('@local override short-circuits scoring', () => {
    const req: ChatRequest = {
      model: 'aiping:claw',
      messages: [{ role: 'user', content: 'Analyse this huge codebase @local' }],
    };
    const result = scorer.score(req);
    expect(result.forced).toBe('local');
  });

  it('complex multi-turn message scores high', () => {
    const longCode = Array(40).fill('const x = require("something");').join('\n');
    const content = `Please analyze and compare:\n\`\`\`js\n${longCode}\n\`\`\``;
    const result = scorer.score(makeRequest(content, 8));
    expect(result.totalScore).toBeGreaterThan(50);
  });
});
