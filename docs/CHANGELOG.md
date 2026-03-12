# Changelog

All notable changes to `@aiping.cn/model_router` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Planned
- ML-based classifier to replace rule scorer
- Routing statistics dashboard
- Cost tracking per session

---

## [1.2.0] - 2026-03-10

### Added
- **`src/setup/detector.ts`** — 独立的环境检测模块：
  - `detectOllama()`: 检测二进制是否存在、服务是否运行、列出已下载模型（优先 `/api/tags`，兜底 `ollama list` CLI）
  - `detectAiping()`: 验证 AIPing API Key 连通性，区分 401 无效 Key / 429 限速 / 网络不可达
  - `RECOMMENDED_MODELS`: 内置推荐本地模型列表（qwen2.5:4b/7b, llama3.2:3b, phi3.5:mini, gemma3:4b）
- **`LocalAdapter.listModels()`** — 查询本地服务可用模型列表
- **向导环境预检阶段** — 启动时自动扫描 Ollama，打印当前状态
- **智能模型选择器** — 检测到已有模型时显示编号列表，用户选序号即可；无模型时展示推荐列表+拉取命令
- **AIPing Key 验证循环** — Key 无效时不静默跳过，提示错误原因 + 重新输入或跳过
- **Ollama 修复引导循环** — 服务未启动时逐步引导（安装命令 / `ollama serve` / 模型下载），支持按 Enter 重新检测
- **最终连通性验证** — 配置完成前对两端做真实连通检测，汇报状态；若两端均失败则明确警告
- **配置摘要表格** — 向导结束时打印本地/云端/阈值/回退状态的一览表
- 新增测试：`detector.test.ts`（11 个）、`local-adapter.test.ts`（5 个），总测试数 47

### Changed
- `LocalAdapter.ping()` 优先使用 `/api/tags`（Ollama 原生接口），兜底 `/v1/models`
- 向导版本号更新至 v1.2

---

## [1.1.0] - 2026-03-10

### Changed
- **路由阈值默认值**: 50 → **85**，约 90% 请求走本地模型
- **Token 触发阈值**: 高阈值 2000 → 4000，低阈值 500 → 1500
- **代码复杂度触发行数**: 30 → 80 行
- **多轮上下文触发轮数**: 6 → 16 轮
- **推理关键词策略**: 单词触发 → 仅强多词短语触发（减少误判）
- **配置向导**: 全面改写为中文，含详细 Ollama 安装、模型拉取指引

### Added
- **默认模型设置**: 安装/配置完成后自动将 `aiping:claw` 设为 OpenClaw 默认模型
  - 优先使用 Gateway API `setDefaultModel()`
  - 兜底写入 `~/.openclaw/config.json`
  - 失败时提示手动命令
- **彩色终端输出**: 向导使用颜色高亮，提升可读性（TTY 自动降级）
- **docs/plan-v1.1.md**: v1.1 架构变更文档

---

## [1.0.0] - 2026-03-10

### Added
- Initial implementation of `@aiping.cn/model_router` OpenClaw plugin
- 5-dimension rule-based scoring engine:
  - Token count dimension (0–30 pts)
  - Code complexity dimension (0–20 pts)
  - Reasoning depth keywords (0–15 pts)
  - Multi-turn context length (0–20 pts)
  - Explicit `@local` / `@cloud` override flags
- `LocalAdapter`: OpenAI-compatible proxy to Ollama (default `http://localhost:11434`)
- `CloudAdapter`: AIPing API adapter for Kimi-K2.5 (BASE_URL `https://aiping.cn/api/v1`)
- Full streaming response support (SSE pass-through)
- Automatic fallback from local to cloud on failure
- First-run setup wizard with connection testing
- `aiping:claw` virtual model registration in OpenClaw Gateway
- Configurable routing threshold (default: 50)
- `@local` / `@cloud` inline override directives
- Extensible `RuleScorer` interface for custom dimensions

### Architecture Decisions
- Pure rule-based routing: zero ML inference overhead, <1ms decision latency
- Native `fetch` API only: no HTTP client dependencies
- TypeScript-first: full type safety throughout
- Plugin-based rule engine: new dimensions implementable without core changes

---

## [0.1.0] - 2026-03-10

### Added
- Project scaffold and architecture planning (docs/plan-v1.md)
- Directory structure established
