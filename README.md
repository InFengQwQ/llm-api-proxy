# LLM API Proxy

统一 LLM API 代理网关——将多个 LLM Provider 聚合为单一端点，自动路由与故障切换。

## 功能

- **5 类 API 协议**：OpenAI Chat Completions / Responses、Anthropic Messages、Google Gemini、Ollama
- **Multi-Protocol 自动探测**：`type: [openai, anthropic, ...]` 或 `type: auto`，首次请求自动缓存正确协议
- **熔断器 + 动态降权**：连续失败 N 次熔断，定期探测恢复；429 触发热度冷却
- **`auto:<group>` 路由组**：多模型 failover + 会话粘性（同 session_id 尽量路由到同一模型）
- **5 标准入口**：`/v1/chat/completions` · `/v1/messages` · `/v1/responses` · `/v1beta/models/...` · `/api/chat`

## 快速开始

```bash
cp config.example.yaml config.yaml    # 复制并填入 API Key
npm install                           # 安装主机端测试/lint 依赖
npm run up                            # 构建镜像并启动容器
```

## API

### OpenAI 兼容端点

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8348/v1", api_key="sk-dummy")

# 直连模型
client.chat.completions.create(
    model="OpenRouter/deepseek/deepseek-v4-flash:free",
    messages=[{"role": "user", "content": "Hello"}]
)

# Auto 路由组（自动 failover）
client.chat.completions.create(
    model="auto:free",
    messages=[{"role": "user", "content": "Hello"}]
)

# 流式
for chunk in client.chat.completions.create(
    model="auto:free",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True
):
    print(chunk.choices[0].delta.content or "", end="")
```

### 其他协议原生端点

```bash
# Anthropic
curl http://localhost:8348/v1/messages -H "Content-Type: application/json" \
  -d '{"model":"auto:free","max_tokens":4096,"messages":[{"role":"user","content":"Hello"}]}'

# Google Gemini
curl http://localhost:8348/v1beta/models/auto:free:generateContent -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"Hello"}]}]}'

# Ollama
curl http://localhost:8348/api/chat -H "Content-Type: application/json" \
  -d '{"model":"auto:free","messages":[{"role":"user","content":"Hello"}]}'

# OpenAI Responses
curl http://localhost:8348/v1/responses -H "Content-Type: application/json" \
  -d '{"model":"auto:free","input":"Hello"}'
```

### 通用端点

```bash
curl http://localhost:8348/v1/models          # 模型列表
curl http://localhost:8348/health             # 健康检查
```

## 管理端点

| 端点 | 说明 |
|------|------|
| `GET /admin/providers` | Provider 列表及熔断器状态 |
| `GET /admin/providers/:name/health` | 单个 Provider 健康详情 |
| `GET /admin/auto-routing` | Auto 路由组列表 |
| `GET /admin/auto-routing/heat` | 模型热度降权状态 |
| `GET /admin/logs?limit=100&provider=xxx` | 请求日志查询 |

## 模型命名

| 格式 | 示例 |
|------|------|
| `<provider>/<model_id>` | `OpenRouter/deepseek/deepseek-v4-flash:free` |
| `auto:<group>` | `auto:free` |
| `auto:<group>/<sessionId>` | `auto:free/my-session-123` |

## 配置

```yaml
server:
  port: 8348

providers:
  - name: "OpenRouter"
    type: openai
    api_key: "${OPENROUTER_API_KEY}"
    base_url: "https://openrouter.ai/api"

  - name: "OpenCode"                        # 多协议自动探测
    type: [openai, anthropic, google, openai_responses]
    api_key: "${OPENCODE_API_KEY}"
    base_url: "https://opencode.ai/zen"

auto_routing:
  - name: free
    targets:
      - "OpenRouter/deepseek/deepseek-v4-flash:free"
      - "OpenRouter/qwen/qwen3-coder:free"
```

`${VAR_NAME}` 自动替换为环境变量。`base_url` 填服务根地址（不含 API 版本路径）。

### Provider 类型

| type | 协议 | 端点 |
|------|------|------|
| `openai` | OpenAI Chat Completions | `/v1/chat/completions` |
| `openai_responses` | OpenAI Responses API | `/v1/responses` |
| `anthropic` | Anthropic Messages | `/v1/messages` |
| `google` | Google Gemini | `/v1beta/models/{model}:generateContent` |
| `ollama` | Ollama Chat | `/api/chat` |
| `auto` / `[openai, anthropic, ...]` | 自动探测 / 按顺序尝试 | — |

### Auto 路由行为

```
请求 model="auto:free" 时：
 1. 会话粘性：同 sessionId 优先复用上次成功的模型
 2. 按 targets 顺序找第一个 熔断闭合 + 未过热的模型
 3. 429 → 标记过热（60s 冷却），切下一个
 4. 502/网络错误 → 记录失败，切下一个
 5. 全部不可用 → 503
```

## Docker

```bash
npm run up         # 启动容器（源码变了自动 rebuild）
build.ps1          # 强制 down → build → up（PowerShell，每次从零）
npm run down       # 停止并移除容器
npm run logs       # 跟随容器日志
```

挂载：`./config.yaml`（只读）· `llm-data`（named volume，持久化 SQLite）

## 开发

改代码就 `npm run up`——容器内 `tsx` 直接跑 TypeScript，重建即生效，不需要本地 `node`。

```bash
npm test           # vitest 单元测试（主机跑）
npm run lint       # tsc --noEmit 类型检查
```