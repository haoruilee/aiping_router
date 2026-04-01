import type { ChatRequest, ModelTask, PluginConfig } from '../types.js';

type LegacyContent = string | null | undefined;
type ContentPart = { type?: string; text?: string; image_url?: { url?: string } };

function toParts(content: unknown): ContentPart[] {
  if (typeof content === 'string') return [];
  if (Array.isArray(content)) return content as ContentPart[];
  return [];
}

function messageHasImage(request: ChatRequest): boolean {
  for (const m of request.messages) {
    const parts = toParts(m.content);
    for (const p of parts) {
      if (p.type === 'image_url' && p.image_url?.url) return true;
      if (p.type === 'image' && (p as { image_url?: { url?: string } }).image_url?.url) return true;
    }
  }
  return false;
}

/** Concatenate user-visible text for keyword detection. */
function extractUserFacingText(request: ChatRequest): string {
  return request.messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const c = m.content as unknown;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        return (c as ContentPart[])
          .map((part) => (typeof part?.text === 'string' ? part.text : ''))
          .join('\n');
      }
      return '';
    })
    .join('\n');
}

const TASK_DIRECTIVE =
  /@task\s*:\s*(text|vlm|image|video)\b|@(text|vlm|image|video)\b/i;

/**
 * Explicit @task:video / @video (and text / vlm / image) on the last user message.
 */
export function parseTaskDirective(request: ChatRequest): ModelTask | undefined {
  const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) return undefined;
  const text =
    typeof lastUser.content === 'string'
      ? lastUser.content
      : Array.isArray(lastUser.content)
        ? (lastUser.content as ContentPart[])
            .map((p) => (typeof p?.text === 'string' ? p.text : ''))
            .join('\n')
        : '';
  const m = text.match(TASK_DIRECTIVE);
  if (!m) return undefined;
  const tag = (m[1] || m[2] || '').toLowerCase();
  if (tag === 'text') return 'text';
  if (tag === 'image') return 'image';
  if (tag === 'video') return 'video';
  return 'vlm';
}

const VIDEO_PATTERNS = [
  /\btext-to-video\b/i,
  /\bt2v\b/i,
  /\bvideo\s*generation\b/i,
  /生视频/,
  /文生视频/,
  /生成.+视频|生成视频/,
  /做个视频/,
  /视频生成/,
];

const IMAGE_PATTERNS = [
  /\btext-to-image\b/i,
  /\bt2i\b/i,
  /\bimage\s*generation\b/i,
  /生图/,
  /文生图/,
  /生成(?:一张|一幅|个)?图/,
  /帮我画/,
  /画一张/,
  /画图(?!片)/,
];

/**
 * Infer task from content and structure (after directives).
 */
export function inferRouterTask(request: ChatRequest): ModelTask {
  if (messageHasImage(request)) return 'vlm';

  const text = extractUserFacingText(request);

  for (const re of VIDEO_PATTERNS) {
    if (re.test(text)) return 'video';
  }
  for (const re of IMAGE_PATTERNS) {
    if (re.test(text)) return 'image';
  }
  return 'text';
}

export function detectRouterTask(request: ChatRequest): ModelTask {
  return parseTaskDirective(request) ?? inferRouterTask(request);
}

export interface ResolvedRoutingModels {
  task: ModelTask;
  localModel: string;
  cloudModel: string;
}

/**
 * Pick concrete model ids for adapters given routing target is already chosen.
 */
export function resolveModelsForTask(cfg: PluginConfig, task: ModelTask): ResolvedRoutingModels {
  if (task === 'text') {
    return { task, localModel: cfg.localModel, cloudModel: cfg.cloudModel };
  }

  const cloud =
    task === 'image'
      ? cfg.cloudImageModel
      : task === 'video'
        ? cfg.cloudVideoModel
        : cfg.cloudVlmModel;

  const localSpecialized =
    task === 'image'
      ? cfg.localImageModel
      : task === 'video'
        ? cfg.localVideoModel
        : cfg.localVlmModel;

  const localModel =
    localSpecialized && localSpecialized.length > 0 ? localSpecialized : cfg.localModel;

  return { task, localModel, cloudModel: cloud };
}
