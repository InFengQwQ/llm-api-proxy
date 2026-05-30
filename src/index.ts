import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config/index.js';
import { initDatabase } from './db/index.js';
import { Router } from './router/index.js';

async function main() {
  const config = loadConfig();

  // 初始化数据库
  initDatabase(config.database.path);

  // 初始化路由
  const router = new Router();
  router.register(config.providers);
  router.registerAutoRouting(config.auto_routing ?? {});

  // 启动服务器
  const app = createApp(router);
  const { host, port } = config.server;

  app.listen(port, host, () => {
    const models = router.getAllModels();
    console.log(`🚀 LLM API Proxy running at http://${host}:${port}`);
    console.log(`📋 Registered ${config.providers.length} providers, ${models.length} models total`);
    console.log(`   POST /v1/chat/completions  (OpenAI compatible)`);
    console.log(`   POST /v1/messages          (Anthropic compatible)`);
    console.log(`   GET  /v1/models            (model list)`);
    console.log(`   GET  /health               (health check)`);
    console.log(`   GET  /admin/providers      (provider status)`);
    console.log(`   GET  /admin/logs            (request logs)`);
  });
}

main().catch(console.error);