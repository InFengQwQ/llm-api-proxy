import type {
  UnifiedRequest, UnifiedResponse, UnifiedStreamEvent,
  UnifiedMessage, UnifiedContentBlock, ProviderHealth,
} from '../../types/api.js';
import { ProviderApiError } from '../../types/api.js';
import type { ProviderConfig } from '../../config/index.js';
import type { ProviderAdapter, EntryConverter } from '../base.js';
import { createHealthCheck, fetchModelsGoogleFormat } from '../base.js';
import { parseUnifiedSSE } from '../unified-utils.js';

export class OllamaAdapter implements ProviderAdapter {
  name: string;
  type = 'ollama';

  constructor(private config: ProviderConfig) {
    this.name = config.name;
  }

  private getBaseUrl(): string {
    return this.config.base_url ?? 'http://localhost:11434';
  }

  private async fetchWithRetry(body: Record<string, unknown>, maxRetries = 4): Promise<Response> {
    const url = `${this.getBaseUrl()}/api/chat`;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120_000);
      try {
        const response = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: controller.signal,
        });
        if (response.status === 503 && attempt < maxRetries) {
          const delay = Math.min(2000 * Math.pow(2, attempt), 16000);
          console.warn(`[Ollama] 503 (model loading), retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})`);
          await response.text().catch(() => {});
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        return response;
      } catch (err) {
        if (attempt < maxRetries) {
          const delay = Math.min(2000 * Math.pow(2, attempt), 16000);
          console.warn(`[Ollama] fetch error, retrying in ${delay / 1000}s`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw err;
      } finally { clearTimeout(timeoutId); }
    }
    throw new Error('Ollama fetchWithRetry: max retries exceeded');
  }

  async send(request: UnifiedRequest): Promise<UnifiedResponse> {
    const body: Record<string, unknown> = {
      model: request.model, stream: false,
      messages: request.messages.map(m => ({
        role: m.role,
        content: m.content.filter(b => b.type === 'text').map(b => (b as { type: 'text'; text: string }).text).join('') || '',
        ...(m.content.some(b => b.type === 'tool_use') ? {
          tool_calls: m.content.filter(b => b.type === 'tool_use').map(b => ({
            id: (b as { type: 'tool_use'; id: string }).id,
            type: 'function',
            function: { name: (b as { type: 'tool_use'; name: string }).name, arguments: JSON.stringify((b as { type: 'tool_use'; input: Record<string, unknown> }).input) },
          })),
        } : {}),
      })),
      options: { temperature: request.temperature, top_p: request.top_p, num_predict: request.max_tokens },
    };

    if (request.tools?.length) body.tools = request.tools;
    if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;

    const response = await this.fetchWithRetry(body);
    if (!response.ok) {
      const errText = await response.text();
      let payload; try { payload = JSON.parse(errText); } catch { /* ignore */ }
      throw new ProviderApiError(`Ollama API error ${response.status}: ${errText}`, response.status, payload);
    }

    const data = await response.json() as {
      message?: { role?: string; content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
    };

    const content: UnifiedContentBlock[] = [];
    if (data.message?.content) content.push({ type: 'text', text: data.message.content });
    if (data.message?.tool_calls) {
      for (const tc of data.message.tool_calls) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ }
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
    }

    return {
      id: `ollama-${Date.now()}`, model: request.model, content,
      stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'stop',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  async *sendStreaming(request: UnifiedRequest): AsyncGenerator<UnifiedStreamEvent> {
    const body: Record<string, unknown> = {
      model: request.model, stream: true,
      messages: request.messages.map(m => ({
        role: m.role,
        content: m.content.filter(b => b.type === 'text').map(b => (b as { type: 'text'; text: string }).text).join('') || '',
        ...(m.content.some(b => b.type === 'tool_use') ? {
          tool_calls: m.content.filter(b => b.type === 'tool_use').map(b => ({
            id: (b as { type: 'tool_use'; id: string }).id,
            type: 'function',
            function: { name: (b as { type: 'tool_use'; name: string }).name, arguments: JSON.stringify((b as { type: 'tool_use'; input: Record<string, unknown> }).input) },
          })),
        } : {}),
      })),
      options: { temperature: request.temperature, top_p: request.top_p, num_predict: request.max_tokens },
    };
    if (request.tools?.length) body.tools = request.tools;
    if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;

    const response = await this.fetchWithRetry(body);
    if (!response.ok) {
      const errText = await response.text();
      let payload; try { payload = JSON.parse(errText); } catch { /* ignore */ }
      throw new ProviderApiError(`Ollama API error ${response.status}: ${errText}`, response.status, payload);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');
    const decoder = new TextDecoder();
    const msgId = `ollama-${Date.now()}`;
    let started = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = decoder.decode(value, { stream: true }).split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          const msg = event.message as Record<string, unknown> | undefined;

          if (msg?.thinking) {
            if (!started) { yield { type: 'message_start', id: msgId, model: request.model }; started = true; }
            yield { type: 'thinking_delta', thinking: msg.thinking as string, index: 0 };
          }

          const toolCalls = msg?.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }> | undefined;
          if (toolCalls?.length) {
            if (!started) { yield { type: 'message_start', id: msgId, model: request.model }; started = true; }
            for (const tc of toolCalls) {
              yield { type: 'tool_use_start', id: tc.id, name: tc.function.name, index: 0 };
              yield { type: 'tool_use_delta', id: tc.id, partial_json: tc.function.arguments, index: 0 };
            }
          }

          if (msg?.content) {
            if (!started) { yield { type: 'message_start', id: msgId, model: request.model }; started = true; }
            yield { type: 'text_delta', text: msg.content as string, index: 0 };
          }

          if (event.done) {
            yield { type: 'message_stop', stop_reason: toolCalls?.length ? 'tool_use' : 'stop' };
          }
        } catch (e) {
          throw new ProviderApiError('Failed to parse Ollama stream line', 500, { error: e });
        }
      }
    }
  }

  async health(): Promise<ProviderHealth> {
    return createHealthCheck(this.name, `${this.getBaseUrl()}/api/tags`);
  }

  async fetchModels(): Promise<string[]> {
    return fetchModelsGoogleFormat(`${this.getBaseUrl()}/api/tags`);
  }
}

