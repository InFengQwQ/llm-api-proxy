import type {
  UnifiedRequest, UnifiedResponse, UnifiedStreamEvent,
  UnifiedMessage, UnifiedContentBlock, ProviderHealth,
} from '../../types/api.js';
import { ProviderApiError } from '../../types/api.js';
import type { ProviderConfig } from '../../config/index.js';
import type { ProviderAdapter, EntryConverter } from '../base.js';
import { createHealthCheck, fetchModelsOpenAIFormat, throwOnHttpError, readSSELines } from '../base.js';
import { parseUnifiedSSE } from '../unified-utils.js';

type ResponsesInputItem =
  | { role: 'user' | 'assistant' | 'system' | 'developer'; content: string | Array<{ type: string; text?: string }> }
  | { type: 'function_call_output'; call_id: string; output: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string };

export class OpenAIResponsesAdapter implements ProviderAdapter {
  name: string;
  type = 'openai_responses';

  constructor(private config: ProviderConfig) {
    this.name = config.name;
  }

  private getBaseUrl(): string { return this.config.base_url ?? 'https://api.openai.com'; }

  private getHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.api_key ?? ''}` };
  }

  private buildRequest(req: UnifiedRequest): Record<string, unknown> {
    const systemMsgs = req.messages.filter(m => m.role === 'system');
    const instructions = systemMsgs.length > 0
      ? systemMsgs.flatMap(m => m.content.filter(b => b.type === 'text')).map(b => (b as { type: 'text'; text: string }).text).join('\n')
      : undefined;

    const inputItems: ResponsesInputItem[] = [];
    for (const m of req.messages) {
      if (m.role === 'system') continue;
      if (m.role === 'tool') {
        const text = m.content.filter(b => b.type === 'text').map(b => (b as { type: 'text'; text: string }).text).join('');
        inputItems.push({ type: 'function_call_output', call_id: m.tool_call_id ?? '', output: text });
      } else if (m.role === 'assistant') {
        const texts = m.content.filter(b => b.type === 'text');
        const thinking = m.content.filter(b => b.type === 'thinking');
        const toolUses = m.content.filter(b => b.type === 'tool_use');
        if (texts.length > 0) inputItems.push({ role: 'assistant', content: texts.map(b => (b as { type: 'text'; text: string }).text).join('') });
        if (thinking.length > 0) inputItems.push({ role: 'assistant', content: thinking.map(b => (b as { type: 'thinking'; thinking: string }).thinking).join('') });
        for (const tu of toolUses) {
          const t = tu as { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
          inputItems.push({ type: 'function_call', call_id: t.id, name: t.name, arguments: JSON.stringify(t.input) });
        }
      } else {
        const text = m.content.filter(b => b.type === 'text').map(b => (b as { type: 'text'; text: string }).text).join('');
        inputItems.push({ role: m.role as 'user' | 'assistant', content: text });
      }
    }

    const request: Record<string, unknown> = {
      model: req.model, input: inputItems.length > 0 ? inputItems : '', stream: false,
    };
    if (instructions) request.instructions = instructions;
    if (req.temperature !== undefined) request.temperature = req.temperature;
    if (req.max_tokens !== undefined) request.max_output_tokens = req.max_tokens;
    if (req.top_p !== undefined) request.top_p = req.top_p;
    if (req.tools?.length) {
      request.tools = req.tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
    }
    if (req.tool_choice !== undefined) {
      if (typeof req.tool_choice === 'object') {
        request.tool_choice = { type: 'function', function: { name: req.tool_choice.name } };
      } else if (req.tool_choice === 'any') {
        request.tool_choice = 'required';
      } else {
        request.tool_choice = req.tool_choice; // 'auto' | 'none'
      }
    }
    return request;
  }

  async send(request: UnifiedRequest): Promise<UnifiedResponse> {
    const body = this.buildRequest(request);
    const response = await fetch(`${this.getBaseUrl()}/v1/responses`, {
      method: 'POST', headers: this.getHeaders(), body: JSON.stringify(body),
    });
    await throwOnHttpError(response, this.name);

    const data = await response.json() as {
      id?: string;
      output?: Array<{ type: string; id?: string; name?: string; content?: Array<{ type: string; text?: string }> }>;
      usage?: { input_tokens: number; output_tokens: number };
    };

    const content: UnifiedContentBlock[] = [];
    for (const out of data.output ?? []) {
      if (out.type === 'message') {
        for (const c of out.content ?? []) {
          if (c.type === 'output_text') content.push({ type: 'text', text: c.text ?? '' });
        }
      } else if (out.type === 'function_call') {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse((out as unknown as { arguments?: string }).arguments ?? '{}'); } catch { /* ignore */ }
        content.push({ type: 'tool_use', id: out.id ?? '', name: out.name ?? '', input });
      }
    }

    const hasToolUse = content.some(b => b.type === 'tool_use');
    return {
      id: data.id ?? `resp-${Date.now()}`, model: request.model, content,
      stop_reason: hasToolUse ? 'tool_use' : 'stop',
      usage: { input_tokens: data.usage?.input_tokens ?? 0, output_tokens: data.usage?.output_tokens ?? 0 },
    };
  }

  async *sendStreaming(request: UnifiedRequest): AsyncGenerator<UnifiedStreamEvent> {
    const body = this.buildRequest(request);
    (body as Record<string, unknown>).stream = true;

    const response = await fetch(`${this.getBaseUrl()}/v1/responses`, {
      method: 'POST', headers: this.getHeaders(), body: JSON.stringify(body),
    });
    await throwOnHttpError(response, this.name);

    const msgId = `resp-${Date.now()}`;
    let started = false;
    const activeFnCalls = new Map<number, { id: string; name: string }>();

    for await (const line of readSSELines(response)) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') { yield { type: 'message_stop', stop_reason: 'stop' }; return; }
      try {
        const event = JSON.parse(data);
        if (!started) { yield { type: 'message_start', id: msgId, model: request.model }; started = true; }

        const eventType = event.type as string;

        if (eventType === 'response.output_item.added') {
          const item = event.item as { type?: string; id?: string; name?: string };
          if (item?.type === 'function_call') {
            activeFnCalls.set(event.output_index as number, { id: item.id ?? '', name: item.name ?? '' });
            yield { type: 'tool_use_start', id: item.id ?? '', name: item.name ?? '', index: event.output_index as number };
          }
        } else if (eventType === 'response.output_text.delta') {
          yield { type: 'text_delta', text: event.delta ?? '', index: event.output_index as number };
        } else if (eventType === 'response.reasoning_text.delta') {
          yield { type: 'thinking_delta', thinking: event.delta ?? '', index: event.output_index as number };
        } else if (eventType === 'response.function_call_arguments.delta') {
          yield { type: 'tool_use_delta', id: event.item_id ?? '', partial_json: event.delta ?? '', index: event.output_index as number };
        } else if (eventType === 'response.function_call_arguments.done') {
          yield { type: 'content_block_stop', index: event.output_index as number };
          activeFnCalls.delete(event.output_index as number);
        } else if (eventType === 'response.output_item.done') {
          // 兜底：如果 function_call_arguments.done 未触发，在此终结 tool_use
          if (activeFnCalls.has(event.output_index as number)) {
            yield { type: 'content_block_stop', index: event.output_index as number };
            activeFnCalls.delete(event.output_index as number);
          }
        } else if (eventType === 'response.completed') {
          // 兜底：清理所有仍活跃的 function_call
          for (const index of activeFnCalls.keys()) {
            yield { type: 'content_block_stop', index };
          }
          activeFnCalls.clear();
          const resp = (event as Record<string, unknown>).response as Record<string, unknown> | undefined;
          const usage = resp?.usage as { input_tokens?: number; output_tokens?: number } | undefined;
          yield { type: 'message_stop', stop_reason: 'stop', usage: usage ? { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 } : undefined };
        }
      } catch (e) {
        throw new ProviderApiError('Failed to parse Responses SSE chunk', 500, { error: e });
      }
    }
  }

  async health(): Promise<ProviderHealth> {
    return createHealthCheck(this.name, `${this.getBaseUrl()}/v1/models`, this.getHeaders());
  }

  async fetchModels(): Promise<string[]> {
    return fetchModelsOpenAIFormat(`${this.getBaseUrl()}/v1/models`, this.getHeaders());
  }
}

// ═══════════════════════════════════════════════
// 入口转换器 — OpenAI Responses ↔ Unified
// ═══════════════════════════════════════════════

function mapResponsesToolChoice(raw: unknown): UnifiedRequest['tool_choice'] {
  if (!raw) return undefined;
  if (typeof raw === 'string') {
    // Responses API uses "required" for "any" in Chat Completions
    if (raw === 'required') return 'any';
    if (raw === 'auto' || raw === 'none') return raw;
    return undefined;
  }
  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, unknown>;
    if (obj.type === 'function' || obj.type === 'tool') {
      const fn = (obj.function as Record<string, string>) ?? obj;
      return { type: 'tool', name: (fn.name ?? obj.name ?? '') as string };
    }
  }
  return undefined;
}

export function createResponsesEntryConverter(): EntryConverter {
  return {
    protocol: 'openai_responses',

    toInternal(body: Record<string, unknown>): UnifiedRequest {
      const inputRaw = body.input as
        | string
        | Array<{
            type?: string;
            role?: string;
            content?: string | Array<{ type: string; text?: string; image_url?: string }>;
            call_id?: string;
            name?: string;
            arguments?: string;
            output?: string;
          }>
        | undefined;
      const msgs: UnifiedMessage[] = [];
      const instructions = body.instructions as string | undefined;
      if (instructions) msgs.push({ role: 'system', content: [{ type: 'text', text: instructions }] });

      if (Array.isArray(inputRaw)) {
        // 建立 function_call call_id → name 映射，用于 function_call_output 的 name 字段
        const functionCallNames = new Map<string, string>();
        for (const item of inputRaw) {
          if (typeof item === 'object' && item.type === 'function_call' && item.call_id && item.name) {
            functionCallNames.set(item.call_id, item.name);
          }
        }

        for (const item of inputRaw) {
          if (typeof item === 'string') continue;

          // function_call_output → tool role
          if (item.type === 'function_call_output') {
            msgs.push({
              role: 'tool',
              content: [{ type: 'text', text: typeof item.output === 'string' ? item.output : '' }],
              tool_call_id: item.call_id ?? '',
              name: functionCallNames.get(item.call_id ?? '') ?? undefined,
            });
            continue;
          }

          // function_call → assistant with tool_use block
          if (item.type === 'function_call') {
            let input: Record<string, unknown> = {};
            try { input = JSON.parse(item.arguments ?? '{}'); } catch { /* ignore */ }
            msgs.push({
              role: 'assistant',
              content: [{ type: 'tool_use', id: item.call_id ?? '', name: item.name ?? '', input }],
            });
            continue;
          }

          // message item (implicit type)
          const content = item.content;
          if (typeof content === 'string') {
            msgs.push({ role: (item.role as UnifiedMessage['role']) ?? 'user', content: [{ type: 'text', text: content }] });
          } else if (Array.isArray(content)) {
            const blocks: UnifiedContentBlock[] = [];
            for (const part of content) {
              if (part.type === 'input_text' && part.text) {
                blocks.push({ type: 'text', text: part.text });
              }
              // input_image / input_file etc. are silently dropped — they don't map to Unified IR
            }
            if (blocks.length > 0) {
              msgs.push({ role: (item.role as UnifiedMessage['role']) ?? 'user', content: blocks });
            }
          }
        }
      } else if (typeof inputRaw === 'string') {
        msgs.push({ role: 'user', content: [{ type: 'text', text: inputRaw }] });
      }

      return {
        model: (body.model as string) ?? '', messages: msgs,
        temperature: body.temperature as number | undefined,
        max_tokens: body.max_output_tokens as number | undefined,
        top_p: body.top_p as number | undefined,
        stream: body.stream as boolean | undefined,
        tools: (body.tools as UnifiedRequest['tools']) ?? undefined,
        tool_choice: mapResponsesToolChoice(body.tool_choice),
      };
    },

    fromInternal(resp: UnifiedResponse): unknown {
      const output: Array<Record<string, unknown>> = [];
      const textParts: Array<{ type: string; text: string }> = [];
      for (const b of resp.content) {
        if (b.type === 'text') {
          textParts.push({ type: 'output_text', text: b.text });
        } else if (b.type === 'thinking') {
          textParts.push({ type: 'reasoning_text', text: b.thinking });
        } else if (b.type === 'tool_use') {
          // flush accumulated text before the tool call
          if (textParts.length > 0) {
            output.push({ type: 'message', role: 'assistant', content: textParts.splice(0) });
          }
          output.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) });
        }
      }
      if (textParts.length > 0) {
        output.push({ type: 'message', role: 'assistant', content: [...textParts] });
      }
      if (output.length === 0) {
        output.push({ type: 'message', role: 'assistant', content: [] });
      }

      return {
        id: resp.id, object: 'response', model: resp.model,
        output,
        usage: { input_tokens: resp.usage.input_tokens, output_tokens: resp.usage.output_tokens, total_tokens: resp.usage.input_tokens + resp.usage.output_tokens },
      };
    },

    toError(_status: number, message: string, type?: string): unknown {
      return { error: { message, type: type ?? 'upstream_error' } };
    },

    transformStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          let msgId = '', model = '';
          const created = Math.floor(Date.now() / 1000);
          const toolAccum = new Map<number, { id: string; name: string; args: string }>();
          let currentItemId = '';
          try {
            for await (const event of parseUnifiedSSE(source)) {
              switch (event.type) {
                case 'message_start':
                  msgId = event.id; model = event.model;
                  controller.enqueue(encoder.encode(
                    `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: msgId, object: 'response', created_at: created, status: 'in_progress', model } })}\n\n`
                  ));
                  break;

                case 'text_delta':
                  if (!currentItemId) currentItemId = `item_msg_${Date.now()}`;
                  controller.enqueue(encoder.encode(
                    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', item_id: currentItemId, output_index: event.index, content_index: 0, delta: event.text })}\n\n`
                  ));
                  break;

                case 'thinking_delta':
                  if (!currentItemId) currentItemId = `item_msg_${Date.now()}`;
                  controller.enqueue(encoder.encode(
                    `event: response.reasoning_text.delta\ndata: ${JSON.stringify({ type: 'response.reasoning_text.delta', item_id: currentItemId, output_index: event.index, content_index: 0, delta: event.thinking })}\n\n`
                  ));
                  break;

                case 'tool_use_start':
                  toolAccum.set(event.index, { id: event.id, name: event.name, args: '' });
                  currentItemId = event.id;
                  controller.enqueue(encoder.encode(
                    `event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: event.index, item: { type: 'function_call', id: event.id, call_id: event.id, name: event.name, arguments: '' } })}\n\n`
                  ));
                  break;

                case 'tool_use_delta': {
                  const tu = toolAccum.get(event.index);
                  if (tu) {
                    tu.args += event.partial_json;
                    controller.enqueue(encoder.encode(
                      `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: tu.id, output_index: event.index, delta: event.partial_json })}\n\n`
                    ));
                  }
                  break;
                }

                case 'content_block_stop': {
                  const tu = toolAccum.get(event.index);
                  if (tu) {
                    controller.enqueue(encoder.encode(
                      `event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.done', item_id: tu.id, output_index: event.index, arguments: tu.args })}\n\n`
                    ));
                    controller.enqueue(encoder.encode(
                      `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: event.index, item: { type: 'function_call', id: tu.id, call_id: tu.id, name: tu.name, arguments: tu.args } })}\n\n`
                    ));
                    toolAccum.delete(event.index);
                  }
                  break;
                }

                case 'message_stop': {
                  const payload: Record<string, unknown> = {
                    type: 'response.completed',
                    response: { id: msgId, object: 'response', created_at: created, status: 'completed', model },
                  };
                  if (event.usage) {
                    (payload.response as Record<string, unknown>).usage = {
                      input_tokens: event.usage.input_tokens,
                      output_tokens: event.usage.output_tokens,
                      total_tokens: event.usage.input_tokens + event.usage.output_tokens,
                    };
                  }
                  controller.enqueue(encoder.encode(`event: response.completed\ndata: ${JSON.stringify(payload)}\n\n`));
                  break;
                }
              }
            }
          } finally {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          }
        },
      });
    },
  };
}
