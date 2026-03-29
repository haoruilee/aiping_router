# @aiping.cn/model_router

> 智能路由：本地 Ollama 小模型处理日常请求，AIPing 云端大模型（Kimi-K2.5）处理复杂任务。  
> 约 **90% 请求走本地**，零成本、低延迟。

[![npm version](https://img.shields.io/npm/v/@aiping.cn/model_router)](https://www.npmjs.com/package/@aiping.cn/model_router)
[![E2E](https://github.com/haoruilee/aiping_router/actions/workflows/e2e.yml/badge.svg)](https://github.com/haoruilee/aiping_router/actions/workflows/e2e.yml)

---
# 如何使用

```
Read https://raw.githubusercontent.com/haoruilee/aiping_router/main/README.md, run 'openclaw plugins install @aiping.cn/model_router' then follow the instructions in that file.`
```


## 工作原理

每条消息按 5 个维度打分，超过阈值才路由到云端：

| 路由目标 | 触发条件 | 优势 |
|---|---|---|
| **本地模型**（Ollama） | 日常对话、短代码、普通问答 | 零延迟、零成本 |
| **AIPing 云端**（Kimi-K2.5） | 超长上下文、大型代码分析、深度推理 | 强能力 |

---

## 一、安装 Ollama 本地模型

> 如果你已经有 Ollama 在跑，直接跳到[第二步](#二安装插件)。

### 1.1 安装 Ollama

**macOS**
```bash
# 方式一：官网安装包（推荐）
# 访问 https://ollama.com/download 下载 macOS 安装包，双击安装
# 安装后 Ollama 会在菜单栏常驻

# 方式二：Homebrew
brew install ollama
```

**Linux**
```bash
curl -fsSL https://ollama.com/install.sh | sh
```

**Windows**
```
访问 https://ollama.com/download 下载 Windows 安装包（.exe），安装后自动启动服务
```

---

### 1.2 启动 Ollama 服务

macOS 安装包版本安装后会自动运行，无需手动启动。  
Linux / 命令行安装 请手动启动：

```bash
ollama serve
```

验证是否在运行：
```bash
curl http://localhost:11434/api/tags
# 正常返回 {"models":[...]}
```

---

### 1.3 拉取本地模型

推荐模型（按内存占用从小到大）：

| 模型 | 大小 | 内存需求 | 适合场景 |
|---|---|---|---|
| `qwen2.5:0.5b` | ~0.4 GB | ≥ 2 GB | 极限轻量，测试用 |
| `qwen2.5:4b` | ~2.3 GB | ≥ 4 GB | **推荐首选**，中文能力强 |
| `qwen2.5:7b` | ~4.4 GB | ≥ 8 GB | 质量更高 |
| `llama3.2:3b` | ~2.0 GB | ≥ 4 GB | 英文能力出色 |
| `phi3.5:mini` | ~2.2 GB | ≥ 4 GB | 推理能力强 |
| `gemma3:4b` | ~3.3 GB | ≥ 6 GB | Google 出品，均衡 |

```bash
# 拉取推荐模型（约 2.3 GB，国内可能需要挂代理）
ollama pull qwen2.5:4b

# 查看已下载的模型
ollama list

# 快速测试模型是否正常
ollama run qwen2.5:4b "你好"
```

> **网络慢？** 可使用国内镜像：
> ```bash
> OLLAMA_HOST=0.0.0.0 ollama serve   # 确保服务在跑
> # 或者直接使用 https://registry.ollama.ai 的国内节点（如有）
> ```

---

## 二、安装插件

```bash
openclaw plugins install @aiping.cn/model_router
```

> **npm 安装遇到问题？** 也可以直接从 GitHub Release 安装：
> ```bash
> openclaw plugins install https://github.com/haoruilee/aiping_router/releases/latest/download/aiping.cn-model_router-1.2.5.tgz
> ```

安装完成后终端会提示：
```
尚未配置 AIPing API Key。
➜  运行配置向导：openclaw model-router-setup
```

---

## 三、运行配置向导

**方式一：交互式向导**（推荐第一次使用）

```bash
openclaw model-router-setup
```

向导会引导你完成以下配置（全程中文，约 2 分钟）：

```
第 1 步：AIPing 云端 API Key
  → 访问 https://aiping.cn/user/user-center 获取
  → 向导会立即验证 Key 是否有效

第 2 步：本地模型地址和模型名
  → 自动检测 Ollama 服务状态
  → 显示已下载模型列表，选序号即可

第 3 步：路由阈值（默认 85，约 90% 走本地）

第 4 步：连通性测试 + 保存配置
```

**方式二：一行命令（CI/CD 或快速配置）**

```bash
openclaw model-router-setup \
  --aiping-api-key "QC-你的Key" \
  --local-model qwen2.5:4b \
  --local-proxy-url http://localhost:11434
```

所有可用参数：

```
--aiping-api-key <key>   AIPing API Key（必填，跳过交互提问）
--local-model <model>    本地模型名称（默认 qwen2.5:4b）
--local-proxy-url <url>  本地 Ollama 地址（默认 http://localhost:11434）
--local-proxy-key <key>  本地代理鉴权 Key（可选，LM Studio 等需要）
--cloud-model <model>    云端模型名称（默认 Kimi-K2.5）
--routing-threshold <n>  路由阈值 0-100（默认 85，越高越偏本地）
--no-fallback            禁用本地失败时自动切换到云端
```

---

## 四、配置 OpenClaw 使用代理端点

插件启动后会在 OpenClaw Gateway 上注册一个 OpenAI 兼容的代理端点：

```
http://localhost:18789/aiping/v1/chat/completions
```

在 `~/.openclaw/openclaw.json` 中添加自定义 provider：

```json
{
  "models": {
    "providers": {
      "aiping": {
        "id": "aiping",
        "api": "openai-completions",
        "url": "http://localhost:18789/aiping/v1",
        "models": [
          {
            "id": "aiping:claw",
            "label": "AIPing 智能路由（本地+云端）"
          }
        ]
      }
    }
  }
}
```

然后重启 Gateway：

```bash
openclaw gateway --restart
```

在 OpenClaw 中选择模型 **`aiping:claw`** 即可。路由自动进行，对你完全透明。

---

## 路由规则详解

每条消息最高得 **85 分**，超过阈值（默认 85）才走云端：

| 维度 | 最高分 | 触发条件 |
|---|---|---|
| Token 数量 | 30 | 估算 > 4000 tokens |
| 代码复杂度 | 20 | 代码块 > 80 行 |
| 强推理关键词 | 15 | "逐步分析"、"深度分析"、"step by step"… |
| 多轮上下文 | 20 | 对话 > 16 轮 |
| 覆盖指令 | — | `@local` 或 `@cloud`（最高优先级） |

### 强制覆盖路由

在消息末尾加指令，忽略所有评分：

```
帮我写个冒泡排序 @local      → 强制本地
帮我做系统架构评审 @cloud    → 强制云端
```

---

## 配置项参考

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `aipingApiKey` | *(必填)* | AIPing API Key，从 [用户中心](https://aiping.cn/user/user-center) 获取 |
| `localProxyUrl` | `http://localhost:11434` | Ollama 或本地代理地址 |
| `localProxyKey` | *(空)* | 本地代理鉴权 Key（可选） |
| `localModel` | `qwen2.5:4b` | 本地模型名称 |
| `cloudModel` | `Kimi-K2.5` | AIPing 云端模型 |
| `routingThreshold` | `85` | 路由阈值 0–100（越高越偏本地） |
| `fallbackToCloud` | `true` | 本地失败时自动切换到云端 |
| `localTimeoutMs` | `30000` | 本地请求超时毫秒数 |
| `debugRouting` | `false` | 打印路由决策日志 |
| `preferCloudForTools` | `code` | 工具路由：`code` / `all` / `false`（见插件 schema） |
| `pinchbenchHeuristics` | `false` | 可选：对上述题型仅加少量分数、**从不强制云端**；默认关闭以尽量走本地 |

---

## 系统架构

```
OpenClaw Gateway (localhost:18789)
  └── /aiping/v1/chat/completions  ← 代理端点
        └── model_router 插件
              ├── RuleScorer（维度 + 可选 PinchBench 启发式，< 1ms）
              │     ├── OverrideScorer         @local/@cloud 强制（优先）
              │     ├── CloudHeuristicScorer   可选小幅加分（默认关，不强制云）
              │     ├── ToolCallScorer         代码工具 + 生图工具
              │     ├── Token / Code / Reasoning / MultiTurn
              ├── LocalAdapter  → http://localhost:11434/v1/chat/completions
              └── CloudAdapter  → https://aiping.cn/api/v1/chat/completions
```

规则引擎可扩展，实现 `RuleScorer` 接口即可添加新维度：

```typescript
interface RuleScorer {
  readonly name: string;
  readonly maxScore: number;
  score(request: ChatRequest): DimensionScore;
}
```

---

## 开发

```bash
git clone https://github.com/haoruilee/aiping_router
cd aiping_router
npm install

npm run build        # 编译 TypeScript
npm test             # 单元测试（47 个）
npm run test:e2e     # 端到端测试（需要 Ollama + AIPing Key）
npm run release patch  # 发布新版本（自动测试 → tag → CI publish）
```

---

## Benchmark — 持续测试不同模型组合

使用 [PinchBench](https://github.com/pinchbench/skill) 自动化测试混合路由效果，支持本地和 CI 两种运行方式。

### 本地一行运行

```bash
# 快速冒烟测试（3 个任务，约 2 分钟）
AIPING_KEY=QC-xxx ./scripts/bench.sh --preset fast

# 默认：qwen2.5:4b local + Kimi-K2.5 cloud
AIPING_KEY=QC-xxx ./scripts/bench.sh

# 自定义模型组合
AIPING_KEY=QC-xxx ./scripts/bench.sh \
  --local-model llama3.2:3b \
  --cloud-model DeepSeek-V3.2 \
  --threshold 80

# 纯云端基线
AIPING_KEY=QC-xxx ./scripts/bench.sh --preset cloud-only

# 查看所有选项
./scripts/bench.sh --help
```

### CI 触发（GitHub Actions）

```bash
# 使用预设
gh workflow run benchmark.yml -f preset=fast

# 自定义模型（也可在 GitHub UI 手动填写）
gh workflow run benchmark.yml \
  -f local_model=qwen2.5:7b \
  -f cloud_model=DeepSeek-V3.2 \
  -f threshold=70
```

### 预设配置（`benchmarks/presets.json`）

| Preset | 本地 | 云端 | 阈值 | 说明 |
|---|---|---|---|---|
| `default` | qwen2.5:4b | Kimi-K2.5 | 85 | 均衡推荐 |
| `fast` | qwen2.5:0.5b | Kimi-K2.5 | 85 | 快速 3 任务验证 |
| `cloud-only` | qwen2.5:0.5b | Kimi-K2.5 | 0 | 纯云端基线 |
| `quality-local` | qwen2.5:7b | Kimi-K2.5 | 100 | 纯本地 |
| `deepseek` | qwen2.5:4b | DeepSeek-V3.2 | 85 | DeepSeek 云端 |
| `llama-local` | llama3.2:3b | Kimi-K2.5 | 85 | Llama 本地 |
| `full` | qwen2.5:4b | Kimi-K2.5 | 85 | 全量，2 次/任务 |

新增 preset：在 `benchmarks/presets.json` 追加一条记录即可。

### 上次结果（qwen2.5:0.5b + Kimi-K2.5, automated-only）

```
  Hybrid  (threshold=85)     33.3%   9 tasks   ← ~90% 走本地
  Cloud   (threshold=0 )     42.6%   9 tasks   ← 100% 走云端
  Quality delta: +9.3pp

  task_00_sanity    ✅ 100%   ✅ 100%   44s / 12s
  task_01_calendar   ❌  0%⏱  ⚠️  83%  125s / 16s
  task_09_files     ✅ 100%   ✅ 100%   79s / 14s
  task_11_clawdhub  ✅ 100%   ✅ 100%   92s / 20s
```

> **关键发现**：路由按文本复杂度分流，短指令（"创建日历事件"）走本地 0.5b 模型，
> 但小模型缺乏工具调用能力导致失败。更换 qwen2.5:4b 或更大模型可显著改善。

---

## 链接

- [AIPing API](https://aiping.cn/api/v1)
- [AIPing 用户中心（获取 API Key）](https://aiping.cn/user/user-center)
- [Ollama 官网](https://ollama.com)
- [OpenClaw 插件文档](https://docs.openclaw.ai/tools/plugin)
- [变更记录](docs/CHANGELOG.md)
- [架构方案 v1.1](docs/plan-v1.1.md)
