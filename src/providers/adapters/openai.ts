import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  ProviderHealth,
  ProviderApiError
} from '../../types/api.js';
import type { ProviderConfig } from '../../config/index.js';
import type { ProviderAdapter, EntryConverter } from '../base.js';

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
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.api_key ?? ''}`,
    };
    return headers;
  }

  private buildRequestBody(request: ChatCompletionRequest, stream: boolean): Record<string, unknown> {
    // Strip null/undefined content, name, and tool_call_id from messages
    // to prevent upstream deserialization failures (e.g., 'null' not matching
    // ChatCompletionRequestUserMessageContent enum variants).
    const cleanMessages = request.messages.map(m => {
      const cleaned: Record<string, unknown> = {
        role: m.role,
        content: m.content ?? '', // null content → empty string for user/assistant
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
    if (request.stop !== undefined) body.stop = request.stop;
    if (request.tools !== undefined) body.tools = request.tools;
    if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;
    if (request.response_format !== undefined) body.response_format = request.response_format;
    if (request.seed !== undefined) body.seed = request.seed;
    if (request.presence_penalty !== undefined) body.presence_penalty = request.presence_penalty;
    if (request.frequency_penalty !== undefined) body.frequency_penalty = request.frequency_penalty;
    if (request.user !== undefined) body.user = request.user;
    return body;
  }

  async send(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
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
      throw new ProviderApiError(`OpenAI API error ${response.status}: ${errorText}`, response.status, payload);
    }

    return response.json() as Promise<ChatCompletionResponse>;
  }

  async *sendStreaming(request: ChatCompletionRequest): AsyncGenerator<StreamChunk> {
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
      throw new ProviderApiError(`OpenAI API error ${response.status}: ${errorText}`, response.status, payload);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') return;
          try {
            yield JSON.parse(data) as StreamChunk;
          } catch (e) {
            throw new ProviderApiError(`Failed to parse chunk: ${data}`, 500, { error: e });
          }
        }
      }
    }
  }

  async health(): Promise<ProviderHealth> {
    const start = Date.now();
    try {
      const response = await fetch(`${this.getBaseUrl()}/v1/models`, {
        headers: this.getHeaders(),
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
    const response = await fetch(`${this.getBaseUrl()}/v1/models`, {
      headers: this.getHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as { data?: Array<{ id?: string }> };
    return (data.data ?? [])
      .map(m => m.id)
      .filter((id): id is string => typeof id === 'string');
  }
}

// ══════════════════════════════════════════════
// 入口转换器 — 透传（CCR 本身即 OpenAI 格式）
// ══════════════════════════════════════════════

export function createOpenAIEntryConverter(): EntryConverter {
  return {
    protocol: 'openai',

    toInternal(body: Record<string, unknown>): ChatCompletionRequest {
      return {
        model: (body.model as string) ?? '',
        messages: (body.messages as ChatCompletionRequest['messages']) ?? [],
        temperature: body.temperature as number | undefined,
        top_p: body.top_p as number | undefined,
        max_tokens: body.max_tokens as number | undefined,
        stream: body.stream as boolean | undefined,
        stop: body.stop as string | string[] | undefined,
        tools: body.tools as ChatCompletionRequest['tools'],
        tool_choice: body.tool_choice as ChatCompletionRequest['tool_choice'],
        response_format: body.response_format as ChatCompletionRequest['response_format'],
        seed: body.seed as number | undefined,
        presence_penalty: body.presence_penalty as number | undefined,
        frequency_penalty: body.frequency_penalty as number | undefined,
        user: body.user as string | undefined,
      };
    },

    fromInternal(ccResp: ChatCompletionResponse): unknown { return ccResp; },

    transformStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> { return source; },
  };
}