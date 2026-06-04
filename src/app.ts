import express, { type Request, type Response, type NextFunction } from 'express';
import { Router } from './router/index.js';
import { getDb } from './db/index.js';
import { logComplete } from './db/index.js';
import { RequestContextMiddleware } from './middleware/request-context.js';
import type { RequestContext } from './types/log.js';
import { entryConverters } from './providers/index.js';

export function createApp(router: Router, requestContextMiddleware?: RequestContextMiddleware) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // 请求上下文中间件（创建 RequestContext + body dump）
  if (requestContextMiddleware) {
    app.use(requestContextMiddleware.middleware());
  }

  // 健康检查
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', providers: router.listProviders() });
  });

  // ---- 5 入口统一处理器 ----

  function pipeStream(stream: ReadableStream<Uint8Array>, res: Response): void {
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked',
    });
    res.flushHeaders();
    const reader = stream.getReader();
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
  }

  async function handleEntry(
    protocol: string,
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const converter = entryConverters[protocol];
      if (!converter) {
        res.status(500).json({ error: { message: `Unknown entry protocol: ${protocol}`, type: 'internal_error' } });
        return;
      }

      // 1. 原生请求 → ChatCompletionRequest
      const ccRequest = converter.toInternal(req.body as Record<string, unknown>);

      if (!ccRequest.model) {
        res.status(400).json({ error: { message: 'model is required', type: 'invalid_request_error' } });
        return;
      }

      const sessionId = req.headers['x-session-id'] as string | undefined;

      // 2. 从 res.locals.ctx 获取请求上下文（由 RequestContextMiddleware 创建）
      const ctx = (res.locals as Record<string, unknown>).ctx as RequestContext | undefined;
      if (ctx) {
        ctx.entryProtocol = protocol;
        ctx.model = ccRequest.model;
      }

      // 3. 路由 + 上游调用
      const upstreamResponse = await router.route(
        ccRequest.model, ccRequest, ctx ?? {
          requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          startTime: Date.now(),
          method: req.method,
          path: req.originalUrl || req.url,
          model: ccRequest.model,
          ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || '-',
          userAgent: (req.headers['user-agent'] as string) || '-',
          entryProtocol: protocol,
          isStream: !!ccRequest.stream,
          provider: '-',
          statusCode: 0,
          latencyMs: 0,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          errorMsg: null,
          errorPayload: null,
        }, sessionId,
      );

      // 4. 流式：OpenAI SSE → 原生 SSE
      if (ccRequest.stream) {
        const contentType = upstreamResponse.headers.get('Content-Type') || '';
        if (!contentType.startsWith('text/event-stream')) {
          const data = await upstreamResponse.json();
          if (data.error) {
            const nativeErr = converter.toError(upstreamResponse.status, data.error.message, data.error.type);
            res.status(upstreamResponse.status).set('X-Request-Id', ctx?.requestId ?? '').json(nativeErr);
          } else {
            res.status(upstreamResponse.status).set('X-Request-Id', ctx?.requestId ?? '').json(data);
          }
          return;
        }
        const nativeStream = converter.transformStream(upstreamResponse.body!);
        pipeStream(nativeStream, res);
        return;
      }

      // 5. 非流式：ChatCompletionResponse → 原生格式
      const ccResp = await upstreamResponse.json();
      if (ccResp.error) {
        const nativeErr = converter.toError(upstreamResponse.status, ccResp.error.message, ccResp.error.type);
        res.status(upstreamResponse.status).set('X-Request-Id', ctx?.requestId ?? '').json(nativeErr);
        return;
      }
      const nativeResp = converter.fromInternal(ccResp);
      res.status(upstreamResponse.status).set('X-Request-Id', ctx?.requestId ?? '').json(nativeResp);
    } catch (err) {
      next(err);
    }
  }

  // ---- 入口端点 ----

  // OpenAI: POST /v1/chat/completions
  app.post('/v1/chat/completions', (req, res, next) => handleEntry('openai', req, res, next));

  // Anthropic: POST /v1/messages
  app.post('/v1/messages',         (req, res, next) => handleEntry('anthropic', req, res, next));

  // OpenAI Responses: POST /v1/responses
  app.post('/v1/responses',        (req, res, next) => handleEntry('openai_responses', req, res, next));

  // Google Gemini: POST /v1beta/models/{model}:generateContent 或 :streamGenerateContent
  app.post('/v1beta/models/:modelAndAction', async (req, res, next) => {
    const fullPath = req.params.modelAndAction as string;
    const colonIdx = fullPath.lastIndexOf(':');
    const model = colonIdx >= 0 ? fullPath.slice(0, colonIdx) : fullPath;
    const action = colonIdx >= 0 ? fullPath.slice(colonIdx + 1) : 'generateContent';
    const isStream = action === 'streamGenerateContent' || req.query.alt === 'sse';
    // Inject model into body (Google entries don't include model in the request body)
    (req.body as Record<string, unknown>).model = model;
    if (!(req.body as Record<string, unknown>).stream) {
      (req.body as Record<string, unknown>).stream = isStream || undefined;
    }
    handleEntry('google', req, res, next);
  });

  // Ollama: POST /api/chat
  app.post('/api/chat', (req, res, next) => handleEntry('ollama', req, res, next));

  // 模型列表（各协议共用）
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
    const protocol = req.query.protocol as string | undefined;
    const status = req.query.status as string | undefined;
    const method = req.query.method as string | undefined;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (provider) {
      conditions.push('provider = ?');
      params.push(provider);
    }
    if (protocol) {
      conditions.push('entry_protocol = ?');
      params.push(protocol);
    }
    if (status) {
      conditions.push('status_code = ?');
      params.push(Number(status));
    }
    if (method) {
      conditions.push('method = ?');
      params.push(method);
    }

    let sql = 'SELECT * FROM request_logs';
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = getDb().prepare(sql).all(...params);
    res.json({ logs: rows });
  });

  // 全局错误处理
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    console.error('[Error]', err);
    const ctx = (res.locals as Record<string, unknown>).ctx as RequestContext | undefined;
    if (ctx) {
      ctx.statusCode = 500;
      ctx.latencyMs = Date.now() - ctx.startTime;
      ctx.errorMsg = err.message || 'Internal server error';
      logComplete(ctx);
    }
    res.status(500).json({ error: { message: err.message || 'Internal server error' } });
  });

  return app;
}