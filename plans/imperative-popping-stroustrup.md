# Implementation Plan: Fix Google Thinking, Fix Ollama Name Field, Unify Adapter Style

## Context

Three issues need to be addressed:

1. **Google Gemini thinking bug**: When using the Gemini API protocol, thinking/reasoning content is emitted as regular `text` instead of being marked as `thinking`. Google uses a `thought: true` boolean flag on parts to distinguish reasoning content, not a `thinking` string property.

2. **Ollama missing `name` field**: Using Ollama protocol to access the proxy fails with `missing field 'name'` because the `toInternal()` entry converter uses a FIFO queue (`toolCallQueue`) that only matches within a single request — in multi-turn conversations where tool results come from prior turns, the queue is empty and `name` is undefined.

3. **Code style unification**: The five adapters have inconsistent naming (`toAnthropicRequest` vs `buildOllamaRequest` vs `buildRequestBody`), import aliases (`ProviderApiError` vs `ProviderApiErrorClass`), and helper function patterns. Aligning them makes future protocol additions easier.

---

## Step 1: Update `GoogleResponse` type in `src/types/api.ts`

Add `thought`, `functionCall`, and `thinking` fields to the Google parts type definition (lines 201-211):

```typescript
export interface GoogleResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;      // Google's thinking flag
        thinking?: string;      // alternative thinking field
        functionCall?: { name: string; args: Record<string, unknown> };
      }>;
      role?: string;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}
```

**File**: `src/types/api.ts` lines 201-211

---

## Step 2: Fix Google Gemini thinking content handling in `src/providers/adapters/google.ts`

### 2a: Fix `send()` response parsing (~lines 107-113)

Currently checks `else if` for thinking, which skips thinking when `text` is also present. Fix to check `thought` flag first:

```typescript
for (const p of parts) {
  if (p.thought) {
    content.push({ type: 'thinking', thinking: p.text ?? '' });
  } else if (p.text !== undefined) {
    content.push({ type: 'text', text: p.text });
  }
  if (p.functionCall) {
    content.push({ type: 'tool_use', id: `call_${Date.now()}`, name: p.functionCall.name, input: p.functionCall.args ?? {} });
  }
}
```

### 2b: Fix `sendStreaming()` type annotation and part handling (~lines 142-155)

Update the `parts` type annotation to include `thought` and `functionCall` fields, and check `thought` flag:

```typescript
const parts: Array<{ text?: string; thought?: boolean; thinking?: string; functionCall?: { name: string; args: Record<string, unknown> } }> = data.candidates?.[0]?.content?.parts ?? [];

for (const [idx, part] of parts.entries()) {
  if (part.thought) {
    if (!started) { yield { type: 'message_start', id: msgId, model: request.model }; started = true; }
    yield { type: 'thinking_delta', thinking: part.text ?? part.thinking ?? '', index: idx };
  } else if (part.text !== undefined) {
    if (!started) { yield { type: 'message_start', id: msgId, model: request.model }; started = true; }
    yield { type: 'text_delta', text: part.text, index: idx };
  }
  // ... functionCall handling unchanged
}
```

### 2c: Fix `toInternal()` entry converter (~lines 219-223)

Add `thought` flag handling for incoming Gemini requests:

```typescript
} else if (part.text !== undefined) {
  msgs.push({
    role: c.role === 'model' ? 'assistant' : 'user',
    content: [{ type: part.thought ? 'thinking' : 'text', ...(part.thought ? { thinking: part.text } : { text: part.text }) }],
  });
}
```

### 2d: Fix `fromInternal()` (~lines 253-265)

Add `thought: true` flag when converting thinking blocks back to Gemini format:

```typescript
else if (b.type === 'thinking') parts.push({ text: b.thinking, thought: true });
```

### 2e: Fix `transformStream()` (~lines 279-290)

Add `thought: true` flag to thinking delta output in Gemini streaming format:

```typescript
case 'thinking_delta':
  controller.enqueue(encoder.encode(
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: event.thinking, thought: true }], role: 'model' } }] })}\n\n`
  ));
  break;
