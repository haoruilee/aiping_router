import { CloudAdapterError } from '../providers/cloud.js';
import { LocalAdapterError } from '../providers/local.js';
import type { ChatResponse } from '../types.js';

export type ObservableFailureType =
  | 'empty_output'
  | 'invalid_response'
  | 'timeout'
  | 'network_error'
  | 'rate_limit'
  | 'auth_error'
  | 'api_error'
  | 'unknown_error';

/** Assistant response failures escalate to cloud without a second local attempt. */
export type RecoveryStrategy = 'cloud';

export interface FallbackDecision {
  failureType: ObservableFailureType;
  recovery: RecoveryStrategy;
  detail: string;
}

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

export function classifyAssistantChatResponse(data: unknown): FallbackDecision | null {
  const resp = asChatResponse(data);
  if (!resp) {
    return {
      failureType: 'invalid_response',
      recovery: 'cloud',
      detail: 'response is not a valid OpenAI chat payload',
    };
  }

  if (resp.choices.length === 0) {
    return {
      failureType: 'invalid_response',
      recovery: 'cloud',
      detail: 'response contains no choices',
    };
  }

  const choice = resp.choices[0];
  if (!choice?.message) {
    return {
      failureType: 'invalid_response',
      recovery: 'cloud',
      detail: 'response choice is missing assistant message',
    };
  }

  if (isEmptyAssistantChatResponse(resp)) {
    return {
      failureType: 'empty_output',
      recovery: 'cloud',
      detail: 'assistant produced no text, no tool calls, and no completion tokens',
    };
  }

  return null;
}

export function classifyObservableError(error: unknown): FallbackDecision {
  const detail = error instanceof Error ? error.message : String(error);
  const lowered = detail.toLowerCase();
  const statusCode = (
    error instanceof LocalAdapterError ||
    error instanceof CloudAdapterError
  ) ? error.statusCode : undefined;

  if (
    (error instanceof Error && error.name === 'AbortError') ||
    lowered.includes('timed out') ||
    statusCode === 408
  ) {
    return { failureType: 'timeout', recovery: 'cloud', detail };
  }

  if (statusCode === 401 || statusCode === 403 || lowered.includes('invalid api key')) {
    return { failureType: 'auth_error', recovery: 'cloud', detail };
  }

  if (statusCode === 429 || lowered.includes('rate limit')) {
    return { failureType: 'rate_limit', recovery: 'cloud', detail };
  }

  if (
    lowered.includes('fetch failed') ||
    lowered.includes('network') ||
    lowered.includes('econnrefused') ||
    lowered.includes('enotfound') ||
    lowered.includes('socket') ||
    lowered.includes('empty response body')
  ) {
    return { failureType: 'network_error', recovery: 'cloud', detail };
  }

  if (typeof statusCode === 'number' && statusCode >= 400) {
    return { failureType: 'api_error', recovery: 'cloud', detail };
  }

  return { failureType: 'unknown_error', recovery: 'cloud', detail };
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
