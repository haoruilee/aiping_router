import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import type { PluginConfig } from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';
import { LocalAdapter } from '../providers/local.js';
import { CloudAdapter } from '../providers/cloud.js';

interface PartialConfig extends Partial<PluginConfig> {
  aipingApiKey?: string;
}

/**
 * Interactive first-run configuration wizard.
 * Guides the user through setting up their API keys and preferences,
 * then tests both connections before saving.
 */
export async function runSetupWizard(
  existingConfig: PartialConfig = {}
): Promise<PluginConfig> {
  const rl = readline.createInterface({ input, output });

  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║        Welcome to @aiping/model_router v1.0         ║');
  console.log('║   Smart routing between local and cloud AI models    ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');

  try {
    // Step 1: AIPing API Key
    console.log('Step 1/4: AIPing Cloud API Key');
    console.log('  Get your key at: https://aiping.cn/user/user-center');
    console.log('');

    const aipingApiKey = await rl.question(
      `  AIPing API Key${existingConfig.aipingApiKey ? ' [already set, press Enter to keep]' : ''}: `
    );

    const resolvedApiKey =
      aipingApiKey.trim() || existingConfig.aipingApiKey || '';

    if (!resolvedApiKey) {
      console.log('  ⚠️  No API key entered. You can set it later with:');
      console.log(
        '     openclaw plugins config @aiping/model_router set aipingApiKey "sk-..."'
      );
      console.log('');
    }

    // Step 2: Local proxy settings
    console.log('');
    console.log('Step 2/4: Local Model Proxy (Ollama)');
    console.log('  Default assumes Ollama running on this machine.');
    console.log('');

    const localProxyUrlInput = await rl.question(
      `  Local proxy URL [${existingConfig.localProxyUrl ?? DEFAULT_CONFIG.localProxyUrl}]: `
    );
    const localProxyUrl =
      localProxyUrlInput.trim() ||
      existingConfig.localProxyUrl ||
      DEFAULT_CONFIG.localProxyUrl;

    const localModelInput = await rl.question(
      `  Local model name [${existingConfig.localModel ?? DEFAULT_CONFIG.localModel}]: `
    );
    const localModel =
      localModelInput.trim() ||
      existingConfig.localModel ||
      DEFAULT_CONFIG.localModel;

    const localProxyKeyInput = await rl.question(
      '  Local proxy auth key (optional, press Enter to skip): '
    );
    const localProxyKey =
      localProxyKeyInput.trim() || existingConfig.localProxyKey || '';

    // Step 3: Routing settings
    console.log('');
    console.log('Step 3/4: Routing Settings');
    console.log('  Requests scoring >= threshold are sent to cloud (0-100).');
    console.log('  Higher = prefer local more. Lower = prefer cloud more.');
    console.log('');

    const thresholdInput = await rl.question(
      `  Complexity threshold [${existingConfig.routingThreshold ?? DEFAULT_CONFIG.routingThreshold}]: `
    );
    const routingThreshold =
      parseInt(thresholdInput.trim(), 10) ||
      existingConfig.routingThreshold ||
      DEFAULT_CONFIG.routingThreshold;

    const fallbackInput = await rl.question(
      `  Fallback to cloud if local fails? [${existingConfig.fallbackToCloud ?? 'yes'}]: `
    );
    const fallbackToCloud =
      fallbackInput.trim() === '' ? true : !['no', 'false', '0'].includes(fallbackInput.trim().toLowerCase());

    // Step 4: Connection test
    console.log('');
    console.log('Step 4/4: Testing connections...');
    console.log('');

    const config: PluginConfig = {
      aipingApiKey: resolvedApiKey,
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
    const localAdapter = new LocalAdapter(config);
    const localResult = await localAdapter.ping();
    if (localResult.ok) {
      console.log(`  ✅ Local (${localModel}): OK (${localResult.latencyMs}ms)`);
    } else {
      console.log(`  ⚠️  Local (${localModel}): ${localResult.error}`);
      console.log(`     Make sure Ollama is running: ollama serve`);
      console.log(`     Then pull your model: ollama pull ${localModel}`);
    }

    // Test cloud
    if (resolvedApiKey) {
      const cloudAdapter = new CloudAdapter(config);
      const cloudResult = await cloudAdapter.ping();
      if (cloudResult.ok) {
        console.log(
          `  ✅ AIPing Cloud (${cloudResult.model}): OK (${cloudResult.latencyMs}ms)`
        );
      } else {
        console.log(`  ⚠️  AIPing Cloud: ${cloudResult.error}`);
        console.log(`     Check your API key at: https://aiping.cn/user/user-center`);
      }
    } else {
      console.log(`  ⚠️  AIPing Cloud: skipped (no API key)`);
    }

    console.log('');
    console.log('✅ Setup complete!');
    console.log('   Select "aiping:claw" as your model in OpenClaw to use the router.');
    console.log('');
    console.log('   Tip: Add @local or @cloud to any message to override routing.');
    console.log('');

    return config;
  } finally {
    rl.close();
  }
}
