/**
 * @aiping.cn/model_router — OpenClaw Plugin Entry Point (v1.3)
 *
 * Uses the real OpenClaw plugin API:
 *   - api.pluginConfig   → plugin's validated config (read-only)
 *   - api.registerHttpRoute() → proxy endpoint at /aiping/v1/chat/completions
 *   - api.registerCommand()   → CLI wizard command
 *
 * After install, configure OpenClaw to use the proxy as a model provider:
 *   openclaw run model_router:setup
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { PluginConfig } from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import { Router } from './router/router.js';
import { LocalAdapter } from './providers/local.js';
import { CloudAdapter } from './providers/cloud.js';
import { runSetupWizard } from './setup/wizard.js';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

// ──────────────────────────────────────────────────────────────────────────────
// Plugin entry point
// ──────────────────────────────────────────────────────────────────────────────

export default function register(api: OpenClawPluginAPI): void {
  const cfg = buildConfig(api.pluginConfig ?? {});

  // ── CLI setup command ────────────────────────────────────────────────────────
  api.registerCommand({
    name: 'model-router-setup',
    description: '运行 AIPing Model Router 中文配置向导',
    handler: async () => {
      const updated = await runSetupWizard(cfg);
      await savePluginConfig(api, updated);
    },
  });

  // ── HTTP proxy route for model routing ───────────────────────────────────────
  // Accessible at: http://localhost:<gateway-port>/api/plugins/model_router/aiping/v1/chat/completions
  api.registerHttpRoute({
    path: '/aiping/v1/chat/completions',
    auth: 'plugin',
    match: 'exact',
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders());
        res.end();
        return true;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }
      try {
        const body = await readBody(req);
        const chatReq = JSON.parse(body);

        // Re-read config on every request so hot-changes work
        const liveCfg = buildConfig(api.pluginConfig ?? {});
        const router = new Router(liveCfg);
        const decision = router.decide(chatReq);

        const isStream = chatReq.stream === true;
        const adapter =
          decision.target === 'local'
            ? new LocalAdapter(liveCfg)
            : new CloudAdapter(liveCfg);

        if (isStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            ...corsHeaders(),
          });
          try {
            for await (const chunk of (decision.target === 'local'
              ? new LocalAdapter(liveCfg)
              : new CloudAdapter(liveCfg)).chatStream(chatReq)) {
              res.write(chunk);
            }
          } catch (streamErr) {
            if (liveCfg.fallbackToCloud && decision.target === 'local') {
              for await (const chunk of new CloudAdapter(liveCfg).chatStream(chatReq)) {
                res.write(chunk);
              }
            } else {
              throw streamErr;
            }
          }
          res.end();
        } else {
          let response;
          try {
            response = await adapter.chat(chatReq);
          } catch (chatErr) {
            if (liveCfg.fallbackToCloud && decision.target === 'local') {
              response = await new CloudAdapter(liveCfg).chat(chatReq);
            } else {
              throw chatErr;
            }
          }
          const json = JSON.stringify(response);
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(json),
            ...corsHeaders(),
          });
          res.end(json);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message, type: 'router_error' } }));
        }
      }
      return true;
    },
  });

  // ── Health check route ───────────────────────────────────────────────────────
  api.registerHttpRoute({
    path: '/aiping/health',
    auth: 'plugin',
    match: 'exact',
    handler: async (_req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      const liveCfg = buildConfig(api.pluginConfig ?? {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        plugin: '@aiping.cn/model_router',
        version: '1.3.0',
        localModel: liveCfg.localModel,
        cloudModel: liveCfg.cloudModel,
        routingThreshold: liveCfg.routingThreshold,
        proxyUrl: '/api/plugins/model_router/aiping/v1/chat/completions',
      }));
      return true;
    },
  });

  // ── First-run warning ────────────────────────────────────────────────────────
  if (!cfg.aipingApiKey) {
    api.logger.warn(
      '[model_router] AIPing API Key 未配置。运行以下命令完成设置：\n' +
      '  openclaw run model-router-setup'
    );
  } else {
    api.logger.info(
      `[model_router] 已就绪。代理端点：/api/plugins/model_router/aiping/v1/chat/completions` +
      ` | 本地=${cfg.localModel} | 云端=${cfg.cloudModel} | 阈值=${cfg.routingThreshold}`
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function buildConfig(raw: Record<string, unknown>): PluginConfig {
  return {
    aipingApiKey:     (raw['aipingApiKey'] as string)  ?? '',
    localProxyUrl:    (raw['localProxyUrl'] as string)  ?? DEFAULT_CONFIG.localProxyUrl,
    localProxyKey:    (raw['localProxyKey'] as string)  ?? '',
    localModel:       (raw['localModel'] as string)     ?? DEFAULT_CONFIG.localModel,
    cloudModel:       (raw['cloudModel'] as string)     ?? DEFAULT_CONFIG.cloudModel,
    routingThreshold: typeof raw['routingThreshold'] === 'number' ? raw['routingThreshold'] : DEFAULT_CONFIG.routingThreshold,
    fallbackToCloud:  typeof raw['fallbackToCloud']  === 'boolean' ? raw['fallbackToCloud']  : DEFAULT_CONFIG.fallbackToCloud,
    localTimeoutMs:   typeof raw['localTimeoutMs']   === 'number' ? raw['localTimeoutMs']   : DEFAULT_CONFIG.localTimeoutMs,
    debugRouting:     typeof raw['debugRouting']     === 'boolean' ? raw['debugRouting']     : DEFAULT_CONFIG.debugRouting,
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

/** Write updated plugin config back to openclaw.json */
async function savePluginConfig(
  api: OpenClawPluginAPI,
  updated: PluginConfig
): Promise<void> {
  const candidates = [
    path.join(os.homedir(), '.openclaw', 'openclaw.json'),
    path.join(os.homedir(), '.config', 'openclaw', 'openclaw.json'),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
      const plugins = (cfg['plugins'] as Record<string, unknown>) ?? {};
      const entries = (plugins['entries'] as Record<string, unknown>) ?? {};
      const entry = (entries[api.id] as Record<string, unknown>) ?? {};
      entry['config'] = updated;
      entries[api.id] = entry;
      plugins['entries'] = entries;
      cfg['plugins'] = plugins;
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
      return;
    } catch { /* try next */ }
  }
  console.warn('[model_router] 无法自动保存配置，请手动运行：');
  console.warn(`  openclaw plugins config model_router set aipingApiKey "${updated.aipingApiKey}"`);
}

