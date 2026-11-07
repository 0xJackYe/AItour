// 结构化日志：生产环境输出 JSON 行（便于 Cloud Logging / ELK 采集），
// 开发环境输出易读的单行文本。自动附带当前请求的 requestId。

import { currentContext } from './context.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function threshold() {
  return LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
}

function write(level, event, fields = {}) {
  if (LEVELS[level] < threshold()) return;
  const requestId = currentContext()?.requestId;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (process.env.NODE_ENV === 'production') {
    sink(JSON.stringify({
      time: new Date().toISOString(),
      severity: level.toUpperCase(),
      event,
      ...(requestId ? { request_id: requestId } : {}),
      ...fields,
    }));
    return;
  }
  const detail = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
  sink(`[${level.toUpperCase()}]${requestId ? ` (${requestId.slice(0, 8)})` : ''} ${event}${detail}`);
}

export const log = {
  debug: (event, fields) => write('debug', event, fields),
  info: (event, fields) => write('info', event, fields),
  warn: (event, fields) => write('warn', event, fields),
  error: (event, fields) => write('error', event, fields),
};
