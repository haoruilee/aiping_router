/**
 * @aiping.cn/model_router — OpenClaw Plugin Entry Point (v1.4)
 *
 * Real OpenClaw 2026.3.11 plugin API:
 *   - api.pluginConfig          → plugin's validated config (read-only snapshot)
 *   - api.registerHttpRoute()   → proxy at /aiping/v1/chat/completions
 *   - api.registerCli()         → adds `openclaw model-router-setup` terminal command
 *
 * Setup flow:
 *   1. openclaw plugins install @aiping.cn/model_router
 *   2. openclaw model-router-setup       ← interactive wizard (stdin/stdout)
 *   3. openclaw gateway --restart        ← reload with new config
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
// Plugin entry point — called synchronously when the plugin is loaded
// ──────────────────────────────────────────────────────────────────────────────

export default function register(api: OpenClawPluginAPI): void {
  const cfg = buildConfig(api.pluginConfig ?? {});

  // ── Register `openclaw model-router-setup` CLI command ───────────────────────
  // registerCli adds real top-level commands to the `openclaw` CLI via Commander.
  // The registrar function receives { program } and attaches subcommands.
  api.registerCli(
    ({ program }: { program: CommanderProgram }) => {
      program
        .command('model-router-setup')
        .description('配置 AIPing Model Router（中文向导 / one-liner flags）')
        .option('--aiping-api-key <key>',      'AIPing API Key（跳过交互式提问）')
        .option('--local-model <model>',       '本地模型名称', 'qwen2.5:4b')
        .option('--local-proxy-url <url>',     '本地 Ollama 地址', 'http://localhost:11434')
        .option('--local-proxy-key <key>',     '本地代理鉴权 Key（可选）')
        .option('--cloud-model <model>',       '云端模型名称', 'Kimi-K2.5')
        .option('--routing-threshold <n>',     '路由阈值 0-100（越高越偏本地）', '85')
        .option('--no-fallback',               '禁用本地失败时自动切换到云端')
        .action(async (opts: unknown) => {
          const o = opts as SetupOptions;
          if (o.aipingApiKey) {
            // ── Non-interactive: apply flags directly ─────────────────────
            const config: PluginConfig = {
              aipingApiKey:     o.aipingApiKey,
              localProxyUrl:    o.localProxyUrl    ?? DEFAULT_CONFIG.localProxyUrl,
              localProxyKey:    o.localProxyKey    ?? '',
              localModel:       o.localModel       ?? DEFAULT_CONFIG.localModel,
              cloudModel:       o.cloudModel       ?? DEFAULT_CONFIG.cloudModel,
              routingThreshold: parseInt(o.routingThreshold ?? '85', 10) || DEFAULT_CONFIG.routingThreshold,
              fallbackToCloud:  o.fallback         ?? DEFAULT_CONFIG.fallbackToCloud,
              localTimeoutMs:   DEFAULT_CONFIG.localTimeoutMs,
              debugRouting:     DEFAULT_CONFIG.debugRouting,
            };
            const saved = writePluginConfigToFile(api.id, config);
            if (saved) {
              console.log(`\n✅ 配置已保存！`);
              console.log(`   本地模型: ${config.localModel} → ${config.localProxyUrl}`);
              console.log(`   云端模型: ${config.cloudModel}`);
              console.log(`   路由阈值: ${config.routingThreshold}`);
              console.log(`\n   重启 gateway 生效: openclaw gateway --restart\n`);
            } else {
              console.error('\n❌ 无法写入配置文件，请手动配置。\n');
              process.exit(1);
            }
          } else {
            // ── Interactive: run full Chinese wizard ──────────────────────
            const current = buildConfig(readPluginConfigFromFile(api.id) ?? api.pluginConfig ?? {});
            const updated = await runSetupWizard(current);
            const saved = writePluginConfigToFile(api.id, updated);
            if (saved) {
              console.log('\n✅ 配置已保存。重启 gateway 生效：openclaw gateway --restart\n');
            } else {
              console.log('\n⚠️  请手动设置 API Key：');
              console.log(`  openclaw plugins config model_router set aipingApiKey "${updated.aipingApiKey}"\n`);
            }
          }
        });
    },
    { commands: ['model-router-setup'] }
  );

  // ── HTTP proxy: /aiping/v1/chat/completions ──────────────────────────────────
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

        // Always re-read from disk so config changes take effect without gateway restart
        const liveCfg = buildConfig(readPluginConfigFromFile(api.id) ?? api.pluginConfig ?? {});
        const router = new Router(liveCfg);
        const decision = router.decide(chatReq);

        if (chatReq.stream === true) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            ...corsHeaders(),
          });
          await pipeStream(decision.target, liveCfg, chatReq, res);
          res.end();
        } else {
          const response = await fetchChat(decision.target, liveCfg, chatReq);
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
        api.logger.warn(`[model_router] request error: ${message}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message, type: 'router_error' } }));
        }
      }
      return true;
    },
  });

  // ── Health / status endpoint ─────────────────────────────────────────────────
  api.registerHttpRoute({
    path: '/aiping/health',
    auth: 'plugin',
    match: 'exact',
    handler: async (_req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
      const liveCfg = buildConfig(readPluginConfigFromFile(api.id) ?? api.pluginConfig ?? {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        plugin: '@aiping.cn/model_router',
        version: '1.4.0',
        configured: Boolean(liveCfg.aipingApiKey),
        localModel: liveCfg.localModel,
        cloudModel: liveCfg.cloudModel,
        routingThreshold: liveCfg.routingThreshold,
        proxyEndpoint: '/aiping/v1/chat/completions',
      }));
      return true;
    },
  });

  // ── Startup log ──────────────────────────────────────────────────────────────
  if (!cfg.aipingApiKey) {
    api.logger.warn(
      '[model_router] 尚未配置 AIPing API Key。\n' +
      '  ➜  运行配置向导：openclaw model-router-setup'
    );
  } else {
    api.logger.info(
      `[model_router] ✅ 就绪 | 本地=${cfg.localModel} | 云端=${cfg.cloudModel}` +
      ` | 阈值=${cfg.routingThreshold} | 代理=/aiping/v1/chat/completions`
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Routing helpers
// ──────────────────────────────────────────────────────────────────────────────

async function fetchChat(
  target: 'local' | 'cloud',
  cfg: PluginConfig,
  req: unknown
): Promise<unknown> {
  const local = new LocalAdapter(cfg);
  const cloud = new CloudAdapter(cfg);
  if (target === 'local') {
    try {
      return await local.chat(req as Parameters<typeof local.chat>[0]);
    } catch (e) {
      if (cfg.fallbackToCloud) {
        return cloud.chat(req as Parameters<typeof cloud.chat>[0]);
      }
      throw e;
    }
  }
  try {
    return await cloud.chat(req as Parameters<typeof cloud.chat>[0]);
  } catch (e) {
    if (cfg.fallbackToCloud) {
      return local.chat(req as Parameters<typeof local.chat>[0]);
    }
    throw e;
  }
}

async function pipeStream(
  target: 'local' | 'cloud',
  cfg: PluginConfig,
  req: unknown,
  res: ServerResponse
): Promise<void> {
  const local = new LocalAdapter(cfg);
  const cloud = new CloudAdapter(cfg);
  const r = req as Parameters<typeof local.chatStream>[0];
  if (target === 'local') {
    try {
      for await (const chunk of local.chatStream(r)) res.write(chunk);
      return;
    } catch (e) {
      if (cfg.fallbackToCloud) {
        for await (const chunk of cloud.chatStream(r)) res.write(chunk);
        return;
      }
      throw e;
    }
  }
  for await (const chunk of cloud.chatStream(r)) res.write(chunk);
}

// ──────────────────────────────────────────────────────────────────────────────
// Config persistence helpers
// ──────────────────────────────────────────────────────────────────────────────

function buildConfig(raw: Record<string, unknown>): PluginConfig {
  return {
    aipingApiKey:     (raw['aipingApiKey']    as string)  ?? '',
    localProxyUrl:    (raw['localProxyUrl']   as string)  ?? DEFAULT_CONFIG.localProxyUrl,
    localProxyKey:    (raw['localProxyKey']   as string)  ?? '',
    localModel:       (raw['localModel']      as string)  ?? DEFAULT_CONFIG.localModel,
    cloudModel:       (raw['cloudModel']      as string)  ?? DEFAULT_CONFIG.cloudModel,
    routingThreshold: typeof raw['routingThreshold'] === 'number' ? raw['routingThreshold'] : DEFAULT_CONFIG.routingThreshold,
    fallbackToCloud:  typeof raw['fallbackToCloud']  === 'boolean' ? raw['fallbackToCloud']  : DEFAULT_CONFIG.fallbackToCloud,
    localTimeoutMs:   typeof raw['localTimeoutMs']   === 'number' ? raw['localTimeoutMs']   : DEFAULT_CONFIG.localTimeoutMs,
    debugRouting:     typeof raw['debugRouting']     === 'boolean' ? raw['debugRouting']     : DEFAULT_CONFIG.debugRouting,
  };
}

function resolveOpenClawConfigPath(): string | null {
  const candidates = [
    path.join(os.homedir(), '.openclaw', 'openclaw.json'),
    path.join(os.homedir(), '.config', 'openclaw', 'openclaw.json'),
  ];
  return candidates.find(p => fs.existsSync(p)) ?? null;
}

/** Read plugin config directly from openclaw.json (always fresh, not from plugin snapshot) */
function readPluginConfigFromFile(pluginId: string): Record<string, unknown> | null {
  try {
    const configPath = resolveOpenClawConfigPath();
    if (!configPath) return null;
    const root = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const entries = (root['plugins'] as Record<string, unknown>)?.['entries'] as Record<string, unknown>;
    const entry = entries?.[pluginId] as Record<string, unknown>;
    return (entry?.['config'] as Record<string, unknown>) ?? null;
  } catch {
    return null;
  }
}

