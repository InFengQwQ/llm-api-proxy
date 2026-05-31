import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config/index.js';
import { initDatabase } from './db/index.js';
import { Router } from './router/index.js';
import { parseModelId } from './providers/index.js';
import { RequestLogger } from './middleware/request-logger.js';

async function main() {
  const config = loadConfig();

  // 初始化数据库
  initDatabase(config.database.path);

  // 初始化文件日志
  const requestLogger = new RequestLogger(config.logging?.log_dir ?? 'logs');

  // 初始化路由
  const router = new Router();
  router.register(config.providers);
  router.registerAutoRouting(config.auto_routing ?? {});

  // 启动时预热连接：对每个 auto-routing group 的首个 target 发起轻量 DNS/TLS 预热
  // 减少首次请求时的连接冷启动延迟，但失败不阻塞启动
  if (config.auto_routing) {
    console.log('   Warming up auto-routing targets...');
    const warmed = new Set<string>();
    for (const [groupName, group] of Object.entries(config.auto_routing)) {
      for (const target of group.targets) {
        if (warmed.has(target)) continue;
        warmed.add(target);
        try {
          const { provider_name } = parseModelId(target);
          const providerConfig = config.providers.find(p => p.name === provider_name);
          if (providerConfig?.base_url && providerConfig.api_key) {
            const warmUrl = `${providerConfig.base_url}/models`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            try {
              await fetch(warmUrl, {
                headers: {
                  'Authorization': `Bearer ${providerConfig.api_key}`,
                  'Content-Type': 'application/json',
                },
                signal: controller.signal,
              });
              console.log(`     ${provider_name}: warmup OK`);
            } catch {
              // 预热失败静默忽略，实际请求时再处理
              console.log(`     ${provider_name}: warmup skipped (unreachable or timeout)`);
            } finally {
              clearTimeout(timeout);
            }
          }
        } catch {
          // 解析失败，跳过
        }
        break; // 每组只预热第一个 target（同 provider 共享连接）
      }
    }
    console.log('   Warmup complete');
  }

  // 启动服务器
  const app = createApp(router, requestLogger);
  const { host, port } = config.server;

  const server = app.listen(port, host, () => {
    const models = router.getAllModels();
    console.log(`   LLM API Proxy running at http://${host}:${port}`);
    console.log(`   Registered ${config.providers.length} providers, ${models.length} models total`);
    console.log(`   POST /v1/chat/completions  (OpenAI compatible)`);
    console.log(`   POST /v1/messages          (Anthropic compatible)`);
    console.log(`   GET  /v1/models            (model list)`);
    console.log(`   GET  /health               (health check)`);
    console.log(`   GET  /admin/providers      (provider status)`);
    console.log(`   GET  /admin/logs           (request logs)`);
  });

  // 优雅关闭
  process.on('SIGINT', () => {
    console.log('\n   Shutting down...');
    requestLogger.close();
    server.close(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    requestLogger.close();
    server.close(() => process.exit(0));
  });
}

main().catch(console.error);