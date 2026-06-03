import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  AnthropicMessageResponse,
  ProviderHealth,
  ProviderApiError
} from '../../types/api.js';
import type { AnthropicRequest, AnthropicContentBlock, ChatMessage } from '../../types/api.js';
import type { ProviderConfig } from '../../config/index.js';
import type { ProviderAdapter, EntryConverter } from '../base.js';
import {
  createHealthCheck,
  fetchModelsOpenAIFormat,
} from '../base.js';

export class AnthropicAdapter implements ProviderAdapter {
  name: string;
  type = 'anthropic';

  constructor(private config: ProviderConfig) {
    this.name = config.name;
  }

  private getBaseUrl(): string {
    return this.config.base_url ?? 'https://api.anthropic.com';
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.config.api_key ?? '',
      'anthropic-version': '2023-06-01',
    };
    return headers;
  }

  // 将 OpenAI 格式请求转换为 Anthropic 格式
  private toAnthropicRequest(req: ChatCompletionRequest): Record<string, unknown> {
    // system 消息 → Anthropic system 字段；不混入 messages 数组
    const systemPrompt = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');

    const messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }> = [];

    for (const msg of req.messages) {
      if (msg.role === 'system') continue;

      if (msg.role === 'tool') {
        // Tool message → user message with tool_result content block
        messages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.tool_call_id ?? '',
            content: msg.content ?? '',
          }],
        });
      } else if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        // Assistant message with tool_calls → assistant with tool_use content blocks
        const blocks: Array<Record<string, unknown>> = [];
        if (msg.content) {
          blocks.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments || '{}'),
          });
        }
        messages.push({ role: 'assistant', content: blocks.length > 0 ? blocks : msg.content ?? '' });
      } else {
        // Regular user/assistant message
        messages.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content ?? '',
        });
      }
    }

    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      max_tokens: req.max_tokens ?? 8192,
      stream: false,
    };

    // Only include optional fields if defined (avoid sending undefined values)
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.top_p !== undefined) body.top_p = req.top_p;
    if (req.stop) body.stop_sequences = req.stop;

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters ?? {},
      }));
      // OpenAI → Anthropic tool_choice 映射
      if (typeof req.tool_choice === 'object' && req.tool_choice?.function?.name) {
        body.tool_choice = { type: 'tool', name: req.tool_choice.function.name };
      } else if (req.tool_choice === 'none') {
        delete body.tools;
      }
    }

    // Pass through thinking config from provider_options (set by Anthropic entry converter)
    const thinking = req.provider_options?.thinking as Record<string, unknown> | undefined;
    if (thinking) {
      body.thinking = thinking;
    }

    return body;
  }

  // 将 Anthropic 响应转换为 OpenAI 格式
  private fromAnthropicResponse(
    resp: AnthropicMessageResponse,
    model: string
  ): ChatCompletionResponse {
    const parts = resp.content.map((block) => {
      if (block.type === 'text') {
        return { role: 'assistant' as const, content: block.text ?? '' };
      }
      if (block.type === 'tool_use') {
        return {
          role: 'assistant' as const,
          content: null,
          tool_calls: [
            {
              id: block.id ?? '',
              type: 'function' as const,
              function: {
                name: block.name ?? '',
                arguments: JSON.stringify(block.input ?? {}),
              },
            },
          ],
        };
      }
      return { role: 'assistant' as const, content: '' };
    });

    const merged = this.mergeMessages(parts);

    return {
      id: resp.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: merged,
          finish_reason: resp.stop_reason === 'end_turn' ? 'stop' : 'length',
        },
      ],
      usage: {
        prompt_tokens: resp.usage?.input_tokens ?? 0,
        completion_tokens: resp.usage?.output_tokens ?? 0,
        total_tokens: (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0),
      },
    };
  }

  private mergeMessages(
    parts: Array<{ role: string; content: string | null; tool_calls?: unknown[] }>
  ): ChatCompletionResponse['choices'][0]['message'] {
    const contentParts: string[] = [];
    const toolCalls: unknown[] = [];

    for (const p of parts) {
      if (p.tool_calls?.length) toolCalls.push(...p.tool_calls);
      if (p.content) contentParts.push(p.content);
    }

    return {
      role: 'assistant',
      content: contentParts.join('\n') || null,
      tool_calls: toolCalls.length > 0 ? toolCalls as ChatCompletionResponse['choices'][0]['message']['tool_calls'] : undefined,
    };
  }

  async send(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const body = this.toAnthropicRequest(request);

    const response = await fetch(`${this.getBaseUrl()}/v1/messages`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let payload;
      try { payload = JSON.parse(errorText); } catch { /* ignore */ }
      throw new ProviderApiError(`Anthropic API error ${response.status}: ${errorText}`, response.status, payload);
    }

    const resp = await response.json() as AnthropicMessageResponse;
    return this.fromAnthropicResponse(resp, request.model);
  }

  async *sendStreaming(request: ChatCompletionRequest): AsyncGenerator<StreamChunk> {
    const body = this.toAnthropicRequest(request);
    body.stream = true;

    const response = await fetch(`${this.getBaseUrl()}/v1/messages`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let payload;
      try { payload = JSON.parse(errorText); } catch { /* ignore */ }
      throw new ProviderApiError(`Anthropic API error ${response.status}: ${errorText}`, response.status, payload);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let accumulatedContent = '';
    let accumulatedReasoning = '';
    let inputTokens = 0;
    let outputTokens = 0;
    // tool_use 追踪: index → { id, name, arguments }
    const toolUseMap = new Map<number, { id: string; name: string; args: string }>();
    const chunkId = `chatcmpl-${Math.random().toString(36).slice(2, 11)}`;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break;

        try {
          const event = JSON.parse(data);

          if (event.type === 'message_start') {
            inputTokens = event.message?.usage?.input_tokens ?? 0;
          }
          else if (event.type === 'content_block_start') {
            const block = event.content_block;
            if (block?.type === 'tool_use') {
              toolUseMap.set(event.index, { id: block.id ?? '', name: block.name ?? '', args: '' });
            }
          }
          else if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              accumulatedContent += event.delta.text;
              yield {
                id: chunkId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: request.model,
                choices: [
                  {
                    index: 0,
                    delta: { content: event.delta.text },
                  },
                ],
              };
            } else if (event.delta.type === 'thinking_delta') {
              accumulatedReasoning += event.delta.thinking;
              yield {
                id: chunkId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: request.model,
                choices: [
                  {
                    index: 0,
                    delta: { reasoning_content: event.delta.thinking },
                  },
                ],
              };
            } else if (event.delta.type === 'input_json_delta') {
              const tu = toolUseMap.get(event.index);
              if (tu) {
                tu.args += event.delta.partial_json;
              }
              yield {
                id: chunkId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: request.model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: event.index,
                          id: tu?.id,
                          function: {
                            name: tu?.name ?? '',
                            arguments: event.delta.partial_json,
                          },
                        },
                      ],
                    },
                  },
                ],
              };
            }
          }
          else if (event.type === 'message_delta') {
            outputTokens = event.usage?.output_tokens ?? 0;
          }
        } catch (e) {
          throw new ProviderApiError(`Failed to parse Anthropic SSE chunk: ${data}`, 500, { error: e });
        }
      }
    }

    // 构建聚合后的 tool_calls 列表
    const toolCalls: Array<{
      id: string;
      type: 'function';
      index: number;
      function: { name: string; arguments: string };
    }> = [];
    for (const [index, tu] of toolUseMap) {
      toolCalls.push({
        id: tu.id,
        type: 'function',
        index,
        function: {
          name: tu.name,
          arguments: tu.args,
        },
      });
    }

    // Always emit a final chunk with usage so output_tokens is never absent
    yield {
      id: chunkId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: request.model,
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
        total_tokens: inputTokens + outputTokens,
      },
    };
  }

  async health(): Promise<ProviderHealth> {
    return createHealthCheck(this.name, `${this.getBaseUrl()}/v1/models`, this.getHeaders());
  }

  async fetchModels(): Promise<string[]> {
    return fetchModelsOpenAIFormat(`${this.getBaseUrl()}/v1/models`, this.getHeaders());
  }
}

