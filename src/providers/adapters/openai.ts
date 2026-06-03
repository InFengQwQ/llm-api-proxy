import type {
  UnifiedRequest,
  UnifiedResponse,
  UnifiedStreamEvent,
  ProviderHealth,
} from '../../types/api.js';
import { ProviderApiError as ProviderApiErrorClass } from '../../types/api.js';
import type { ProviderConfig } from '../../config/index.js';
import type { ProviderAdapter, EntryConverter } from '../base.js';
import {
  createHealthCheck,
  fetchModelsOpenAIFormat,
} from '../base.js';
import {
  chatMessagesToUnified,
  unifiedToChatMessages,
  blocksToText,
  blocksToToolCalls,
  parseUnifiedSSE,
} from '../unified-utils.js';

export class OpenAIAdapter implements ProviderAdapter {
  name: string;
  type = 'openai';

  constructor(private config: ProviderConfig) {
    this.name = config.name;
  }

  private getBaseUrl(): string {
    return this.config.base_url ?? 'https://api.openai.com';
  }

  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.api_key ?? ''}`,
    };
  }

  private buildRequestBody(request: UnifiedRequest, stream: boolean): Record<string, unknown> {
    const chatMsgs = unifiedToChatMessages(request.messages);
    const cleanMessages = chatMsgs.map(m => {
      const cleaned: Record<string, unknown> = {
        role: m.role,
        content: m.content ?? '',
      };
      if (m.name) cleaned.name = m.name;
      if (m.tool_call_id) cleaned.tool_call_id = m.tool_call_id;
      if (m.tool_calls !== undefined) cleaned.tool_calls = m.tool_calls;
      return cleaned;
    });

    const body: Record<string, unknown> = {
      model: request.model,
      messages: cleanMessages,
      stream,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
    if (request.stop_sequences !== undefined) body.stop = request.stop_sequences;
    if (request.tools?.length) {
      body.tools = request.tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (request.tool_choice !== undefined) {
      if (typeof request.tool_choice === 'object') {
        body.tool_choice = { type: 'function', function: { name: request.tool_choice.name } };
      } else {
        body.tool_choice = request.tool_choice;
      }
    }
    return body;
  }

  private toUnifiedResponse(data: Record<string, unknown>, requestModel: string): UnifiedResponse {
    const choices = (data.choices ?? []) as Array<{
      message?: { role?: string; content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
      finish_reason?: string;
    }>;
    const choice = choices[0];
    const content: UnifiedResponse['content'] = [];

    if (choice?.message?.content) {
      content.push({ type: 'text', text: choice.message.content });
    }
    if (choice?.message?.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ }
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
    }

    const usage = (data.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
    return {
      id: (data.id as string) ?? `openai-${Date.now()}`,
      model: requestModel,
      content,
      stop_reason: choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'stop',
      usage: {
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
      },
    };
  }

  async send(request: UnifiedRequest): Promise<UnifiedResponse> {
    const body = this.buildRequestBody(request, false);

    const response = await fetch(`${this.getBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let payload;
      try { payload = JSON.parse(errorText); } catch { /* ignore */ }
      throw new ProviderApiErrorClass(`OpenAI API error ${response.status}: ${errorText}`, response.status, payload);
    }

    return this.toUnifiedResponse(await response.json() as Record<string, unknown>, request.model);
  }

  async *sendStreaming(request: UnifiedRequest): AsyncGenerator<UnifiedStreamEvent> {
    const body = this.buildRequestBody(request, true);

    const response = await fetch(`${this.getBaseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let payload;
      try { payload = JSON.parse(errorText); } catch { /* ignore */ }
      throw new ProviderApiErrorClass(`OpenAI API error ${response.status}: ${errorText}`, response.status, payload);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    const msgId = `openai-${Date.now()}`;
    let started = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          yield { type: 'message_stop', stop_reason: 'stop' };
          return;
        }
        try {
          const chunk = JSON.parse(data);
          if (!started) {
            yield { type: 'message_start', id: chunk.id ?? msgId, model: request.model };
            started = true;
          }
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            yield { type: 'text_delta', text: delta.content, index: 0 };
          }
          if (delta?.reasoning_content) {
            yield { type: 'thinking_delta', thinking: delta.reasoning_content, index: 0 };
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.id) {
                yield { type: 'tool_use_start', id: tc.id, name: tc.function?.name ?? '', index: tc.index };
              }
              if (tc.function?.arguments) {
                yield { type: 'tool_use_delta', id: tc.id ?? '', partial_json: tc.function.arguments, index: tc.index };
              }
            }
          }
          if (chunk.choices?.[0]?.finish_reason) {
            yield { type: 'message_stop', stop_reason: chunk.choices[0].finish_reason };
          }
        } catch (e) {
          throw new ProviderApiErrorClass(`Failed to parse chunk: ${data}`, 500, { error: e });
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

// ══════════════════════════════════════════════
// 入口转换器 — OpenAI → Unified 及反向
// ══════════════════════════════════════════════

export function createOpenAIEntryConverter(): EntryConverter {
  return {
    protocol: 'openai',

    toInternal(body: Record<string, unknown>): UnifiedRequest {
      const msgs = (body.messages ?? []) as ChatCompletionRequest['messages'];
      const tools = body.tools as Array<{ type: string; function: { name: string; description?: string; parameters?: Record<string, unknown> } }> | undefined;
      const toolChoiceRaw = body.tool_choice as string | { type: string; function: { name: string } } | undefined;

      let toolChoice: UnifiedRequest['tool_choice'];
      if (typeof toolChoiceRaw === 'object') {
        toolChoice = { type: 'tool', name: toolChoiceRaw.function.name };
      } else if (toolChoiceRaw === 'auto' || toolChoiceRaw === 'none') {
        toolChoice = toolChoiceRaw;
      }

      return {
        model: (body.model as string) ?? '',
        messages: chatMessagesToUnified(msgs),
        temperature: body.temperature as number | undefined,
        top_p: body.top_p as number | undefined,
        max_tokens: body.max_tokens as number | undefined,
        stream: body.stream as boolean | undefined,
        stop_sequences: (body.stop as string[]) ?? (typeof body.stop === 'string' ? [body.stop] : undefined),
        tools: tools?.map(t => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })),
        tool_choice: toolChoice,
      };
    },

    fromInternal(resp: UnifiedResponse): unknown {
      const texts = blocksToText(resp.content);
      const toolCalls = blocksToToolCalls(resp.content);
      return {
        id: resp.id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: resp.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: texts || null,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: resp.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
        }],
        usage: {
          prompt_tokens: resp.usage.input_tokens,
          completion_tokens: resp.usage.output_tokens,
          total_tokens: resp.usage.input_tokens + resp.usage.output_tokens,
        },
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
                  break;
                case 'text_delta':
                  controller.enqueue(encoder.encode(
                    `data: ${JSON.stringify({ id: msgId, object: 'chat.completion.chunk', created, model, choices: [{ index: event.index, delta: { content: event.text } }] })}\n\n`
                  ));
                  break;
                case 'thinking_delta':
                  controller.enqueue(encoder.encode(
                    `data: ${JSON.stringify({ id: msgId, object: 'chat.completion.chunk', created, model, choices: [{ index: event.index, delta: { reasoning_content: event.thinking } }] })}\n\n`
                  ));
                  break;
                case 'tool_use_start':
                  controller.enqueue(encoder.encode(
                    `data: ${JSON.stringify({ id: msgId, object: 'chat.completion.chunk', created, model, choices: [{ index: event.index, delta: { tool_calls: [{ index: 0, id: event.id, type: 'function', function: { name: event.name, arguments: '' } }] } }] })}\n\n`
                  ));
                  break;
                case 'tool_use_delta':
                  controller.enqueue(encoder.encode(
                    `data: ${JSON.stringify({ id: msgId, object: 'chat.completion.chunk', created, model, choices: [{ index: event.index, delta: { tool_calls: [{ index: 0, function: { arguments: event.partial_json } }] } }] })}\n\n`
                  ));
                  break;
                case 'message_stop': {
                  const finishReason =
                    event.stop_reason === 'tool_use' ? 'tool_calls' :
                    event.stop_reason === 'max_tokens' ? 'length' : 'stop';
                  const chunk: Record<string, unknown> = {
                    id: msgId, object: 'chat.completion.chunk', created, model,
                    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                  };
                  if (event.usage) {
                    chunk.usage = {
                      prompt_tokens: event.usage.input_tokens,
                      completion_tokens: event.usage.output_tokens,
                      total_tokens: event.usage.input_tokens + event.usage.output_tokens,
                    };
                  }
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  break;
                }
                // content_block_stop / message_start: no OpenAI visible chunk
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

// Re-import for entry converter types
import type { ChatCompletionRequest } from '../../types/api.js';