/** Persist updated plugin config back to openclaw.json */
function writePluginConfigToFile(pluginId: string, updated: PluginConfig): boolean {
  try {
    const configPath = resolveOpenClawConfigPath();
    if (!configPath) return false;
    const root = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const plugins = (root['plugins'] as Record<string, unknown>) ?? {};
    const entries = (plugins['entries'] as Record<string, unknown>) ?? {};
    const entry = (entries[pluginId] as Record<string, unknown>) ?? {};
    entry['config'] = updated;
    entries[pluginId] = entry;
    plugins['entries'] = entries;
    root['plugins'] = plugins;
    fs.writeFileSync(configPath, JSON.stringify(root, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
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

// ──────────────────────────────────────────────────────────────────────────────
// OpenClaw Plugin API types (verified from source 2026.3.11)
// ──────────────────────────────────────────────────────────────────────────────

interface CommanderProgram {
  command(name: string): CommanderCommand;
}

interface CommanderCommand {
  description(desc: string): CommanderCommand;
  option(flags: string, desc?: string, defaultValue?: unknown): CommanderCommand;
  action(fn: (...args: unknown[]) => void | Promise<void>): CommanderCommand;
}

interface SetupOptions {
  aipingApiKey?:     string;
  localModel?:       string;
  localProxyUrl?:    string;
  localProxyKey?:    string;
  cloudModel?:       string;
  routingThreshold?: string;
  fallback?:         boolean;
}

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
  config: Record<string, unknown>;
  pluginConfig: Record<string, unknown>;
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
  registerCli(
    registrar: (params: { program: CommanderProgram; config: unknown; workspaceDir: string; logger: PluginLogger }) => void | Promise<void>,
    opts?: { commands?: string[] }
  ): void;
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
