# @aiping.cn/model_router — 详细架构方案

**版本**: v1.0  
**日期**: 2026-03-10  
**作者**: AIPing Team  
**状态**: Draft → Review

---

## 1. 背景与目标

### 1.1 问题陈述

用户在本地（如 MacBook）用 Ollama 跑了一个轻量模型（如 qwen2.5:4b），同时也有权限访问云端强模型（如 Kimi-2.5 via AIPing API）。两个模型分别适合不同复杂度的任务：

| 场景 | 本地 4B | 云端 Kimi-2.5 |
|------|---------|--------------|
| 短对话、日常问答 | ✅ 低延迟，零成本 | ❌ 浪费算力 |
| 多步推理、代码生成 | ❌ 能力不足 | ✅ 高质量输出 |
| 长文本分析（>2000 tokens） | ❌ 上下文窗口有限 | ✅ 大上下文 |

**目标**：一键安装的 OpenClaw 插件，暴露虚拟模型 `aiping:claw`，对用户透明地把请求分流到最合适的后端。

### 1.2 设计约束

- **轻**：纯规则路由，无需 ML 推理，路由决策 < 1ms
- **快**：冷启动 < 200ms，不引入额外服务进程
- **可扩展**：规则引擎插件化，未来可接入更多维度或 ML 分类器
- **优雅**：OpenAI-compatible API，对 OpenClaw 完全透明
- **版本管理**：docs/ 目录存储所有版本规划文档

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                       OpenClaw Gateway                       │
│                                                             │
│  用户请求 aiping:claw ──► ModelRouter Plugin                │
│                              │                              │
│                    ┌─────────▼─────────┐                   │
│                    │   Rule Scorer      │                   │
│                    │  (5 dimensions)    │                   │
│                    └─────────┬─────────┘                   │
│                              │ score 0-100                  │
│                   ┌──────────▼──────────┐                  │
│                   │  Routing Decision   │                   │
│                   │  threshold: 50      │                   │
│                   └──────┬──────┬───────┘                  │
│                          │      │                           │
│                    score<50  score>=50                      │
│                          │      │                           │
│               ┌──────────▼┐    ┌▼──────────────┐          │
│               │  Local    │    │  AIPing Cloud  │          │
│               │  Adapter  │    │  Adapter       │          │
│               │  (Ollama) │    │  Kimi-2.5      │          │
│               └──────────┬┘    └┬───────────────┘          │
│                          │      │                           │
│                    Fallback: 若 local 失败 → cloud          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 项目结构

```
@aiping.cn/model_router/
├── package.json                    # npm 包描述
├── openclaw.plugin.json            # OpenClaw 插件清单
├── tsconfig.json                   # TypeScript 配置
├── src/
│   ├── index.ts                    # 插件入口，注册所有扩展
│   ├── types.ts                    # 共享类型定义
│   ├── router/
│   │   ├── scorer.ts               # 评分引擎（5维度）
│   │   ├── rules.ts                # 规则定义与权重
│   │   └── router.ts               # 路由主逻辑
│   ├── providers/
│   │   ├── local.ts                # Ollama/本地代理适配器
│   │   └── cloud.ts                # AIPing 云端适配器
│   └── setup/
│       └── wizard.ts               # 首次运行配置向导
├── docs/
│   ├── plan-v1.md                  # 本文档（当前版本）
│   └── CHANGELOG.md                # 版本变更记录
└── README.md
```

---

## 4. 核心模块详解

### 4.1 评分引擎（5-Dimension Scorer）

受 ClawRouter 15 维度评分器启发，我们用 5 个轻量维度覆盖 90% 的路由决策场景：

