import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config/index.js';
import { initDatabase } from './db/index.js';
import { Router } from './router/index.js';
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