// ════════════════════════════════════════════════════════════════════════
// 入口转换器 — Anthropic request → ChatCompletionRequest 及反向
// ════════════════════════════════════════════════════════════════════════

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

function anthropicStopReason(finish: string): 'end_turn' | 'max_tokens' {
  return finish === 'length' ? 'max_tokens' : 'end_turn';
}

function toInternal(body: Record<string, unknown>): ChatCompletionRequest {
  const req = body as unknown as AnthropicRequest;
  const msgs: ChatMessage[] = [];

  if (req.system) {
    const sysText = typeof req.system === 'string'
      ? req.system
      : req.system.map(s => s.text).join('\n');
    if (sysText) msgs.push({ role: 'system', content: sysText });
  }

  for (const m of req.messages) {
    if (typeof m.content === 'string') {
      msgs.push({ role: m.role, content: m.content });
    } else {
      const blocks = m.content as AnthropicContentBlock[];
      const texts: string[] = [];
      const toolCalls: ChatMessage['tool_calls'] = [];
      const toolResults: Array<{ tool_call_id: string; content: string }> = [];

      for (const b of blocks) {
        if (b.type === 'text') {
          texts.push(b.text ?? '');
        } else if (b.type === 'tool_use') {
          toolCalls?.push({
            id: b.id ?? '', type: 'function',
            function: { name: b.name ?? '', arguments: JSON.stringify(b.input ?? {}) },
          });
        } else if (b.type === 'tool_result') {
          // Anthropic tool_result blocks: convert to tool role messages
          const resultContent = typeof b.content === 'string'
            ? b.content
            : (b.content as Array<{ type: string; text?: string }> | undefined)?.map(c => c.text ?? '').join('') ?? '';
          toolResults.push({ tool_call_id: b.tool_use_id ?? '', content: resultContent });
        }
      }

      // Push the main message — only if it has actual content or tool_calls
      const hasContent = texts.length > 0 && texts.join('').trim().length > 0;
      const hasToolCalls = toolCalls && toolCalls.length > 0;
      if (hasContent || hasToolCalls) {
        msgs.push({
          role: m.role, content: hasContent ? texts.join('\n') : null,
          ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
        });
      }

      // Push tool result messages as separate tool-role messages
      for (const tr of toolResults) {
        msgs.push({ role: 'tool', tool_call_id: tr.tool_call_id, content: tr.content });
      }
    }
  }

  const tools = req.tools?.map(t => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  let toolChoice: ChatCompletionRequest['tool_choice'];
  if (req.tool_choice) {
    if (req.tool_choice.type === 'tool')
      toolChoice = { type: 'function', function: { name: req.tool_choice.name ?? '' } };
    else if (req.tool_choice.type === 'auto') toolChoice = 'auto';
    else toolChoice = 'none';
  }

  return {
    model: req.model, messages: msgs, max_tokens: req.max_tokens,
    temperature: req.temperature, top_p: req.top_p, stop: req.stop_sequences,
    stream: req.stream, tools, tool_choice: toolChoice,
    provider_options: { thinking: req.thinking },
  };
}

function fromInternal(ccResp: ChatCompletionResponse): AnthropicMessageResponse {
  const choice = ccResp.choices[0];
  if (!choice) {
    return { id: ccResp.id, type: 'message', role: 'assistant', content: [],
      model: ccResp.model, stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 } };
  }

  const content: AnthropicMessageResponse['content'] = [];
  if (choice.message.content)
    content.push({ type: 'text', text: choice.message.content });
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls)
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: safeParse(tc.function.arguments) });
  }

  return {
    id: ccResp.id, type: 'message', role: 'assistant', content, model: ccResp.model,
    stop_reason: anthropicStopReason(choice.finish_reason), stop_sequence: null,
    usage: { input_tokens: ccResp.usage?.prompt_tokens ?? 0, output_tokens: ccResp.usage?.completion_tokens ?? 0 },
  };
}

