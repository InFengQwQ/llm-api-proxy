import express, { type Request, type Response, type NextFunction } from 'express';
import type { ChatCompletionRequest } from './types/api.js';
import { Router } from './router/index.js';
import { getDb } from './db/index.js';
import { type RequestLogger } from './middleware/request-logger.js';

export function createApp(router: Router, requestLogger?: RequestLogger) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // HTTP 请求文件日志中间件（在所有路由之前）
  if (requestLogger) {
    app.use(requestLogger.middleware());
  }

  // 健康检查
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', providers: router.listProviders() });
  });

  // OpenAI 兼容端点
  app.post('/v1/chat/completions', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as ChatCompletionRequest;

      if (!body.model) {
        res.status(400).json({ error: { message: 'model is required', type: 'invalid_request_error' } });
        return;
      }

      const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const sessionId = req.headers['x-session-id'] as string | undefined;
      const response = await router.route(body.model, body, requestId, sessionId);

      if (body.stream) {
        // 检查响应是否为真正的 SSE 流；若路由返回了 JSON 错误（非流式），
        // 不应进入 SSE 流水线，否则会以 200 + text/event-stream 回传错误 JSON，
        // 导致客户端显示空白（SSE 解析器无法解析 JSON）
        const contentType = response.headers.get('Content-Type') || '';
        if (!contentType.startsWith('text/event-stream')) {
          const data = await response.json();
          res.status(response.status).set('X-Request-Id', requestId).json(data);
          return;
        }

        // 流式响应：读取 Web Response 并写入 Express Response
        res.set({
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Request-Id': requestId,
          'Transfer-Encoding': 'chunked',
        });
        res.flushHeaders();
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        const pump = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) { res.end(); break; }
              res.write(value);
            }
          } catch (err) {
            console.error(`[gateway] stream read error: ${err instanceof Error ? err.message : String(err)}`);
            res.end();
          }
        };
        pump();
        return;
      }

      const data = await response.json();
      res.status(response.status).set('X-Request-Id', requestId).json(data);
    } catch (err) {
      next(err);
    }
  });

  // Anthropic Messages API 端点（可选入口）
  app.post('/v1/messages', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as {
        model: string;
        messages: unknown[];
        max_tokens: number;
        stream?: boolean;
      };

      if (!body.model || !body.max_tokens) {
        res.status(400).json({ error: { message: 'model and max_tokens are required', type: 'invalid_request_error' } });
        return;
      }

      const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const chatRequest: ChatCompletionRequest = {
        model: body.model,
        messages: (body.messages as ChatCompletionRequest['messages']) ?? [],
        max_tokens: body.max_tokens,
        stream: body.stream,
      };

      const sessionId = req.headers['x-session-id'] as string | undefined;
      const response = await router.route(body.model, chatRequest, requestId, sessionId);

      if (body.stream) {
        // 检查响应是否为真正的 SSE 流（与 /v1/chat/completions 相同逻辑）
        const contentType = response.headers.get('Content-Type') || '';
        if (!contentType.startsWith('text/event-stream')) {
          const data = await response.json();
          res.status(response.status).set('X-Request-Id', requestId).json(data);
          return;
        }

        res.set({
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Request-Id': requestId,
          'Transfer-Encoding': 'chunked',
        });
        res.flushHeaders();
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        const pump = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) { res.end(); break; }
              res.write(value);
            }
          } catch (err) {
            console.error(`[gateway] stream read error: ${err instanceof Error ? err.message : String(err)}`);
            res.end();
          }
        };
        pump();
        return;
      }

      const data = await response.json();
      res.status(response.status).set('X-Request-Id', requestId).json(data);
    } catch (err) {
      next(err);
    }
  });

  // 模型列表
  app.get('/v1/models', (_req: Request, res: Response) => {
    const models = router.getAllModels();
    res.json({
      object: 'list',
      data: models,
    });
  });

  // Provider 状态
  app.get('/admin/providers', (_req, res) => {
    res.json(router.listProviders());
  });

  app.get('/admin/providers/:name/health', (req, res) => {
    const health = router.getProviderHealth(req.params.name);
    if (!health) {
      res.status(404).json({ error: 'Provider not found' });
      return;
    }
    res.json(health);
  });

  // Auto 路由组列表
  app.get('/admin/auto-routing', (_req, res) => {
    res.json(router.listAutoRoutingGroups());
  });

  // 热度降权状态
  app.get('/admin/auto-routing/heat', (_req, res) => {
    res.json(router.getModelHeatInfo());
  });

  // 请求日志
  app.get('/admin/logs', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    const provider = req.query.provider as string | undefined;

    let sql = 'SELECT * FROM request_logs';
    const params: unknown[] = [];
    if (provider) {
      sql += ' WHERE provider = ?';
      params.push(provider);
    }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = getDb().prepare(sql).all(...params);
    res.json({ logs: rows });
  });

  // 全局错误处理
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[Error]', err);
    res.status(500).json({ error: { message: err.message || 'Internal server error' } });
  });

  return app;
}