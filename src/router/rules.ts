import type { ChatRequest, DimensionScore, RuleScorer } from '../types.js';

// Estimates token count from a string using a simple heuristic (~4 chars per token)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function extractAllText(request: ChatRequest): string {
  return request.messages
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n');
}

/**
 * Token Count Scorer
 * Long inputs are harder for small local models (limited context window).
 * > 2000 estimated tokens → full 30 points
 * Scales linearly from 0 at 500 tokens to 30 at 2000 tokens.
 */
export class TokenCountScorer implements RuleScorer {
  readonly name = 'token_count';
  readonly maxScore = 30;

  private readonly LOW_THRESHOLD = 500;
  private readonly HIGH_THRESHOLD = 2000;

  score(request: ChatRequest): DimensionScore {
    const text = extractAllText(request);
    const tokens = estimateTokens(text);

    let points = 0;
    let reason = `~${tokens} estimated tokens`;

    if (tokens >= this.HIGH_THRESHOLD) {
      points = this.maxScore;
      reason += ` (≥${this.HIGH_THRESHOLD} → cloud favored)`;
    } else if (tokens > this.LOW_THRESHOLD) {
      points = Math.round(
        ((tokens - this.LOW_THRESHOLD) / (this.HIGH_THRESHOLD - this.LOW_THRESHOLD)) *
          this.maxScore
      );
      reason += ` (scaling ${this.LOW_THRESHOLD}-${this.HIGH_THRESHOLD})`;
    }

    return { name: this.name, score: points, maxScore: this.maxScore, reason };
  }
}

/**
 * Code Complexity Scorer
 * Large code blocks require strong reasoning capabilities.
 * Code fences with > 30 lines → full 20 points.
 */
export class CodeComplexityScorer implements RuleScorer {
  readonly name = 'code_complexity';
  readonly maxScore = 20;

  private readonly LINE_THRESHOLD = 30;

  score(request: ChatRequest): DimensionScore {
    const text = extractAllText(request);
    const codeBlockRegex = /```[\s\S]*?```/g;
    const blocks = text.match(codeBlockRegex) ?? [];

    let maxBlockLines = 0;
    for (const block of blocks) {
      const lines = block.split('\n').length;
      if (lines > maxBlockLines) maxBlockLines = lines;
    }

    let points = 0;
    let reason = `${blocks.length} code block(s), max ${maxBlockLines} lines`;

    if (maxBlockLines >= this.LINE_THRESHOLD) {
      points = this.maxScore;
      reason += ` (≥${this.LINE_THRESHOLD} lines → cloud favored)`;
    } else if (blocks.length > 0) {
      points = Math.round((maxBlockLines / this.LINE_THRESHOLD) * this.maxScore);
    }

    return { name: this.name, score: points, maxScore: this.maxScore, reason };
  }
}

/**
 * Reasoning Depth Scorer
 * Keywords indicating complex analytical tasks favour stronger cloud models.
 */
export class ReasoningDepthScorer implements RuleScorer {
  readonly name = 'reasoning_depth';
  readonly maxScore = 15;

  private readonly KEYWORDS = [
    // English
    'analyze', 'analyse', 'compare', 'contrast', 'explain in detail',
    'step by step', 'step-by-step', 'reason through', 'evaluate',
    'critique', 'pros and cons', 'trade-offs', 'trade offs',
    // Chinese
    '分析', '对比', '比较', '详细解释', '逐步', '一步一步', '推理',
    '评估', '优缺点', '权衡', '深入', '综合',
  ];

  score(request: ChatRequest): DimensionScore {
    const text = extractAllText(request).toLowerCase();
    const matched = this.KEYWORDS.filter((kw) => text.includes(kw.toLowerCase()));

    const points = matched.length > 0 ? this.maxScore : 0;
    const reason =
      matched.length > 0
        ? `Complex reasoning keywords found: ${matched.slice(0, 3).join(', ')}`
        : 'No complex reasoning keywords';

    return { name: this.name, score: points, maxScore: this.maxScore, reason };
  }
}

/**
 * Multi-turn Context Scorer
 * Long conversation histories require the model to synthesize and track many facts.
 * > 6 message turns → full 20 points.
 */
export class MultiTurnContextScorer implements RuleScorer {
  readonly name = 'multi_turn_context';
  readonly maxScore = 20;

  private readonly TURN_THRESHOLD = 6;

  score(request: ChatRequest): DimensionScore {
    const turns = request.messages.length;
    let points = 0;
    let reason = `${turns} message(s) in context`;

    if (turns >= this.TURN_THRESHOLD) {
      points = this.maxScore;
      reason += ` (≥${this.TURN_THRESHOLD} turns → cloud favored)`;
    } else if (turns > 1) {
      points = Math.round((turns / this.TURN_THRESHOLD) * this.maxScore);
    }

    return { name: this.name, score: points, maxScore: this.maxScore, reason };
  }
}

/**
 * Override Scorer
 * Detects explicit @local or @cloud directives in the last user message.
 * These force routing and override all other scores.
 */
export class OverrideScorer implements RuleScorer {
  readonly name = 'override_directive';
  readonly maxScore = 0; // Does not contribute to score; uses forced field

  score(request: ChatRequest): DimensionScore & { forced?: 'local' | 'cloud' } {
    const lastUserMessage = [...request.messages]
      .reverse()
      .find((m) => m.role === 'user');

    const content = typeof lastUserMessage?.content === 'string'
      ? lastUserMessage.content
      : '';

    if (/@local\b/i.test(content)) {
      return {
        name: this.name,
        score: 0,
        maxScore: this.maxScore,
        reason: '@local directive detected — forcing local routing',
        forced: 'local',
      };
    }

    if (/@cloud\b/i.test(content)) {
      return {
        name: this.name,
        score: 0,
        maxScore: this.maxScore,
        reason: '@cloud directive detected — forcing cloud routing',
        forced: 'cloud',
      };
    }

    return {
      name: this.name,
      score: 0,
      maxScore: this.maxScore,
      reason: 'No override directive',
    };
  }
}

// Default set of rule scorers (ordered by processing speed, cheapest first)
export const DEFAULT_SCORERS: RuleScorer[] = [
  new OverrideScorer(),
  new MultiTurnContextScorer(),
  new TokenCountScorer(),
  new CodeComplexityScorer(),
  new ReasoningDepthScorer(),
];
