import type { ChatResponse } from '../types.js';

function asChatResponse(data: unknown): ChatResponse | null {
  if (!data || typeof data !== 'object') return null;
  const o = data as ChatResponse;
  if (!Array.isArray(o.choices)) return null;
  return o;
}

/**
 * True when the assistant produced no usable output: no trimmed text, no tool calls,
 * and (when usage is present) zero completion tokens — typical “out=0 / tps=0” failures
 * after a successful HTTP response from local Ollama.
 */
export function isEmptyAssistantChatResponse(data: unknown): boolean {
  const resp = asChatResponse(data);
  if (!resp) return true;

  const choice = resp.choices[0];
  if (!choice?.message) return true;

  const msg = choice.message;
  const content = typeof msg.content === 'string' ? msg.content.trim() : '';
  const tools = msg.tool_calls;
  const hasTools = Array.isArray(tools) && tools.length > 0;
  if (hasTools) return false;
  if (content.length > 0) return false;

  const completionTok = resp.usage?.completion_tokens;
  if (typeof completionTok === 'number' && completionTok > 0) return false;

  return true;
}

/** SSE chunk from our LocalAdapter: lines like `data: {...}\\n\\n` or `data: [DONE]`. */
export function openAiSseChunkIsSubstantive(sseChunk: string): boolean {
  const lines = sseChunk.split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload) as {
        choices?: Array<{
          delta?: { content?: string; tool_calls?: unknown[] };
        }>;
      };
      const delta = obj.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content.trim().length > 0) return true;
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function sseChunkIsDoneLine(sseChunk: string): boolean {
  return sseChunk.includes('data: [DONE]');
}
