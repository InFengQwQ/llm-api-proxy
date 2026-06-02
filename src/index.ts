import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config/index.js';
import { initDatabase, closeDatabase } from './db/index.js';
import { Router, stopFlushInterval } from './router/index.js';
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
  router.registerAutoRouting(config.auto_routing ?? []);

  // 启动时异步拉取各 Provider 的模型列表（不阻塞服务启动）
  router.refreshAllModels();

  // 启动服务器
  const app = createApp(router, requestLogger);
  const { host, port } = config.server;

  const server = app.listen(port, host, () => {
    const models = router.getAllModels();
    console.log(`   LLM API Proxy running at http://${host}:${port}`);
    console.log(`   Registered ${config.providers.length} providers, ${models.length} models (from config / dynamic fetch)`);
    console.log(`   POST /v1/chat/completions             (OpenAI Chat Completions)`);
    console.log(`   POST /v1/messages                     (Anthropic Messages)`);
    console.log(`   POST /v1/responses                    (OpenAI Responses)`);
    console.log(`   POST /v1beta/models/:modelAndAction   (Google Gemini)`);
    console.log(`   POST /api/chat                        (Ollama Chat)`);
    console.log(`   GET  /v1/models                       (model list)`);
    console.log(`   GET  /health                          (health check)`);
    console.log(`   GET  /admin/providers                 (provider status)`);
    console.log(`   GET  /admin/logs                      (request logs)`);
  });

  // 优雅关闭
  const cleanup = () => {
    requestLogger.close();
    stopFlushInterval();
    router.destroy();
    closeDatabase();
  };
  process.on('SIGINT', () => {
    console.log('\n   Shutting down...');
    cleanup();
    server.close(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    console.log('\n   Shutting down...');
    cleanup();
    server.close(() => process.exit(0));
  });
}

main().catch(console.error);