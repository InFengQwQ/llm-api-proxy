# LLM API Proxy

统一多 Provider LLM API 代理网关，支持 OpenAI、Anthropic、Google Gemini、Ollama 五种入口协议，自动路由与故障切换。

```
客户端 → 入口协议 → 内部 UnifiedRequest → 路由 → Provider 适配器 → 上游 API
```

## 快速开始

```bash
# 1. 克隆后创建配置
cp config.example.yaml config.yaml
# 编辑 config.yaml 填入你的 API key

# 2. 启动（PowerShell）
build.ps1

# 或手动（任意 shell）
npm install
export PORT=$(grep 'port:' config.yaml | grep -o '\d\+')
docker compose up -d --build
```

服务启动后监听 `http://localhost:8348`（端口由 config.yaml 的 `server.port` 控制）。

## 入口协议

| 端点 | 协议 | 适用客户端 |
|------|------|-----------|
| `POST /v1/chat/completions` | OpenAI Chat | OpenAI SDK、ChatGPT |
| `POST /v1/messages` | Anthropic Messages | Anthropic SDK、Claude |
| `POST /v1/responses` | OpenAI Responses | OpenAI Responses API |
| `POST /v1beta/models/{model}:generateContent` | Google Gemini | Google AI SDK |
| `POST /api/chat` | Ollama Chat | Ollama、Open WebUI |
| `GET /v1/models` | 聚合模型列表 | 模型探测 |
| `GET /health` | 健康检查 | 负载均衡器 |

## 模型命名

```
ProviderName/model_id        → 直连该 Provider 下的模型
auto:group_name              → 自动路由组，在候选间故障切换
auto:group_name/sessionId    → 自动路由 + 会话粘性（同 session 路由到同一 Provider）
```

## 管理接口

| 端点 | 说明 |
|------|------|
| `GET /admin/providers` | 查看 Provider 列表与熔断器状态 |
| `GET /admin/providers/:name/health` | 单个 Provider 健康检查 |
| `GET /admin/auto-routing` | Auto 路由组配置 |
| `GET /admin/auto-routing/heat` | 模型热度降权状态 |
| `GET /admin/logs?limit=100&provider=X` | 请求日志 |

## 配置详解

配置文件 `config.yaml` 是唯一配置来源，所有字段均需显式填写。

### server

| 字段 | 类型 | 说明 |
|------|------|------|
| `host` | string | 监听地址（如 `"0.0.0.0"`） |
| `port` | number | 监听端口（`1`–`65535`） |
| `master_key` | string (可选) | 全局鉴权 key，为空则不校验 |

### providers

Provider 定义了上游 LLM API 的接入信息。

```yaml
providers:
  - name: "MyProvider"          # 唯一标识，用于模型命名（如 "MyProvider/gpt-4"）
    type: openai                # 协议类型
    api_key: "sk-xxx"           # API key（可选，部分 Provider 不需要）
    base_url: "https://..."     # 上游地址（可选，有默认值）
    enabled: true               # 是否启用
    fetch_models: true          # 是否从 /models 端点拉取模型列表
    compat_output_tokens: false # Anthropic 兼容模式：发送 output_tokens 字段
    circuit_breaker:
      failure_threshold: 3      # 连续失败 N 次后打开熔断器
      recovery_timeout: 30      # 熔断后多久尝试恢复（秒）
```

**type 可选值**：

| 值 | 说明 |
|----|------|
| `openai` | OpenAI Chat Completions 协议 |
| `anthropic` | Anthropic Messages 协议 |
| `google` | Google Gemini 协议 |
| `ollama` | Ollama API |
| `openai_responses` | OpenAI Responses API |
| `[type1, type2, ...]` | 多协议数组，按优先级依次尝试 |
| `auto` | 自动探测匹配的协议 |

**type 为数组或 auto 时**，相当于为同一个上游配置了多个协议适配器。首次请求会自动探测哪个协议可用，后续按缓存结果直连。适用于 OpenAI→Anthropic 协议转换等场景。

### rate_limits

全局速率限制（可选，不配置则不限制）：

```yaml
rate_limits:
  rpm: 60        # 每分钟请求数
  tpm: 90000     # 每分钟 token 数
```

### logging

```yaml
logging:
  log_dir: "logs"              # 日志目录（挂载到宿主机）
  log_file: "requests.ndjson"  # 日志文件名（NDJSON 格式，每行一条请求记录）
```

每条日志包含：`request_id`、`method`、`path`、`model`、`provider`、`entry_protocol`、`status_code`、`latency_ms`、`prompt_tokens`、`completion_tokens`、`error_msg` 等。敏感 headers 自动脱敏。

### auto_routing

自动路由组：指定一组候选模型，按优先级依次尝试，失败自动切换。

```yaml
auto_routing:
  - name: free                  # 组名，客户端用 model="auto:free" 调用
    targets:
      - ProviderA/model-1
      - ProviderB/model-2
    failure_threshold: 5        # 连续失败 N 次后跳过该 target
```

客户端只需指定 `model: "auto:free"`，网关自动在候选间重试。

### 完整示例

```yaml
server:
  host: "0.0.0.0"
  port: 8348
  master_key: ""

providers:
  - name: "OpenRouter"
    type: openai
    api_key: "sk-or-..."
    base_url: "https://openrouter.ai/api"
    enabled: true
    fetch_models: true
    compat_output_tokens: false
    circuit_breaker:
      failure_threshold: 3
      recovery_timeout: 30

  - name: "NVIDIA"
    type: openai
    api_key: "nvapi-..."
    base_url: "https://integrate.api.nvidia.com"
    enabled: true
    fetch_models: true
    compat_output_tokens: false
    circuit_breaker:
      failure_threshold: 3
      recovery_timeout: 30

logging:
  log_dir: "logs"
  log_file: "requests.ndjson"

rate_limits:
  rpm: 60
  tpm: 90000

auto_routing:
  - name: free
    targets:
      - OpenRouter/model-a:free
      - NVIDIA/model-b
    failure_threshold: 5
```

## 高级特性

**熔断器** — 每个 Provider 独立熔断。连续失败达到 `failure_threshold` 后跳过该 Provider；经过 `recovery_timeout` 秒后允许探测请求，成功则恢复。

**会话粘性** — `auto:group/sessionId` 模式下，同一 sessionId 会尽量路由到同一 Provider，10 分钟无活动自动过期。

**模型热度降权** — 上游返回 429 时标记该模型"过热"，冷却 60 秒后恢复；连续 3 次 429 则彻底停用该模型。

**环境变量替换** — 配置文件中 `${VAR_NAME}` 会被替换为环境变量值。

## 常用命令

```bash
npm run up         # 构建并启动 Docker 容器
npm run down       # 停止容器
npm run logs       # 查看容器日志
npm test           # 运行单元测试（本机）
npm run lint       # TypeScript 类型检查
```

## 技术栈

TypeScript · Node.js 22 · Express.js · Zod · Docker · NDJSON 日志
