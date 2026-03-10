import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { PluginConfig } from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';
import { LocalAdapter } from '../providers/local.js';
import { CloudAdapter } from '../providers/cloud.js';

interface PartialConfig extends Partial<PluginConfig> {
  aipingApiKey?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Terminal colour helpers (graceful degradation if TTY not available)
// ──────────────────────────────────────────────────────────────────────────────
const isTTY = process.stdout.isTTY ?? false;
const c = {
  bold:  (s: string) => isTTY ? `\x1b[1m${s}\x1b[0m`  : s,
  green: (s: string) => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  yellow:(s: string) => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
  cyan:  (s: string) => isTTY ? `\x1b[36m${s}\x1b[0m` : s,
  red:   (s: string) => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
  dim:   (s: string) => isTTY ? `\x1b[2m${s}\x1b[0m`  : s,
};

function hr() { console.log(c.dim('─'.repeat(56))); }
function blank() { console.log(''); }
function tip(text: string) { console.log(c.dim(`  💡 ${text}`)); }
function warn(text: string) { console.log(c.yellow(`  ⚠️  ${text}`)); }
function ok(text: string)   { console.log(c.green(`  ✅ ${text}`)); }
function err(text: string)  { console.log(c.red(`  ❌ ${text}`)); }
function info(text: string) { console.log(`  ${text}`); }

// ──────────────────────────────────────────────────────────────────────────────
// Attempt to set the default model in OpenClaw's config file
// ──────────────────────────────────────────────────────────────────────────────
async function trySetDefaultModel(): Promise<boolean> {
  const candidates = [
    path.join(os.homedir(), '.openclaw', 'config.json'),
    path.join(os.homedir(), '.config', 'openclaw', 'config.json'),
  ];

  for (const configPath of candidates) {
    try {
      if (!fs.existsSync(configPath)) continue;

      const raw = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(raw) as Record<string, unknown>;
      config['defaultModel'] = 'aiping:claw';
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
      return true;
    } catch {
      // Try next candidate
    }
  }

  // Try to create the config file if neither exists
  const defaultPath = path.join(os.homedir(), '.openclaw', 'config.json');
  try {
    fs.mkdirSync(path.dirname(defaultPath), { recursive: true });
    const newConfig = { defaultModel: 'aiping:claw' };
    fs.writeFileSync(defaultPath, JSON.stringify(newConfig, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Main wizard
// ──────────────────────────────────────────────────────────────────────────────
export async function runSetupWizard(
  existingConfig: PartialConfig = {}
): Promise<PluginConfig> {
  const rl = readline.createInterface({ input, output });

  blank();
  console.log(c.bold('╔════════════════════════════════════════════════════════╗'));
  console.log(c.bold('║     🚀  AIPing Model Router  配置向导  v1.1           ║'));
  console.log(c.bold('║   智能路由：本地小模型 + 云端强模型，一键搞定          ║'));
  console.log(c.bold('╚════════════════════════════════════════════════════════╝'));
  blank();
  info('本向导将帮你完成以下配置：');
  info('  1. AIPing 云端 API Key（用于调用 Kimi-2.5 等云端模型）');
  info('  2. 本地模型代理（Ollama 或其他兼容接口）');
  info('  3. 路由策略（什么时候走本地，什么时候走云端）');
  info('  4. 将 aiping:claw 设为 OpenClaw 默认模型');
  blank();
  info('中途可以按 Ctrl+C 退出，稍后用以下命令重新运行：');
  info(c.cyan('  openclaw run aiping:setup'));
  blank();

  try {
    // ── 第一步：AIPing API Key ──────────────────────────────────────────────
    hr();
    console.log(c.bold('  第 1 步 / 4  ·  AIPing 云端 API Key'));
    hr();
    blank();
    info('AIPing 是本插件使用的云端 AI 服务商（BASE_URL: https://aiping.cn/api/v1）。');
    info('默认的云端模型是 kimi-2.5，只有复杂请求才会自动路由到这里。');
    blank();
    tip('获取你的 API Key：');
    tip(c.cyan('  https://aiping.cn/user/user-center'));
    tip('登录后在「API 密钥」页面生成，格式通常为 sk-xxxxxxxx...');
    blank();

    const existingKeyHint = existingConfig.aipingApiKey
      ? ' [已设置，直接回车保留]'
      : '';
    const aipingApiKeyInput = await rl.question(
      `  请输入 AIPing API Key${existingKeyHint}：`
    );
    const aipingApiKey =
      aipingApiKeyInput.trim() || existingConfig.aipingApiKey || '';

    if (!aipingApiKey) {
      warn('未填写 API Key，云端路由暂时不可用。');
      warn('你可以稍后用以下命令补充：');
      warn(c.cyan('  openclaw plugins config @aiping/model_router set aipingApiKey "sk-..."'));
    }
    blank();

    // ── 第二步：本地模型配置 ────────────────────────────────────────────────
    hr();
    console.log(c.bold('  第 2 步 / 4  ·  本地模型配置（Ollama）'));
    hr();
    blank();
    info('本插件默认把约 90% 的请求路由到你的本地模型，几乎零延迟、零费用。');
    info('推荐使用 Ollama 作为本地模型运行时（支持 Mac / Linux / Windows）。');
    blank();
    tip('如果还没安装 Ollama，先执行：');
    tip(c.cyan('  curl -fsSL https://ollama.com/install.sh | sh   # Linux / Mac'));
    tip(c.cyan('  # 或访问 https://ollama.com/download 下载安装包'));
    blank();
    tip('启动 Ollama 服务：');
    tip(c.cyan('  ollama serve'));
    blank();
    tip('拉取本地模型（以 qwen2.5:4b 为例，约 2.3 GB）：');
    tip(c.cyan('  ollama pull qwen2.5:4b'));
    tip('其他可选本地模型：qwen2.5:7b · llama3.2:3b · phi3.5:mini · gemma3:4b');
    blank();

    const defaultLocalUrl = existingConfig.localProxyUrl ?? DEFAULT_CONFIG.localProxyUrl;
    const localProxyUrlInput = await rl.question(
      `  本地代理地址 [${defaultLocalUrl}]：`
    );
    const localProxyUrl = localProxyUrlInput.trim() || defaultLocalUrl;

    const defaultLocalModel = existingConfig.localModel ?? DEFAULT_CONFIG.localModel;
    const localModelInput = await rl.question(
      `  本地模型名称 [${defaultLocalModel}]：`
    );
    const localModel = localModelInput.trim() || defaultLocalModel;

    blank();
    tip('如果你的本地代理需要 API Key（如自搭建的 LM Studio），请填写：');
    const localProxyKeyInput = await rl.question(
      '  本地代理 Key（可选，无则直接回车）：'
    );
    const localProxyKey =
      localProxyKeyInput.trim() || existingConfig.localProxyKey || '';
    blank();

    // ── 第三步：路由策略 ────────────────────────────────────────────────────
    hr();
    console.log(c.bold('  第 3 步 / 4  ·  路由策略配置'));
    hr();
    blank();
    info('路由策略决定什么时候把请求转发到云端（Kimi-2.5）。');
    info('插件会对每条消息打分（满分 85 分），超过阈值才走云端。');
    blank();
    info('评分维度：');
    info('  • Token 数量 > 4000    → +30 分（超长上下文，本地难以处理）');
    info('  • 代码块 > 80 行       → +20 分（大型代码分析任务）');
    info('  • 强推理关键词         → +15 分（如"逐步分析"/"深度分析"）');
    info('  • 对话轮次 > 16 轮     → +20 分（超长多轮上下文）');
    blank();
    tip('阈值越高 → 越多请求走本地。默认 85 对应约 90% 走本地。');
    tip('建议范围：70（偏云端）~ 90（偏本地）。');
    blank();

    const defaultThreshold = existingConfig.routingThreshold ?? DEFAULT_CONFIG.routingThreshold;
    const thresholdInput = await rl.question(
      `  路由阈值（0-100）[${defaultThreshold}]：`
    );
    const routingThreshold =
      parseInt(thresholdInput.trim(), 10) || defaultThreshold;

    blank();
    tip('当本地模型无响应时，自动切换到云端（强烈建议开启）。');
    const fallbackInput = await rl.question(
      `  本地失败时自动切换到云端？[yes]：`
    );
    const fallbackToCloud = !['no', 'false', 'n', '否', '不'].includes(
      fallbackInput.trim().toLowerCase()
    );

    blank();
    tip('你随时可以在消息末尾加 @local 或 @cloud 强制覆盖路由：');
    tip('  "帮我写个排序算法 @local"  →  强制走本地');
    tip('  "帮我做架构评审 @cloud"    →  强制走云端');
    blank();

    // ── 第四步：连接测试 + 设置默认模型 ───────────────────────────────────
    hr();
    console.log(c.bold('  第 4 步 / 4  ·  连接测试 & 设置默认模型'));
    hr();
    blank();

    const config: PluginConfig = {
      aipingApiKey,
      localProxyUrl,
      localProxyKey,
      localModel,
      cloudModel: existingConfig.cloudModel || DEFAULT_CONFIG.cloudModel,
      routingThreshold,
      fallbackToCloud,
      localTimeoutMs: existingConfig.localTimeoutMs || DEFAULT_CONFIG.localTimeoutMs,
      debugRouting: existingConfig.debugRouting ?? DEFAULT_CONFIG.debugRouting,
    };

    // Test local
    info('正在测试本地模型连接...');
    const localAdapter = new LocalAdapter(config);
    const localResult = await localAdapter.ping();
    if (localResult.ok) {
      ok(`本地 Ollama（${localModel}）：连接正常 ✓  响应 ${localResult.latencyMs}ms`);
    } else {
      err(`本地 Ollama（${localModel}）：${localResult.error}`);
      warn('请确认 Ollama 已启动：ollama serve');
      warn(`并已拉取模型：ollama pull ${localModel}`);
      if (fallbackToCloud && aipingApiKey) {
        info('  → 本地不可用时，请求将自动 fallback 到云端。');
      }
    }

    // Test cloud
    if (aipingApiKey) {
      blank();
      info('正在测试 AIPing 云端连接...');
      const cloudAdapter = new CloudAdapter(config);
      const cloudResult = await cloudAdapter.ping();
      if (cloudResult.ok) {
        ok(`AIPing 云端（${cloudResult.model}）：连接正常 ✓  响应 ${cloudResult.latencyMs}ms`);
      } else {
        err(`AIPing 云端（${config.cloudModel}）：${cloudResult.error}`);
        if (cloudResult.error?.includes('API key') || cloudResult.error?.includes('401')) {
          warn('API Key 无效，请在以下地址检查：');
          warn(c.cyan('  https://aiping.cn/user/user-center'));
        }
      }
    } else {
      warn('未配置 AIPing API Key，跳过云端测试。');
    }

    // Set as default model
    blank();
    const setDefaultInput = await rl.question(
      '  是否将 aiping:claw 设为 OpenClaw 默认模型？[yes]：'
    );
    const shouldSetDefault = !['no', 'false', 'n', '否', '不'].includes(
      setDefaultInput.trim().toLowerCase()
    );

    if (shouldSetDefault) {
      const success = await trySetDefaultModel();
      if (success) {
        ok('已将 aiping:claw 设为默认模型。');
      } else {
        warn('自动设置失败，请手动运行：');
        warn(c.cyan('  openclaw config set defaultModel "aiping:claw"'));
      }
    }

    // Summary
    blank();
    hr();
    console.log(c.bold(c.green('  🎉 配置完成！')));
    hr();
    blank();
    info('路由规则摘要（约 90% 请求走本地）：');
    info(`  本地模型：${localModel}  →  ${localProxyUrl}`);
    info(`  云端模型：${config.cloudModel}  →  https://aiping.cn/api/v1`);
    info(`  路由阈值：${routingThreshold}  （满分 85，超过阈值走云端）`);
    info(`  失败回退：${fallbackToCloud ? '开启' : '关闭'}`);
    blank();
    info('使用方法：');
    info(c.cyan('  在 OpenClaw 中选择模型 "aiping:claw" 即可。'));
    info('  路由自动进行，对你完全透明。');
    blank();
    info('常用命令：');
    info(c.dim('  openclaw run aiping:setup                               # 重新运行此向导'));
    info(c.dim('  openclaw plugins config @aiping/model_router list       # 查看当前配置'));
    info(c.dim('  openclaw plugins config @aiping/model_router set debugRouting true  # 开启路由日志'));
    blank();

    return config;
  } finally {
    rl.close();
  }
}
