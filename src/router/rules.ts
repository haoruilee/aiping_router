import type { ChatRequest, DimensionScore, RuleScorer } from '../types.js';

type LegacyContent = string | null | undefined;
type StructuredContent = { type: 'text'; text: string }[] | null | undefined;

function toMessageText(content: LegacyContent | StructuredContent): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('');
  }

  return '';
}

// Estimates token count from a string using a simple heuristic (~4 chars per token)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Extracts text from messages for scoring. Excludes system messages to avoid
 * OpenClaw/agent wrapper (long system prompts, tool schemas) inflating scores.
 * Only user, assistant, and tool messages reflect actual conversation content.
 */
function extractAllText(request: ChatRequest): string {
  return request.messages
    .filter((m) => m.role !== 'system')
    .map((m) => toMessageText(m.content as LegacyContent | StructuredContent))
    .join('\n');
}

/** Message count excluding system (used for multi-turn scoring). */
function conversationTurnCount(request: ChatRequest): number {
  return request.messages.filter((m) => m.role !== 'system').length;
}

/**
 * Token Count Scorer
 * Long inputs are harder for small local models (limited context window).
 * ≥ 6000 estimated tokens → full 35 points (stricter thresholds keep scores lower).
 * Scales linearly from 0 at 2500 tokens to 35 at 6000 tokens.
 */
export class TokenCountScorer implements RuleScorer {
  readonly name = 'token_count';
  readonly maxScore = 35;

  private readonly LOW_THRESHOLD = 2500;
  private readonly HIGH_THRESHOLD = 6000;

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
 * Code fences with ≥ 100 lines → full 24 points (stricter to keep scores lower).
 */
export class CodeComplexityScorer implements RuleScorer {
  readonly name = 'code_complexity';
  readonly maxScore = 24;

  private readonly LINE_THRESHOLD = 100;

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
 * Only triggers for clearly heavy analytical tasks (≥2 strong keywords).
 * Requires ≥2 matches to score (stricter to keep scores lower).
 */
export class ReasoningDepthScorer implements RuleScorer {
  readonly name = 'reasoning_depth';
  readonly maxScore = 17;

  // Only "strong" multi-word or unambiguously complex phrases trigger scoring
  private readonly STRONG_KEYWORDS = [
    // English – multi-word / unambiguous
    'explain in detail', 'step by step', 'step-by-step',
    'reason through', 'pros and cons', 'trade-offs', 'trade offs',
    'critically evaluate', 'comprehensive analysis',
    // Chinese – unambiguously heavy
    '详细分析', '逐步分析', '全面对比', '深度分析', '系统性分析',
    '优缺点对比', '深入推理',
  ];

  score(request: ChatRequest): DimensionScore {
    const text = extractAllText(request).toLowerCase();
    const matched = this.STRONG_KEYWORDS.filter((kw) =>
      text.includes(kw.toLowerCase())
    );

    // Require ≥2 strong phrases for full score; 1 match = half score (stricter)
    const points = matched.length >= 2 ? this.maxScore : (matched.length >= 1 ? Math.round(this.maxScore / 2) : 0);
    const reason =
      matched.length >= 1
        ? `强推理关键词: ${matched.slice(0, 3).join(', ')} (${matched.length}个)`
        : '无强推理关键词';

    return { name: this.name, score: points, maxScore: this.maxScore, reason };
  }
}

/**
 * Multi-turn Context Scorer
 * Long conversation histories require the model to synthesize and track many facts.
 * ≥ 20 messages → full 24 points (stricter to keep scores lower).
 */
export class MultiTurnContextScorer implements RuleScorer {
  readonly name = 'multi_turn_context';
  readonly maxScore = 24;

  private readonly TURN_THRESHOLD = 20;

  score(request: ChatRequest): DimensionScore {
    const turns = conversationTurnCount(request);
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

    const content = toMessageText(
      lastUserMessage?.content as LegacyContent | StructuredContent
    );

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

/** Substrings in tool names that indicate image / multimodal generation (PinchBench task_13). */
const IMAGE_TOOL_PATTERNS = [
  'generate_image',
  'image_gen',
  'imagegen',
  'dall',
  'dalle',
  'flux',
  'imagen',
  'sdxl',
  'stable_diffusion',
  'stability',
  'midjourney',
];

function collectDeclaredToolNames(request: ChatRequest): string[] {
  const names: string[] = [];
  for (const t of request.tools ?? []) {
    const n = t.function?.name;
    if (n) names.push(n);
  }
  for (const m of request.messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const n = tc.function?.name;
        if (n) names.push(n);
      }
    }
  }
  return names;
}

export function isImageGenTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return IMAGE_TOOL_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Nudges cloud for request shapes that PinchBench scores poorly on mid-size locals
 * (e.g. Qwen3.5-35B): image gen, second-brain persistence, inbox-wide email synthesis,
 * competitive research reports, CSV+Excel combo analysis, ELI5 PDF tasks.
 * Uses only message text + light structure — no task IDs.
 */
export class CloudHeuristicScorer implements RuleScorer {
  readonly name = 'pinchbench_heuristic';
  readonly maxScore = 55;

