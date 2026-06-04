# Ollama 入口 → NVIDIA API 400 错误修复计划

## 问题背景

用户通过 Ollama 入口 (`POST /api/chat`) 发送请求到代理，代理路由到 NVIDIA Provider（OpenAI 兼容协议），NVIDIA 返回 400 错误：

```
NVIDIA API error 400: "Failed to deserialize the JSON body into the target type: invalid type: null, expected a string"
```

## 根因分析

经过完整链路追踪，确认 **主要原因** 是 Ollama 入口转换器 (`createOllamaEntryConverter().toInternal()`) 中存在 **tools 格式未转换** 的 bug：

### 数据流
```
Ollama 原生请求 → toInternal() → UnifiedRequest → Router → ProviderAdapter (OpenAI) → NVIDIA API
```

### Bug 1（主要原因）：tools 格式未转换

**文件**：`src/providers/adapters/ollama.ts` 第 221 行

```typescript
tools: body.tools as UnifiedRequest['tools'],  // ← 只是类型断言，无转换！
```

- Ollama 原生 tools 格式：`[{type: "function", function: {name, description, parameters}}]`
- `UnifiedTool` 格式：`[{name, description, parameters}]`（扁平结构）
- OpenAI adapter `buildRequest()` 读取 `t.name`、`t.description`、`t.parameters` → 全部 `undefined`
- JSON.stringify 省略 undefined，生成 `{"function": {}}`
- NVIDIA 反序列化器报 "null, expected a string"（缺失的必填字段被视作 null）

### Bug 2（防御）：`options.stop` 可能为 null

**文件**：`src/providers/adapters/ollama.ts` 第 220 行

```typescript
stop_sequences: options.stop as string[] | undefined,
```

如果请求中 `options.stop` 为 `null`，会直接传到 UnifiedRequest 再到 upstream body。

### Bug 3（防御）：`body.tool_choice` 可能为 null

**文件**：`src/providers/adapters/ollama.ts` 第 222 行

```typescript
tool_choice: body.tool_choice as UnifiedRequest['tool_choice'],
```

与 Bug 2 同理，显式 `null` 值不会被过滤。

### 附带问题：tool_calls 中 arguments 可能是对象

**文件**：`src/providers/adapters/ollama.ts` 第 189 行

```typescript
try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ }
```

Ollama API 中 `arguments` 可能已经是对象（而非 JSON 字符串），`JSON.parse(obj)` 会抛错，导致 input 丢失（变成 `{}`）。

## 修改计划

### 1. 修复 tools 格式转换 (`ollama.ts` ~221 行)

将 `toInternal()` 中的 tools 映射从 Ollama 格式转换为 UnifiedTool 格式：

```typescript
tools: Array.isArray(body.tools)
  ? (body.tools as Array<Record<string, unknown>>).map((t: Record<string, unknown>) => {
      const fn = (t.function ?? t) as Record<string, unknown>;
      return {
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters,
      };
    })
  : undefined,
```

同时处理两种情况：`t.function` 存在（Ollama 标准格式）或不存在（已是扁平格式，兼容性）。

### 2. 修复 null 值防御 (`ollama.ts` ~220, 222 行)

```typescript
// stop_sequences: null → undefined 转换
stop_sequences: (options.stop ?? undefined) as string[] | undefined,

// tool_choice: null → undefined 转换  
tool_choice: (body.tool_choice ?? undefined) as UnifiedRequest['tool_choice'],
```

### 3. 修复 arguments 对象/字符串兼容处理 (`ollama.ts` ~189 行)

```typescript
let input: Record<string, unknown> = {};
const args = tc.function.arguments;
if (typeof args === 'string') {
  try { input = JSON.parse(args || '{}'); } catch { /* ignore */ }
} else if (args && typeof args === 'object') {
  input = args as Record<string, unknown>;
}
```

## 涉及文件

- `src/providers/adapters/ollama.ts` — 所有修改都在此文件
- 无其他文件（不需要修改 `unified-utils.ts` 或 `openai.ts`）

## 验证方法

1. **单元测试**：运行 `npm test` 确保现有测试通过
2. **实战测试**：通过 Ollama 客户端发送带 tools 的请求到代理，观察 NVIDIA API 是否正常响应
3. **边界测试**：
   - tools 为 undefined → 不发送 tools 字段
   - tools 为 `[{type: "function", function: {name: "X"}}]` → 正确转换
   - options.stop 为 null → 不发送 stop 字段
   - tool_choice 为 null → 不发送 tool_choice 字段
   - tool_calls 中 arguments 为对象 → 正确解析
