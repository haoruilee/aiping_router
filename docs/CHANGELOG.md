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
