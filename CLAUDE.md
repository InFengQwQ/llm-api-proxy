# CLAUDE.md

## 项目概述

统一 LLM API 代理网关：支持上游多个 LLM Provider 协议，并提供同样多个协议入口，当一个 Provider 不可用时自动切换。

**入口**：5 种原生 API 协议 → 内部 `UnifiedRequest` → 上游 Provider → `UnifiedResponse` → 原生响应

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
| `GET /admin/providers/:name/health` | 单 Provider 健康 |
| `GET /admin/auto-routing` | Auto 路由组 |
| `GET /admin/auto-routing/heat` | 模型热度降权 |
| `GET /admin/logs` | 请求日志 |

## 技术栈

TypeScript · Node.js 22+ · Express.js · YAML 配置 · SQLite · Zod · Vitest · Docker

## 核心架构

```
Request → EntryConverter (原生→Unified) → Router → ProviderAdapter → Upstream
                                              ↓
                                 熔断 / 会话粘性 / 模型热度降权
```

### 两层格式转换

- **EntryConverter** (`providers/base.ts`)：5 种入口协议 ↔ `UnifiedRequest` / `UnifiedResponse`
- **ProviderAdapter** (`providers/base.ts`)：`UnifiedRequest` ↔ 上游协议（OpenAI / Anthropic / Google / Ollama / Responses）

### Provider 抽象

```typescript
interface ProviderAdapter {
  send(req: UnifiedRequest): Promise<UnifiedResponse>;
  sendStreaming(req: UnifiedRequest): AsyncGenerator<UnifiedStreamEvent>;
  health(): Promise<ProviderHealth>;
  fetchModels(): Promise<string[]>;
}
```

`MultiProtocolAdapter`（`type: [openai, anthropic, ...]` 或 `type: auto`）维护 model→adapter 缓存，首次请求自动探测正确协议。

### 路由 (`router/`)

- **CircuitBreaker**：连续失败 N 次后 open，跳过该 Provider；probe 探测恢复
- **会话粘性**：同 session 路由到同一 Provider（TTL 10 分钟）
- **模型热度降权**：429 后标记模型过热，冷却后恢复
- **Auto 路由组**：`auto:<group>` 在候选模型间自动切换，支持 `auto:<group>/<sessionId>` 会话粘性

## 目录结构

```
src/
  index.ts              # 入口，启动 + 优雅关闭
  app.ts                # Express app，路由注册，全局错误处理
  config/               # YAML 加载 + Zod 校验
  db/                   # SQLite 初始化 + 请求日志（缓冲写入）
  middleware/
    request-context.ts # 请求上下文（requestId / 状态记录）
  providers/
    base.ts             # ProviderAdapter / EntryConverter 接口 + 共享工具
    index.ts            # adapterMap + createAdapter 工厂 + parseModelId
    multi.ts            # 多协议 auto/array 代理
    unified-utils.ts    # Shared converters: accumulators, OpenAI↔Unified, etc.
    adapters/
      openai.ts         # OpenAI Chat Completions
      anthropic.ts      # Anthropic Messages
      google.ts         # Google Gemini
      ollama.ts         # Ollama
      openai-responses.ts  # OpenAI Responses API
  router/
    index.ts            # Router 类（路由/auto组/会话粘性/模型热度/日志刷盘）
    circuit-breaker.ts  # 熔断器
  types/
    api.ts              # Unified IR 类型 + 各协议原生类型 + ProviderHealth + ProviderApiError
    provider.ts         # ProviderType 枚举
config.yaml             # 实际配置（不入 git）
config.example.yaml     # 配置模板
```

## 常用命令

> 一个统一的 Docker 镜像，dev / prod 不区分。改代码就 `npm run up`（自动 rebuild）；强制从零走 `build.ps1`（PowerShell）。

```bash
npm run up         # 启动容器（源码变了自动 rebuild）
build.ps1          # 强制 down → build → up（PowerShell）
npm run down       # 停容器
npm run logs       # 跟随容器日志
npm test           # 单测（vitest，主机跑）
npm run lint       # 类型检查（tsc --noEmit）
```

## 模型命名约定

- `ProviderName/model_id` → 直连
- `auto:group` → 自动路由组
- `auto:group/sessionId` → 带会话粘性的自动路由

## 关键设计

- **YAML 配置优先**：改配置无需重新编译
- **请求日志不可关闭**（敏感 headers 自动脱敏）
- **无外部消息队列**：内存队列处理跨 Provider 重试
- **生命周期**：`Router.destroy()` 清理定时器，`stopLogBuffer()` 刷盘并停止日志定时器