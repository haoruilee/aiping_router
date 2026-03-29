import type { ChatRequest, ScoringResult, RuleScorer } from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';
import { OverrideScorer, buildScorerChain } from './rules.js';

export class Scorer {
  private readonly scorers: RuleScorer[];

  /**
   * @param scorers  Full ordered list of scorers to apply.
   *                 Default matches Router: override → PinchBench heuristics (if enabled)
   *                 → tool scorer (if enabled) → token/code/reasoning/multi-turn.
   */
  constructor(
    scorers: RuleScorer[] = buildScorerChain({
      preferCloudForTools: DEFAULT_CONFIG.preferCloudForTools,
      pinchbenchHeuristics: DEFAULT_CONFIG.pinchbenchHeuristics,
    })
  ) {
    this.scorers = scorers;
  }

  score(request: ChatRequest): ScoringResult {
    let totalScore = 0;
    const dimensionScores = [];
    let forced: 'local' | 'cloud' | undefined;

    for (const scorer of this.scorers) {
      // Any scorer may return a `forced` field via duck-typing (OverrideScorer, ToolCallScorer)
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
        // Short-circuit: any forced directive stops further evaluation
        break;
      }
    }

    // Cap total at 100 (fixed max score)
    totalScore = Math.min(100, totalScore);

    return { totalScore, dimensionScores, forced };
  }
}
