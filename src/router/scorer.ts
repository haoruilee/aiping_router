import type { ChatRequest, ScoringResult, RuleScorer } from '../types.js';
import { DEFAULT_SCORERS, OverrideScorer } from './rules.js';

export class Scorer {
  private readonly scorers: RuleScorer[];

  constructor(scorers: RuleScorer[] = DEFAULT_SCORERS) {
    this.scorers = scorers;
  }

  score(request: ChatRequest): ScoringResult {
    let totalScore = 0;
    const dimensionScores = [];
    let forced: 'local' | 'cloud' | undefined;

    for (const scorer of this.scorers) {
      // OverrideScorer may return a `forced` field via duck-typing
      const result = scorer.score(request) as ReturnType<OverrideScorer['score']>;

      dimensionScores.push({
        name: result.name,
        score: result.score,
        maxScore: result.maxScore,
        reason: result.reason,
      });

      totalScore += result.score;

      if (result.forced) {
        forced = result.forced;
        // Short-circuit: override directives take immediate effect
        break;
      }
    }

    return { totalScore, dimensionScores, forced };
  }
}
