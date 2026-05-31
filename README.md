# LLM API Proxy

统一 LLM API 代理网关——将多个 LLM Provider 聚合为单一端点，自动路由与故障切换。

## 功能

- OpenAI、Anthropic、DeepSeek、Gemini、Ollama 多 Provider 支持
- 熔断器 + 动态降权，Provider 不可用时自动切换
- `auto:<group>` 路由组，多模型间自动 failover
- SSE 流式响应透明转发
- OpenAI `/v1/chat/completions` + Anthropic `/v1/messages` 双端点
- SQLite 请求日志 + 文件日志（请求/响应体完整捕获）
- 模型命名统一为 `<provider>/<model>` 格式

## 快速开始

```bash
cp config.example.yaml config.yaml    # 复制并填入 API Key
npm install
npm run dev                           # 开发模式（热重载）
```

## API

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8348/v1", api_key="sk-dummy")
client.chat.completions.create(
    model="OpenRouter/deepseek/deepseek-v4-flash:free",
    messages=[{"role": "user", "content": "Hello"}]
)
```

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

## 配置

```yaml
providers:
  - name: "OpenRouter"
    type: openai
    api_key: "${OPENROUTER_API_KEY}"
    base_url: "https://openrouter.ai/api/v1"
    models: [deepseek/deepseek-v4-flash:free]
    circuit_breaker:
      failure_threshold: 3
      recovery_timeout: 30

auto_routing:                        # 可选：多模型自动 failover
  default:
    targets:
      - "OpenRouter/deepseek/deepseek-v4-flash:free"
      - "NVIDIA/minimaxai/minimax-m2.7"
```

## Docker

```bash
docker compose up --build
```

## 开发

```bash
npm run build    # tsc 编译
npm test         # vitest
npm run lint     # tsc --noEmit 类型检查
```