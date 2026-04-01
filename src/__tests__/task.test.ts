import { describe, it, expect } from 'vitest';
import {
  parseTaskDirective,
  inferRouterTask,
  detectRouterTask,
  resolveModelsForTask,
} from '../router/task.js';
import type { ChatRequest, PluginConfig } from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';

const baseCfg: PluginConfig = {
  ...DEFAULT_CONFIG,
  aipingApiKey: 'k',
  localModel: 'qwen2.5:4b',
  cloudModel: 'Kimi-K2.5',
};

function userMsg(content: string | unknown[]): ChatRequest {
  return {
    model: 'aiping:claw',
    messages: [{ role: 'user', content: content as never }],
  };
}

describe('parseTaskDirective', () => {
  it('parses @task:image', () => {
    expect(parseTaskDirective(userMsg('hello @task:image'))).toBe('image');
  });
  it('parses @video', () => {
    expect(parseTaskDirective(userMsg('@video 做个短片'))).toBe('video');
  });
  it('parses @text for chat bucket', () => {
    expect(parseTaskDirective(userMsg('普通聊天 @text'))).toBe('text');
  });
  it('returns undefined when absent', () => {
    expect(parseTaskDirective(userMsg('仅文本'))).toBeUndefined();
  });
});

describe('inferRouterTask', () => {
  it('uses text for plain message', () => {
    expect(inferRouterTask(userMsg('你好'))).toBe('text');
  });
  it('detects 生图', () => {
    expect(inferRouterTask(userMsg('帮我画一只猫'))).toBe('image');
  });
  it('detects 生视频', () => {
    expect(inferRouterTask(userMsg('生成一段日落视频'))).toBe('video');
  });
  it('vlm when image parts present', () => {
    const req: ChatRequest = {
      model: 'aiping:claw',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '这是什么' },
            { type: 'image_url', image_url: { url: 'https://x/p.png' } },
          ],
        },
      ],
    };
    expect(inferRouterTask(req)).toBe('vlm');
  });
});

describe('detectRouterTask', () => {
  it('directive wins over inference', () => {
    const req = userMsg('生视频需求 @task:image');
    expect(detectRouterTask(req)).toBe('image');
  });
});

describe('resolveModelsForTask', () => {
  it('text uses cloudModel and localModel', () => {
    const r = resolveModelsForTask(baseCfg, 'text');
    expect(r).toEqual({
      task: 'text',
      localModel: 'qwen2.5:4b',
      cloudModel: 'Kimi-K2.5',
    });
  });
  it('vlm uses cloudVlmModel and optional localVlm', () => {
    const r = resolveModelsForTask(
      { ...baseCfg, localVlmModel: 'llava', cloudVlmModel: 'Doubao-Seed-2.0-pro' },
      'vlm'
    );
    expect(r.cloudModel).toBe('Doubao-Seed-2.0-pro');
    expect(r.localModel).toBe('llava');
  });
  it('vlm falls back to localModel when localVlm empty', () => {
    const r = resolveModelsForTask(baseCfg, 'vlm');
    expect(r.localModel).toBe('qwen2.5:4b');
    expect(r.cloudModel).toBe(DEFAULT_CONFIG.cloudVlmModel);
  });
  it('image uses cloudImageModel', () => {
    const r = resolveModelsForTask(baseCfg, 'image');
    expect(r.cloudModel).toBe(DEFAULT_CONFIG.cloudImageModel);
  });
});