| 维度 | 判断方式 | 分值 | 说明 |
|------|---------|------|------|
| **Token 数量** | 估算 input token count | +30 | > 2000 tokens → 本地难以处理 |
| **代码复杂度** | 检测代码块行数 | +20 | ``` 代码块 > 30 行 → 复杂代码任务 |
| **推理深度** | 关键词匹配 | +15 | "分析/compare/explain in detail" 等 |
| **多轮上下文** | messages 数组长度 | +20 | > 6 轮对话 → 上下文依赖强 |
| **显式覆盖** | `@local` / `@cloud` 标记 | ±100 | 用户强制指定，最高优先级 |

**决策逻辑**：
```
总分 >= threshold (默认 50) → 路由到云端 (AIPing Kimi-2.5)
总分 < threshold              → 路由到本地 (Ollama)
@local 标记                   → 强制本地（忽略分数）
@cloud 标记                   → 强制云端（忽略分数）
```

### 4.2 路由器（Router）

```typescript
// 路由决策接口
interface RoutingDecision {
  target: 'local' | 'cloud';
  score: number;
  reasons: string[];
  forced: boolean;    // 是否被 @local/@cloud 强制
}
```

路由器逻辑：
1. 调用 Scorer 获取分数和原因
2. 对比 threshold 做出 local/cloud 决策
3. 若 target=local 且 `fallbackToCloud=true`，捕获 local 失败并透明 fallback 到 cloud
4. 记录路由日志（可选 debug 模式）

### 4.3 本地适配器（Local Adapter）

对接 Ollama 的 OpenAI-compatible endpoint：

```
POST http://localhost:11434/v1/chat/completions
Authorization: Bearer {localProxyKey}   # 可选
```

支持流式响应（`stream: true`），转发所有 OpenAI 标准字段。

### 4.4 云端适配器（Cloud Adapter）

对接 AIPing API：

```
POST https://aiping.cn/api/v1/chat/completions
Authorization: Bearer {aipingApiKey}
```

- BASE_URL: `https://aiping.cn/api/v1`
- 默认模型: `kimi-2.5`（可配置）
- 支持流式响应
- 错误码映射（429 rate limit → 退避重试）

### 4.5 配置向导（Setup Wizard）

首次安装时自动触发：

```
🎉 Welcome to @aiping.cn/model_router!

Step 1/4: AIPing API Key
  Your key is available at: https://aiping.cn/user/user-center
  Enter your AIPing API Key: ****

Step 2/4: Local Model Proxy
  Enter local proxy URL [http://localhost:11434]: 
  Enter local model name [qwen2.5:4b]: 

Step 3/4: Routing Settings
  Complexity threshold (0-100) [50]: 
  Fallback to cloud if local fails? [yes]: 

Step 4/4: Testing connections...
  ✅ AIPing Cloud (Kimi-2.5): OK (142ms)
  ✅ Local Ollama (qwen2.5:4b): OK (23ms)

✅ Setup complete! Use model "aiping:claw" in OpenClaw.
```

---

## 5. OpenClaw 集成方案

### 5.1 openclaw.plugin.json

```json
{
  "id": "@aiping.cn/model_router",
  "version": "1.0.0",
  "name": "AIPing Model Router",
  "description": "Routes requests between local and cloud models intelligently",
  "extensions": ["dist/index.js"],
  "configSchema": {
    "type": "object",
    "required": ["aipingApiKey"],
    "properties": {
      "aipingApiKey": { "type": "string" },
      "localProxyUrl": { "type": "string", "default": "http://localhost:11434" },
      "localModel": { "type": "string", "default": "qwen2.5:4b" },
      "cloudModel": { "type": "string", "default": "kimi-2.5" },
      "routingThreshold": { "type": "number", "default": 50 },
      "fallbackToCloud": { "type": "boolean", "default": true }
    }
  }
}
```

### 5.2 虚拟模型注册

插件在 OpenClaw Gateway 上注册一个自定义路由：

```
POST /v1/chat/completions  (model: "aiping:claw")
→ 插件拦截 → 路由决策 → 转发到 local 或 cloud
→ 返回 OpenAI-compatible 响应
```

用户在 OpenClaw 中选择 `aiping:claw` 作为模型，完全透明。

---

## 6. 数据流

```
用户消息
    │
    ▼
[OpenClaw Gateway]
    │  识别 model="aiping:claw"
    ▼
[ModelRouter.handleRequest()]
    │
    ├─► [Scorer.score(messages)]
    │       ├─ countTokens()      → 0-30 pts
    │       ├─ detectCodeBlocks() → 0-20 pts
    │       ├─ matchKeywords()    → 0-15 pts
    │       ├─ countTurns()       → 0-20 pts
    │       └─ checkOverride()    → forced / 0
    │
    ├─► [Router.decide(score)]
    │       └─ local | cloud
    │
    ├─► [LocalAdapter.forward()] 或 [CloudAdapter.forward()]
    │       └─ HTTP POST to Ollama / AIPing
    │
    └─► 返回 Response 给 OpenClaw
```