```

---

## Step 3: Fix Ollama `name` field bug in `src/providers/adapters/ollama.ts`

### 3a: Fix `toInternal()` entry converter (~lines 164-210)

Replace the FIFO `toolCallQueue` array with a `Map<string, string>` built from ALL messages before processing, so tool results from any turn can find their `name` and `tool_call_id`:

```typescript
toInternal(body: Record<string, unknown>): UnifiedRequest {
  const options = (body.options ?? {}) as Record<string, unknown>;
  const rawMsgs = (body.messages ?? []) as Array<{ role: string; content: string; name?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string }> }>;

  // Build a map from ALL messages — tool_use IDs → tool names
  const toolNameMap = new Map<string, string>();
  for (const m of rawMsgs) {
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        toolNameMap.set(tc.id, tc.function.name);
      }
    }
  }

  const msgs = rawMsgs.map(m => {
    const blocks: UnifiedContentBlock[] = [];
    if (m.content) blocks.push({ type: 'text', text: m.content });
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
    }

    // For tool role messages, look up name from the map
    let name = m.name;
    let toolCallId: string | undefined;
    if (m.role === 'tool') {
      if (!name && m.tool_call_id) {
        name = toolNameMap.get(m.tool_call_id) ?? name;
      }
      // If Ollama doesn't send tool_call_id, we still need it for UnifiedMessage
      // but without it we can't resolve — leave undefined and let adapter handle
      toolCallId = m.tool_call_id;
    }

    return { role: m.role as UnifiedMessage['role'], content: blocks, name, tool_call_id: toolCallId };
  });

  return { ... };
}
```

Wait — checking Ollama protocol: Ollama's native format for tool results uses `tool_call_id` directly on the message, matching OpenAI's format. The current code ignores it entirely. Let me also check Ollama's actual API format...

Actually, Ollama tool role messages have:
- `role: "tool"`
- `tool_call_id: "call_xxx"` (present in newer Ollama versions)
- `content: "result text"`
- `name: "function_name"` (optional, some providers require it)

The fix: use `m.tool_call_id` directly from the incoming Ollama message, and look up the name from `toolNameMap` when `m.name` is missing. Remove the FIFO queue entirely.

### 3b: Fix `fromInternal()` — change `reasoning_content` to `thinking`

The Ollama native API uses `thinking` field (not OpenAI's `reasoning_content`):

```typescript
// Before:
...(reasoningContent ? { reasoning_content: reasoningContent } : {})
// After:
...(reasoningContent ? { thinking: reasoningContent } : {})
```

### 3c: Fix `transformStream()` — thinking content should use `thinking` field not `content`

```typescript
// Before:
case 'thinking_delta':
  controller.enqueue(encoder.encode(
    JSON.stringify({ model, created_at: createdAt, message: { role: 'assistant', content: event.thinking, images: null }, done: false }) + '\n'
  ));
  break;

// After:
case 'thinking_delta':
  controller.enqueue(encoder.encode(
    JSON.stringify({ model, created_at: createdAt, message: { role: 'assistant', content: '', thinking: event.thinking }, done: false }) + '\n'
  ));
  break;
```

---

## Step 4: Unify adapter code style across all five files

### 4a: Standardize method names

Unify request-building method names across adapters:

| Adapter | Current | Target |
|---------|---------|--------|
| OpenAI | `buildRequestBody()` | `buildRequest()` |
| Anthropic | `toAnthropicRequest()` | `buildRequest()` |
| Google | `toGoogleRequest()` | `buildRequest()` |
| Ollama | `buildOllamaRequest()` | `buildRequest()` |
| OpenAI Responses | `toResponsesRequest()` | `buildRequest()` |

Also rename response conversion methods for consistency:

| Adapter | Current | Target |
|---------|---------|--------|
| Anthropic | `toUnifiedResponse()` | `parseResponse()` |
| OpenAI | `toUnifiedResponse()` | `parseResponse()` |

### 4b: Standardize `ProviderApiError` import alias

All files should import as `ProviderApiError` (not `ProviderApiErrorClass`):

- `openai.ts` line 8: `import { ProviderApiError } from '../../types/api.js'` (remove `Class` suffix alias)

### 4c: Extract `parseResponse()` response parsing from streaming adapters

For Anthropic and OpenAI adapters, the `send()` method directly inlines JSON parsing and response conversion. Standardize to use a clear `parseResponse()` private method, matching the pattern used implicitly.

### 4d: Add `blocksToThinking()` utility to `unified-utils.ts`

Multiple adapters extract thinking content with the same pattern. Add a shared utility:

```typescript
export function blocksToThinking(blocks: UnifiedContentBlock[]): string {
  return blocks
    .filter((b): b is { type: 'thinking'; thinking: string } => b.type === 'thinking')
    .map(b => b.thinking)
    .join('');
}
```

Use it in:
- `openai.ts` `fromInternal()`
- `ollama.ts` `fromInternal()`
- `anthropic.ts` `fromInternal()` (if applicable)

---

## Step 5: Update `openai-responses.ts` style alignment

Read this file and align method naming / import style with the other adapters after the above changes.

---

## Files to Modify

1. `src/types/api.ts` — Update `GoogleResponse` type
2. `src/providers/adapters/google.ts` — Fix thinking handling (5 places)
3. `src/providers/adapters/ollama.ts` — Fix tool name resolution + thinking field (3 places)
4. `src/providers/adapters/openai.ts` — Rename `buildRequestBody` → `buildRequest`, fix import alias
5. `src/providers/adapters/anthropic.ts` — Rename `toAnthropicRequest` → `buildRequest`, `toUnifiedResponse` → `parseResponse`
6. `src/providers/adapters/openai-responses.ts` — Rename `toResponsesRequest` → `buildRequest`
7. `src/providers/unified-utils.ts` — Add `blocksToThinking()` utility

---

## Verification

1. `npm run build` — TypeScript compilation must succeed
2. `npm run lint` — No type errors
3. `npm test` — All existing tests pass
4. Manual test: Send a request via Google Gemini protocol with a thinking model and verify thinking content is marked with `thought: true`
5. Manual test: Send a multi-turn Ollama request with tool calls and verify `name` field is present