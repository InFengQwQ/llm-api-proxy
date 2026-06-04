/**
 * 共享转换工具：各适配器共用的 Unified ↔ 其他格式 转换逻辑
 */

import type {
  UnifiedMessage,
  UnifiedContentBlock,
  UnifiedRequest,
  UnifiedResponse,
  UnifiedStreamEvent,
  ToolCall,
  ChatMessage,
} from '../types/api.js';
import { readLines } from './base.js';

// ═══════════════════════════════════════════════
// SSE 流解析：从 Router 输出的 UnifiedStreamEvent SSE → 事件迭代器
// ═══════════════════════════════════════════════

/**
 * 将 Router 输出的 SSE 流（每行 `data: <UnifiedStreamEvent JSON>`）
 * 解析为 UnifiedStreamEvent 异步迭代器。
 * 所有入口协议的 transformStream 共用此函数。
 */
export async function* parseUnifiedSSE(
  source: ReadableStream<Uint8Array>,
): AsyncGenerator<UnifiedStreamEvent> {
  for await (const line of readLines(source.getReader())) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data: ')) continue;
    const data = trimmed.slice(6).trim();
    if (data === '[DONE]') continue;
    try {
      yield JSON.parse(data) as UnifiedStreamEvent;
    } catch { /* skip malformed chunks */ }
  }
}

// ═══════════════════════════════════════════════
// Content block 收集器（流式使用）
// ═══════════════════════════════════════════════

export interface AccumulatorState {
  text: string;
  thinking: string;
  toolUses: Map<number, { id: string; name: string; args: string }>;
}

export function createAccumulator(): AccumulatorState {
  return { text: '', thinking: '', toolUses: new Map() };
}

export function applyEvent(state: AccumulatorState, event: UnifiedStreamEvent): void {
  switch (event.type) {
    case 'text_delta':
      state.text += event.text;
      break;
    case 'thinking_delta':
      state.thinking += event.thinking;
      break;
    case 'tool_use_start':
      state.toolUses.set(event.index, { id: event.id, name: event.name, args: '' });
      break;
    case 'tool_use_delta':
      const tu = state.toolUses.get(event.index);
      if (tu) tu.args += event.partial_json;
      break;
  }
}

export function accumulatorToContent(state: AccumulatorState): UnifiedContentBlock[] {
  const blocks: UnifiedContentBlock[] = [];
  if (state.text) blocks.push({ type: 'text', text: state.text });
  if (state.thinking) blocks.push({ type: 'thinking', thinking: state.thinking });
  for (const [, tu] of state.toolUses) {
    let input: Record<string, unknown> = {};
    try { input = JSON.parse(tu.args || '{}'); } catch { /* ignore */ }
    blocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input });
  }
  return blocks;
}

// ═══════════════════════════════════════════════
// OpenAI ChatMessage[] ↔ UnifiedMessage[]
// ═══════════════════════════════════════════════

export function chatMessagesToUnified(msgs: ChatMessage[]): UnifiedMessage[] {
  return msgs.map(m => {
    const blocks: UnifiedContentBlock[] = [];

    if (m.content) {
      if (typeof m.content === 'string') {
        blocks.push({ type: 'text', text: m.content });
      } else {
        // Array of content parts (multimodal): extract text parts
        for (const part of m.content) {
          if (part.type === 'text' && part.text) {
            blocks.push({ type: 'text', text: part.text });
          }
          // image_url parts are silently dropped — they don't map to Unified IR
        }
      }
    }

    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
    }

    return {
      role: m.role,
      content: blocks,
      name: m.name,
      tool_call_id: m.tool_call_id,
    };
  });
}

export function unifiedToChatMessages(msgs: UnifiedMessage[]): ChatMessage[] {
  // Build a tool_call_id → name map from tool_use blocks so we can fill in
  // missing `name` on tool-role messages — required by OpenAI-compatible APIs.
  const toolNameMap = new Map<string, string>();
  for (const m of msgs) {
    for (const b of m.content) {
      if (b.type === 'tool_use') {
        const id = (b as { type: 'tool_use'; id: string; name: string }).id;
        const name = (b as { type: 'tool_use'; id: string; name: string }).name;
        if (id && name) toolNameMap.set(id, name);
      }
    }
  }

  return msgs.map(m => {
    const texts = m.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text');
    const toolUses = m.content.filter((b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } => b.type === 'tool_use');

    const toolCalls: ToolCall[] | undefined = toolUses.length > 0
      ? toolUses.map(tu => ({
          id: tu.id,
          type: 'function' as const,
          function: { name: tu.name, arguments: JSON.stringify(tu.input) },
        }))
      : undefined;

    // Resolve name for tool-role messages: prefer explicit name, then look up via tool_call_id
    let name = m.name;
    if (m.role === 'tool' && !name && m.tool_call_id) {
      name = toolNameMap.get(m.tool_call_id);
    }

    return {
      role: m.role,
      content: texts.map(t => t.text).join('') || null,
      name,
      tool_call_id: m.tool_call_id,
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
    };
  });
}

// ═══════════════════════════════════════════════
// Content Block 提取工具
// ═══════════════════════════════════════════════

export function blocksToToolCalls(blocks: UnifiedContentBlock[]): ToolCall[] {
  return blocks
    .filter((b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } => b.type === 'tool_use')
    .map(b => ({
      id: b.id,
      type: 'function' as const,
      function: { name: b.name, arguments: JSON.stringify(b.input) },
    }));
}

export function blocksToText(blocks: UnifiedContentBlock[]): string {
  return blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('');
}

export function blocksToThinking(blocks: UnifiedContentBlock[]): string {
  return blocks
    .filter((b): b is { type: 'thinking'; thinking: string } => b.type === 'thinking')
    .map(b => b.thinking)
    .join('');
}