// 流式 — OpenAI SSE → Anthropic SSE 状态机

interface StreamState {
  messageId: string;
  phase: 'init' | 'started' | 'content' | 'tool_use' | 'stopped';
  contentBlockCount: number;
  toolUseBlocks: Map<number, { id: string; name: string }>;
  inputTokens: number;
  thinkingStarted: boolean;
}

function transformStream(source: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();
      let buffer = '';
      const state: StreamState = { messageId: `msg_${Math.random().toString(36).slice(2, 11)}`,
        phase: 'init', contentBlockCount: 0, toolUseBlocks: new Map(), inputTokens: 0, thinkingStarted: false };
      let lastOutputTokens = 0;

      function emit(event: string, data: unknown): void {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }
      function onFirstChunk(): void {
        if (state.phase !== 'init') return;
        state.phase = 'started';
        emit('message_start', { type: 'message_start', message: { id: state.messageId, type: 'message',
          role: 'assistant', content: [], model,
          usage: { input_tokens: state.inputTokens, output_tokens: 0 } } });
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') { if (state.phase !== 'stopped') { if (state.thinkingStarted) { emit('content_block_stop', { type: 'content_block_stop', index: 0 }); state.thinkingStarted = false; } if (state.contentBlockCount > 0) emit('content_block_stop', { type: 'content_block_stop', index: 0 }); for (const index of state.toolUseBlocks.keys()) emit('content_block_stop', { type: 'content_block_stop', index: index + 1 }); emit('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: lastOutputTokens } }); state.phase = 'stopped'; emit('message_stop', { type: 'message_stop' }); } continue; }
            try {
              const chunk = JSON.parse(data);
              if (state.phase === 'init' && chunk.usage) state.inputTokens = chunk.usage.prompt_tokens ?? 0;

              const delta = chunk.choices?.[0]?.delta;
              const finishReason = chunk.choices?.[0]?.finish_reason;
              const content = delta?.content;
              const reasoningContent = delta?.reasoning_content;
              const toolCalls = delta?.tool_calls as Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> | undefined;

              // Handle reasoning/thinking content
              if (reasoningContent !== undefined && reasoningContent !== null) {
                onFirstChunk();
                if (!state.thinkingStarted) {
                  state.thinkingStarted = true;
                  emit('content_block_start', { type: 'content_block_start', index: state.contentBlockCount, content_block: { type: 'thinking', thinking: '' } });
                }
                emit('content_block_delta', { type: 'content_block_delta', index: state.contentBlockCount, delta: { type: 'thinking_delta', thinking: reasoningContent } });
              }

              if (content !== undefined && content !== null) {
                onFirstChunk();
                // Close thinking block before opening text block (they share index 0)
                if (state.thinkingStarted) {
                  emit('content_block_stop', { type: 'content_block_stop', index: 0 });
                  state.thinkingStarted = false;
                }
                if (state.contentBlockCount === 0) {
                  state.contentBlockCount = 1;
                  emit('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
                }
                emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } });
              }

              if (toolCalls && toolCalls.length > 0) {
                onFirstChunk();
                for (const tc of toolCalls) {
                  if (!state.toolUseBlocks.has(tc.index)) {
                    const id = tc.id ?? `toolu_${Math.random().toString(36).slice(2, 11)}`;
                    state.toolUseBlocks.set(tc.index, { id, name: tc.function?.name ?? '' });
                    emit('content_block_start', { type: 'content_block_start', index: tc.index + 1, content_block: { type: 'tool_use', id, name: tc.function?.name ?? '' } });
                  }
                  emit('content_block_delta', { type: 'content_block_delta', index: tc.index + 1, delta: { type: 'input_json_delta', partial_json: tc.function?.arguments ?? '' } });
                }
              }

              // Track usage from chunk
              if (chunk.usage?.completion_tokens !== undefined) {
                lastOutputTokens = chunk.usage.completion_tokens;
              }

              if (finishReason) {
                onFirstChunk();
                if (state.thinkingStarted) { emit('content_block_stop', { type: 'content_block_stop', index: 0 }); state.thinkingStarted = false; }
                if (state.contentBlockCount > 0) emit('content_block_stop', { type: 'content_block_stop', index: 0 });
                for (const index of state.toolUseBlocks.keys()) emit('content_block_stop', { type: 'content_block_stop', index: index + 1 });
                emit('message_delta', { type: 'message_delta', delta: { stop_reason: finishReason === 'length' ? 'max_tokens' : 'end_turn' },
                  usage: { output_tokens: lastOutputTokens } });
                if (state.phase !== 'stopped') { state.phase = 'stopped'; emit('message_stop', { type: 'message_stop' }); }
              }
            } catch { /* skip unparseable */ }
          }
        }
      } finally {
        reader.releaseLock();
        // Always emit message_delta with output_tokens before message_stop if not yet emitted
        if (state.phase !== 'stopped') {
          emit('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: lastOutputTokens } });
          controller.enqueue(encoder.encode(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`));
        }
        controller.close();
      }
    },
  });
}

export function createAnthropicEntryConverter(): EntryConverter {
  return { protocol: 'anthropic', toInternal, fromInternal, transformStream };
}