import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  ProviderHealth,
  ProviderApiError
} from '../../types/api.js';
import type { ProviderConfig } from '../../config/index.js';
import type { ProviderAdapter, EntryConverter } from '../base.js';
import type { OllamaResponse } from '../../types/api.js';

export class OllamaAdapter implements ProviderAdapter {
  name: string;
  type = 'ollama';

  constructor(private config: ProviderConfig) {
    this.name = config.name;
  }

  private getBaseUrl(): string {
    return this.config.base_url ?? 'http://localhost:11434';
  }

  /**
   * Fetch with retry on 503 — Ollama returns 503 when a model is still
   * loading into memory. Retry with exponential backoff (2s, 4s, 8s, 16s).
   */
  private async fetchWithRetry(body: Record<string, unknown>, maxRetries = 4): Promise<Response> {
    const url = `${this.getBaseUrl()}/api/chat`;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutMs = 120_000; // 2 min total — generous for model loading
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        // 503 "model loading" is transient — retry after backoff
        if (response.status === 503 && attempt < maxRetries) {
          const delay = Math.min(2000 * Math.pow(2, attempt), 16000);
          console.warn(
            `[Ollama] 503 (model loading), retrying in ${delay / 1000}s ` +
            `(attempt ${attempt + 1}/${maxRetries})`
          );
          // Drain the response body to avoid memory leaks
          await response.text().catch(() => {});
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        return response;
      } catch (err) {
        // On network error / abort, retry if we have attempts left
        if (attempt < maxRetries) {
          const delay = Math.min(2000 * Math.pow(2, attempt), 16000);
          console.warn(
            `[Ollama] fetch error, retrying in ${delay / 1000}s ` +
            `(attempt ${attempt + 1}/${maxRetries}): ${err instanceof Error ? err.message : String(err)}`
          );
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    // Unreachable — loop always returns or throws
    throw new Error('Ollama fetchWithRetry: max retries exceeded');
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

    const response = await this.fetchWithRetry(body);

    if (!response.ok) {
      const errorText = await response.text();
      let payload;
      try { payload = JSON.parse(errorText); } catch { /* ignore */ }
      throw new ProviderApiError(`Ollama API error ${response.status}: ${errorText}`, response.status, payload);
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

    const response = await this.fetchWithRetry(body);

    if (!response.ok) {
      const errorText = await response.text();
      let payload;
      try { payload = JSON.parse(errorText); } catch { /* ignore */ }
      throw new ProviderApiError(`Ollama API error ${response.status}: ${errorText}`, response.status, payload);
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

          // Ollama thinking/reasoning content (exposed as "thinking" field in chat API)
          const thinkingContent = (event.message as Record<string, unknown> | undefined)?.thinking as string | undefined;
          if (thinkingContent !== undefined && thinkingContent !== '') {
            yield {
              id: chunkId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: request.model,
              choices: [{
                index: 0,
                delta: { reasoning_content: thinkingContent },
              }],
            };
          }

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
      } catch (e) {
        throw new ProviderApiError(`Failed to parse Ollama stream line`, 500, { error: e });
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
      return {
        provider: this.name,
        status: 'unavailable',
        latency_ms: Date.now() - start,
        error_rate: 1,
      };
    }
  }

  async fetchModels(): Promise<string[]> {
    const response = await fetch(`${this.getBaseUrl()}/api/tags`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as { models?: Array<{ name?: string }> };
    return (data.models ?? [])
      .map(m => m.name)
      .filter((id): id is string => typeof id === 'string');
  }
}

// ═══════════════════════════════════════════════
// 入口转换器 — Ollama request → CCR 及反向
// ═══════════════════════════════════════════════

export function createOllamaEntryConverter(): EntryConverter {
  return {
    protocol: 'ollama',

    toInternal(body: Record<string, unknown>): ChatCompletionRequest {
      const options = (body.options ?? {}) as Record<string, unknown>;
      return {
        model: (body.model as string) ?? '',
        messages: (body.messages ?? []) as ChatCompletionRequest['messages'],
        temperature: options.temperature as number | undefined,
        top_p: options.top_p as number | undefined,
        max_tokens: options.num_predict as number | undefined,
        stream: body.stream as boolean | undefined,
        stop: options.stop as string[] | undefined,
      };
    },

    fromInternal(ccResp: ChatCompletionResponse): OllamaResponse {
      return { model: ccResp.model, message: { role: 'assistant', content: ccResp.choices[0]?.message?.content ?? '' }, done: true };
    },

    transformStream(source: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder(); const decoder = new TextDecoder();
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = source.getReader(); let buffer = '';
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
              for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') { controller.enqueue(encoder.encode(JSON.stringify({ model, message: { role: 'assistant', content: '' }, done: true }) + '\n')); continue; }
                try {
                  const chunk = JSON.parse(data);
                  const reasoning = chunk.choices?.[0]?.delta?.reasoning_content;
                  const content = chunk.choices?.[0]?.delta?.content;
                  if (reasoning !== undefined && reasoning !== null)
                    controller.enqueue(encoder.encode(JSON.stringify({ model, message: { role: 'assistant', content: '', thinking: reasoning }, done: false }) + '\n'));
                  if (content !== undefined && content !== null)
                    controller.enqueue(encoder.encode(JSON.stringify({ model, message: { role: 'assistant', content }, done: false }) + '\n'));
                  if (chunk.choices?.[0]?.finish_reason)
                    controller.enqueue(encoder.encode(JSON.stringify({ model, message: { role: 'assistant', content: '' }, done: true }) + '\n'));
                } catch { /* skip */ }
              }
            }
          } finally { reader.releaseLock(); controller.close(); }
        },
      });
    },
  };
}