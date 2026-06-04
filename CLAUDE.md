# CLAUDE.md — LLM API Proxy

## 项目概述

统一 LLM API 代理网关：支持 5 种入口协议，内部转换为统一中间表示（Unified IR），路由到上游 Provider，再转回上游协议。熔断、会话粘性、热度降权保证可用性。

```
入口协议 → EntryConverter → UnifiedRequest → Router → ProviderAdapter → 上游 API
```

## 入口点

| 端点 | 入口转换器 |
|------|-----------|
| `/v1/chat/completions` | OpenAI Chat (openai.ts) |
| `/v1/messages` | Anthropic (anthropic.ts) |
| `/v1/responses` | OpenAI Responses (openai-responses.ts) |
| `/v1beta/models/{model}:generateContent` | Google Gemini (google.ts) |
| `/api/chat` | Ollama (ollama.ts) |

## 目录结构

```
src/
  index.ts              # 启动 + 优雅关闭
  app.ts                # Express 路由注册、全局错误处理
  config/index.ts       # YAML 加载 + Zod 校验（无默认值，一切以文件为准）
  db/index.ts           # NDJSON 日志写入 + 缓冲刷盘
  middleware/request-context.ts  # requestId、请求体暂存
  providers/
    base.ts             # ProviderAdapter / EntryConverter 接口定义
    index.ts            # createAdapter 工厂 + parseModelId
    multi.ts            # MultiProtocolAdapter（数组/auto 类型）
    unified-utils.ts    # Unified IR ↔ OpenAI ChatMessage 转换、流式累加器
    adapters/
      openai.ts         # OpenAI → Unified 双向转换
      anthropic.ts      # Anthropic → Unified 双向转换
      google.ts         # Google → Unified 双向转换
      ollama.ts         # Ollama → Unified 双向转换
      openai-responses.ts # OpenAI Responses → Unified 双向转换
  router/
    index.ts            # 路由主逻辑（直连 / auto 组 / 会话粘性 / 热度降权）
    circuit-breaker.ts  # 熔断器（closed → open → half_open）
  types/
    api.ts              # Unified IR + 各协议原生类型
    provider.ts         # ProviderType 枚举
```

## 核心架构

### 两层转换

- **EntryConverter**：入口协议原生请求 ↔ `UnifiedRequest` / `UnifiedResponse`
- **ProviderAdapter**：`UnifiedRequest` / `UnifiedResponse` ↔ 上游协议

统一中间表示（`types/api.ts`）使用 Content Block 数组，不偏向任何协议。

### ProviderAdapter 接口

```typescript
interface ProviderAdapter {
  send(req: UnifiedRequest): Promise<UnifiedResponse>;
  sendStreaming(req: UnifiedRequest): AsyncGenerator<UnifiedStreamEvent>;
  health(): Promise<ProviderHealth>;
  fetchModels(): Promise<string[]>;
}
```

`MultiProtocolAdapter` 维护 model→adapter 缓存，首次请求自动探测可用协议。

### 路由

- **熔断器**：连续失败 N 次 → open（跳过），recovery_timeout 后 → half_open（允许探测）
- **会话粘性**：同 sessionId 路由到同一 Provider，TTL 10 分钟
- **模型热度**：429 后标记过热，60s 冷却；连续 3 次 429 停用
- **Auto 路由组**：`auto:<group>` → 按 targets 顺序尝试，跳过已试 + 熔断 + 过热

## 关键设计决策

- **YAML 是唯一配置来源**：config.yaml 必须包含所有必需字段，schema 无 `.default()`。缺字段启动即报错。
- **请求日志不可关闭**：所有请求自动记录 NDJSON，敏感 headers 自动脱敏。
- **无外部消息队列**：跨 Provider 重试由内存队列处理。
- **NDJSON 日志**：`logs/requests.ndjson`，每行一条 JSON。`readLogs()` 支持按 provider/protocol/status/method 筛选。
- **熔断器线程安全**：无锁设计（Node.js 单线程），状态转移：closed → open → half_open → closed。
- **流式处理**：`sendStreaming()` 返回 `AsyncGenerator`，首个 chunk 预取用于探测上游健康。

## 模型命名约定

```
ProviderName/model_id        → 直连
auto:group_name              → 自动路由组（targets 间故障切换）
auto:group_name/sessionId    → 自动路由 + 会话粘性
```

`parseModelId()` 以第一个 `/` 分割 provider 和 model。

## 配置字段速查

config.yaml 的所有必需字段（完整说明见 README）：

**server**: `host`, `port`
**providers[]**: `name`, `type`, `enabled`, `fetch_models`, `compat_output_tokens`, `circuit_breaker.{failure_threshold, recovery_timeout}`
**logging**: `log_dir`, `log_file`
**auto_routing[]**: `name`, `targets`, `failure_threshold`

## 常用命令

```bash
npm run up         # 构建 + 启动 Docker（自动 rebuild）
npm run down       # 停容器
npm run logs       # 跟随容器日志
npm test           # Vitest 单测（本机）
npm run lint       # tsc --noEmit 类型检查
build.ps1          # PowerShell 构建脚本（自动 npm install + 启动）
```
