import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  ProviderHealth,
} from '../types/api.js';
import type { ProviderConfig } from '../config/index.js';
import type { ProviderAdapter } from './base.js';

export class GeminiAdapter implements ProviderAdapter {
  name: string;
  type = 'gemini';

  constructor(private config: ProviderConfig) {
    this.name = config.name;
  }

  private getBaseUrl(): string {
    return this.config.base_url ?? 'https://generativelanguage.googleapis.com/v1beta';
  }

  private buildUrl(model: string, stream: boolean): string {
    const parts = [`key=${this.config.api_key ?? ''}`];
    if (stream) parts.push('stream=true');
    return `${this.getBaseUrl()}/models/${model}:generateContent?${parts.join('&')}`;
  }

  private toGeminiRequest(req: ChatCompletionRequest): Record<string, unknown> {
    const systemInstructions = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => ({ text: m.content ?? '' }));

    const contents = [];
    let currentRole: string | null = null;
    let currentParts: Array<{ text?: string }> = [];

    for (const msg of req.messages) {
      if (msg.role === 'system') continue;

      const role = msg.role === 'tool' ? 'model' : (msg.role === 'assistant' ? 'model' : 'user');
      if (role !== currentRole) {
        if (currentParts.length) {
          contents.push({ role: currentRole, parts: currentParts });
        }
        currentRole = role;
        currentParts = [];
      }

      if (typeof msg.content === 'string') {
        currentParts.push({ text: msg.content });
      }
    }
    if (currentParts.length) {
      contents.push({ role: currentRole, parts: currentParts });
    }

    const generationConfig: Record<string, unknown> = {};
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
    if (req.top_p !== undefined) generationConfig.topP = req.top_p;
    if (req.max_tokens !== undefined) generationConfig.maxOutputTokens = req.max_tokens;

    const body: Record<string, unknown> = {
      contents,
      generationConfig,
    };

    if (systemInstructions.length) {
      body.systemInstruction = { parts: systemInstructions };
    }

    return body;
  }

  async send(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const url = this.buildUrl(request.model, false);
    const body = this.toGeminiRequest(request);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${error}`);
    }

    const data = await response.json() as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    };

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const texts = parts.map((p) => p.text ?? '').join('');
    const finishReason = data.candidates?.[0]?.finishReason ?? 'STOP';

    return {
      id: `gemini-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: texts },
          finish_reason: finishReason === 'STOP' ? 'stop' : 'length',
        },
      ],
      usage: {
        prompt_tokens: data.usageMetadata?.promptTokenCount ?? 0,
        completion_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        total_tokens: data.usageMetadata?.totalTokenCount ?? 0,
      },
    };
  }

  async *sendStreaming(request: ChatCompletionRequest): AsyncGenerator<StreamChunk> {
    const url = this.buildUrl(request.model, true);
    const body = this.toGeminiRequest(request);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    const chunkId = `gemini-${Date.now()}`;
    let accumulatedText = '';
    let firstChunk = true;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      const lines = text.split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (content !== undefined) {
            accumulatedText += content;

            yield {
              id: chunkId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: request.model,
              choices: [
                {
                  index: 0,
                  delta: { content },
                },
              ],
            };
            firstChunk = false;
          }
        } catch {
          // skip non-JSON lines
        }
      }
    }

    if (firstChunk) {
      yield {
        id: chunkId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      };
    }
  }

  async health(): Promise<ProviderHealth> {
    const start = Date.now();
    try {
      const url = `${this.getBaseUrl()}/models?key=${this.config.api_key ?? ''}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
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
}