---

## 7. 安装体验

```bash
# 一键安装
openclaw plugins install @aiping.cn/model_router

# 安装后自动触发配置向导
# 或手动配置
openclaw plugins config @aiping.cn/model_router set aipingApiKey "sk-xxxxxxxx"
openclaw plugins config @aiping.cn/model_router set localProxyUrl "http://localhost:11434"
```

---

## 8. 扩展性设计

### 8.1 规则引擎插件化

`RuleScorer` 接口允许未来添加新维度：

```typescript
interface RuleScorer {
  name: string;
  weight: number;
  score(req: ChatRequest): number;   // 返回 0-1
}
```

新增规则只需实现接口并注册，无需修改核心路由逻辑。

### 8.2 未来扩展方向

| 优先级 | 功能 | 说明 |
|--------|------|------|
| P1 | 多本地模型支持 | 根据类型路由到不同本地模型（代码模型 vs 对话模型） |
| P1 | 路由统计面板 | 记录每次路由决策，可视化本地/云端使用比例 |
| P2 | ML 分类器 | 用轻量 ONNX 模型替代规则评分 |
| P2 | 成本追踪 | 累计云端 token 消耗和费用估算 |
| P3 | A/B 测试模式 | 按比例随机分流，评估模型质量差异 |
| P3 | 离线缓存 | 语义缓存重复查询 |

### 8.3 多路由策略

未来可通过配置切换路由策略：

```typescript
type RoutingStrategy = 
  | 'rule-based'      // 当前默认：规则评分
  | 'cost-optimized'  // 最小化 API 成本
  | 'latency-first'   // 优先本地（除非置信度低）
  | 'quality-first'   // 优先云端（除非明确简单）
  | 'round-robin'     // 轮询（A/B 测试）
```

---

## 9. 技术栈

| 组件 | 选型 | 理由 |
|------|------|------|
| 语言 | TypeScript | OpenClaw 生态标准，类型安全 |
| HTTP 客户端 | 原生 `fetch` | Node 18+ 内置，零依赖 |
| 配置存储 | OpenClaw config API | 插件标准方式，持久化 |
| 流式响应 | Web Streams API | 原生支持 SSE/chunked 转发 |
| 测试 | Vitest | 轻量，与 TypeScript 原生集成 |

---

## 10. 风险与缓解

| 风险 | 概率 | 影响 | 缓解方案 |
|------|------|------|---------|
| 本地模型未启动 | 高 | 中 | 自动 fallback 到云端 + 错误日志 |
| AIPing API Key 无效 | 中 | 高 | 向导测试 + 友好错误提示 |
| 本地模型响应慢 | 中 | 低 | 可配置超时，超时后 fallback |
| 评分误判（复杂任务走本地）| 低 | 中 | 用户可用 `@cloud` 强制覆盖 |
| 网络延迟导致云端慢 | 低 | 低 | 流式响应降低感知延迟 |

---

## 11. 里程碑

| 里程碑 | 目标 | 状态 |
|--------|------|------|
| M1 | 核心路由引擎 + 两个适配器 | ✅ 实现中 |
| M2 | OpenClaw 插件集成 + 配置向导 | ✅ 实现中 |
| M3 | npm 发布 + 一键安装测试 | 📋 待验证 |
| M4 | 路由统计 + 用户反馈调优 | 📋 规划中 |

---

## 附录：参考资料

- [ClawRouter — BlockRunAI](https://github.com/BlockRunAI/ClawRouter) — 15维度路由，本项目简化参考
- [manifest — mnfst](https://github.com/mnfst/manifest) — OpenClaw 插件架构参考
- [OpenClaw Plugin API](https://open-claw.bot/docs/plugins/api) — 官方插件开发文档
- [AIPing API](https://aiping.cn/api/v1) — 云端模型服务
- [Ollama OpenAI Compatibility](https://ollama.com/blog/openai-compatibility) — 本地模型接口标准
