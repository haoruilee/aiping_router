// Shared type definitions for @aiping.cn/model_router

/** Routing / model selection bucket: chat vs vision-language vs media generation. */
export type ModelTask = 'text' | 'vlm' | 'image' | 'video';

export interface PluginConfig {
  aipingApiKey: string;
  localProxyUrl: string;
  localProxyKey: string;
  localModel: string;
  cloudModel: string;
  /** Optional: local VLM; empty → use localModel for vision requests. */
  localVlmModel: string;
  /** Optional: local T2I; empty → use localModel. */
  localImageModel: string;
  /** Optional: local video; empty → use localModel. */
  localVideoModel: string;
  /**
   * When true (default), adds `think: false` on local Ollama `/v1/chat/completions`
   * requests so reasoning stays off unless the client set `think` or `disableThinking`.
   */
  localDisableThinking: boolean;
  /** Cloud model for vision / multimodal chat (default: Doubao-Seed-2.0-pro). */
  cloudVlmModel: string;
  /** Cloud model for image generation (default: Doubao-Seedream-5.0-lite). */
  cloudImageModel: string;
  /** Cloud model for video generation (default: Doubao-Seedance-1.0-Pro-Fast). */
  cloudVideoModel: string;
  routingThreshold: number;
  fallbackToCloud: boolean;
  localTimeoutMs: number;
  debugRouting: boolean;
  /**
   * Controls how tool-use requests are routed:
   *
   *  'code'  (default) — Only code-writing tools get a score boost (+40 pts),
   *          nudging them toward cloud when combined with code context.
   *          Simple tools (bash, read_file, search…) get no boost and stay local.
   *
   *  'all'   — Any request with a tools array is forced to cloud regardless
   *          of content. Use this only if your local model cannot tool-call at all.
   *
   *  false   — No tool-based routing. Pure score+threshold decides everything.
   */
  preferCloudForTools: 'code' | 'all' | false;
}

export const DEFAULT_CLOUD_VLM_MODEL = 'Doubao-Seed-2.0-pro';
export const DEFAULT_CLOUD_IMAGE_MODEL = 'Doubao-Seedream-5.0-lite';
export const DEFAULT_CLOUD_VIDEO_MODEL = 'Doubao-Seedance-1.0-Pro-Fast';

export const DEFAULT_CONFIG: Omit<PluginConfig, 'aipingApiKey'> = {
  localProxyUrl: 'http://localhost:11434',
  localProxyKey: '',
  // No hardcoded local model — auto-detected from Ollama at setup time.
  localModel: '',
  cloudModel: 'Kimi-K2.5',
  localVlmModel: '',
  localImageModel: '',
  localVideoModel: '',
  localDisableThinking: true,
  cloudVlmModel: DEFAULT_CLOUD_VLM_MODEL,
  cloudImageModel: DEFAULT_CLOUD_IMAGE_MODEL,
  cloudVideoModel: DEFAULT_CLOUD_VIDEO_MODEL,
  // High threshold keeps ~90% of requests on the local model. Max score = 100.
  routingThreshold: 85,
  fallbackToCloud: true,
  localTimeoutMs: 30000,
  debugRouting: false,
  // Default 'code': adds score boost for code-writing tools, leaves simple tools local.
  preferCloudForTools: 'code' as const,
};

// ── OpenAI-compatible message structure (with tool call extensions) ─────────

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  /** Present on assistant messages when the model requests a tool call. */
  tool_calls?: ToolCall[];
  /** Present on tool messages as a reference to the originating tool_call.id. */
  tool_call_id?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** When present, the model may call these tools. */
  tools?: ToolDefinition[];
  tool_choice?: unknown;
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
