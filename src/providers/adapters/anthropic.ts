import type {
  UnifiedRequest,
  UnifiedResponse,
  UnifiedStreamEvent,
  UnifiedMessage,
  UnifiedContentBlock,
  ProviderHealth,
} from '../../types/api.js';
import { ProviderApiError } from '../../types/api.js';
import type { AnthropicRequest, AnthropicContentBlock, AnthropicMessageResponse } from '../../types/api.js';
import type { ProviderConfig } from '../../config/index.js';
import type { ProviderAdapter, EntryConverter } from '../base.js';
import {
  createHealthCheck,
  fetchModelsOpenAIFormat,
  throwOnHttpError,
  readSSELines,
} from '../base.js';
import { parseUnifiedSSE } from '../unified-utils.js';

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
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.config.api_key ?? '',
      'anthropic-version': '2023-06-01',
    };
  }

  // Unified �?Anthropic request
  private buildRequest(req: UnifiedRequest): Record<string, unknown> {
    const systemBlocks = req.messages
      .filter(m => m.role === 'system')
      .flatMap(m => m.content.filter(b => b.type === 'text'))
      .map(b => (b as { type: 'text'; text: string }).text);
    const systemPrompt = systemBlocks.join('\n');

    const messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }> = [];

    for (const msg of req.messages) {
      if (msg.role === 'system') continue;

      if (msg.role === 'tool') {
        // Tool message �?user with tool_result content blocks
        const resultBlocks = msg.content.map(b => {
          if (b.type === 'text') return { type: 'tool_result' as const, tool_use_id: msg.tool_call_id ?? '', content: b.text };
          return { type: 'tool_result' as const, tool_use_id: msg.tool_call_id ?? '', content: JSON.stringify(b) };
        });
        messages.push({ role: 'user', content: resultBlocks as unknown as Array<Record<string, unknown>> });
      } else {
        // Convert content blocks to Anthropic blocks
        const blocks: Array<Record<string, unknown>> = [];
        for (const b of msg.content) {
          switch (b.type) {
            case 'text':
              blocks.push({ type: 'text', text: b.text });
              break;
            case 'tool_use':
              blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
              break;
            case 'thinking':
              blocks.push({ type: 'thinking', thinking: b.thinking });
              break;
            // image/tool_result handled above in tool case
          }
        }
        if (blocks.length === 0) {
          messages.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: '' });
        } else if (blocks.length === 1 && blocks[0].type === 'text') {
          messages.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: blocks[0].text as string });
        } else {
          messages.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: blocks });
        }
      }
    }

    const maxTokens = req.max_tokens ?? 8192;
    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      max_tokens: maxTokens,
      ...(this.config.compat_output_tokens ? { output_tokens: maxTokens } : {}),
      stream: false,
    };

    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.top_p !== undefined) body.top_p = req.top_p;
    if (req.stop_sequences) body.stop_sequences = req.stop_sequences;
    if (systemPrompt) body.system = systemPrompt;

    if (req.tools?.length) {
      body.tools = req.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters ?? {},
      }));
      if (req.tool_choice) {
        if (typeof req.tool_choice === 'object') {
          body.tool_choice = { type: 'tool', name: req.tool_choice.name };
        } else if (req.tool_choice === 'auto') {
          body.tool_choice = { type: 'auto' };
        } else if (req.tool_choice === 'any') {
          body.tool_choice = { type: 'any' };
        } else {
          // 'none' �?don't send tools
          delete body.tools;
        }
      }
    }

    if (req.extended_thinking) {
      body.thinking = { type: 'enabled', budget_tokens: req.extended_thinking.budget_tokens };
    }

    return body;
  }

  // Anthropic response �?UnifiedResponse
  private parseResponse(resp: AnthropicMessageResponse, model: string): UnifiedResponse {
    const content: UnifiedContentBlock[] = [];

    for (const block of resp.content) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text ?? '' });
      } else if (block.type === 'tool_use') {
        content.push({
          type: 'tool_use',
          id: block.id ?? '',
          name: block.name ?? '',
          input: block.input ?? {},
        });
      } else if (block.type === 'thinking') {
        content.push({ type: 'thinking', thinking: block.thinking ?? '' });
      }
    }

    return {
      id: resp.id,
      model,
      content,
      stop_reason: resp.stop_reason === 'tool_use' ? 'tool_use'
        : resp.stop_reason === 'max_tokens' ? 'max_tokens'
        : resp.stop_reason === 'stop_sequence' ? 'stop_sequence'
        : 'stop',
      usage: {
        input_tokens: resp.usage?.input_tokens ?? 0,
        output_tokens: resp.usage?.output_tokens ?? 0,
      },
    };
  }

  async send(request: UnifiedRequest): Promise<UnifiedResponse> {
    const body = this.buildRequest(request);

    const response = await fetch(`${this.getBaseUrl()}/v1/messages`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    await throwOnHttpError(response, this.name);

    const resp = await response.json() as AnthropicMessageResponse;
    return this.parseResponse(resp, request.model);
  }

  async *sendStreaming(request: UnifiedRequest): AsyncGenerator<UnifiedStreamEvent> {
    const body = this.buildRequest(request);
    body.stream = true;

    const response = await fetch(`${this.getBaseUrl()}/v1/messages`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    await throwOnHttpError(response, this.name);

    const msgId = `msg_${Math.random().toString(36).slice(2, 11)}`;
    let started = false;
    const activeToolIndexes = new Map<number, { id: string; name: string }>();
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason = 'end_turn';

    for await (const line of readSSELines(response)) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') break;

      try {
        const event = JSON.parse(data);

        if (event.type === 'message_start') {
          if (!started) {
            yield { type: 'message_start', id: msgId, model: request.model };
            started = true;
          }
          inputTokens = event.message?.usage?.input_tokens ?? 0;
        } else if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block?.type === 'tool_use') {
            activeToolIndexes.set(event.index, { id: block.id ?? '', name: block.name ?? '' });
            yield { type: 'tool_use_start', id: block.id ?? '', name: block.name ?? '', index: event.index };
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            yield { type: 'text_delta', text: event.delta.text, index: event.index };
          } else if (event.delta.type === 'input_json_delta') {
            const info = activeToolIndexes.get(event.index);
            yield { type: 'tool_use_delta', id: info?.id ?? '', partial_json: event.delta.partial_json, index: event.index };
          } else if (event.delta.type === 'thinking_delta') {
            yield { type: 'thinking_delta', thinking: event.delta.thinking, index: event.index };
          }
        } else if (event.type === 'content_block_stop') {
          yield { type: 'content_block_stop', index: event.index };
        } else if (event.type === 'message_delta') {
          outputTokens = event.usage?.output_tokens ?? 0;
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
        } else if (event.type === 'message_stop') {
          // Anthropic sends message_stop at end
        }
      } catch (e) {
        throw new ProviderApiError(`Failed to parse Anthropic SSE chunk: ${data}`, 500, { error: e });
      }
    }

    yield {
      type: 'message_stop',
      stop_reason: stopReason,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
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
// 入口转换�?�?Anthropic �?Unified 及反�?// ════════════════════════════════════════════════════════════════════════

function contentToUnifiedBlocks(blocks: AnthropicContentBlock[]): UnifiedContentBlock[] {
  return blocks.map(b => {
    switch (b.type) {
      case 'text':
        return { type: 'text' as const, text: b.text ?? '' };
      case 'tool_use':
        return { type: 'tool_use' as const, id: b.id, name: b.name ?? '', input: b.input ?? {} };
      case 'tool_result': {
        const text = typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.map(c => c.text ?? '').join('') : '';
        return { type: 'text' as const, text };
      }
      case 'thinking':
        return { type: 'thinking' as const, thinking: b.thinking ?? '' };
      default:
        return { type: 'text' as const, text: '' };
    }
  });
}

export function createAnthropicEntryConverter(): EntryConverter {
  return {
    protocol: 'anthropic',

    toInternal(body: Record<string, unknown>): UnifiedRequest {
      const req = body as unknown as AnthropicRequest;
      const msgs: UnifiedMessage[] = [];

      if (req.system) {
        const sysText = typeof req.system === 'string'
          ? req.system
          : req.system.map(s => s.text).join('\n');
        if (sysText) msgs.push({ role: 'system', content: [{ type: 'text', text: sysText }] });
      }

      const toolUseNames = new Map<string, string>();

      for (const m of req.messages) {
        if (typeof m.content === 'string') {
          msgs.push({ role: m.role, content: [{ type: 'text', text: m.content }] });
        } else {
          const originalBlocks = m.content as AnthropicContentBlock[];
          const mainBlocks: UnifiedContentBlock[] = [];

          for (const orig of originalBlocks) {
            if (orig.type === 'tool_result') {
              const text = typeof orig.content === 'string'
                ? orig.content
                : Array.isArray(orig.content) ? orig.content.map(c => c.text ?? '').join('') : '';
              const name = toolUseNames.get(orig.tool_use_id);
              msgs.push({ role: 'tool', content: [{ type: 'text', text }], tool_call_id: orig.tool_use_id, name });
            } else {
              // Track tool_use name for later tool result pairing
              if (orig.type === 'tool_use') toolUseNames.set(orig.id ?? '', orig.name ?? '');
              // Convert non-tool_result blocks via helper
              const [unified] = contentToUnifiedBlocks([orig]);
              mainBlocks.push(unified);
            }
          }

          if (mainBlocks.length > 0) {
            msgs.push({ role: m.role, content: mainBlocks });
          }
        }
      }

      const tools = req.tools?.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      }));

      let toolChoice: UnifiedRequest['tool_choice'];
      if (req.tool_choice) {
        if (req.tool_choice.type === 'tool')
          toolChoice = { type: 'tool', name: req.tool_choice.name ?? '' };
        else if (req.tool_choice.type === 'auto') toolChoice = 'auto';
        else if (req.tool_choice.type === 'any') toolChoice = 'any';
        else if (req.tool_choice.type === 'none') toolChoice = 'none';
      }

      return {
        model: req.model, messages: msgs, max_tokens: req.max_tokens ?? 8192,
        temperature: req.temperature, top_p: req.top_p, stop_sequences: req.stop_sequences,
        stream: req.stream, tools, tool_choice: toolChoice,
        extended_thinking: req.thinking ? { budget_tokens: req.thinking.budget_tokens } : undefined,
      };
    },

    fromInternal(resp: UnifiedResponse): AnthropicMessageResponse {
      const content: AnthropicMessageResponse['content'] = [];
      for (const b of resp.content) {
        if (b.type === 'text') content.push({ type: 'text', text: b.text });
        else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
        else if (b.type === 'thinking') content.push({ type: 'thinking', thinking: b.thinking });
      }

      const stopReason = resp.stop_reason === 'tool_use' ? 'tool_use' : (
        resp.stop_reason === 'max_tokens' ? 'max_tokens' : (
          resp.stop_reason === 'stop_sequence' ? 'stop_sequence' : 'end_turn'
        )
      );

      return {
        id: resp.id, type: 'message', role: 'assistant', content, model: resp.model,
        stop_reason: stopReason, stop_sequence: null,
        usage: { input_tokens: resp.usage.input_tokens, output_tokens: resp.usage.output_tokens },
      };
    },

    toError(_status: number, message: string, type?: string): unknown {
      return { type: 'error', error: { type: type ?? 'api_error', message } };
    },

    transformStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          const startedBlocks = new Set<number>();
          try {
            for await (const event of parseUnifiedSSE(source)) {
              switch (event.type) {
                case 'message_start':
                  controller.enqueue(encoder.encode(
                    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: event.id, type: 'message', role: 'assistant', content: [], model: event.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`
                  ));
                  break;

                case 'text_delta':
                  if (!startedBlocks.has(event.index)) {
                    startedBlocks.add(event.index);
                    controller.enqueue(encoder.encode(
                      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: event.index, content_block: { type: 'text', text: '' } })}\n\n`
                    ));
                  }
                  controller.enqueue(encoder.encode(
                    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: event.index, delta: { type: 'text_delta', text: event.text } })}\n\n`
                  ));
                  break;

                case 'thinking_delta':
                  if (!startedBlocks.has(event.index)) {
                    startedBlocks.add(event.index);
                    controller.enqueue(encoder.encode(
                      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: event.index, content_block: { type: 'thinking', thinking: '' } })}\n\n`
                    ));
                  }
                  controller.enqueue(encoder.encode(
                    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: event.index, delta: { type: 'thinking_delta', thinking: event.thinking } })}\n\n`
                  ));
                  break;

                case 'tool_use_start':
                  startedBlocks.add(event.index);
                  controller.enqueue(encoder.encode(
                    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: event.index, content_block: { type: 'tool_use', id: event.id, name: event.name, input: {} } })}\n\n`
                  ));
                  break;

                case 'tool_use_delta':
                  controller.enqueue(encoder.encode(
                    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: event.index, delta: { type: 'input_json_delta', partial_json: event.partial_json } })}\n\n`
                  ));
                  break;

                case 'content_block_stop':
                  controller.enqueue(encoder.encode(
                    `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: event.index })}\n\n`
                  ));
                  break;

                case 'message_stop': {
                  const stopReason = event.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn';
                  const deltaPayload: Record<string, unknown> = {
                    type: 'message_delta',
                    delta: { stop_reason: stopReason, stop_sequence: null },
                    usage: { output_tokens: event.usage?.output_tokens ?? 0 },
                  };
                  controller.enqueue(encoder.encode(`event: message_delta\ndata: ${JSON.stringify(deltaPayload)}\n\n`));
                  controller.enqueue(encoder.encode(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`));
                  break;
                }
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
