import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  ProviderHealth,
  ProviderApiError
} from '../../types/api.js';
import type { ProviderConfig } from '../../config/index.js';
import type { ProviderAdapter, EntryConverter } from '../base.js';
import {
  createHealthCheck,
  fetchModelsOpenAIFormat,
} from '../base.js';
import type { ChatMessage } from '../../types/api.js';

/**
 * OpenAI Responses API Adapter (POST /v1/responses)
 *
 * Converts Chat Completions request format to Responses format,
 * and maps Responses API output back to Chat Completions response format.
 *
 * Key differences from Chat Completions:
 * - Endpoint: POST /v1/responses (not /chat/completions)
 * - Input: structured array of role/content items (not a flat string)
 * - System messages → "instructions"
 * - Tool messages → function_call_output items
 * - Output: response.output[].content[].text → choices[].message.content
 */

type ResponsesInputItem =
  | { role: 'user' | 'assistant' | 'system' | 'developer'; content: string | Array<{ type: string; text?: string }> }
  | { type: 'function_call_output'; call_id: string; output: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string };

interface ResponsesApiRequest {
  model: string;
  input: string | ResponsesInputItem[];
  instructions?: string;
  temperature?: number;
  max_output_tokens?: number;
  top_p?: number;
  stream?: boolean;
  tools?: Array<{ type: 'function'; name: string; description?: string; parameters?: Record<string, unknown> }>;
}

