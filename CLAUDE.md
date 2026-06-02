# CLAUDE.md

## 项目概述

统一 LLM API 代理网关：将多个 LLM Provider 抽象为单一端点，当一个 Provider 不可用时自动切换。

**入口**：5 种原生 API 协议 → 内部 `ChatCompletionRequest` → 上游 Provider → `ChatCompletionResponse` → 原生响应

| 端点 | 协议 |
|------|------|
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/messages` | Anthropic Messages |
| `POST /v1/responses` | OpenAI Responses |
| `POST /v1beta/models/{model}:generateContent` | Google Gemini |
| `POST /api/chat` | Ollama Chat |
| `GET /v1/models` | 聚合模型列表 |
| `GET /health` | 健康检查 |
| `GET /admin/providers` | Provider 状态 |
| `GET /admin/logs` | 请求日志 |

## 技术栈

TypeScript · Node.js 22+ · Express.js · YAML 配置 · SQLite · Zod · Docker

## 核心架构

```
Request → EntryConverter (原生→CCR) → Router → ProviderAdapter → Upstream
                                        ↓
                               CircuitBreaker / 会话粘性 / 动态降权
```

### 两层格式转换

- **EntryConverter** (`providers/base.ts`)：5 种入口协议 ↔ `ChatCompletionRequest`/`ChatCompletionResponse`
- **ProviderAdapter** (`providers/base.ts`)：`ChatCompletionRequest` ↔ 上游协议（OpenAI / Anthropic / Google / Ollama / Responses）

### Provider 抽象

```typescript
interface ProviderAdapter {
  send(req: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  sendStreaming(req: ChatCompletionRequest): AsyncGenerator<StreamChunk>;
  health(): Promise<ProviderHealth>;
  fetchModels(): Promise<string[]>;
}
```

`MultiProtocolAdapter`（`type: [openai, anthropic, ...]` 或 `type: auto`）维护 model→adapter 缓存，首次请求自动探测正确协议。

### 路由 (`router/`)

- **CircuitBreaker**：连续失败 N 次后 open，跳过该 Provider；probe 探测恢复
- **会话粘性**：同 session 路由到同一 Provider（TTL 10 分钟）
- **动态降权**：429 后标记模型过热，冷却后恢复
- **Auto 路由组**：`auto:<group>` 在候选模型间自动切换

## 目录结构

```
src/
  index.ts              # 入口，启动 + 优雅关闭（调用 destroy/stopFlushInterval）
  app.ts                # Express app，路由注册，全局错误处理
  config/               # YAML 加载 + Zod 校验
  db/                   # SQLite 初始化 + 请求日志写入
  middleware/
    request-logger.ts   # 请求日志（文件 + 体捕获）
  providers/
    base.ts             # ProviderAdapter / EntryConverter 接口
    index.ts            # adapterMap + createAdapter 工厂
    multi.ts            # 多协议 auto/array 代理
    adapters/
      openai.ts         # OpenAI Chat Completions
      openai-responses.ts  # OpenAI Responses API
      anthropic.ts      # Anthropic Messages
      google.ts         # Google Gemini
      ollama.ts         # Ollama
  router/
    index.ts            # Router 类（路由/auto组/会话粘性/模型热度/日志刷盘）
    circuit-breaker.ts  # 熔断器
  types/                # 共享类型
config.yaml             # 实际配置（不入 git）
config.example.yaml     # 配置模板
build.ps1               # Docker 构建 + 部署 + 健康检查
```

## 常用命令

```bash
npm run dev        # 开发模式（tsx watch）
npm run build      # 构建（tsc）
npm start          # 生产运行
npm test           # 单测（vitest）
npm run lint       # 类型检查（tsc --noEmit）
npm run docker     # Docker 部署（build.ps1）
```

## 模型命名约定

- `ProviderName/model_id` → 直连
- `auto:group` → 自动路由组
- `auto:group/sessionId` → 带会话粘性的自动路由

## 关键设计

- **YAML 配置优先**：改配置无需重新编译
- **请求日志不可关闭**（可配置脱敏级别）
- **无外部消息队列**：内存队列处理跨 Provider 重试
- **生命周期**：`Router.destroy()` 清理定时器，`stopFlushInterval()` 刷盘并停止日志定时器