// ──────────────────────────────────────────────────────────────────────────────
// OpenClaw Plugin API types (real shape from 2026.3.11)
// ──────────────────────────────────────────────────────────────────────────────

interface PluginLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

interface OpenClawPluginAPI {
  id: string;
  name: string;
  version: string;
  description: string;
  source: string;
  config: Record<string, unknown>;        // full OpenClaw config (read-only)
  pluginConfig: Record<string, unknown>;  // this plugin's validated config
  runtime: unknown;
  logger: PluginLogger;

  registerTool(tool: unknown, opts?: unknown): void;
  registerHook(events: unknown, handler: unknown, opts?: unknown): void;
  registerHttpRoute(params: {
    path: string;
    auth: 'gateway' | 'plugin';
    match?: 'exact' | 'prefix';
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void>;
  }): void;
  registerChannel(registration: unknown): void;
  registerProvider(provider: unknown): void;
  registerGatewayMethod(method: string, handler: unknown): void;
  registerCli(registrar: unknown, opts?: unknown): void;
  registerService(service: unknown): void;
  registerCommand(command: {
    name: string;
    description: string;
    handler(...args: unknown[]): Promise<void>;
  }): void;
  registerContextEngine(id: string, factory: unknown): void;
  resolvePath(input: string): string;
  on(hookName: string, handler: unknown, opts?: unknown): void;
}
