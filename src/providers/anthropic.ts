import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  ProviderHealth,
} from '../../types/api.js';
import type { ProviderConfig } from '../../config/index.js';
import type { ProviderAdapter } from './base.js';

export class AnthropicAdapter implements ProviderAdapter {
  name: string;
  type = 'anthropic';

  constructor(private config: ProviderConfig) {
    this.name = config.name;
  }

  private getBaseUrl(): string {
    return this.config.base_url ?? 'https://api.anthropic.com/v1';
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
    const messages = req.messages.map((msg) => {
      if (msg.role === 'system') {
        return { role: 'user', content: `<system>${msg.content}</system>` };
      }
      return { role: msg.role, content: msg.content ?? '' };
    });

    const systemPrompt = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');

    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      max_tokens: req.max_tokens ?? 4096,
      temperature: req.temperature,
      top_p: req.top_p,
      stream: false,
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters ?? {},
      }));
      body.tool_choice = req.tool_choice === 'none'
        ? { type: 'any' }
        : { type: 'auto' };
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
        return { role: 'assistant' as const, content: block.text };
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
        prompt_tokens: resp.usage.input_tokens,
        completion_tokens: resp.usage.output_tokens,
        total_tokens: resp.usage.input_tokens + resp.usage.output_tokens,
      },
    };
  }

  private mergeMessages(parts: Array<{ role: string; content: string | null; tool_calls?: unknown[] }>) {
    const contentParts: string[] = [];
    const toolCalls: unknown[] = [];

    for (const p of parts) {
      if (p.tool_calls?.length) {
        toolCalls.push(...p.tool_calls);
      }
      if (p.content) {
        contentParts.push(p.content);
      }
    }

    return {
      role: 'assistant' as const,
      content: contentParts.join('\n') || null,
      tool_calls: toolCalls.length ? toolCalls as ChatCompletionResponse['choices'][0]['message']['tool_calls'] : undefined,
    };
  }

  async send(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const body = this.toAnthropicRequest(request);

    const response = await fetch(`${this.getBaseUrl()}/messages`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${error}`);
    }

    const resp = await response.json() as AnthropicMessageResponse;
    return this.fromAnthropicResponse(resp, request.model);
  }

  async *sendStreaming(request: ChatCompletionRequest): AsyncGenerator<StreamChunk> {
    const body = this.toAnthropicRequest(request);
    body.stream = true;

    const response = await fetch(`${this.getBaseUrl()}/messages`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let accumulatedContent = '';
    let toolCalls: unknown[] = [];
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
        if (data === '[DONE]') {
          yield this.makeFinalChunk(chunkId, request.model, accumulatedContent, toolCalls);
          return;
        }

        try {
          const event = JSON.parse(data);

          if (event.type === 'content_block_delta') {
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
            } else if (event.delta.type === 'input_json_delta') {
              // tool_use delta
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
                          index: 0,
                          id: event.id,
                          function: {
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
        } catch {
          // skip
        }
      }
    }

    yield this.makeFinalChunk(chunkId, request.model, accumulatedContent, toolCalls);
  }

  private makeFinalChunk(
    id: string,
    model: string,
    content: string,
    _toolCalls: unknown[]
  ): StreamChunk {
    return {
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'stop',
        },
      ],
    };
  }

  async health(): Promise<ProviderHealth> {
    const start = Date.now();
    try {
      const response = await fetch(`${this.getBaseUrl()}/messages`, {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.models[0],
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(5000),
      });
      return {
        provider: this.name,
        status: response.ok || response.status === 400 ? 'healthy' : 'degraded',
        latency_ms: Date.now() - start,
        error_rate: response.ok ? 0 : 1,
      };
    } catch {
      return {
        provider: this.name,
        status: 'unavailable',
        latency_ms: Date.now() - start,
        error_rate: 1,
      };
    }
  }
}