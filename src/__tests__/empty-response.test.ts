import { describe, it, expect } from 'vitest';
import {
  classifyAssistantChatResponse,
  classifyObservableError,
  isEmptyAssistantChatResponse,
  openAiSseChunkIsSubstantive,
  sseChunkIsDoneLine,
} from '../router/empty-response.js';
import { LocalAdapterError } from '../providers/local.js';
import type { ChatResponse } from '../types.js';

describe('isEmptyAssistantChatResponse', () => {
  it('empty message + zero completion → empty', () => {
    const r: ChatResponse = {
      id: '1',
      object: 'chat.completion',
      created: 0,
      model: 'x',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
    };
    expect(isEmptyAssistantChatResponse(r)).toBe(true);
  });

  it('whitespace-only content → empty', () => {
    const r: ChatResponse = {
      id: '1',
      object: 'chat.completion',
      created: 0,
      model: 'x',
      choices: [{ index: 0, message: { role: 'assistant', content: '  \n' }, finish_reason: 'stop' }],
    };
    expect(isEmptyAssistantChatResponse(r)).toBe(true);
  });

  it('non-empty text → not empty', () => {
    const r: ChatResponse = {
      id: '1',
      object: 'chat.completion',
      created: 0,
      model: 'x',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    };
    expect(isEmptyAssistantChatResponse(r)).toBe(false);
  });

  it('tool_calls only → not empty', () => {
    const r: ChatResponse = {
      id: '1',
      object: 'chat.completion',
      created: 0,
      model: 'x',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'bash', arguments: '{}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
    };
    expect(isEmptyAssistantChatResponse(r)).toBe(false);
  });

  it('no text but completion_tokens > 0 → not empty', () => {
    const r: ChatResponse = {
      id: '1',
      object: 'chat.completion',
      created: 0,
      model: 'x',
      choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
    };
    expect(isEmptyAssistantChatResponse(r)).toBe(false);
  });
});

describe('SSE substantive / done detection', () => {
  it('detects [DONE] line', () => {
    expect(sseChunkIsDoneLine('data: [DONE]\n\n')).toBe(true);
  });

  it('detects substantive content delta', () => {
    const chunk = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
    })}\n\n`;
    expect(openAiSseChunkIsSubstantive(chunk)).toBe(true);
  });

  it('detects substantive tool_calls delta', () => {
    const chunk = `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ id: '1', type: 'function', function: { name: 'x', arguments: '' } }] },
        },
      ],
    })}\n\n`;
    expect(openAiSseChunkIsSubstantive(chunk)).toBe(true);
  });

  it('empty delta → not substantive', () => {
    const chunk = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: null }],
    })}\n\n`;
    expect(openAiSseChunkIsSubstantive(chunk)).toBe(false);
  });
});

describe('classifyAssistantChatResponse', () => {
  it('returns cloud recovery for empty assistant output', () => {
    const r: ChatResponse = {
      id: '1',
      object: 'chat.completion',
      created: 0,
      model: 'x',
      choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
    };
    expect(classifyAssistantChatResponse(r)).toMatchObject({
      failureType: 'empty_output',
      recovery: 'cloud',
    });
  });

  it('returns cloud recovery for structurally invalid payloads', () => {
    expect(classifyAssistantChatResponse({ choices: [] })).toMatchObject({
      failureType: 'invalid_response',
      recovery: 'cloud',
    });
  });

  it('returns null for a usable assistant reply', () => {
    const r: ChatResponse = {
      id: '1',
      object: 'chat.completion',
      created: 0,
      model: 'x',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    };
    expect(classifyAssistantChatResponse(r)).toBeNull();
  });
});

describe('classifyObservableError', () => {
  it('maps timeout errors to cloud recovery', () => {
    const err = new LocalAdapterError('Local model timed out after 1000ms', 408);
    expect(classifyObservableError(err)).toMatchObject({
      failureType: 'timeout',
      recovery: 'cloud',
    });
  });

  it('maps network-like errors to cloud recovery', () => {
    expect(classifyObservableError(new Error('fetch failed: ECONNREFUSED 127.0.0.1'))).toMatchObject({
      failureType: 'network_error',
      recovery: 'cloud',
    });
  });

  it('maps HTTP failures to cloud recovery', () => {
    const err = new LocalAdapterError('Local model returned 500: upstream error', 500);
    expect(classifyObservableError(err)).toMatchObject({
      failureType: 'api_error',
      recovery: 'cloud',
    });
  });
});
