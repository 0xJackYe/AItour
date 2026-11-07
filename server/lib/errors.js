// 统一错误模型：每个错误都带稳定的 code、HTTP 状态和是否可重试，
// 前端据此展示友好提示，日志据此聚合告警。

export class AppError extends Error {
  constructor(code, message, { status = 500, retryable = false, retryAfterMs = 0, cause, details } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    if (retryAfterMs) this.retryAfterMs = retryAfterMs;
    if (details) this.details = details;
  }
}

// 面向用户的提示文案。内部错误细节只进日志，不直接暴露给浏览器。
const PUBLIC_MESSAGES = {
  INVALID_INPUT: '请输入旅行需求',
  INPUT_TOO_LONG: '需求描述过长，请精简后再试',
  RATE_LIMITED: '请求过于频繁，请稍后再试',
  SERVER_BUSY: '当前规划请求较多，请稍后重试',
  CONFIG_MISSING: '服务端未配置大模型 API Key',
  LLM_AUTH: '大模型 API Key 无效或没有权限',
  LLM_QUOTA: '大模型账户余额不足',
  LLM_RATE_LIMITED: '大模型服务繁忙，请稍后重试',
  LLM_UNAVAILABLE: '大模型服务暂时不可用，请稍后重试',
  LLM_BAD_REQUEST: '大模型请求参数异常，请检查模型配置',
  LLM_TIMEOUT: '大模型响应超时，请稍后重试',
  LLM_INVALID_OUTPUT: 'AI 返回的行程格式异常，请重试',
  LLM_CONTENT_FILTERED: '该需求触发了内容安全策略，请调整描述',
  PLAN_INCOMPLETE: 'AI 未能生成完整的逐日行程，请重试或缩短天数',
  PLAN_TIMEOUT: '行程生成耗时过长，请稍后重试或缩短天数',
  CANCELLED: '已取消',
  NOT_FOUND: '接口不存在',
  PAYLOAD_TOO_LARGE: '请求内容过大',
  INTERNAL: '服务器内部错误，请稍后重试',
};

// LLM 输出层面的细分错误统一对外表现为“格式异常”或“天数不完整”。
const PUBLIC_CODE_ALIASES = {
  LLM_EMPTY_OUTPUT: 'LLM_INVALID_OUTPUT',
  LLM_INVALID_JSON: 'LLM_INVALID_OUTPUT',
  LLM_OUTPUT_TRUNCATED: 'LLM_INVALID_OUTPUT',
  LLM_OUTPUT_INTERRUPTED: 'LLM_INVALID_OUTPUT',
  LLM_MISSING_PLAN: 'LLM_INVALID_OUTPUT',
  LLM_STREAM_INTERRUPTED: 'LLM_UNAVAILABLE',
  LLM_STALLED: 'LLM_TIMEOUT',
  LLM_INCOMPLETE_PLAN: 'PLAN_INCOMPLETE',
};

export function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'CANCELLED' || error?.code === 'ABORT_ERR';
}

export function cancelledError(message = '请求已取消') {
  return new AppError('CANCELLED', message, { status: 499 });
}

export function toPublicError(error) {
  if (error instanceof AppError) {
    const code = PUBLIC_CODE_ALIASES[error.code] || error.code;
    const exposeOriginal = code === 'INVALID_INPUT' || code === 'INPUT_TOO_LONG' || code === 'PLAN_INCOMPLETE';
    return {
      code,
      message: (exposeOriginal && error.message) || PUBLIC_MESSAGES[code] || error.message || PUBLIC_MESSAGES.INTERNAL,
      status: error.status || 500,
      retryable: Boolean(error.retryable) || ['RATE_LIMITED', 'SERVER_BUSY', 'LLM_RATE_LIMITED', 'LLM_UNAVAILABLE', 'LLM_TIMEOUT', 'LLM_INVALID_OUTPUT', 'PLAN_INCOMPLETE', 'PLAN_TIMEOUT'].includes(code),
      retry_after_ms: error.retryAfterMs || undefined,
    };
  }
  if (isAbortError(error)) {
    return { code: 'CANCELLED', message: PUBLIC_MESSAGES.CANCELLED, status: 499, retryable: true };
  }
  return { code: 'INTERNAL', message: PUBLIC_MESSAGES.INTERNAL, status: 500, retryable: true };
}