interface ResponsesApiResponse {
  id: string;
  object: 'response';
  model: string;
  output?: Array<{
    type: string;
    id?: string;
    role?: string;
    content?: Array<{
      type: string;
      text?: string;
    }>;
  }>;
  incomplete_details?: {
    reason?: string;
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

/** Map Responses API incomplete_details.reason → Chat Completion finish_reason */
function mapFinishReason(reason: string | undefined): 'stop' | 'length' | 'content_filter' | 'tool_calls' {
  switch (reason) {
    case 'max_output_tokens':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

export class OpenAIResponsesAdapter implements ProviderAdapter {
  name: string;
  type = 'openai_responses';

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

  // ---- Chat → Responses request mapping ----

  private toResponsesRequest(req: ChatCompletionRequest, stream: boolean): ResponsesApiRequest {
    // Extract system messages → instructions
    const systemMsgs = req.messages.filter(m => m.role === 'system');
    const instructions = systemMsgs.length > 0
      ? systemMsgs.map(m => m.content ?? '').join('\n')
      : undefined;

    // Build structured input items from non-system messages
    const inputItems: ResponsesInputItem[] = [];

    for (const m of req.messages) {
      if (m.role === 'system') continue;

      if (m.role === 'tool') {
        // Tool message → function_call_output input item
        inputItems.push({
          type: 'function_call_output',
          call_id: m.tool_call_id ?? '',
          output: m.content ?? '',
        });
      } else if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        // Assistant text content (if any non-empty)
        if (m.content) {
          inputItems.push({ role: 'assistant', content: m.content });
        }
        // Tool calls → function_call input items
        for (const tc of m.tool_calls) {
          inputItems.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      } else {
        // User/assistant message: send as structured role/content item
        inputItems.push({
          role: m.role as 'user' | 'assistant',
          content: m.content ?? '',
        });
      }
    }

    const request: ResponsesApiRequest = {
      model: req.model,
      input: inputItems.length > 0 ? inputItems : '',
      stream,
    };

    if (instructions) request.instructions = instructions;
    if (req.temperature !== undefined) request.temperature = req.temperature;
    if (req.max_tokens !== undefined) request.max_output_tokens = req.max_tokens;
    if (req.top_p !== undefined) request.top_p = req.top_p;

    // Pass tools if present
    if (req.tools && req.tools.length > 0) {
      request.tools = req.tools.map(t => ({
        type: 'function' as const,
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      }));
    }

    return request;
  }

  // ---- Responses → Chat response mapping ----

  private fromResponsesResponse(resp: ResponsesApiResponse, model: string): ChatCompletionResponse {
    // Find the first message output
    const messageOutput = resp.output?.find(o => o.type === 'message');
    const content = messageOutput?.content
      ?.filter(c => c.type === 'output_text')
      .map(c => c.text ?? '')
      .join('') ?? '';

    return {
      id: resp.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: content || null,
          },
          finish_reason: mapFinishReason(resp.incomplete_details?.reason),
        },
      ],
      usage: {
        prompt_tokens: resp.usage?.input_tokens ?? 0,
        completion_tokens: resp.usage?.output_tokens ?? 0,
        total_tokens: resp.usage?.total_tokens ?? 0,
      },
    };
  }

  // ---- ProviderAdapter implementation ----

  async send(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const body = this.toResponsesRequest(request, false);

    const response = await fetch(`${this.getBaseUrl()}/v1/responses`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let payload;
      try { payload = JSON.parse(errorText); } catch { /* ignore */ }
      throw new ProviderApiError(`Responses API error ${response.status}: ${errorText}`, response.status, payload);
    }

    const resp = await response.json() as ResponsesApiResponse;
    return this.fromResponsesResponse(resp, request.model);
  }

  async *sendStreaming(request: ChatCompletionRequest): AsyncGenerator<StreamChunk> {
    const body = this.toResponsesRequest(request, true);

    const response = await fetch(`${this.getBaseUrl()}/v1/responses`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let payload;
      try { payload = JSON.parse(errorText); } catch { /* ignore */ }
      throw new ProviderApiError(`Responses API error ${response.status}: ${errorText}`, response.status, payload);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    const chunkId = `chatcmpl-${Math.random().toString(36).slice(2, 11)}`;
    const created = Math.floor(Date.now() / 1000);
    let model = request.model;
    let streamCompleted = false; // track if response.completed was seen
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Responses API SSE format: "data: {...}" (may also have "event: ..." lines)
        if (trimmed.startsWith('event: ')) continue; // event line — handled by data payload

        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6).trim();
          if (data === '[DONE]') {
            streamCompleted = true;
            break;
          }

          try {
            const parsed = JSON.parse(data);

            // response.output_text.delta — text delta chunk
            if (parsed.type === 'response.output_text.delta' && parsed.delta) {
              const chunk: StreamChunk = {
                id: chunkId,
                object: 'chat.completion.chunk',
                created,
                model: parsed.response?.model ?? model,
                choices: [
                  {
                    index: 0,
                    delta: { content: parsed.delta },
                  },
                ],
              };
              yield chunk;
            }

            // response.completed — final chunk with usage
            if (parsed.type === 'response.completed' && parsed.response) {
              streamCompleted = true;
              const r = parsed.response as ResponsesApiResponse;
              if (r.model) model = r.model;
              if (r.usage) {
                inputTokens = r.usage.input_tokens;
                outputTokens = r.usage.output_tokens;
                totalTokens = r.usage.total_tokens;
              }

              const finalChunk: StreamChunk = {
                id: chunkId,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: 'stop',
                  },
                ],
                usage: {
                  prompt_tokens: inputTokens,
                  completion_tokens: outputTokens,
                  total_tokens: totalTokens,
                },
              };
              yield finalChunk;
            }
          } catch (e) {
            throw new ProviderApiError(`Failed to parse Responses API SSE chunk: ${data}`, 500, { error: e });
          }
        }
      }

      if (streamCompleted) break;
    }

    // Fallback: if stream ended without response.completed, emit a final chunk
    if (!streamCompleted) {
      yield {
        id: chunkId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: totalTokens,
        },
      };
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
// 入口转换器 — Responses request → CCR 及反向
// ═══════════════════════════════════════════════

