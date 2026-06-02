import type { ProviderConfig } from '../config/index.js';
import type { ProviderAdapter, EntryConverter } from './base.js';
import { OpenAIAdapter, createOpenAIEntryConverter } from './adapters/openai.js';
import { AnthropicAdapter, createAnthropicEntryConverter } from './adapters/anthropic.js';
import { OllamaAdapter, createOllamaEntryConverter } from './adapters/ollama.js';
import { GoogleAdapter, createGoogleEntryConverter } from './adapters/google.js';
import { OpenAIResponsesAdapter, createResponsesEntryConverter } from './adapters/openai-responses.js';
import { MultiProtocolAdapter } from './multi.js';

export type { EntryConverter } from './base.js';

/** protocol key → entry converter 注册表 */
export const entryConverters: Record<string, EntryConverter> = {
  openai: createOpenAIEntryConverter(),
  anthropic: createAnthropicEntryConverter(),
  google: createGoogleEntryConverter(),
  ollama: createOllamaEntryConverter(),
  openai_responses: createResponsesEntryConverter(),
};

const adapterMap: Record<string, new (config: ProviderConfig) => ProviderAdapter> = {
  openai: OpenAIAdapter,
  anthropic: AnthropicAdapter,
  ollama: OllamaAdapter,
  google: GoogleAdapter,
  openai_responses: OpenAIResponsesAdapter,
};

/** Return all registered adapter type keys (for 'auto' resolution) */
export function getAdapterKeys(): string[] {
  return Object.keys(adapterMap);
}

export function createAdapter(config: ProviderConfig): ProviderAdapter {
  const { type } = config;

  // 'auto' → try all registered adapters
  if (type === 'auto') {
    return new MultiProtocolAdapter(config, getAdapterKeys());
  }

  // Array → MultiProtocolAdapter with priority order
  if (Array.isArray(type)) {
    return new MultiProtocolAdapter(config, type);
  }

  // Single string type
  const AdapterClass = adapterMap[type];
  if (!AdapterClass) {
    throw new Error(`Unsupported provider type: ${type}`);
  }
  return new AdapterClass(config);
}

// 解析模型 ID，返回 { provider_name, model_id }
// 例如 "我的Claude/claude-sonnet-4-7" -> { provider_name: "我的Claude", model_id: "claude-sonnet-4-7" }
export function parseModelId(fullId: string): { provider_name: string; model_id: string } {
  const idx = fullId.indexOf('/');
  if (idx === -1) {
    throw new Error(`Invalid model id format: "${fullId}". Expected "<provider>/<model_id>".`);
  }
  return {
    provider_name: fullId.slice(0, idx),
    model_id: fullId.slice(idx + 1),
  };
}