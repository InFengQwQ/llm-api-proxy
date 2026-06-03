import type {
  UnifiedRequest, UnifiedResponse, UnifiedStreamEvent,
  UnifiedMessage, UnifiedContentBlock, ProviderHealth,
} from '../../types/api.js';
import { ProviderApiError } from '../../types/api.js';
import type { ProviderConfig } from '../../config/index.js';
import type { ProviderAdapter, EntryConverter } from '../base.js';
import { createHealthCheck, fetchModelsOpenAIFormat } from '../base.js';
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

  private toResponsesRequest(req: UnifiedRequest): Record<string, unknown> {
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
        const toolUses = m.content.filter(b => b.type === 'tool_use');
        if (texts.length > 0) inputItems.push({ role: 'assistant', content: texts.map(b => (b as { type: 'text'; text: string }).text).join('') });
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
    return request;
  }

  async send(request: UnifiedRequest): Promise<UnifiedResponse> {
    const body = this.toResponsesRequest(request);
    const response = await fetch(`${this.getBaseUrl()}/v1/responses`, {
      method: 'POST', headers: this.getHeaders(), body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errText = await response.text();
      let payload; try { payload = JSON.parse(errText); } catch { /* ignore */ }
      throw new ProviderApiError(`OpenAI Responses API error ${response.status}: ${errText}`, response.status, payload);
    }

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

    return {
      id: data.id ?? `resp-${Date.now()}`, model: request.model, content,
      stop_reason: 'stop',
      usage: { input_tokens: data.usage?.input_tokens ?? 0, output_tokens: data.usage?.output_tokens ?? 0 },
    };
  }

  async *sendStreaming(request: UnifiedRequest): AsyncGenerator<UnifiedStreamEvent> {
    const body = this.toResponsesRequest(request);
    (body as Record<string, unknown>).stream = true;

    const response = await fetch(`${this.getBaseUrl()}/v1/responses`, {
      method: 'POST', headers: this.getHeaders(), body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errText = await response.text();
      let payload; try { payload = JSON.parse(errText); } catch { /* ignore */ }
      throw new ProviderApiError(`OpenAI Responses API error ${response.status}: ${errText}`, response.status, payload);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');
    const decoder = new TextDecoder();
    let buffer = '';
    const msgId = `resp-${Date.now()}`;
    let started = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') { yield { type: 'message_stop', stop_reason: 'stop' }; return; }
        try {
          const event = JSON.parse(data);
          if (!started) { yield { type: 'message_start', id: msgId, model: request.model }; started = true; }
          // Responses API stream format: content_part.added, text.delta, etc.
          if (event.type === 'response.output_text.delta') {
            yield { type: 'text_delta', text: event.delta ?? '', index: 0 };
          } else if (event.type === 'response.completed') {
            yield { type: 'message_stop', stop_reason: 'stop' };
          }
        } catch (e) {
          throw new ProviderApiError(`Failed to parse Responses SSE chunk`, 500, { error: e });
        }
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

export function createResponsesEntryConverter(): EntryConverter {
  return {
    protocol: 'openai_responses',

    toInternal(body: Record<string, unknown>): UnifiedRequest {
      const inputRaw = body.input as string | Array<{ role: string; content: string }> | undefined;
      const msgs: UnifiedMessage[] = [];
      const instructions = body.instructions as string | undefined;
      if (instructions) msgs.push({ role: 'system', content: [{ type: 'text', text: instructions }] });

      if (Array.isArray(inputRaw)) {
        for (const item of inputRaw) {
          if (typeof item === 'string') continue;
          msgs.push({ role: (item.role as UnifiedMessage['role']) ?? 'user', content: [{ type: 'text', text: item.content ?? '' }] });
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
      };
    },

    fromInternal(resp: UnifiedResponse): unknown {
      const texts = resp.content.filter(b => b.type === 'text').map(b => (b as { type: 'text'; text: string }).text).join('');
      return {
        id: resp.id, object: 'response', model: resp.model,
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: texts }] }],
        usage: { input_tokens: resp.usage.input_tokens, output_tokens: resp.usage.output_tokens, total_tokens: resp.usage.input_tokens + resp.usage.output_tokens },
      };
    },

    transformStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          let msgId = '', model = '';
          const created = Math.floor(Date.now() / 1000);
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
                  controller.enqueue(encoder.encode(
                    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', item_id: msgId, output_index: event.index, content_index: 0, delta: event.text })}\n\n`
                  ));
                  break;

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
