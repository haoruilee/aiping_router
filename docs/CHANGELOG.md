# Changelog

All notable changes to `@aiping/model_router` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Planned
- ML-based classifier to replace rule scorer
- Routing statistics dashboard
- Cost tracking per session

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
- Initial implementation of `@aiping/model_router` OpenClaw plugin
- 5-dimension rule-based scoring engine:
  - Token count dimension (0–30 pts)
  - Code complexity dimension (0–20 pts)
  - Reasoning depth keywords (0–15 pts)
  - Multi-turn context length (0–20 pts)
  - Explicit `@local` / `@cloud` override flags
- `LocalAdapter`: OpenAI-compatible proxy to Ollama (default `http://localhost:11434`)
- `CloudAdapter`: AIPing API adapter for Kimi-2.5 (BASE_URL `https://aiping.cn/api/v1`)
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
