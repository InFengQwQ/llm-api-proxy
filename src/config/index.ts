import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { ProviderType } from '../types/index.js';

// 环境变量替换：${VAR_NAME} -> process.env.VAR_NAME
function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '');
  }
  if (Array.isArray(obj)) return obj.map(resolveEnvVars);
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = resolveEnvVars(v);
    }
    return result;
  }
  return obj;
}

const RateLimitSchema = z.object({
  rpm: z.number().optional(),
  tpm: z.number().optional(),
});

const CircuitBreakerSchema = z.object({
  failure_threshold: z.number().min(1).default(3),
  recovery_timeout: z.number().min(1).default(30),
});

const ProviderSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['openai', 'anthropic', 'deepseek', 'gemini', 'ollama']),
  api_key: z.string().optional(),
  base_url: z.string().url().optional(),
  models: z.array(z.string()).min(1),
  enabled: z.boolean().default(true),
  circuit_breaker: CircuitBreakerSchema.default({}),
  rate_limit: RateLimitSchema.optional(),
});

const ConfigSchema = z.object({
  server: z.object({
    host: z.string().default('0.0.0.0'),
    port: z.number().int().min(1).max(65535).default(3000),
    master_key: z.string().optional(),
  }),
  providers: z.array(ProviderSchema).min(1),
  database: z.object({
    path: z.string().default('./data/gateway.db'),
  }),
  rate_limits: RateLimitSchema.optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ProviderConfig = Config['providers'][number];

let configInstance: Config | null = null;

export function loadConfig(path: string = 'config.yaml'): Config {
  if (configInstance) return configInstance;

  const raw = readFileSync(path, 'utf-8');
  const resolved = resolveEnvVars(parse(raw)) as unknown;
  configInstance = ConfigSchema.parse(resolved);
  return configInstance;
}

export function getConfig(): Config {
  if (!configInstance) return loadConfig();
  return configInstance;
}

export function resetConfig(): void {
  configInstance = null;
}