import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  StreamChunk,
  ProviderHealth,
  ProviderApiError
} from '../../types/api.js';
import type { ProviderConfig } from '../../config/index.js';
import type { ProviderAdapter, EntryConverter } from '../base.js';
import { createHealthCheck, fetchModelsGoogleFormat } from '../base.js';
import type { ChatMessage, GoogleResponse } from '../../types/api.js';

export class GoogleAdapter implements ProviderAdapter {
  name: string;
  type = 'google';

  constructor(private config: ProviderConfig) {
    this.name = config.name;
  }

  private getBaseUrl(): string {
    return this.config.base_url ?? 'https://generativelanguage.googleapis.com';
  }

  private buildUrl(model: string, stream: boolean): string {
    const endpoint = stream ? 'streamGenerateContent' : 'generateContent';
    const key = `key=${this.config.api_key ?? ''}`;
    return `${this.getBaseUrl()}/v1beta/models/${model}:${endpoint}?${key}`;
  }

  private toGoogleRequest(req: ChatCompletionRequest): Record<string, unknown> {
    const systemInstructions = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => ({ text: m.content ?? '' }));

    const contents = [];
    let currentRole: string | null = null;
    let currentParts: Array<{ text?: string }> = [];

    for (const msg of req.messages) {
      if (msg.role === 'system') continue;

      const role = msg.role === 'assistant' ? 'model' : 'user';
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
    const body = this.toGoogleRequest(request);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let payload;
      try { payload = JSON.parse(errorText); } catch { /* ignore */ }
      throw new ProviderApiError(`Google API error ${response.status}: ${errorText}`, response.status, payload);
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
      id: `google-${Date.now()}`,
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
    const body = this.toGoogleRequest(request);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let payload;
      try { payload = JSON.parse(errorText); } catch { /* ignore */ }
      throw new ProviderApiError(`Google API error ${response.status}: ${errorText}`, response.status, payload);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    const chunkId = `google-${Date.now()}`;
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
        } catch (e) {
          throw new ProviderApiError(`Failed to parse Google SSE line: ${line}`, 500, { error: e });
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
    return createHealthCheck(this.name, `${this.getBaseUrl()}/v1beta/models?key=${this.config.api_key ?? ''}`);
  }

  async fetchModels(): Promise<string[]> {
    return fetchModelsGoogleFormat(`${this.getBaseUrl()}/v1beta/models?key=${this.config.api_key ?? ''}`);
  }
}

// ═══════════════════════════════════════════════
// 入口转换器 — Gemini request → CCR 及反向
// ═══════════════════════════════════════════════

const FINISH_MAP: Record<string, 'stop' | 'length'> = { STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'length', RECITATION: 'length' };

export function createGoogleEntryConverter(): EntryConverter {
  return {
    protocol: 'google',

    toInternal(body: Record<string, unknown>): ChatCompletionRequest {
      const systemParts = ((body.systemInstruction as Record<string, unknown>)?.parts as Array<{ text: string }>) ?? [];
      const generationConfig = (body.generationConfig ?? {}) as Record<string, unknown>;
      const msgs: ChatMessage[] = [];
      const sysText = systemParts.map(p => p.text).join('\n');
      if (sysText) msgs.push({ role: 'system', content: sysText });

      const contents = (body.contents ?? []) as Array<{ role: 'user' | 'model'; parts: Array<{ text?: string }> }>;
      for (const c of contents) {
        const text = c.parts.map(p => p.text ?? '').join('');
        msgs.push({ role: c.role === 'model' ? 'assistant' : 'user', content: text });
      }

      return {
        model: (body.model as string) ?? '', messages: msgs,
        temperature: generationConfig.temperature as number | undefined,
        top_p: generationConfig.topP as number | undefined,
        max_tokens: generationConfig.maxOutputTokens as number | undefined,
        stream: body.stream as boolean | undefined,
        stop: generationConfig.stopSequences as string[] | undefined,
      };
    },

    fromInternal(ccResp: ChatCompletionResponse): GoogleResponse {
      const text = ccResp.choices[0]?.message?.content ?? '';
      const rawFinish = ccResp.choices[0]?.finish_reason ?? 'stop';
      return {
        candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: rawFinish === 'stop' ? 'STOP' : 'MAX_TOKENS' }],
        usageMetadata: { promptTokenCount: ccResp.usage?.prompt_tokens ?? 0, candidatesTokenCount: ccResp.usage?.completion_tokens ?? 0, totalTokenCount: ccResp.usage?.total_tokens ?? 0 },
      };
    },

    transformStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = source.getReader();
          let buffer = ''; let finished = false;
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
                  const content = chunk.choices?.[0]?.delta?.content;
                  const reasoning = chunk.choices?.[0]?.delta?.reasoning_content;
                  const finishReason = chunk.choices?.[0]?.finish_reason;
                  if (reasoning !== undefined && reasoning !== null)
                    controller.enqueue(encoder.encode(JSON.stringify({ candidates: [{ content: { parts: [{ text: reasoning, thought: true }] } }] }) + '\n'));
                  if (content !== undefined && content !== null)
                    controller.enqueue(encoder.encode(JSON.stringify({ candidates: [{ content: { parts: [{ text: content }] } }] }) + '\n'));
                  if (finishReason) {
                    finished = true;
                    controller.enqueue(encoder.encode(JSON.stringify({
                      candidates: [{ content: { parts: [{ text: '' }] }, finishReason: FINISH_MAP[finishReason.toUpperCase()] === 'stop' ? 'STOP' : 'MAX_TOKENS' }],
                      usageMetadata: chunk.usage ? { promptTokenCount: chunk.usage.prompt_tokens, candidatesTokenCount: chunk.usage.completion_tokens, totalTokenCount: chunk.usage.total_tokens } : undefined,
                    }) + '\n'));
                  }
                } catch { /* skip */ }
              }
            }
            if (!finished) controller.enqueue(encoder.encode(JSON.stringify({ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }] }) + '\n'));
          } finally { controller.close(); reader.releaseLock(); }
        },
      });
    },
  };
}
