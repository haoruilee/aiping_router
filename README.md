# @aiping/model_router

> Smart routing between your local Ollama model and AIPing cloud (Kimi-2.5).  
> One plugin, one virtual model — zero workflow changes.

[![npm version](https://img.shields.io/npm/v/@aiping/model_router)](https://www.npmjs.com/package/@aiping/model_router)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## What it does

When you use the `aiping:claw` model in OpenClaw, this plugin automatically decides whether to send your request to:

| Destination | When | Why |
|---|---|---|
| **Local model** (Ollama, e.g. `qwen2.5:4b`) | Short, simple queries | Low latency, zero cost |
| **AIPing cloud** (Kimi-2.5) | Complex, long, or multi-turn | High capability |

Routing is based on a **5-dimension rule scorer** that runs in < 1ms — no ML inference, no extra processes.

---

## Quick Start

### 1. Install

```bash
openclaw plugins install @aiping/model_router
```

The setup wizard will guide you through configuration automatically.

### 2. Get your AIPing API key

Visit [https://aiping.cn/user/user-center](https://aiping.cn/user/user-center) to obtain your API key.

### 3. Make sure Ollama is running locally

```bash
# Start Ollama
ollama serve

# Pull your preferred local model
ollama pull qwen2.5:4b
```

### 4. Use it

Select **`aiping:claw`** as your model in OpenClaw. The plugin handles the rest.

---

## Manual Configuration

```bash
# Set your AIPing API key
openclaw plugins config @aiping/model_router set aipingApiKey "sk-your-key-here"

# Change local proxy URL (default: http://localhost:11434)
openclaw plugins config @aiping/model_router set localProxyUrl "http://localhost:11434"

# Change local model (default: qwen2.5:4b)
openclaw plugins config @aiping/model_router set localModel "qwen2.5:4b"

# Run setup wizard again
openclaw run aiping:setup
```

---

## How Routing Works

Each request is scored across 5 dimensions:

| Dimension | Max Points | Trigger |
|---|---|---|
| Token count | 30 | > 2000 estimated tokens |
| Code complexity | 20 | Code block with > 30 lines |
| Reasoning depth | 15 | Keywords: analyze, compare, 分析, 对比... |
| Multi-turn context | 20 | > 6 messages in history |
| Override directive | — | `@local` or `@cloud` in message |

**Score ≥ threshold (default: 50) → Cloud (Kimi-2.5)**  
**Score < threshold → Local (Ollama)**

### Override Routing

Add `@local` or `@cloud` to any message to force a specific destination:

```
Summarise this paragraph @local
```

```
Write a comprehensive analysis of this architecture @cloud
```

---

## Configuration Reference

| Key | Default | Description |
|---|---|---|
| `aipingApiKey` | *(required)* | AIPing API key from [aiping.cn](https://aiping.cn/user/user-center) |
| `localProxyUrl` | `http://localhost:11434` | Ollama or local proxy base URL |
| `localProxyKey` | *(empty)* | Optional auth key for local proxy |
| `localModel` | `qwen2.5:4b` | Local model name in Ollama |
| `cloudModel` | `kimi-2.5` | Cloud model on AIPing |
| `routingThreshold` | `50` | Score threshold (0–100) |
| `fallbackToCloud` | `true` | Auto-fallback to cloud if local fails |
| `localTimeoutMs` | `30000` | Local request timeout in ms |
| `debugRouting` | `false` | Print routing decisions to console |

---

## Architecture

```
OpenClaw Gateway
  └── aiping:claw (virtual model)
        └── ModelRouter Plugin
              ├── RuleScorer (5 dimensions, < 1ms)
              │     ├── TokenCountScorer
              │     ├── CodeComplexityScorer
              │     ├── ReasoningDepthScorer
              │     ├── MultiTurnContextScorer
              │     └── OverrideScorer (@local / @cloud)
              ├── LocalAdapter  → Ollama /v1/chat/completions
              └── CloudAdapter  → https://aiping.cn/api/v1/chat/completions
```

The `RuleScorer` interface is extensible — add new scoring dimensions by implementing:

```typescript
interface RuleScorer {
  readonly name: string;
  readonly maxScore: number;
  score(request: ChatRequest): DimensionScore;
}
```

---

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Watch mode
npm run dev
```

---

## Links

- [AIPing API](https://aiping.cn/api/v1)
- [AIPing User Center (API Key)](https://aiping.cn/user/user-center)
- [OpenClaw Plugin Docs](https://open-claw.bot/docs/plugins/api)
- [Changelog](docs/CHANGELOG.md)
- [Architecture Plan](docs/plan-v1.md)

---

## License

MIT © AIPing Team
