import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { z } from 'zod';

// 环境变量替换：${VAR_NAME} -> process.env.VAR_NAME
function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{(\w+)\}/g, (_, name) => {
      if (process.env[name] === undefined) {
        throw new Error(`Environment variable "${name}" is referenced in config but not set.`);
      }
      return process.env[name]!;
    });
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

export interface CircuitBreakerConfig {
  failure_threshold: number; // 连续失败多少次后打开断路器
  recovery_timeout: number; // 秒，恢复探测间隔
}

const RateLimitSchema = z.object({
  rpm: z.number().optional(),
  tpm: z.number().optional(),
}).strict();

const CircuitBreakerSchema = z.object({
  failure_threshold: z.number().min(1).default(3),
  recovery_timeout: z.number().min(1).default(30),
}).strict();

const ProviderTypeEnum = z.enum(['openai', 'anthropic', 'google', 'ollama', 'openai_responses']);

// type 支持单值、数组（按优先级尝试）、或 'auto'（尝试所有已注册 adapter）
const TypeSchema = z.union([
  ProviderTypeEnum,
  z.array(ProviderTypeEnum).min(1),
  z.literal('auto'),
]);

const ProviderSchema = z.object({
  name: z.string().min(1),
  type: TypeSchema,
  api_key: z.string().optional(),
  base_url: z.string().url().optional(),
  /** 静态模型列表（可选）。不填则实时从 /models 端点拉取 */
  models: z.array(z.string()).optional(),
  /** 是否从 Provider 的 /models 端点实时拉取模型列表（默认 true） */
  fetch_models: z.boolean().default(true),
  enabled: z.boolean().default(true),
  circuit_breaker: CircuitBreakerSchema.default({}),
  rate_limit: RateLimitSchema.optional(),
}).strict();

const AutoRoutingGroupSchema = z.object({
  name: z.string().min(1),
  /** 候选列表，格式同 model 字段，支持 <provider>/<model> */
  targets: z.array(z.string()).min(1),
  /** 熔断恢复前连续失败 N 次后暂时跳过该 target（默认 3） */
  failure_threshold: z.number().min(1).default(3),
}).strict();

const ConfigSchema = z.object({
  server: z.object({
    host: z.string().default('0.0.0.0'),
    port: z.number().int().min(1).max(65535).default(3000),
    master_key: z.string().optional(),
  }).strict(),
  providers: z.array(ProviderSchema).min(1),
  database: z.object({
    path: z.string().default('./data/gateway.db'),
  }).strict(),
  logging: z.object({
    log_dir: z.string().default('logs'),
  }).strict().optional().default({}),
  rate_limits: RateLimitSchema.optional(),
  /** auto 路由组，调用方使用 model="auto:<group>" 触发 */
  auto_routing: z.array(AutoRoutingGroupSchema).optional(),
}).strict();

export type AutoRoutingGroup = z.infer<typeof AutoRoutingGroupSchema>;

export type Config = z.infer<typeof ConfigSchema>;
export type ProviderConfig = Config['providers'][number];
export type AutoRoutingConfig = AutoRoutingGroup[];

let configInstance: Config | null = null;
let configPath: string | null = null;

export function loadConfig(path: string = 'config.yaml'): Config {
  if (configInstance) {
    if (configPath !== path) {
      console.warn(`[config] loadConfig("${path}") called but already loaded from "${configPath}". Using cached instance.`);
    }
    return configInstance;
  }

  const raw = readFileSync(path, 'utf-8');
  const resolved = resolveEnvVars(parse(raw)) as unknown;
  configInstance = ConfigSchema.parse(resolved);
  configPath = path;
  return configInstance;
}

export function getConfig(): Config {
  if (!configInstance) return loadConfig();
  return configInstance;
}

export function resetConfig(): void {
  configInstance = null;
}