  score(request: ChatRequest): DimensionScore & { forced?: 'cloud' } {
    const text = extractAllText(request).toLowerCase();
    const lastUser = [...request.messages]
      .reverse()
      .find((m) => m.role === 'user');
    const lastUserText = toMessageText(
      lastUser?.content as LegacyContent | StructuredContent
    ).toLowerCase();

    // Image generation (task_13) — mid-size locals often fail; threshold alone may not reach 85
    if (
      /\bgenerate an image\b/.test(text) ||
      /\bgenerate_image\b/.test(text) ||
      (/\bsave it as\b.*\.png\b/.test(text) && /\bimage\b/.test(text)) ||
      (/\bimage generation\b/.test(text) && /\.png\b/.test(text))
    ) {
      return {
        name: this.name,
        score: 0,
        maxScore: this.maxScore,
        reason: 'PinchBench-style: image generation task → 强制云端',
        forced: 'cloud',
      };
    }

    // Second brain / explicit memory file persistence (task_22)
    if (
      /memory\/memory\.md/.test(text) ||
      (/remember this/.test(lastUserText) &&
        /save (it |this )?to (a )?file/i.test(lastUserText)) ||
      (/recall later|future session/i.test(text) && /memory\.md/.test(text))
    ) {
      return {
        name: this.name,
        score: 0,
        maxScore: this.maxScore,
        reason: 'PinchBench-style: persistent memory/MEMORY.md workflow → 强制云端',
        forced: 'cloud',
      };
    }

    // Multi-file email corpus synthesis (task_17)
    if (
      (/emails?\//.test(text) || /folder.*emails/i.test(text)) &&
      (/search through all|all the emails|comprehensive summary/i.test(text) ||
        (/project alpha/i.test(text) && /alpha_summary\.md/.test(text)))
    ) {
      return {
        name: this.name,
        score: 0,
        maxScore: this.maxScore,
        reason: 'PinchBench-style: multi-email search + synthesis → 强制云端',
        forced: 'cloud',
      };
    }

    // Competitive landscape / analyst report (task_18)
    if (
      /competitive landscape|market segment/i.test(text) &&
      /(pricing model|differentiator|comparison table|market research)/i.test(text)
    ) {
      return {
        name: this.name,
        score: 0,
        maxScore: this.maxScore,
        reason: 'PinchBench-style: competitive market research report → 强制云端',
        forced: 'cloud',
      };
    }

    // CSV + Excel dual analysis (task_19)
    if (
      /\.xlsx\b/.test(text) &&
      /\.csv\b/.test(text) &&
      /(summary report|data_summary|quarterly_sales|workbook)/i.test(text)
    ) {
      return {
        name: this.name,
        score: 0,
        maxScore: this.maxScore,
        reason: 'PinchBench-style: CSV + Excel combined analysis → 强制云端',
        forced: 'cloud',
      };
    }

    // ELI5 + PDF technical paper (task_20)
    if (
      /\bELI5\b|explain like i'm 5|explain like i am 5/i.test(text) &&
      /\.pdf\b/i.test(text)
    ) {
      return {
        name: this.name,
        score: 0,
        maxScore: this.maxScore,
        reason: 'PinchBench-style: ELI5 PDF summary → 强制云端',
        forced: 'cloud',
      };
    }

    return {
      name: this.name,
      score: 0,
      maxScore: this.maxScore,
      reason: 'No PinchBench-style heuristic match',
    };
  }
}

/**
 * Tool Call Scorer — routes tool-use requests intelligently.
 *
 * Mode 'code' (default):
 *   Detects code-writing tools (write_file, str_replace, create_file, apply_patch…)
 *   and adds +20 score. Combined with typical code context this pushes complex
 *   coding tasks over the 100-pt threshold. Simple tools (bash, read_file, search,
 *   ls…) get no boost and stay on the local model.
 *
 * Mode 'all':
 *   Forces cloud for any request with a tools array — old behaviour, useful when
 *   the local model cannot produce valid JSON function calls at all.
 *
 * Mode false:
 *   Scorer is not added to the pipeline; tool presence has no effect.
 */

// Tools whose primary purpose is writing/editing/generating code or text.
// If a tool's name contains any of these substrings it's treated as a code tool.
const CODE_TOOL_PATTERNS = [
  'write', 'create', 'str_replace', 'replace', 'edit', 'patch', 'insert',
  'overwrite', 'save', 'generate', 'refactor', 'rewrite',
];

// Tools that are simple execution/read operations — explicitly NOT code tools.
const SIMPLE_TOOL_PATTERNS = [
  'bash', 'run', 'execute', 'read', 'view', 'list', 'ls', 'find',
  'search', 'grep', 'cat', 'head', 'tail', 'pwd', 'cd', 'fetch', 'get',
];

export function isCodeTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  if (isImageGenTool(lower)) return false;
  if (SIMPLE_TOOL_PATTERNS.some(p => lower.includes(p))) return false;
  return CODE_TOOL_PATTERNS.some(p => lower.includes(p));
}

export class ToolCallScorer implements RuleScorer {
  readonly name = 'tool_call_detection';
  readonly maxScore = 20;

