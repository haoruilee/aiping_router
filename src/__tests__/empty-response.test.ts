import { describe, it, expect } from 'vitest';
import {
  isEmptyAssistantChatResponse,
  openAiSseChunkIsSubstantive,
  sseChunkIsDoneLine,
} from '../router/empty-response.js';
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
