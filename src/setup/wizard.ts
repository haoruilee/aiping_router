import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { PluginConfig } from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';
import {
  detectOllama,
  detectAiping,
  RECOMMENDED_MODELS,
  type OllamaStatus,
  type AipingStatus,
} from './detector.js';

export interface PartialConfig extends Partial<PluginConfig> {
  aipingApiKey?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Terminal colour helpers
// ──────────────────────────────────────────────────────────────────────────────
const isTTY = process.stdout.isTTY ?? false;
const c = {
  bold:   (s: string) => isTTY ? `\x1b[1m${s}\x1b[0m`   : s,
  green:  (s: string) => isTTY ? `\x1b[32m${s}\x1b[0m`  : s,
  yellow: (s: string) => isTTY ? `\x1b[33m${s}\x1b[0m`  : s,
  cyan:   (s: string) => isTTY ? `\x1b[36m${s}\x1b[0m`  : s,
  red:    (s: string) => isTTY ? `\x1b[31m${s}\x1b[0m`  : s,
  dim:    (s: string) => isTTY ? `\x1b[2m${s}\x1b[0m`   : s,
  blue:   (s: string) => isTTY ? `\x1b[34m${s}\x1b[0m`  : s,
};

function hr()              { console.log(c.dim('─'.repeat(58))); }
function blank()           { console.log(''); }
function tip(t: string)    { console.log(c.dim(`     💡 ${t}`)); }
function warn(t: string)   { console.log(c.yellow(`     ⚠️  ${t}`)); }
function ok(t: string)     { console.log(c.green(`     ✅ ${t}`)); }
function fail(t: string)   { console.log(c.red(`     ❌ ${t}`)); }
function info(t: string)   { console.log(`  ${t}`); }
function cmd(t: string)    { console.log(c.cyan(`     $ ${t}`)); }
function step(n: string)   { blank(); hr(); console.log(c.bold(`  ${n}`)); hr(); blank(); }
function spinner(t: string){ process.stdout.write(c.dim(`     ⏳ ${t}...`)); }
function spinnerEnd()      { process.stdout.write('\r' + ' '.repeat(60) + '\r'); }

// ──────────────────────────────────────────────────────────────────────────────
// Write aiping:claw as default model into OpenClaw config file
// ──────────────────────────────────────────────────────────────────────────────
async function trySetDefaultModel(): Promise<boolean> {
  const candidates = [
    path.join(os.homedir(), '.openclaw', 'config.json'),
    path.join(os.homedir(), '.config', 'openclaw', 'config.json'),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
      cfg['defaultModel'] = 'aiping:claw';
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
      return true;
    } catch { /* try next */ }
  }
  // Create fresh config
  const newPath = candidates[0]!;
  try {
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.writeFileSync(newPath, JSON.stringify({ defaultModel: 'aiping:claw' }, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Print Ollama status banner
// ──────────────────────────────────────────────────────────────────────────────
function printOllamaStatus(status: OllamaStatus, baseUrl: string): void {
  if (!status.binaryFound) {
    fail('未检测到 Ollama 可执行文件');
    info('');
    info('  Ollama 是在本机运行开源大模型的工具，安装非常简单：');
    blank();
    info('  macOS / Linux：');
    cmd('curl -fsSL https://ollama.com/install.sh | sh');
    blank();
    info('  Windows / 图形界面安装包：');
    tip(c.cyan('https://ollama.com/download'));
    blank();
    info('  安装后请重新运行此向导：');
    cmd('openclaw model-router-setup');
  } else if (!status.serviceRunning) {
    warn(`Ollama 已安装，但服务未运行（地址：${baseUrl}）`);
    blank();
    info('  请在终端运行以下命令启动 Ollama 服务：');
    cmd('ollama serve');
    blank();
    info('  启动后按 Enter 重新检测，或继续配置（稍后修复）。');
  } else {
    ok(`Ollama 服务运行中（${baseUrl}），响应 ${status.latencyMs}ms`);
    if (status.models.length === 0) {
      warn('暂无已下载的模型');
      blank();
      info('  请先拉取一个本地模型，推荐：');
      cmd('ollama pull qwen2.5:4b   # 约 2.3 GB，中文能力强');
    } else {
      ok(`已检测到 ${status.models.length} 个本地模型`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Print AIPing status banner
// ──────────────────────────────────────────────────────────────────────────────
function printAipingStatus(status: AipingStatus): void {
  if (!status.reachable) {
    fail(`AIPing 服务不可达：${status.error ?? '网络错误'}`);
    warn('请检查网络连接，或确认 https://aiping.cn 可正常访问。');
  } else if (!status.keyValid) {
    if (status.errorCode === 429) {
      warn(`API Key 有效，但请求被限速（429）。响应 ${status.latencyMs}ms`);
      tip('等待几秒后自动恢复，不影响正常使用。');
    } else {
      fail(`API Key 验证失败：${status.error ?? '未知错误'}`);
      warn('请到以下地址检查或重新生成 Key：');
      tip(c.cyan('https://aiping.cn/user/user-center'));
    }
  } else {
    ok(`AIPing 云端（${status.model}）连接正常，响应 ${status.latencyMs}ms`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Interactive model picker — auto-detects, validates, guides pull if missing
// ──────────────────────────────────────────────────────────────────────────────
async function pickLocalModel(
  rl: readline.Interface,
  available: Array<{ name: string; size?: string }>,
  serviceRunning: boolean,
  proxyUrl: string,
  existingModel?: string
): Promise<string> {

  if (available.length > 0) {
    // ── Service running + models found: show list, no hardcoded default ──────
    blank();
    info('  检测到以下本地模型，请选择序号，或直接输入其他模型名称：');
    blank();
    available.forEach((m, i) => {
      const isCurrent = existingModel && (m.name === existingModel || m.name.startsWith(existingModel.split(':')[0]!));
      const marker = isCurrent ? c.green(' ← 上次使用') : '';
      const size = m.size ? c.dim(` (${m.size})`) : '';
      info(`  ${c.bold(`[${i + 1}]`)}  ${c.cyan(m.name)}${size}${marker}`);
    });
    blank();

    // Default: first detected model (not a hardcoded name)
    const defaultModel = existingModel && available.some(m => m.name === existingModel)
      ? existingModel
      : available[0]!.name;

    const raw = await rl.question(`  请选择本地模型 [${defaultModel}]：`);
    const trimmed = raw.trim();

    if (!trimmed) return defaultModel;

    const idx = parseInt(trimmed, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= available.length) {
      return available[idx - 1]!.name;
    }
    // Typed a name directly — accept it (may need pull)
    return trimmed;
  }

  // ── No models detected: ask user, validate, guide pull ────────────────────
  blank();
  if (serviceRunning) {
    warn('Ollama 服务运行中，但暂无已下载模型。');
  }
  info('  以下是常用模型推荐（按大小排序）：');
  blank();
  RECOMMENDED_MODELS.forEach((m, i) => {
    info(`  ${c.bold(`[${i + 1}]`)}  ${c.cyan(m.name.padEnd(18))} ${m.size.padEnd(10)}  ${c.dim(m.desc)}`);
  });
  blank();

  while (true) {
    const raw = await rl.question(
      '  输入模型名称（如 qwen2.5:4b），或输入序号选择推荐模型：'
    );
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // Numeric selection from recommended list
    const idx = parseInt(trimmed, 10);
    const selected = (!isNaN(idx) && idx >= 1 && idx <= RECOMMENDED_MODELS.length)
      ? RECOMMENDED_MODELS[idx - 1]!.name
      : trimmed;

    if (!serviceRunning) {
      // Can't verify — accept as-is
      return selected;
    }

    // Verify the model exists
    blank();
    spinner(`检查模型 ${selected} 是否已下载`);
    const refreshed = await detectOllama(proxyUrl);
    spinnerEnd();

    const found = refreshed.models.some(
      m => m.name === selected || m.name.startsWith(selected.split(':')[0]!)
    );

    if (found) {
      ok(`模型 ${selected} 已就绪`);
      return selected;
    }

    // Model not installed — offer to guide pull
    blank();
    warn(`模型 "${selected}" 尚未下载。`);
    info('  在另一个终端运行以下命令下载：');
    cmd(`ollama pull ${selected}`);
    blank();

    const waitPull = await rl.question(
      '  下载完成后按 Enter 重新检测，输入 "skip" 跳过验证直接使用该名称：'
    );
    if (waitPull.trim().toLowerCase() === 'skip') {
      warn(`将使用 ${selected}（请确保下载完成后再启动 gateway）。`);
      return selected;
    }

    // Re-check after user says it's done
    blank();
    spinner(`重新检测模型 ${selected}`);
    const rechecked = await detectOllama(proxyUrl);
    spinnerEnd();

    const nowFound = rechecked.models.some(
      m => m.name === selected || m.name.startsWith(selected.split(':')[0]!)
    );

    if (nowFound) {
      ok(`模型 ${selected} 已就绪！`);
      return selected;
    }

    warn(`仍未检测到 ${selected}，请重新输入或等待下载完成。`);
    blank();
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// AIPing key input loop — retries until valid or user explicitly skips
// ──────────────────────────────────────────────────────────────────────────────
async function promptAipingKey(
  rl: readline.Interface,
  existingKey: string | undefined,
  cloudModel: string
): Promise<{ key: string; verified: boolean }> {
  let currentKey = existingKey ?? '';
  let attempts = 0;

  while (true) {
    const hint = currentKey ? ' [已设置，直接回车保留；输入新 Key 替换]' : '';
    const raw = await rl.question(`\n  请输入 AIPing API Key${hint}：`);
    const entered = raw.trim();
    const key = entered || currentKey;

    if (!key) {
      warn('未填写 API Key，云端路由将不可用。');
      const skip = await rl.question('  跳过云端配置，仅使用本地模型？[yes/no]：');
      if (!['no', 'n', '不', '否'].includes(skip.trim().toLowerCase())) {
        return { key: '', verified: false };
      }
      continue;
    }

    attempts++;
    blank();
    spinner(`正在验证 Key（第 ${attempts} 次）`);
    const status = await detectAiping(key, cloudModel);
    spinnerEnd();

    printAipingStatus(status);

    if (status.keyValid || status.errorCode === 429) {
      return { key, verified: true };
    }

    if (!status.reachable) {
      // Network issue — not a key problem; let user decide
      warn('网络检测失败，可能是网络问题。');
      const skip = await rl.question('  继续配置（之后修复网络）？[yes/no]：');
      if (!['no', 'n', '不', '否'].includes(skip.trim().toLowerCase())) {
        return { key, verified: false };
      }
      continue;
    }

    // Invalid key
    blank();
    info('  请到以下地址获取或重新生成 API Key：');
    tip(c.cyan('https://aiping.cn/user/user-center'));
    const retry = await rl.question('  重新输入 Key？[yes/no]：');
    if (['no', 'n', '不', '否'].includes(retry.trim().toLowerCase())) {
      return { key, verified: false };
    }
    currentKey = '';
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Ollama service probe loop — detects, prints status, optionally waits for fix
// ──────────────────────────────────────────────────────────────────────────────
async function probeOllamaWithRepair(
  rl: readline.Interface,
  baseUrl: string
): Promise<OllamaStatus> {
  let status = await detectOllama(baseUrl);

  while (!status.serviceRunning) {
    printOllamaStatus(status, baseUrl);
    blank();

    if (!status.binaryFound) {
      // Binary not found — user needs to install; can't fix here
      const cont = await rl.question(
        '  安装 Ollama 后按 Enter 重新检测，或输入 "skip" 跳过本地模型配置：'
      );
      if (cont.trim().toLowerCase() === 'skip') return status;
    } else {
      // Installed but not running
      const cont = await rl.question(
        '  运行 "ollama serve" 后按 Enter 重新检测，或输入 "skip" 跳过：'
      );
      if (cont.trim().toLowerCase() === 'skip') return status;
    }

    blank();
    spinner('重新检测 Ollama');
    status = await detectOllama(baseUrl);
    spinnerEnd();
  }

  return status;
}

// ──────────────────────────────────────────────────────────────────────────────
// Final connectivity verification — guarantees at least one backend works
// ──────────────────────────────────────────────────────────────────────────────
interface ConnectivityReport {
  localOk: boolean;
  cloudOk: boolean;
  localLatency?: number;
  cloudLatency?: number;
}

async function verifyConnectivity(config: PluginConfig): Promise<ConnectivityReport> {
  const [localResult, cloudResult] = await Promise.all([
    detectOllama(config.localProxyUrl),
    config.aipingApiKey
      ? detectAiping(config.aipingApiKey, config.cloudModel)
      : Promise.resolve<AipingStatus>({ reachable: false, keyValid: false, model: config.cloudModel }),
  ]);

  return {
    localOk: localResult.serviceRunning && localResult.models.some(
      (m) => m.name === config.localModel || m.name.startsWith(config.localModel.split(':')[0]!)
    ),
    cloudOk: cloudResult.keyValid || cloudResult.errorCode === 429,
    localLatency: localResult.latencyMs,
    cloudLatency: cloudResult.latencyMs,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Main wizard
// ──────────────────────────────────────────────────────────────────────────────
export async function runSetupWizard(existingConfig: PartialConfig = {}): Promise<PluginConfig> {
  const rl = readline.createInterface({ input, output });

  blank();
  console.log(c.bold('╔══════════════════════════════════════════════════════════╗'));
  console.log(c.bold('║    🚀  AIPing Model Router  配置向导  v1.2              ║'));
  console.log(c.bold('║    智能路由：本地小模型 + 云端强模型，自动检测修复       ║'));
  console.log(c.bold('╚══════════════════════════════════════════════════════════╝'));
  blank();
  info('向导将自动检测环境，并引导你修复任何问题，确保安装完即可使用。');
  info('中途可按 Ctrl+C 退出，稍后运行 ' + c.cyan('openclaw model-router-setup') + ' 重新配置。');
  blank();

  try {
    // ── 环境预检：自动扫描 Ollama ──────────────────────────────────────────
    step('环境预检  ·  自动扫描本地 Ollama');

    const localProxyUrl = existingConfig.localProxyUrl ?? DEFAULT_CONFIG.localProxyUrl;
    spinner('正在扫描 Ollama 服务');
    const initialOllama = await detectOllama(localProxyUrl);
    spinnerEnd();

    if (initialOllama.serviceRunning) {
      ok(`Ollama 服务运行中（${localProxyUrl}），响应 ${initialOllama.latencyMs}ms`);
      if (initialOllama.models.length > 0) {
        ok(`检测到 ${initialOllama.models.length} 个本地模型：${initialOllama.models.map((m) => m.name).join('、')}`);
      } else {
        warn('服务运行但暂无已下载模型，稍后将提示下载。');
      }
    } else {
      printOllamaStatus(initialOllama, localProxyUrl);
    }
    blank();

    // ── 第一步：AIPing API Key ──────────────────────────────────────────────
    step('第 1 步 / 4  ·  配置 AIPing 云端 API Key');

    info('AIPing 是本插件对接的云端 AI 服务（https://aiping.cn/api/v1）。');
    info('云端模型（Kimi-K2.5）仅在复杂请求时使用，约 10% 的请求量。');
    blank();
    info('  访问 ' + c.cyan('https://aiping.cn/user/user-center'));
    info('  复制页面上 ' + c.bold(c.cyan('QC-')) + ' 开头的 API Key');
    blank();

    const cloudModel = existingConfig.cloudModel ?? DEFAULT_CONFIG.cloudModel;
    const { key: aipingApiKey, verified: cloudVerified } = await promptAipingKey(
      rl,
      existingConfig.aipingApiKey,
      cloudModel
    );
    blank();

    // ── 第二步：本地模型配置 ────────────────────────────────────────────────
    step('第 2 步 / 4  ·  配置本地模型（Ollama）');

    info('本插件默认约 90% 请求走本地模型——零延迟、零费用。');
    blank();

    // Allow user to change the proxy URL
    const localUrlInput = await rl.question(
      `  Ollama 服务地址 [${localProxyUrl}]（直接回车保持默认）：`
    );
    const finalLocalUrl = localUrlInput.trim() || localProxyUrl;

    // If URL changed, re-probe
    let ollamaStatus = initialOllama;
    if (finalLocalUrl !== localProxyUrl) {
      spinner('重新检测新地址');
      ollamaStatus = await detectOllama(finalLocalUrl);
      spinnerEnd();
    }

    // Repair loop if service not running
    if (!ollamaStatus.serviceRunning) {
      blank();
      ollamaStatus = await probeOllamaWithRepair(rl, finalLocalUrl);
    }

    // Model selection — auto-detect, validate, guide pull if missing
    const localModel = await pickLocalModel(
      rl,
      ollamaStatus.models,
      ollamaStatus.serviceRunning,
      finalLocalUrl,
      existingConfig.localModel
    );

    blank();
    tip('如本地代理需要鉴权（如 LM Studio），填写 Key；无需则直接回车：');
    const localProxyKeyInput = await rl.question('  本地代理 Key（可选）：');
    const localProxyKey = localProxyKeyInput.trim() || existingConfig.localProxyKey || '';
    blank();

    // ── 第三步：路由策略 ────────────────────────────────────────────────────
    step('第 3 步 / 4  ·  路由策略配置');

    info('插件对每条消息打分（满分 85 分），超过阈值才路由到云端：');
    blank();
    info(`  ${c.cyan('Token 数量 > 4000')}    → +30 分  （超长上下文）`);
    info(`  ${c.cyan('代码块 > 80 行')}        → +20 分  （大型代码分析）`);
    info(`  ${c.cyan('强推理关键词')}           → +15 分  （"深度分析"/"step by step"）`);
    info(`  ${c.cyan('对话轮次 > 16 轮')}      → +20 分  （超长多轮历史）`);
    blank();
    info(`  当前建议：阈值设 ${c.bold('85')} → 约 90% 请求走本地`);
    info('  范围参考：70（偏云端）/ 85（推荐）/ 95（几乎全本地）');
    blank();

    const defThreshold = existingConfig.routingThreshold ?? DEFAULT_CONFIG.routingThreshold;
    const threshInput = await rl.question(`  路由阈值 [${defThreshold}]：`);
    const routingThreshold = parseInt(threshInput.trim(), 10) || defThreshold;

    blank();
    tip('强烈建议开启失败自动回退：本地无响应时自动切换到云端。');
    const fbInput = await rl.question('  本地失败时自动切换到云端？[yes]：');
    const fallbackToCloud = !['no', 'false', 'n', '否', '不'].includes(
      fbInput.trim().toLowerCase()
    );

    blank();
    info('  你也可以在消息末尾加指令强制覆盖路由决策：');
    info(c.dim('  "帮我写个函数 @local"    → 强制走本地'));
    info(c.dim('  "系统架构评审 @cloud"   → 强制走云端'));
    blank();

    // ── 第四步：最终验证 + 设置默认模型 ───────────────────────────────────
    step('第 4 步 / 4  ·  连通性验证 & 设为默认模型');

    const config: PluginConfig = {
      aipingApiKey,
      localProxyUrl: finalLocalUrl,
      localProxyKey,
      localModel,
      cloudModel,
      routingThreshold,
      fallbackToCloud,
      localTimeoutMs: existingConfig.localTimeoutMs ?? DEFAULT_CONFIG.localTimeoutMs,
      debugRouting: existingConfig.debugRouting ?? DEFAULT_CONFIG.debugRouting,
    };

    // Full connectivity check
    info('正在进行最终连通性验证...');
    blank();

    spinner('验证本地 Ollama');
    const finalOllama = await detectOllama(finalLocalUrl);
    spinnerEnd();

    if (finalOllama.serviceRunning) {
      ok(`本地 Ollama（${localModel}）：服务正常，响应 ${finalOllama.latencyMs}ms`);
    } else {
      fail(`本地 Ollama（${localModel}）：服务未就绪`);
      if (fallbackToCloud && aipingApiKey) {
        info('     → 已开启云端回退，本地失败时自动切换到云端。');
      } else {
        warn('本地不可用且无回退，请安装并启动 Ollama：');
        cmd('ollama serve');
      }
    }

    if (aipingApiKey) {
      blank();
      spinner('验证 AIPing 云端');
      const finalCloud = await detectAiping(aipingApiKey, cloudModel);
      spinnerEnd();
      printAipingStatus(finalCloud);

      // Key validation failed — offer one more chance to re-enter
      if (!finalCloud.keyValid && finalCloud.reachable && finalCloud.errorCode !== 429) {
        blank();
        warn('云端验证失败。是否重新输入 API Key？');
        const rekey = await rl.question('  输入新 Key（直接回车跳过）：');
        if (rekey.trim()) {
          spinner('重新验证');
          const retry = await detectAiping(rekey.trim(), cloudModel);
          spinnerEnd();
          printAipingStatus(retry);
          if (retry.keyValid || retry.errorCode === 429) {
            config.aipingApiKey = rekey.trim();
          }
        }
      }
    } else {
      warn('未配置 AIPing API Key，云端路由不可用。');
    }

    // Abort if nothing works
    const report = await verifyConnectivity(config);
    if (!report.localOk && !report.cloudOk) {
      blank();
      hr();
      console.log(c.red(c.bold('  ⚠️  警告：本地和云端均未就绪')));
      hr();
      info('配置已保存，但当前 aiping:claw 无法处理任何请求。');
      info('请修复后运行：' + c.cyan(' openclaw model-router-setup'));
      blank();
    }

    // Set as default model
    blank();
    hr();
    const setDefaultInput = await rl.question(
      '  是否将 aiping:claw 设为 OpenClaw 默认模型？[yes]：'
    );
    const shouldSetDefault = !['no', 'false', 'n', '否', '不'].includes(
      setDefaultInput.trim().toLowerCase()
    );

    if (shouldSetDefault) {
      const success = await trySetDefaultModel();
      if (success) {
        ok('aiping:claw 已设为 OpenClaw 默认模型。');
      } else {
        warn('自动写入失败，请手动运行：');
        cmd('openclaw config set defaultModel "aiping:claw"');
      }
    }

    // ── 完成摘要 ───────────────────────────────────────────────────────────
    blank();
    hr();
    console.log(c.bold(c.green('  🎉 配置完成！')));
    hr();
    blank();

    const localStatus = report.localOk
      ? c.green('✅ 正常')
      : c.red('❌ 未就绪（请运行 ollama serve）');
    const cloudStatus = report.cloudOk
      ? c.green('✅ 正常')
      : (aipingApiKey ? c.red('❌ 验证失败') : c.dim('— 未配置'));

    info('  ┌─────────────────────────────────────────────────┐');
    info(`  │  本地模型  ${localModel.padEnd(20)} ${localStatus.padEnd(10)}`);
    info(`  │  云端模型  ${cloudModel.padEnd(20)} ${cloudStatus.padEnd(10)}`);
    info(`  │  路由阈值  ${String(routingThreshold).padEnd(20)} （~90% 走本地）`);
    info(`  │  失败回退  ${fallbackToCloud ? '开启' : '关闭'}`);
    info('  └─────────────────────────────────────────────────┘');
    blank();
    info('  在 OpenClaw 中选择模型 ' + c.bold(c.cyan('"aiping:claw"')) + ' 即可开始使用。');
    blank();
    info('  常用命令：');
    info(c.dim('  openclaw model-router-setup                                  # 重新配置'));
    info(c.dim('  openclaw plugins config @aiping.cn/model_router list          # 查看配置'));
    info(c.dim('  openclaw plugins config @aiping.cn/model_router set debugRouting true  # 路由日志'));
    blank();

    return config;
  } finally {
    rl.close();
  }
}
