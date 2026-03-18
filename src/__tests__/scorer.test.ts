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
// HIGH_THRESHOLD = 6000, LOW_THRESHOLD = 2500

describe('TokenCountScorer', () => {
  const scorer = new TokenCountScorer();

  it('returns 0 for very short messages', () => {
    const result = scorer.score(makeRequest('Hi'));
    expect(result.score).toBe(0);
  });

  it('returns 0 for medium messages under 2500 tokens', () => {
    const content = 'word '.repeat(500); // ~500 tokens
    const result = scorer.score(makeRequest(content));
    expect(result.score).toBe(0);
  });

  it('returns max score for very long messages (≥6000 tokens)', () => {
    const longContent = 'word '.repeat(6500); // ~6500 tokens
    const result = scorer.score(makeRequest(longContent));
    expect(result.score).toBe(scorer.maxScore);
  });

  it('returns partial score for messages between 2500-6000 tokens', () => {
    const medContent = 'word '.repeat(3500); // ~3500 tokens
    const result = scorer.score(makeRequest(medContent));
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(scorer.maxScore);
  });

  it('ignores system messages (OpenClaw wrapper) — short user + long system = low score', () => {
    // Simulates OpenClaw adding long system prompt/tool schemas; only user content should count
    const longSystemPrompt = 'You are a helpful assistant. ' + 'instruction '.repeat(5000);
    const req: ChatRequest = {
      model: 'aiping:claw',
      messages: [
        { role: 'system', content: longSystemPrompt },
        { role: 'user', content: 'Hi' },
      ],
    };
    const result = scorer.score(req);
    expect(result.score).toBe(0);
  });
});

// ── CodeComplexityScorer ──────────────────────────────────────────────────────
// LINE_THRESHOLD = 100

describe('CodeComplexityScorer', () => {
  const scorer = new CodeComplexityScorer();

  it('returns 0 for messages without code', () => {
    const result = scorer.score(makeRequest('How does React work?'));
    expect(result.score).toBe(0);
  });

  it('returns partial score for small code blocks (< 100 lines)', () => {
    const codeLines = Array(20).fill('  const x = 1;').join('\n');
    const content = `Here is code:\n\`\`\`typescript\n${codeLines}\n\`\`\``;
    const result = scorer.score(makeRequest(content));
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThan(scorer.maxScore);
  });

  it('returns max score for large code blocks (≥ 100 lines)', () => {
    const codeLines = Array(105).fill('  const x = 1;').join('\n');
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

  it('detects strong English multi-word phrases (1 match = half score)', () => {
    const result = scorer.score(makeRequest('Please explain in detail how this works.'));
    expect(result.score).toBe(Math.round(scorer.maxScore / 2));
  });

  it('gives full score for ≥2 strong phrases', () => {
    const result = scorer.score(makeRequest('Please explain in detail and walk me through step by step.'));
    expect(result.score).toBe(scorer.maxScore);
  });

  it('detects strong Chinese multi-word phrases (1 match = half score)', () => {
    const result = scorer.score(makeRequest('请对这两个方案进行深度分析'));
    expect(result.score).toBe(Math.round(scorer.maxScore / 2));
  });
});

// ── MultiTurnContextScorer ────────────────────────────────────────────────────
// TURN_THRESHOLD = 20

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

  it('returns max score for very long conversations (≥ 20 turns)', () => {
    const result = scorer.score(makeRequest('content', 21));
    expect(result.score).toBe(scorer.maxScore);
  });

  it('ignores system messages in turn count — system + 1 user = 1 turn', () => {
    const req: ChatRequest = {
      model: 'aiping:claw',
      messages: [
        { role: 'system', content: 'Long system prompt...' },
        { role: 'user', content: 'Hi' },
      ],
    };
    const result = scorer.score(req);
    expect(result.score).toBe(0);
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
    expect(result.totalScore).toBeLessThan(30);
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
    const bigCode = Array(105).fill('const x = require("something");').join('\n');
    const content = `请逐步分析这段代码并深度分析优缺点：\n\`\`\`js\n${bigCode}\n\`\`\`\n` + 'x'.repeat(28000); // ~7000 tokens
    const result = scorer.score(makeRequest(content, 21));
    expect(result.totalScore).toBeGreaterThanOrEqual(85);
  });

  it('total score is capped at 100', () => {
    const bigCode = Array(105).fill('const x = require("something");').join('\n');
    const content = `请逐步分析并深度分析：\n\`\`\`js\n${bigCode}\n\`\`\`\n` + 'x'.repeat(28000);
    const result = scorer.score(makeRequest(content, 21));
    expect(result.totalScore).toBeLessThanOrEqual(100);
  });

  it('OpenClaw wrapper: long system + short user does not inflate score', () => {
    const longWrapper = 'System instructions... ' + 'x'.repeat(20000); // ~5000 tokens
    const req: ChatRequest = {
      model: 'aiping:claw',
      messages: [
        { role: 'system', content: longWrapper },
        { role: 'user', content: '1+1等于几？' },
      ],
    };
    const result = scorer.score(req);
    expect(result.totalScore).toBeLessThan(85);
  });
});
