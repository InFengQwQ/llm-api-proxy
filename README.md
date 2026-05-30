# LLM API Proxy

统一 LLM API 代理网关——将多个 LLM Provider 聚合为单一端点，自动路由与故障切换。

## 功能特性

- **多 Provider 聚合**：支持 OpenAI、Anthropic、Ollama，可扩展更多 Provider
- **统一模型命名**：`<provider>/<model_id>` 格式（如 `我的Claude/claude-sonnet-4-7`）
- **自动故障切换**：熔断器模式，Provider 失败自动切换到下一个
- **流式响应支持**：SSE 流式输出完整透传
- **SQLite 请求日志**：持久化记录所有请求，支持审计查询
- **OpenAI + Anthropic 双端点**：既可以用 `/v1/chat/completions`（OpenAI SDK），也可以用 `/v1/messages`（Anthropic SDK）

## 快速开始

```bash
# 1. 复制配置
cp config.example.yaml config.yaml

# 2. 编辑 config.yaml，填入 API Key
#    环境变量用 ${VAR_NAME} 语法，例如 ${OPENAI_API_KEY}

# 3. 安装依赖
npm install

# 4. 开发模式运行
npm run dev

# 5. 生产构建
npm run build && npm start
```

## API 使用

### OpenAI SDK 方式

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-dummy",           # 任意值，本地代理不需要真实 key
    base_url="http://localhost:3000/v1"
)

response = client.chat.completions.create(
    model="我的Claude/claude-sonnet-4-7",  # 格式: <provider名>/<模型名>
    messages=[{"role": "user", "content": "Hello!"}]
)
```

### Anthropic SDK 方式

```python
import anthropic

client = anthropic.Anthropic(
    api_key="sk-dummy",
    base_url="http://localhost:3000/v1/messages"
)
# 注意：使用 /v1/messages 端点
```

### 模型列表

```bash
curl http://localhost:3000/v1/models
```

### 健康检查

```bash
curl http://localhost:3000/health
```

## 配置说明

```yaml
providers:
  - name: "我的Claude"        # 任意起的名字，出现在模型名前缀中
    type: anthropic           # openai | anthropic | ollama
    api_key: "${API_KEY}"     # 支持环境变量
    models:
      - claude-sonnet-4-7
      - claude-haiku-4-5
    circuit_breaker:
      failure_threshold: 3    # 连续失败 N 次后断路
      recovery_timeout: 30    # 每 30 秒探测一次恢复
```

## Docker 部署

```bash
docker-compose up --build
```

## 管理接口

- `GET /admin/providers` — 查看所有 Provider 状态和熔断器状态
- `GET /admin/logs?limit=100&provider=我的Claude` — 查询请求日志