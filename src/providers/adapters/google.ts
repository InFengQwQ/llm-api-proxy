import type {
  UnifiedRequest, UnifiedResponse, UnifiedStreamEvent,
  UnifiedMessage, UnifiedContentBlock, ProviderHealth,
} from '../../types/api.js';
import { ProviderApiError } from '../../types/api.js';
import type { ProviderConfig } from '../../config/index.js';
import type { ProviderAdapter, EntryConverter } from '../base.js';
import { createHealthCheck, fetchModelsGoogleFormat, throwOnHttpError, readSSELines } from '../base.js';
import { parseUnifiedSSE } from '../unified-utils.js';
import type { GoogleResponse } from '../../types/api.js';

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

  private buildRequest(req: UnifiedRequest): Record<string, unknown> {
    const systemInstructions = req.messages
      .filter(m => m.role === 'system')
      .flatMap(m => m.content.filter(b => b.type === 'text'))
      .map(b => ({ text: (b as { type: 'text'; text: string }).text }));

    const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];
    let currentRole: string | null = null;
    let currentParts: Array<Record<string, unknown>> = [];

    const flush = () => { if (currentParts.length) { contents.push({ role: currentRole!, parts: currentParts }); } };

    for (const msg of req.messages) {
      if (msg.role === 'system') continue;

      if (msg.role === 'tool') {
        flush();
        currentRole = 'user'; currentParts = [];
        const textBlock = msg.content.find(b => b.type === 'text') as { type: 'text'; text: string } | undefined;
        const content = textBlock?.text ?? '';
        let response: unknown = content;
        try { response = JSON.parse(content || '{}'); } catch { /* raw */ }
        currentParts.push({
          functionResponse: { name: msg.name ?? '', response: { content: response } },
        });
        flush();
        currentRole = null; currentParts = [];
        continue;
      }

      const role = msg.role === 'assistant' ? 'model' : 'user';
      if (role !== currentRole) { flush(); currentRole = role; currentParts = []; }

      for (const b of msg.content) {
        if (b.type === 'text') {
          currentParts.push({ text: b.text });
        } else if (b.type === 'tool_use') {
          currentParts.push({ functionCall: { name: b.name, args: b.input } });
        }
      }
    }
    flush();

    const cfg: Record<string, unknown> = {};
    if (req.temperature !== undefined) cfg.temperature = req.temperature;
    if (req.top_p !== undefined) cfg.topP = req.top_p;
    if (req.max_tokens !== undefined) cfg.maxOutputTokens = req.max_tokens;

    const body: Record<string, unknown> = { contents, generationConfig: cfg };
    if (systemInstructions.length) body.systemInstruction = { parts: systemInstructions };

    if (req.tools?.length) {
      body.tools = [{ functionDeclarations: req.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
    }

    if (req.tool_choice !== undefined) {
      if (req.tool_choice === 'none') body.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
      else if (req.tool_choice === 'auto') body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
      else if (req.tool_choice === 'any') body.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
      else if (typeof req.tool_choice === 'object') body.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [req.tool_choice.name] } };
    }

    return body;
  }

  async send(request: UnifiedRequest): Promise<UnifiedResponse> {
    const url = this.buildUrl(request.model, false);
    const body = this.buildRequest(request);
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    await throwOnHttpError(response, this.name);

    const data = await response.json() as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string;
            thought?: boolean;
            thinking?: string;
            functionCall?: { name: string; args: Record<string, unknown> };
          }>;
          role?: string;
        };
        finishReason?: string;
      }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
    };

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const content: UnifiedContentBlock[] = [];
    for (const p of parts) {
      if (p.thought) {
        content.push({ type: 'thinking', thinking: p.text ?? p.thinking ?? '' });
      } else if (p.text !== undefined) {
        content.push({ type: 'text', text: p.text });
      }
      if (p.functionCall) content.push({ type: 'tool_use', id: `call_${Date.now()}`, name: p.functionCall.name, input: p.functionCall.args ?? {} });
    }

    const finishReason = data.candidates?.[0]?.finishReason;
    const stopReason = finishReason === 'MAX_TOKENS' ? 'max_tokens'
      : finishReason === 'STOP' ? 'stop'
      : content.some(b => b.type === 'tool_use') ? 'tool_use'
      : 'stop';

    return {
      id: `google-${Date.now()}`, model: request.model, content,
      stop_reason: stopReason,
      usage: { input_tokens: data.usageMetadata?.promptTokenCount ?? 0, output_tokens: data.usageMetadata?.candidatesTokenCount ?? 0 },
    };
  }

  async *sendStreaming(request: UnifiedRequest): AsyncGenerator<UnifiedStreamEvent> {
    const url = this.buildUrl(request.model, true);
    const body = this.buildRequest(request);
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    await throwOnHttpError(response, this.name);

    const msgId = `google-${Date.now()}`;
    let started = false;
    const activeFnIndices = new Set<number>();

    for await (const line of readSSELines(response)) {
      try {
        const data = JSON.parse(line);
        const parts: Array<{ text?: string; thought?: boolean; thinking?: string; functionCall?: { name: string; args: Record<string, unknown> } }> = data.candidates?.[0]?.content?.parts ?? [];

        for (const [idx, part] of parts.entries()) {
          if (part.thought) {
            if (!started) { yield { type: 'message_start', id: msgId, model: request.model }; started = true; }
            yield { type: 'thinking_delta', thinking: part.text ?? part.thinking ?? '', index: idx };
          } else if (part.text !== undefined) {
            if (!started) { yield { type: 'message_start', id: msgId, model: request.model }; started = true; }
            yield { type: 'text_delta', text: part.text, index: idx };
          }
          if (part.functionCall) {
            if (!started) { yield { type: 'message_start', id: msgId, model: request.model }; started = true; }
            activeFnIndices.add(idx);
            const toolCallId = `call_${Date.now()}_${idx}`;
            yield { type: 'tool_use_start', id: toolCallId, name: part.functionCall.name, index: idx };
            yield { type: 'tool_use_delta', id: toolCallId, partial_json: JSON.stringify(part.functionCall.args ?? {}), index: idx };
          }
        }

        if (data.candidates?.[0]?.finishReason) {
          for (const index of activeFnIndices) {
            yield { type: 'content_block_stop', index };
          }
          activeFnIndices.clear();
          const hasFC = parts.some(p => p.functionCall);
          yield { type: 'message_stop', stop_reason: hasFC ? 'tool_use' : 'stop' };
        }
      } catch (e) {
        throw new ProviderApiError(`Failed to parse Google SSE line: ${line}`, 500, { error: e });
      }
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
// 入口转换器 — Gemini ↔ Unified
// ═══════════════════════════════════════════════

export function createGoogleEntryConverter(): EntryConverter {
  return {
    protocol: 'google',

    toInternal(body: Record<string, unknown>): UnifiedRequest {
      const systemParts = ((body.systemInstruction as Record<string, unknown>)?.parts as Array<{ text: string }>) ?? [];
      const genConfig = (body.generationConfig ?? {}) as Record<string, unknown>;
      const msgs: UnifiedMessage[] = [];
      const sysText = systemParts.map(p => p.text).join('\n');
      if (sysText) msgs.push({ role: 'system', content: [{ type: 'text', text: sysText }] });

      const contents = (body.contents ?? []) as Array<{
        role: 'user' | 'model';
        parts: Array<{ text?: string; thought?: boolean; thinking?: string; functionCall?: { name: string; args: Record<string, unknown> }; functionResponse?: { name: string; response: Record<string, unknown> } }>;
      }>;

      // 追踪同名 functionCall 的 ID 队列，用于 functionResponse 的 tool_call_id
      const toolCallIdQueues = new Map<string, string[]>();

      for (const c of contents) {
        for (const part of c.parts) {
          if (part.functionCall) {
            const id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            const queue = toolCallIdQueues.get(part.functionCall.name) ?? [];
            queue.push(id);
            toolCallIdQueues.set(part.functionCall.name, queue);
            msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id, name: part.functionCall.name, input: part.functionCall.args ?? {} }] });
          } else if (part.functionResponse) {
            const resultStr = typeof part.functionResponse.response === 'string'
              ? part.functionResponse.response
              : JSON.stringify(part.functionResponse.response?.content ?? part.functionResponse.response ?? '');
            const queue = toolCallIdQueues.get(part.functionResponse.name) ?? [];
            const toolCallId = queue.shift();
            msgs.push({ role: 'tool', content: [{ type: 'text', text: resultStr }], name: part.functionResponse.name, tool_call_id: toolCallId });
          } else if (part.text !== undefined) {
            const role = c.role === 'model' ? 'assistant' : 'user';
            const isThinking = part.thought === true;
            msgs.push({ role, content: [isThinking
              ? { type: 'thinking' as const, thinking: part.text }
              : { type: 'text' as const, text: part.text }] });
          }
        }
      }

      const googleTools = (body.tools ?? []) as Array<{ functionDeclarations?: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }> }>;
      let tools: UnifiedRequest['tools'];
      if (googleTools.length > 0 && googleTools[0].functionDeclarations) {
        tools = googleTools[0].functionDeclarations.map(fd => ({ name: fd.name, description: fd.description, parameters: fd.parameters }));
      }

      const callingCfg = ((body.toolConfig as Record<string, unknown>)?.functionCallingConfig) as Record<string, unknown> | undefined;
      let toolChoice: UnifiedRequest['tool_choice'];
      if (callingCfg) {
        if (callingCfg.mode === 'NONE') toolChoice = 'none';
        else if (callingCfg.mode === 'AUTO') toolChoice = 'auto';
        else if (callingCfg.mode === 'ANY') {
          const allowed = callingCfg.allowedFunctionNames as string[] | undefined;
          toolChoice = allowed?.length === 1 ? { type: 'tool', name: allowed[0] } : 'auto';
        }
      }

      return {
        model: (body.model as string) ?? '', messages: msgs,
        temperature: genConfig.temperature as number | undefined,
        top_p: genConfig.topP as number | undefined,
        max_tokens: genConfig.maxOutputTokens as number | undefined,
        stream: body.stream as boolean | undefined,
        stop_sequences: genConfig.stopSequences as string[] | undefined,
        tools, tool_choice: toolChoice,
      };
    },

    fromInternal(resp: UnifiedResponse): GoogleResponse {
      const parts: Array<{ text?: string; thought?: boolean; functionCall?: { name: string; args: Record<string, unknown> } }> = [];
      for (const b of resp.content) {
        if (b.type === 'text') parts.push({ text: b.text });
        else if (b.type === 'thinking') parts.push({ text: b.thinking, thought: true });
        else if (b.type === 'tool_use') parts.push({ functionCall: { name: b.name, args: b.input } });
      }
      const googleFinish = resp.stop_reason === 'max_tokens' ? 'MAX_TOKENS' : 'STOP';
      return {
        candidates: [{ content: { parts, role: 'model' }, finishReason: googleFinish }],
        usageMetadata: { promptTokenCount: resp.usage.input_tokens, candidatesTokenCount: resp.usage.output_tokens, totalTokenCount: resp.usage.input_tokens + resp.usage.output_tokens },
      };
    },

    toError(status: number, message: string, _type?: string): unknown {
      return { error: { code: status, message, status: 'INTERNAL' } };
    },

    transformStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          const toolAccum = new Map<number, { name: string; args: string }>();
          let finished = false;
          try {
            for await (const event of parseUnifiedSSE(source)) {
              switch (event.type) {
                case 'text_delta':
                  controller.enqueue(encoder.encode(
                    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: event.text }], role: 'model' } }] })}\n\n`
                  ));
                  break;

                case 'thinking_delta':
                  controller.enqueue(encoder.encode(
                    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: event.thinking, thought: true }], role: 'model' } }] })}\n\n`
                  ));
                  break;

                case 'tool_use_start':
                  toolAccum.set(event.index, { name: event.name, args: '' });
                  break;

                case 'tool_use_delta': {
                  const acc = toolAccum.get(event.index);
                  if (acc) acc.args += event.partial_json;
                  break;
                }

                case 'content_block_stop': {
                  const acc = toolAccum.get(event.index);
                  if (acc) {
                    let parsedArgs: Record<string, unknown> = {};
                    try { parsedArgs = JSON.parse(acc.args); } catch { /* emit empty */ }
                    controller.enqueue(encoder.encode(
                      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: acc.name, args: parsedArgs } }], role: 'model' } }] })}\n\n`
                    ));
                    toolAccum.delete(event.index);
                  }
                  break;
                }

                case 'message_stop': {
                  finished = true;
                  const finishReason = event.stop_reason === 'max_tokens' ? 'MAX_TOKENS' : 'STOP';
                  const resp: Record<string, unknown> = {
                    candidates: [{ content: { parts: [], role: 'model' }, finishReason }],
                  };
                  if (event.usage) {
                    resp.usageMetadata = {
                      promptTokenCount: event.usage.input_tokens,
                      candidatesTokenCount: event.usage.output_tokens,
                      totalTokenCount: event.usage.input_tokens + event.usage.output_tokens,
                    };
                  }
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(resp)}\n\n`));
                  break;
                }
              }
            }
          } finally {
            if (!finished) {
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ candidates: [{ content: { parts: [], role: 'model' }, finishReason: 'STOP' }] })}\n\n`
              ));
            }
            controller.close();
          }
        },
      });
    },
  };
}
