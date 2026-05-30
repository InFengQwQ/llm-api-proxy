# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

这是一个 **统一 LLM API 代理网关**，核心目标是：

- 将多个 LLM Provider（OpenAI、Anthropic、DeepSeek、Gemini 等）抽象为单一端点
- 当一个 Provider 不可用时**自动切换**到下一个健康 Provider，对调用方透明
- 支持 OpenAI Chat Completions API 和 Anthropic Messages API 两种入口
- 统一管理 API Key、路由策略、熔断器、请求日志

## 技术栈

- **语言**: TypeScript
- **运行时**: Node.js 22+
- **框架**: Express.js（HTTP）+ 异步请求转发
- **配置**: YAML（`config.yaml`）
- **存储**: SQLite（请求日志、路由状态）+ 内存（缓存、熔断器）
- **部署**: Docker + docker-compose（一键启动）

## 核心架构

### 入口层
- `POST /v1/chat/completions` — OpenAI 兼容端点
- `POST /v1/messages` — Anthropic Messages API 端点
- `GET /v1/models` — 模型列表（聚合所有 Provider 的可用模型）

### 中间件链
请求经过以下中间件：
1. **认证中间件** — 验证 master key 或 per-client key
2. **限流中间件** — per-key RPM/TPM 控制
3. **路由中间件** — 将请求路由到目标 Provider
4. **转发层** — 适配不同 Provider 的请求/响应格式
5. **日志中间件** — 记录请求到 SQLite

### Provider 抽象层（`src/providers/`）
每个 Provider 是独立的 adapter，实现统一接口：
```typescript
interface LLMProvider {
  name: string;
  capabilities: ('chat' | 'streaming' | 'tools' | 'images')[];
  send(request: ChatRequest): Promise<ChatResponse>;
  sendStreaming(request: ChatRequest): AsyncGenerator<StreamChunk>;
  health(): Promise<ProviderHealth>;
}
```

### 路由与故障切换（`src/router/`）
- **熔断器模式** — 连续失败 N 次后 open，跳过该 Provider；定期发送 probe 探测恢复
- **优先级路由** — 按配置顺序尝试 Provider 列表
- **会话粘性** — 同一会话（session_id）尽量路由到同一 Provider，保证上下文连贯性
- **动态降权** — 429 响应后临时降低该 Provider 权重，权重随时间衰减恢复

### 格式适配层（`src/adapters/`）
将请求/响应在 Provider 间做格式转换：
- OpenAI → Anthropic（工具定义格式差异）
- Anthropic → OpenAI（system prompt 位置差异）
- 流式响应的 SSE 格式统一

## 目录结构

```
src/
  index.ts              # 入口，Express 服务器初始化
  config/               # YAML 配置加载与验证
  middleware/           # 认证、限流、日志中间件
  providers/            # Provider adapter 实现
    openai.ts
    anthropic.ts
    deepseek.ts
    gemini.ts
    ollama.ts
  router/               # 路由逻辑与熔断器
    router.ts
    circuit-breaker.ts
    session-affinity.ts
  adapters/             # 格式转换器
  types/                # 共享 TypeScript 类型
  db/                   # SQLite 初始化与查询
config.yaml             # 主配置文件
docker-compose.yml      # Docker 部署配置
```

## 常用命令

```bash
# 安装依赖
npm install

# 开发模式（热重载）
npm run dev

# 构建
npm run build

# 生产运行
npm start

# Docker 部署
docker-compose up --build

# 单测
npm test

# 单测（监听模式）
npm run test:watch

# 单个测试文件
npx vitest run src/router/router.test.ts
```

## 配置（`config.yaml`）结构

```yaml
server:
  host: "0.0.0.0"
  port: 3000
  master_key: "sk-xxx"          # 主密钥

providers:
  - name: openai
    api_key: "${OPENAI_API_KEY}"
    base_url: "https://api.openai.com/v1"
    models: ["gpt-4o-mini", "gpt-4o"]
    circuit_breaker:
      failure_threshold: 3     # 连续失败次数阈值
      recovery_timeout: 30     # 秒，探测恢复间隔
  - name: anthropic
    api_key: "${ANTHROPIC_API_KEY}"
    models: ["claude-sonnet-4-7", "claude-haiku-4"]
    circuit_breaker:
      failure_threshold: 3
      recovery_timeout: 30

routes:
  - model_alias: "default"
    targets: ["anthropic", "openai"]   # 按优先级排列的 Provider 列表
  - model_alias: "fast"
    targets: ["openai:gpt-4o-mini", "deepseek"]

rate_limits:
  default_rpm: 60
  default_tpm: 90000

database:
  path: "./data/gateway.db"
```

## 与现有项目的差异化设计

| 特性 | freellm | free-llm-gateway | AI-API-Failover-Router | 本项目 |
|------|---------|-----------------|----------------------|--------|
| Anthropic Messages API 原生入口 | ❌ | ❌ | ❌ | ✅ |
| Function Calling 翻译 | ❌ | 部分 | ❌ | ✅ |
| 流式跨 Provider 切换 | ❌ | 流式支持但无切换 | ❌ | ✅ |
| SQLite 持久化状态 | ❌ | ✅ | ❌ | ✅ |
| 会话粘性路由 | ❌ | ✅ | ❌ | ✅ |
| 熔断器 + 动态降权 | 熔断器 | 动态惩罚 | 熔断器 | 两者兼有 |
| 多 Key 轮换 | ✅ | ❌ | ❌ | 可选支持 |

## 模型命名约定

全局统一使用 `<provider>/<model_id>` 格式，其中 **provider 名称为用户在配置中自定义的别名**（非固定 provider 类型名），例如：

```
我的Claude/claude-sonnet-4-7
备用OpenAI/gpt-4o-mini
公司DeepSeek/deepseek-chat
本地Ollama/llama3
```

- 调用方在请求中传入 `model: "我的Claude/claude-sonnet-4-7"` 即可路由到对应配置
- `/v1/models` 接口返回的模型列表按此格式聚合展示
- 路由层解析出 provider 别名后，通过配置找到对应的 adapter 类型（openai/anthropic/ollama 等）进行请求转发
- 同一 provider 类型可配置多个实例，用不同的别名区分

## 关键设计决策

- **YAML 配置优先**：不需要重新编译即可调整路由和 Provider 参数
- **请求日志不可关闭**（但可配置脱敏级别）：用于调试和审计
- **不引入外部消息队列**：保持部署简洁，用内存队列处理跨 Provider 重试