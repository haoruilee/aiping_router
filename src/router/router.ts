import type {
  ChatRequest,
  RoutingDecision,
  PluginConfig,
} from '../types.js';
import { Scorer } from './scorer.js';
import { DEFAULT_SCORERS, ToolCallScorer } from './rules.js';

export class Router {
  private readonly scorer: Scorer;
  private readonly config: PluginConfig;

  constructor(config: PluginConfig, scorer?: Scorer) {
    this.config = config;

    if (!scorer) {
      // When preferCloudForTools is enabled, prepend ToolCallScorer so it runs
      // first and can short-circuit before any other scoring takes place.
      // (It runs even before @local/@cloud overrides, because tool-use failures
      //  are almost always wrong — users who know their model supports tools can
      //  set preferCloudForTools: false.)
      const scorerList = config.preferCloudForTools
        ? [new ToolCallScorer(), ...DEFAULT_SCORERS]
        : DEFAULT_SCORERS;
      this.scorer = new Scorer(scorerList);
    } else {
      this.scorer = scorer;
    }
  }

  decide(request: ChatRequest): RoutingDecision {
    const { totalScore, dimensionScores, forced } = this.scorer.score(request);

    if (forced) {
      const decision: RoutingDecision = {
        target: forced,
        score: totalScore,
        forced: true,
        reasons: dimensionScores.map((d) => `[${d.name}] ${d.reason}`),
      };
      this.log(decision);
      return decision;
    }

    const target = totalScore >= this.config.routingThreshold ? 'cloud' : 'local';
    const decision: RoutingDecision = {
      target,
      score: totalScore,
      forced: false,
      reasons: [
        `Score ${totalScore} vs threshold ${this.config.routingThreshold} → ${target}`,
        ...dimensionScores
          .filter((d) => d.score > 0)
          .map((d) => `[${d.name}] ${d.reason} (+${d.score})`),
      ],
    };

    this.log(decision);
    return decision;
  }

  private log(decision: RoutingDecision): void {
    if (!this.config.debugRouting) return;
    console.log(
      `[aiping:router] → ${decision.target.toUpperCase()} ` +
        `(score=${decision.score}, forced=${decision.forced})\n` +
        decision.reasons.map((r) => `  • ${r}`).join('\n')
    );
  }
}