export function createResponsesEntryConverter(): EntryConverter {
  return {
    protocol: 'openai_responses',

    toInternal(body: Record<string, unknown>): ChatCompletionRequest {
      const msgs: ChatMessage[] = [];
      const instructions = body.instructions as string | undefined;
      if (instructions) msgs.push({ role: 'system', content: instructions });

      if (typeof body.input === 'string') {
        if (body.input) msgs.push({ role: 'user', content: body.input });
      } else if (Array.isArray(body.input)) {
        for (const item of body.input as Array<Record<string, unknown>>) {
          if (item.type === 'function_call_output') {
            msgs.push({
              role: 'tool',
              tool_call_id: (item.call_id as string) ?? '',
              content: (item.output as string) ?? '',
            });
          } else if (item.role === 'assistant' && item.tool_calls) {
            msgs.push({
              role: 'assistant',
              content: (item.content as string) || null,
              tool_calls: item.tool_calls as ChatMessage['tool_calls'],
            });
          } else {
            const role = (item.role as string) === 'assistant' ? 'assistant' : 'user';
            const content = typeof item.content === 'string' ? item.content
              : Array.isArray(item.content) ? (item.content as Array<{ text?: string }>).map(c => c.text ?? '').join('')
              : '';
            if (content || item.tool_calls) {
              msgs.push({
                role,
                content: content || null,
                ...(item.tool_calls ? { tool_calls: item.tool_calls as ChatMessage['tool_calls'] } : {}),
              });
            }
          }
        }
      }

      const rawTools = body.tools as Array<Record<string, unknown>> | undefined;
      return {
        model: (body.model as string) ?? '', messages: msgs,
        temperature: body.temperature as number | undefined,
        top_p: body.top_p as number | undefined,
        max_tokens: body.max_output_tokens as number | undefined,
        stream: body.stream as boolean | undefined,
        tools: rawTools?.map(t => ({ type: 'function' as const, function: { name: (t.name as string) ?? '', description: t.description as string | undefined, parameters: t.parameters as Record<string, unknown> | undefined } })),
        provider_options: { previous_response_id: body.previous_response_id, text_format: (body as Record<string, unknown>).text },
      };
    },

    fromInternal(ccResp: ChatCompletionResponse) {
      const text = ccResp.choices[0]?.message?.content ?? '';
      const finishReason = ccResp.choices[0]?.finish_reason;
      return {
        id: ccResp.id, object: 'response', model: ccResp.model,
        created_at: ccResp.created,
        status: 'completed' as const,
        output: [{ type: 'message', id: `msg_${Math.random().toString(36).slice(2, 9)}`, status: 'completed' as const, role: 'assistant', content: [{ type: 'output_text', text }] }],
        incomplete_details: { reason: finishReason === 'length' ? 'max_output_tokens' : 'stop' },
        usage: { input_tokens: ccResp.usage?.prompt_tokens ?? 0, output_tokens: ccResp.usage?.completion_tokens ?? 0, total_tokens: ccResp.usage?.total_tokens ?? 0 },
      };
    },

    transformStream(source: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder(); const decoder = new TextDecoder();
      const responseId = `resp_${Math.random().toString(36).slice(2, 11)}`;
      const itemId = `msg_${Math.random().toString(36).slice(2, 11)}`;
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = source.getReader(); let buffer = ''; let finished = false;
          let itemStarted = false;
          let contentPartStarted = false;
          let reasoningStarted = false;
          let accumulatedText = '';
          let accumulatedReasoning = '';
          let lastUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;

          const emit = (event: string, data: unknown) => {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          };

          function ensureItemStarted(): void {
            if (itemStarted) return;
            itemStarted = true;
            emit('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: itemId, status: 'in_progress', role: 'assistant', content: [] } });
          }

          function ensureContentPartStarted(): void {
            if (contentPartStarted) return;
            // Close reasoning part before opening text part (they share the message item)
            if (reasoningStarted) {
              emit('response.reasoning_text.done', { type: 'response.reasoning_text.done', item_id: itemId, output_index: 0, content_index: 0, text: accumulatedReasoning });
              emit('response.content_part.done', { type: 'response.content_part.done', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'reasoning', text: accumulatedReasoning } });
              reasoningStarted = false;
            }
            ensureItemStarted();
            contentPartStarted = true;
            emit('response.content_part.added', { type: 'response.content_part.added', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } });
          }

          function ensureReasoningStarted(): void {
            if (reasoningStarted) return;
            // Close text part before opening reasoning part
            if (contentPartStarted) {
              emit('response.output_text.done', { type: 'response.output_text.done', item_id: itemId, output_index: 0, content_index: 0, text: accumulatedText });
              emit('response.content_part.done', { type: 'response.content_part.done', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: accumulatedText } });
              contentPartStarted = false;
            }
            ensureItemStarted();
            reasoningStarted = true;
            emit('response.content_part.added', { type: 'response.content_part.added', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'reasoning', text: '' } });
          }

          // Build the final output content array for response.completed
          function buildOutputContent(): Array<{ type: string; text: string }> {
            const parts: Array<{ type: string; text: string }> = [];
            if (accumulatedReasoning) parts.push({ type: 'reasoning', text: accumulatedReasoning });
            if (accumulatedText) parts.push({ type: 'output_text', text: accumulatedText });
            return parts;
          }

          // emit response.created at the very beginning
          emit('response.created', { type: 'response.created', response: { id: responseId, object: 'response', model, status: 'in_progress', output: [] } });

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
              for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') { finished = true; continue; }
                try {
                  const chunk = JSON.parse(data);
                  const delta = chunk.choices?.[0]?.delta;
                  const content = delta?.content;
                  const reasoningContent = delta?.reasoning_content;
                  const finishReason = chunk.choices?.[0]?.finish_reason;

                  // Track usage from any chunk that carries it
                  if (chunk.usage) {
                    lastUsage = {
                      prompt_tokens: chunk.usage.prompt_tokens ?? 0,
                      completion_tokens: chunk.usage.completion_tokens ?? 0,
                      total_tokens: chunk.usage.total_tokens ?? 0,
                    };
                  }

                  // Handle reasoning/thinking content first
                  if (reasoningContent !== undefined && reasoningContent !== null) {
                    ensureReasoningStarted();
                    accumulatedReasoning += reasoningContent;
                    emit('response.reasoning_text.delta', { type: 'response.reasoning_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: reasoningContent });
                  }

                  // Handle regular text content
                  if (content !== undefined && content !== null) {
                    ensureContentPartStarted();
                    accumulatedText += content;
                    emit('response.output_text.delta', { type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: content });
                  }

                  if (finishReason) {
                    // Close any open reasoning part
                    if (reasoningStarted) {
                      emit('response.reasoning_text.done', { type: 'response.reasoning_text.done', item_id: itemId, output_index: 0, content_index: 0, text: accumulatedReasoning });
                      emit('response.content_part.done', { type: 'response.content_part.done', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'reasoning', text: accumulatedReasoning } });
                      reasoningStarted = false;
                    }
                    // Close any open text part
                    if (contentPartStarted) {
                      emit('response.output_text.done', { type: 'response.output_text.done', item_id: itemId, output_index: 0, content_index: 0, text: accumulatedText });
                      emit('response.content_part.done', { type: 'response.content_part.done', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: accumulatedText } });
                      contentPartStarted = false;
                    }
                    if (itemStarted) {
                      const outputContent = buildOutputContent();
                      emit('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: itemId, status: 'completed', role: 'assistant', content: outputContent } });
                      itemStarted = false;
                    }
                    finished = true;
                    const outputContent = buildOutputContent();
                    emit('response.completed', { type: 'response.completed', response: { id: responseId, object: 'response', model, status: 'completed', output: [{ type: 'message', id: itemId, status: 'completed', role: 'assistant', content: outputContent }], usage: lastUsage } });
                  }
                } catch { /* skip */ }
              }
            }
            // Fallback: if stream ended without finish_reason, emit completion events
            if (!finished) {
              if (reasoningStarted) {
                emit('response.reasoning_text.done', { type: 'response.reasoning_text.done', item_id: itemId, output_index: 0, content_index: 0, text: accumulatedReasoning });
                emit('response.content_part.done', { type: 'response.content_part.done', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'reasoning', text: accumulatedReasoning } });
                reasoningStarted = false;
              }
              if (contentPartStarted) {
                emit('response.output_text.done', { type: 'response.output_text.done', item_id: itemId, output_index: 0, content_index: 0, text: accumulatedText });
                emit('response.content_part.done', { type: 'response.content_part.done', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: accumulatedText } });
                contentPartStarted = false;
              }
              if (itemStarted) {
                const outputContent = buildOutputContent();
                emit('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: itemId, status: 'completed', role: 'assistant', content: outputContent } });
                itemStarted = false;
              }
              const outputContent = buildOutputContent();
              emit('response.completed', { type: 'response.completed', response: { id: responseId, object: 'response', model, status: 'completed', output: [{ type: 'message', id: itemId, status: 'completed', role: 'assistant', content: outputContent }], usage: lastUsage } });
            }
          } finally { reader.releaseLock(); controller.close(); }
        },
      });
    },
  };
}
