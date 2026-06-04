import type {
  UnifiedRequest, UnifiedResponse, UnifiedStreamEvent,
  UnifiedMessage, UnifiedContentBlock, ProviderHealth,
} from '../../types/api.js';
import { ProviderApiError } from '../../types/api.js';
import type { ProviderConfig } from '../../config/index.js';
import type { ProviderAdapter, EntryConverter } from '../base.js';
import { createHealthCheck, fetchModelsGoogleFormat, throwOnHttpError, readSSELines } from '../base.js';
import { blocksToText, blocksToThinking, blocksToToolCalls, parseUnifiedSSE } from '../unified-utils.js';

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

  private buildRequest(request: UnifiedRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model, stream,
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
        ...(m.role === 'tool' && m.name ? { name: m.name } : {}),
        ...(m.content.some(b => b.type === 'thinking') ? { thinking: m.content.filter(b => b.type === 'thinking').map(b => (b as { type: 'thinking'; thinking: string }).thinking).join('') } : {}),
      })),
      options: { temperature: request.temperature, top_p: request.top_p, num_predict: request.max_tokens },
    };
    if (request.tools?.length) body.tools = request.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;
    return body;
  }

  async send(request: UnifiedRequest): Promise<UnifiedResponse> {
    const body = this.buildRequest(request, false);

    const response = await this.fetchWithRetry(body);
    await throwOnHttpError(response, this.name);

    const data = await response.json() as {
      message?: { role?: string; content?: string; thinking?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
    };

    const content: UnifiedContentBlock[] = [];
    if (data.message?.content) content.push({ type: 'text', text: data.message.content });
    if (data.message?.thinking) content.push({ type: 'thinking', thinking: data.message.thinking });
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
    const body = this.buildRequest(request, true);

    const response = await this.fetchWithRetry(body);
    await throwOnHttpError(response, this.name);

    const msgId = `ollama-${Date.now()}`;
    let started = false;

    for await (const line of readSSELines(response)) {
      try {
        const event = JSON.parse(line);
        const msg = event.message as Record<string, unknown> | undefined;

        if (msg?.thinking) {
          if (!started) { yield { type: 'message_start', id: msgId, model: request.model }; started = true; }
          yield { type: 'thinking_delta', thinking: msg.thinking as string, index: 0 };
        }

        const toolCalls = msg?.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }> | undefined;
        let hasToolCall = false;
        if (toolCalls?.length) {
          if (!started) { yield { type: 'message_start', id: msgId, model: request.model }; started = true; }
          hasToolCall = true;
          for (const tc of toolCalls) {
            yield { type: 'tool_use_start', id: tc.id, name: tc.function.name, index: 0 };
            yield { type: 'tool_use_delta', id: tc.id, partial_json: tc.function.arguments, index: 0 };
          }
          // Emit content_block_stop to finalize tool call blocks
          yield { type: 'content_block_stop', index: 0 };
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
      const rawMsgs = (body.messages ?? []) as Array<{ role: string; content: string; name?: string; tool_call_id?: string; tool_calls?: Array<{ id: string | null; function: { name: string; arguments: string | Record<string, unknown>; index?: number | null } }> }>;

      // Build a lookup map from ALL messages — tool_use IDs → tool names,
      // so tool role messages from any turn can find their name.
      const toolNameMap = new Map<string, string>();
      for (const m of rawMsgs) {
        if (m.tool_calls) {
          for (const tc of m.tool_calls) {
            if (tc.id) toolNameMap.set(tc.id, tc.function.name);
          }
        }
      }

      const msgs = rawMsgs.map(m => {
        const blocks: UnifiedContentBlock[] = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        if (m.tool_calls) {
          for (const tc of m.tool_calls) {
            if (!tc.id) continue;
            let input: Record<string, unknown> = {};
            const args = tc.function.arguments;
            if (typeof args === 'string') {
              try { input = JSON.parse(args || '{}'); } catch { /* ignore */ }
            } else if (args && typeof args === 'object') {
              input = args as Record<string, unknown>;
            }
            blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
          }
        }

        let name = m.name;
        let toolCallId: string | undefined;
        if (m.role === 'tool') {
          if (m.tool_call_id) {
            toolCallId = m.tool_call_id;
            if (!name) name = toolNameMap.get(m.tool_call_id);
          } else if (!name && toolNameMap.size > 0) {
            for (const [id, toolName] of toolNameMap) {
              name = toolName;
              toolCallId = id;
              toolNameMap.delete(id);
              break;
            }
          }
        }

        return { role: m.role as UnifiedMessage['role'], content: blocks, name, tool_call_id: toolCallId };
      });

      return {
        model: (body.model as string) ?? '', messages: msgs,
        temperature: options.temperature as number | undefined,
        top_p: options.top_p as number | undefined,
        max_tokens: options.num_predict as number | undefined,
        stream: body.stream as boolean | undefined,
        stop_sequences: (options.stop ?? undefined) as string[] | undefined,
        tools: Array.isArray(body.tools)
          ? (body.tools as Array<Record<string, unknown>>).map((t: Record<string, unknown>) => {
              const fn = (t.function ?? t) as Record<string, unknown>;
              return {
                name: fn.name as string,
                description: fn.description as string | undefined,
                parameters: fn.parameters as Record<string, unknown> | undefined,
              };
            })
          : undefined,
        tool_choice: (body.tool_choice ?? undefined) as UnifiedRequest['tool_choice'],
      };
    },

    fromInternal(resp: UnifiedResponse): unknown {
      const texts = blocksToText(resp.content);
      const toolCalls = blocksToToolCalls(resp.content);
      const thinkingContent = blocksToThinking(resp.content);
      return {
        model: resp.model,
        message: { role: 'assistant', content: texts, ...(thinkingContent ? { thinking: thinkingContent } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        done: true,
      };
    },

    toError(_status: number, message: string, _type?: string): unknown {
      return { error: message };
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

                case 'thinking_delta':
                  controller.enqueue(encoder.encode(
                    JSON.stringify({ model, created_at: createdAt, message: { role: 'assistant', content: '', thinking: event.thinking }, done: false }) + '\n'
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
