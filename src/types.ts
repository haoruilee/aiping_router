// Shared type definitions for @aiping.cn/model_router

export interface PluginConfig {
  aipingApiKey: string;
  localProxyUrl: string;
  localProxyKey: string;
  localModel: string;
  cloudModel: string;
  routingThreshold: number;
  fallbackToCloud: boolean;
  localTimeoutMs: number;
  debugRouting: boolean;
}

export const DEFAULT_CONFIG: Omit<PluginConfig, 'aipingApiKey'> = {
  localProxyUrl: 'http://localhost:11434',
  localProxyKey: '',
  localModel: 'qwen2.5:4b',
  cloudModel: 'kimi-2.5',
  // High threshold keeps ~90% of requests on the local model.
  // Only genuinely heavy requests (long context + complex code + deep reasoning) reach cloud.
  routingThreshold: 85,
  fallbackToCloud: true,
  localTimeoutMs: 30000,
  debugRouting: false,
};

// OpenAI-compatible message structure
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  [key: string]: unknown;
}

export interface ChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export type RoutingTarget = 'local' | 'cloud';

export interface RoutingDecision {
  target: RoutingTarget;
  score: number;
  reasons: string[];
  forced: boolean;
}

export interface ScoringResult {
  totalScore: number;
  dimensionScores: DimensionScore[];
  forced?: RoutingTarget;
}

export interface DimensionScore {
  name: string;
  score: number;
  maxScore: number;
  reason: string;
}

// Interface for pluggable rule scorers
export interface RuleScorer {
  readonly name: string;
  readonly maxScore: number;
  score(request: ChatRequest): DimensionScore;
}