// ═══════════════════════════════════════════════
// 入口转换器 — Ollama ↔ Unified
// ═══════════════════════════════════════════════

export function createOllamaEntryConverter(): EntryConverter {
  return {
    protocol: 'ollama',

    toInternal(body: Record<string, unknown>): UnifiedRequest {
      const options = (body.options ?? {}) as Record<string, unknown>;
      const msgs = ((body.messages ?? []) as Array<{ role: string; content: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }>).map(m => {
        const blocks: UnifiedContentBlock[] = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        if (m.tool_calls) {
          for (const tc of m.tool_calls) {
            let input: Record<string, unknown> = {};
            try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ }
            blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
          }
        }
        return { role: m.role as UnifiedMessage['role'], content: blocks };
      });

      return {
        model: (body.model as string) ?? '', messages: msgs,
        temperature: options.temperature as number | undefined,
        top_p: options.top_p as number | undefined,
        max_tokens: options.num_predict as number | undefined,
        stream: body.stream as boolean | undefined,
        stop_sequences: options.stop as string[] | undefined,
        tools: body.tools as UnifiedRequest['tools'],
        tool_choice: body.tool_choice as UnifiedRequest['tool_choice'],
      };
    },

    fromInternal(resp: UnifiedResponse): unknown {
      const texts = resp.content.filter(b => b.type === 'text').map(b => (b as { type: 'text'; text: string }).text).join('');
      const toolCalls = resp.content.filter(b => b.type === 'tool_use').map(b => ({
        id: (b as { type: 'tool_use'; id: string }).id,
        type: 'function',
        function: { name: (b as { type: 'tool_use'; name: string }).name, arguments: JSON.stringify((b as { type: 'tool_use'; input: Record<string, unknown> }).input) },
      }));
      return {
        model: resp.model,
        message: { role: 'assistant', content: texts, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        done: true,
      };
    },

    transformStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          const toolAccum = new Map<number, { id: string; name: string; args: string }>();
          let model = '';
          const createdAt = new Date().toISOString();
          try {
            for await (const event of parseUnifiedSSE(source)) {
              switch (event.type) {
                case 'message_start':
                  model = event.model;
                  break;

                case 'text_delta':
                  controller.enqueue(encoder.encode(
                    JSON.stringify({ model, created_at: createdAt, message: { role: 'assistant', content: event.text, images: null }, done: false }) + '\n'
                  ));
                  break;

                case 'tool_use_start':
                  toolAccum.set(event.index, { id: event.id, name: event.name, args: '' });
                  break;

                case 'tool_use_delta': {
                  const acc = toolAccum.get(event.index);
                  if (acc) acc.args += event.partial_json;
                  break;
                }

                case 'content_block_stop': {
                  const acc = toolAccum.get(event.index);
                  if (acc) {
                    let parsedArgs: Record<string, unknown> = {};
                    try { parsedArgs = JSON.parse(acc.args); } catch { /* use empty */ }
                    controller.enqueue(encoder.encode(
                      JSON.stringify({
                        model, created_at: createdAt,
                        message: {
                          role: 'assistant', content: '', images: null,
                          tool_calls: [{ function: { name: acc.name, arguments: parsedArgs } }],
                        },
                        done: false,
                      }) + '\n'
                    ));
                    toolAccum.delete(event.index);
                  }
                  break;
                }

                case 'message_stop':
                  controller.enqueue(encoder.encode(
                    JSON.stringify({ model, created_at: createdAt, message: { role: 'assistant', content: '', images: null }, done: true }) + '\n'
                  ));
                  break;
              }
            }
          } finally {
            controller.close();
          }
        },
      });
    },
  };
}
