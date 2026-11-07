// POST /api/plan —— HTTP 层：输入校验、限流、并发保护、总时长上限、
// 客户端断开即取消（停止后续大模型与地图调用），支持 SSE 流式进度与普通 JSON 两种响应。

import { Router } from 'express';
import { getConfig } from '../config.js';
import { runWithContext } from '../lib/context.js';
import { AppError, cancelledError, toPublicError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { createRateLimiter } from '../lib/rateLimit.js';
import { acceptsEventStream, openEventStream } from '../lib/sse.js';
import { runPlanPipeline } from '../services/pipeline.js';

// 去掉控制字符，保留换行与制表符。
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function validateQuery(body, maxLength) {
  const query = body?.query;
  if (typeof query !== 'string' || !query.trim()) {
    throw new AppError('INVALID_INPUT', '请输入旅行需求', { status: 400 });
  }
  const cleaned = query.replace(CONTROL_CHARS, '').trim();
  if (cleaned.length > maxLength) {
    throw new AppError('INPUT_TOO_LONG', `需求描述过长，请控制在 ${maxLength} 字以内`, { status: 400 });
  }
  return cleaned;
}

export function createPlanRouter(config = getConfig()) {
  const router = Router();
  const rateLimit = createRateLimiter({ max: config.plan.rateLimitMax, windowMs: config.plan.rateLimitWindowMs });
  let active = 0;

  router.post('/plan', rateLimit, async (req, res, next) => {
    let query;
    try {
      query = validateQuery(req.body, config.plan.maxQueryLength);
    } catch (error) {
      next(error);
      return;
    }
    if (!getConfig().llm.apiKey) {
      next(new AppError('CONFIG_MISSING', '未配置 DEEPSEEK_API_KEY', { status: 503 }));
      return;
    }
    if (active >= config.plan.maxConcurrent) {
      res.setHeader('Retry-After', '15');
      next(new AppError('SERVER_BUSY', '并发规划请求已满', { status: 503, retryAfterMs: 15000 }));
      return;
    }

    active++;
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort(new AppError('PLAN_TIMEOUT', `行程生成超过 ${Math.round(config.plan.timeoutMs / 1000)} 秒`, { status: 504 }));
    }, config.plan.timeoutMs);
    // 注意：必须监听 res 的 close；req 的 close 在请求体读完后就会触发。
    res.on('close', () => {
      if (!res.writableEnded) controller.abort(cancelledError('客户端已断开'));
    });

    const stream = acceptsEventStream(req) ? openEventStream(res) : null;
    const context = { requestId: req.requestId, signal: controller.signal, stats: {} };
    try {
      const result = await runWithContext(context, () => {
        log.info('plan.start', { chars: query.length, stream: Boolean(stream) });
        return runPlanPipeline(query, { onProgress: event => stream?.send('progress', event) });
      });
      if (stream) {
        stream.send('result', result);
        stream.end();
      } else {
        res.json(result);
      }
    } catch (error) {
      const publicError = toPublicError(error);
      const level = publicError.code === 'CANCELLED' ? 'info' : publicError.status >= 500 ? 'error' : 'warn';
      runWithContext(context, () => log[level]('plan.failed', {
        code: error?.code || publicError.code,
        message: error?.message,
        ...(level === 'error' && !(error instanceof AppError) ? { stack: error?.stack } : {}),
      }));
      const body = {
        error: publicError.message,
        code: publicError.code,
        retryable: publicError.retryable,
        request_id: req.requestId,
      };
      if (stream) {
        stream.send('error', body);
        stream.end();
      } else if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        res.status(publicError.status).json(body);
      }
    } finally {
      active--;
      clearTimeout(deadline);
    }
  });

  return router;
}
