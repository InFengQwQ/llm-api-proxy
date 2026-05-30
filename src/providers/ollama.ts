import type { ChatCompletionRequest, ChatCompletionResponse, StreamChunk, ProviderHealth } from '../../types/api.js';
import type { ProviderConfig } from '../../config/index.js';
import type { ProviderAdapter } from './base.js';

export class OllamaAdapter implements ProviderAdapter {
  name: string;
  type = 'ollama';

  constructor(private config: ProviderConfig) {
    this.name = config.name;
  }

  private getBaseUrl(): string {
    return this.config.base_url ?? 'http://localhost:11434';
  }

  async send(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const body = {
      model: request.model,
      messages: request.messages,
      stream: false,
      options: {
        temperature: request.temperature,
        top_p: request.top_p,
        num_predict: request.max_tokens,
      },
    };

    const response = await fetch(`${this.getBaseUrl()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error ${response.status}: ${error}`);
    }

    const data = await response.json() as {
      model: string;
      message: { role: string; content: string };
      total_duration: number;
    };

    return {
      id: `ollama-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: data.message.content },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };
  }

  async *sendStreaming(request: ChatCompletionRequest): AsyncGenerator<StreamChunk> {
    const body = {
      model: request.model,
      messages: request.messages,
      stream: true,
      options: {
        temperature: request.temperature,
        top_p: request.top_p,
        num_predict: request.max_tokens,
      },
    };

    const response = await fetch(`${this.getBaseUrl()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error ${response.status}: ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    const chunkId = `ollama-${Date.now()}`;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      try {
        const lines = text.split('\n').filter(Boolean);
        for (const line of lines) {
          const event = JSON.parse(line);
          if (event.message?.content) {
            yield {
              id: chunkId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: request.model,
              choices: [{
                index: 0,
                delta: { content: event.message.content },
              }],
            };
          }
          if (event.done) {
            yield {
              id: chunkId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: request.model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            };
          }
        }
      } catch {
        // skip malformed lines
      }
    }
  }

  async health(): Promise<ProviderHealth> {
    const start = Date.now();
    try {
      const response = await fetch(`${this.getBaseUrl()}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      return {
        provider: this.name,
        status: response.ok ? 'healthy' : 'degraded',
        latency_ms: Date.now() - start,
        error_rate: response.ok ? 0 : 1,
      };
    } catch {
      return { provider: this.name, status: 'unavailable', latency_ms: Date.now() - start, error_rate: 1 };
    }
  }
}