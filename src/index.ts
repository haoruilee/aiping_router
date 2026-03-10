/**
 * @aiping/model_router — OpenClaw Plugin Entry Point
 *
 * Registers the "aiping:claw" virtual model with the OpenClaw Gateway
 * and routes incoming requests to either a local Ollama model or the
 * AIPing cloud API based on a lightweight 5-dimension rule scorer.
 *
 * 默认策略：约 90% 请求走本地模型，只有复杂任务走云端。
 */

import type { ChatRequest, ChatResponse, PluginConfig } from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import { Router } from './router/router.js';
import { LocalAdapter, LocalAdapterError } from './providers/local.js';
import { CloudAdapter } from './providers/cloud.js';
import { runSetupWizard } from './setup/wizard.js';

// ──────────────────────────────────────────────────────────────────────────────
// OpenClaw plugin API surface (api object injected by the Gateway at load time)
// ──────────────────────────────────────────────────────────────────────────────

export default function register(api: OpenClawPluginAPI): void {
  let config: PluginConfig = buildConfig(api.getConfig());

  // Re-build config whenever it changes (live reload support)
  api.onConfigChange((newConfig: Record<string, unknown>) => {
    config = buildConfig(newConfig);
  });

  // ── 注册 CLI 命令：重新运行配置向导 ─────────────────────────────────────
  api.registerCommand({
    name: 'aiping:setup',
    description: '运行 AIPing Model Router 中文配置向导',
    async run() {
      const updated = await runSetupWizard(config);
      await api.setConfig(updated as unknown as Record<string, unknown>);
      config = updated;
    },
  });

  // ── 首次安装：自动触发中文配置向导 ─────────────────────────────────────
  // 如果 aipingApiKey 还没配置，说明是首次安装，自动启动向导。
  if (!config.aipingApiKey) {
    runSetupWizard(config)
      .then(async (updated) => {
        await api.setConfig(updated as unknown as Record<string, unknown>);
        config = updated;
      })
      .catch((wizardErr: Error) => {
        console.warn(
          '[aiping:router] 配置向导退出，稍后可运行 `openclaw run aiping:setup` 重新配置。',
          wizardErr.message
        );
      });
  }

  // ── 注册虚拟模型 aiping:claw ─────────────────────────────────────────────
  api.registerModelRoute({
    model: 'aiping:claw',
    description:
      'AIPing 智能路由 — 自动在本地模型和云端 Kimi-2.5 之间切换（约 90% 走本地）',

    async chat(request: ChatRequest): Promise<ChatResponse> {
      return handleChat(request, config);
    },

    async *chatStream(request: ChatRequest): AsyncGenerator<string> {
      yield* handleChatStream(request, config);
    },
  });

  // ── 注册为默认模型 ────────────────────────────────────────────────────────
  // 尝试通过 Gateway API 设置默认模型（若 API 可用）
  if (typeof api.setDefaultModel === 'function') {
    api.setDefaultModel('aiping:claw').catch(() => {
      // 静默失败：向导内已提供手动设置方式
    });
  }

  console.log(
    '[aiping:router] ✅ 已注册虚拟模型 "aiping:claw"' +
      ` | 阈值=${config.routingThreshold} | 本地=${config.localModel}` +
      (config.debugRouting ? ' | 路由调试开启' : '')
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Core request handlers
// ──────────────────────────────────────────────────────────────────────────────

async function handleChat(
  request: ChatRequest,
  config: PluginConfig
): Promise<ChatResponse> {
  const router = new Router(config);
  const local = new LocalAdapter(config);
  const cloud = new CloudAdapter(config);

  const decision = router.decide(request);

  if (decision.target === 'local') {
    try {
      return await local.chat(request);
    } catch (err) {
      if (config.fallbackToCloud) {
        console.warn(
          `[aiping:router] Local failed (${(err as Error).message}), falling back to cloud`
        );
        return cloud.chat(request);
      }
      throw err;
    }
  }

  // Cloud path: no fallback needed (cloud errors surface directly)
  try {
    return await cloud.chat(request);
  } catch (err) {
    // If cloud fails and fallback is enabled, try local as last resort
    if (config.fallbackToCloud && !(err instanceof LocalAdapterError)) {
      console.warn(
        `[aiping:router] Cloud failed (${(err as Error).message}), trying local as fallback`
      );
      return local.chat(request);
    }
    throw err;
  }
}

async function* handleChatStream(
  request: ChatRequest,
  config: PluginConfig
): AsyncGenerator<string> {
  const router = new Router(config);
  const local = new LocalAdapter(config);
  const cloud = new CloudAdapter(config);

  const decision = router.decide(request);

  if (decision.target === 'local') {
    try {
      yield* local.chatStream(request);
      return;
    } catch (err) {
      if (config.fallbackToCloud) {
        console.warn(
          `[aiping:router] Local stream failed (${(err as Error).message}), falling back to cloud`
        );
        yield* cloud.chatStream(request);
        return;
      }
      throw err;
    }
  }

  yield* cloud.chatStream(request);
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function buildConfig(raw: Record<string, unknown>): PluginConfig {
  return {
    aipingApiKey: (raw['aipingApiKey'] as string) ?? '',
    localProxyUrl:
      (raw['localProxyUrl'] as string) ?? DEFAULT_CONFIG.localProxyUrl,
    localProxyKey: (raw['localProxyKey'] as string) ?? '',
    localModel: (raw['localModel'] as string) ?? DEFAULT_CONFIG.localModel,
    cloudModel: (raw['cloudModel'] as string) ?? DEFAULT_CONFIG.cloudModel,
    routingThreshold:
      typeof raw['routingThreshold'] === 'number'
        ? raw['routingThreshold']
        : DEFAULT_CONFIG.routingThreshold,
    fallbackToCloud:
      typeof raw['fallbackToCloud'] === 'boolean'
        ? raw['fallbackToCloud']
        : DEFAULT_CONFIG.fallbackToCloud,
    localTimeoutMs:
      typeof raw['localTimeoutMs'] === 'number'
        ? raw['localTimeoutMs']
        : DEFAULT_CONFIG.localTimeoutMs,
    debugRouting:
      typeof raw['debugRouting'] === 'boolean'
        ? raw['debugRouting']
        : DEFAULT_CONFIG.debugRouting,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// OpenClaw Plugin API type stubs
// These will be provided by the OpenClaw Gateway at runtime.
// ──────────────────────────────────────────────────────────────────────────────

interface OpenClawPluginAPI {
  getConfig(): Record<string, unknown>;
  setConfig(config: Record<string, unknown>): Promise<void>;
  onConfigChange(callback: (config: Record<string, unknown>) => void): void;
  registerCommand(cmd: {
    name: string;
    description: string;
    run(): Promise<void>;
  }): void;
  registerModelRoute(route: {
    model: string;
    description: string;
    chat(request: ChatRequest): Promise<ChatResponse>;
    chatStream(request: ChatRequest): AsyncGenerator<string>;
  }): void;
  /** Optional: set the Gateway's default model (available in OpenClaw Gateway ≥ 1.x) */
  setDefaultModel?(model: string): Promise<void>;
}