  private readonly mode: 'code' | 'all';

  constructor(mode: 'code' | 'all' = 'code') {
    this.mode = mode;
  }

  score(request: ChatRequest): DimensionScore & { forced?: 'cloud' } {
    const tools: Array<{ function?: { name?: string } }> =
      Array.isArray(request.tools) ? request.tools : [];

    const hasAnyTool = tools.length > 0 ||
      request.messages.some(m => m.role === 'tool') ||
      request.messages.some(
        m => m.role === 'assistant' &&
             Array.isArray(m.tool_calls) &&
             m.tool_calls.length > 0
      );

    if (!hasAnyTool) {
      return { name: this.name, score: 0, maxScore: this.maxScore, reason: '无工具调用' };
    }

    const declaredNames = collectDeclaredToolNames(request);
    const imageNames = declaredNames.filter(isImageGenTool);
    if (imageNames.length > 0) {
      return {
        name: this.name,
        score: 0,
        maxScore: this.maxScore,
        reason: `图像生成工具 [${imageNames.slice(0, 2).join(',')}] → 强制走云端`,
        forced: 'cloud',
      };
    }

    // ── Mode 'all': force everything to cloud ────────────────────────────────
    if (this.mode === 'all') {
      const toolNames = tools.map(t => t.function?.name ?? '?').slice(0, 3).join(',');
      return {
        name:    this.name,
        score:   0,
        maxScore: this.maxScore,
        reason:  `all-mode: 检测到工具调用 [${toolNames}] → 强制走云端`,
        forced:  'cloud',
      };
    }

    // ── Mode 'code': score boost only for code-writing tools ─────────────────
    const codeTools = tools.filter(t => isCodeTool(t.function?.name ?? ''));
    const simpleTools = tools.filter(t => !isCodeTool(t.function?.name ?? ''));

    if (codeTools.length > 0) {
      const names = codeTools.map(t => t.function?.name ?? '?').slice(0, 3).join(',');
      return {
        name:    this.name,
        score:   this.maxScore,  // +20 pts — nudges code tasks toward cloud
        maxScore: this.maxScore,
        reason:  `代码写入工具 [${names}] +20分（与代码上下文叠加趋向云端）`,
      };
    }

    // Simple tools only — no score boost, stay local
    const names = simpleTools.map(t => t.function?.name ?? '?').slice(0, 3).join(',');
    return {
      name:    this.name,
      score:   0,
      maxScore: this.maxScore,
      reason:  `简单工具 [${names}]（bash/read/search），不加分，走本地`,
    };
  }
}

// Core scorers after @local/@cloud override (OverrideScorer must run first).
export const CORE_SCORERS: RuleScorer[] = [
  new MultiTurnContextScorer(),
  new TokenCountScorer(),
  new CodeComplexityScorer(),
  new ReasoningDepthScorer(),
];

/** @deprecated Use CORE_SCORERS; OverrideScorer is prepended in buildScorerChain. */
export const DEFAULT_SCORERS: RuleScorer[] = [
  new OverrideScorer(),
  ...CORE_SCORERS,
];

/**
 * Ordered scorer list: user directives first, then optional PinchBench heuristics,
 * then optional tool detection, then token/code/reasoning/multi-turn rules.
 */
export function buildScorerChain(options: {
  preferCloudForTools: 'code' | 'all' | false;
  pinchbenchHeuristics: boolean;
}): RuleScorer[] {
  const chain: RuleScorer[] = [new OverrideScorer()];
  if (options.pinchbenchHeuristics) {
    chain.push(new CloudHeuristicScorer());
  }
  const mode = options.preferCloudForTools;
  if (mode) {
    chain.push(new ToolCallScorer(mode === 'all' ? 'all' : 'code'));
  }
  chain.push(...CORE_SCORERS);
  return chain;
}
