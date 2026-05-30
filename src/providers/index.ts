import type { ProviderConfig } from '../config/index.js';
import type { ProviderAdapter } from './base.js';
import { OpenAIAdapter } from './openai.js';
import { AnthropicAdapter } from './anthropic.js';
import { OllamaAdapter } from './ollama.js';
import { GeminiAdapter } from './gemini.js';

const adapterMap = {
  openai: OpenAIAdapter,
  anthropic: AnthropicAdapter,
  ollama: OllamaAdapter,
  gemini: GeminiAdapter,
};

export function createAdapter(config: ProviderConfig): ProviderAdapter {
  const AdapterClass = adapterMap[config.type as keyof typeof adapterMap];
  if (!AdapterClass) {
    throw new Error(`Unsupported provider type: ${config.type}`);
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