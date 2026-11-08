// 大模型调用层：OpenAI 兼容协议（默认 DeepSeek）。
//
// 可靠性设计：
//  - 传输层：流式读取 + 总超时 + 空闲超时（识别上游卡死），429/5xx/网络错误
//    指数退避重试，调用方取消立即中止，不再继续消耗额度；
//  - 输出层：JSON 解析容错，空输出 / 非法 JSON 带提示重试一次；
//  - 结构层：规范化 + 逐日完整性校验，缺天只针对缺失天定向补全，而不是整份重来；
//  - 策略层：长行程走“骨架 + 分段细化”；单次生成被截断时自动降级为分段生成。

import { AppError, isAbortError } from '../lib/errors.js';
import { createDeadline, mapWithConcurrency, parseRetryAfter, withRetry } from '../lib/async.js';
import { currentContext, currentSignal, recordStat } from '../lib/context.js';
import { log } from '../lib/log.js';
import { getConfig } from '../config.js';
import { analyzeDays, analyzeQuery } from './intent.js';
import { toMinutes } from './schedule.js';
import {
  destinationForDay,
  durationHours,
  findMissingDays,
  isMultiCityLabel,
  mergeDays,
  normalizeClock,
  normalizeDay,
  normalizePlan as normalizePlanSchema,
  normalizeSpot,
  planOutline,
  positiveInt,
  singleCountry,
  text,
} from './planSchema.js';
import {
  DETAIL_PROMPT,
  LONG_OUTLINE_PROMPT,
  SYSTEM_PROMPT,
  buildUserMessage,
  repairPrompt,
} from './prompts.js';
import { hasWorkersAI, requestWorkersAiCompletion } from './workersAi.js';

export const LONG_TRIP_THRESHOLD_DAYS = 8;
// 细化分段越小，模型越能稳定地写足细节；并发执行，总耗时基本不变。
export const DETAIL_CHUNK_SIZE = 3;
const DETAIL_CONCURRENCY = 4;
const MIN_DESCRIPTION_CHARS = 25;
// 当前 DeepSeek 模型单次可输出数十万 token；16K 足以容纳 7 天的详细行程，
// 又不会让单次生成过慢（更长的行程走分段生成）。
const DEFAULT_MAX_TOKENS = 16384;
const DETAIL_MAX_TOKENS = 12288;
const FALLBACK_TO_CHUNKED = new Set([
  'LLM_OUTPUT_TRUNCATED',
  'LLM_INVALID_JSON',
  'LLM_EMPTY_OUTPUT',
  'LLM_OUTPUT_INTERRUPTED',
  'LLM_MISSING_PLAN',
  'LLM_INCOMPLETE_PLAN',
]);
const WORKERS_AI_FALLBACK_CODES = new Set([
  'CONFIG_MISSING',
  'LLM_AUTH',
  'LLM_QUOTA',
  'LLM_RATE_LIMITED',
  'LLM_UNAVAILABLE',
  'LLM_TIMEOUT',
  'LLM_STALLED',
  'LLM_STREAM_INTERRUPTED',
]);

export class LLMOutputError extends AppError {
  constructor(message, code = 'LLM_INVALID_OUTPUT') {
    super(code, message, { status: 502 });
    this.name = 'LLMOutputError';
  }
}

// ───────────────────────── 兼容旧接口的工具函数 ─────────────────────────

export function requestedDaysFromText(input = '') {
  return analyzeDays(input).days;
}

export function isLongTripRequest(input = '') {
  const info = analyzeDays(input);
  const days = info.strategyDays ?? info.days;
  return days !== null && days >= LONG_TRIP_THRESHOLD_DAYS;
}

export function normalizePlan(plan, options = {}) {
  return normalizePlanSchema(plan, typeof options === 'number' ? { expectedDays: options } : options || {});
}

export function parseJsonContent(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new LLMOutputError('LLM 未返回内容', 'LLM_EMPTY_OUTPUT');
  }
  const trimmed = content.trim().replace(/^﻿/, '');
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  // 最后兜底：去掉模型偶尔输出的尾逗号。
  candidates.push(...candidates.map(item => item.replace(/,\s*([}\]])/g, '$1')));

  for (const candidate of [...new Set(candidates)]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // 继续尝试下一个候选片段。
    }
  }
  throw new LLMOutputError('LLM 返回了无法解析的内容', 'LLM_INVALID_JSON');
}

/** 兼容 https://api.deepseek.com、…/v1、…/compatible-mode/v1、完整 endpoint 等写法。 */
export function chatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  if (/\/v\d+[a-z0-9]*$/i.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

// ───────────────────────────── 传输层 ─────────────────────────────

function upstreamError(status, detail, retryAfterMs) {
  const snippet = String(detail || '').slice(0, 300);
  if (status === 401 || status === 403) {
    return new AppError('LLM_AUTH', `LLM 鉴权失败 (${status}): ${snippet}`, { status: 503 });
  }
  if (status === 402) return new AppError('LLM_QUOTA', `LLM 账户余额不足: ${snippet}`, { status: 503 });
  if (status === 429) {
    return new AppError('LLM_RATE_LIMITED', `LLM 限流: ${snippet}`, { status: 503, retryable: true, retryAfterMs });
  }
  if ([408, 409, 425].includes(status) || status >= 500) {
    return new AppError('LLM_UNAVAILABLE', `LLM 服务异常 (${status}): ${snippet}`, { status: 502, retryable: true, retryAfterMs });
  }
  return new AppError('LLM_BAD_REQUEST', `LLM 请求被拒绝 (${status}): ${snippet}`, { status: 502 });
}

function transportError(error, deadline) {
  if (error instanceof AppError) return error;
  if (deadline.signal.aborted) {
    const reason = deadline.signal.reason;
    if (reason instanceof Error) return reason;
  }
  return new AppError('LLM_UNAVAILABLE', `LLM 网络错误: ${error?.cause?.code || error?.message || error}`, {
    status: 502,
    retryable: true,
    cause: error,
  });
}

async function readJsonBody(response) {
  const data = await response.json();
  if (data?.error) {
    throw new AppError('LLM_UNAVAILABLE', `LLM 返回错误: ${data.error.message || JSON.stringify(data.error)}`, {
      status: 502,
      retryable: true,
    });
  }
  const choice = data?.choices?.[0];
  return {
    content: choice?.message?.content ?? '',
    finishReason: choice?.finish_reason ?? null,
    usage: data?.usage ?? null,
  };
}

async function readEventStream(response, { onDelta, onActivity }) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finishReason = null;
  let usage = null;

  const handleLine = (rawLine) => {
    const line = rawLine.replace(/\r$/, '');
    if (!line.startsWith('data:')) return; // 注释行（: keep-alive）、event: 行、空行
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return;
    }
    if (chunk.error) {
      throw new AppError('LLM_UNAVAILABLE', `LLM 流式错误: ${chunk.error.message || 'unknown'}`, { status: 502, retryable: true });
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta?.content;
    if (delta) {
      content += delta;
      onDelta?.(content.length);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    onActivity?.();
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      handleLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer) handleLine(buffer);

  if (!finishReason) {
    throw new AppError('LLM_STREAM_INTERRUPTED', 'LLM 流式输出意外中断', { status: 502, retryable: true });
  }
  return { content, finishReason, usage };
}

function recordUsage(usage) {
  if (!usage) return;
  recordStat('llm_prompt_tokens', usage.prompt_tokens || 0);
  recordStat('llm_completion_tokens', usage.completion_tokens || 0);
  recordStat('llm_cache_hit_tokens', usage.prompt_cache_hit_tokens || 0);
}

async function workersAiFallback(error, { system, user, maxTokens, temperature, onDelta, purpose, signal }) {
  if (!hasWorkersAI() || !WORKERS_AI_FALLBACK_CODES.has(error?.code) || signal?.aborted) throw error;
  recordStat('llm_fallback_calls');
  const started = Date.now();
  log.warn('llm.fallback', { purpose, provider: 'workers-ai', code: error.code, message: error.message });
  try {
    const result = await withRetry(async () => {
      try {
        return await requestWorkersAiCompletion(system, user, { maxTokens, temperature, onDelta });
      } catch (fallbackError) {
        if (signal?.aborted) throw signal.reason || error;
        throw new AppError('LLM_UNAVAILABLE', `Workers AI 调用失败: ${fallbackError?.message || fallbackError}`, {
          status: 502,
          retryable: true,
          cause: fallbackError,
        });
      }
    }, {
      retries: 2,
      baseDelayMs: 300,
      maxDelayMs: 1500,
      signal,
      onRetry: (retryError, attempt, delay) => log.warn('llm.fallback_retry', {
        purpose,
        attempt,
        delay_ms: Math.round(delay),
        message: retryError.message,
      }),
    });
    if (signal?.aborted) throw signal.reason || error;
    recordUsage(result.usage);
    log.info('llm.call', {
      purpose,
      provider: 'workers-ai',
      ms: Date.now() - started,
      finish: result.finishReason,
      chars: result.content.length,
      completion_tokens: result.usage?.completion_tokens,
    });
    return result;
  } catch (fallbackError) {
    if (signal?.aborted) throw signal.reason || error;
    log.error('llm.fallback_failed', { purpose, message: fallbackError?.message });
    throw new AppError('LLM_UNAVAILABLE', `主模型与后备模型均不可用: ${fallbackError?.message || fallbackError}`, {
      status: 502,
      retryable: true,
      cause: fallbackError,
    });
  }
}

/** 一次 Chat Completions 调用（含传输层重试）。返回 { content, finishReason, usage }。 */
export async function chatCompletion({
  system,
  user,
  maxTokens = DEFAULT_MAX_TOKENS,
  temperature = 0.3,
  onDelta = null,
  purpose = 'plan',
  retries,
} = {}) {
  const cfg = getConfig().llm;
  const signal = currentSignal();
  if (!cfg.apiKey) {
    return workersAiFallback(
      new AppError('CONFIG_MISSING', '未配置 DEEPSEEK_API_KEY', { status: 503 }),
      { system, user, maxTokens, temperature, onDelta, purpose, signal },
    );
  }
  const url = chatCompletionsUrl(cfg.baseUrl);
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
  };
  if (cfg.stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }

  try {
    return await withRetry(async (attempt) => {
      recordStat('llm_calls');
      const started = Date.now();
      const deadline = createDeadline({
        parentSignal: signal,
        timeoutMs: cfg.timeoutMs,
        idleTimeoutMs: cfg.idleTimeoutMs,
        onTimeout: () => new AppError('LLM_TIMEOUT', `LLM 请求超过 ${Math.round(cfg.timeoutMs / 1000)} 秒`, { status: 504 }),
        onIdle: () => new AppError('LLM_STALLED', `LLM 超过 ${Math.round(cfg.idleTimeoutMs / 1000)} 秒无数据`, { status: 504, retryable: true }),
      });
      try {
        let response;
        try {
          response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: cfg.stream ? 'text/event-stream' : 'application/json',
              Authorization: `Bearer ${cfg.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: deadline.signal,
          });
        } catch (error) {
          throw transportError(error, deadline);
        }
        deadline.touch();
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw upstreamError(response.status, detail, parseRetryAfter(response.headers.get('retry-after')));
        }
        let result;
        try {
          result = (response.headers.get('content-type') || '').includes('text/event-stream')
            ? await readEventStream(response, { onDelta, onActivity: deadline.touch })
            : await readJsonBody(response);
        } catch (error) {
          throw transportError(error, deadline);
        }
        recordUsage(result.usage);
        log.info('llm.call', {
          purpose,
          attempt,
          ms: Date.now() - started,
          finish: result.finishReason,
          chars: result.content.length,
          completion_tokens: result.usage?.completion_tokens,
        });
        // DeepSeek 在后端资源不足时会以该 finish_reason 结束，属于可重试的瞬时故障。
        if (result.finishReason === 'insufficient_system_resource') {
          throw new AppError('LLM_UNAVAILABLE', 'LLM 后端资源不足', { status: 502, retryable: true });
        }
        return result;
      } finally {
        deadline.dispose();
      }
    }, {
      retries: retries ?? cfg.maxRetries,
      signal,
      onRetry: (error, attempt, delay) => log.warn('llm.retry', {
        purpose,
        attempt,
        delay_ms: Math.round(delay),
        code: error.code,
        message: error.message,
      }),
    });
  } catch (error) {
    return workersAiFallback(error, { system, user, maxTokens, temperature, onDelta, purpose, signal });
  }
}

/** 请求 JSON 输出并解析。截断、内容拦截等结束原因转为结构化错误。 */
export async function requestJson(system, user, options = {}) {
  const result = await chatCompletion({ system, user, ...options });
  if (result.finishReason === 'length') {
    throw new LLMOutputError('行程内容超过单次输出长度', 'LLM_OUTPUT_TRUNCATED');
  }
  if (result.finishReason === 'content_filter') {
    throw new AppError('LLM_CONTENT_FILTERED', '内容被安全策略拦截', { status: 422 });
  }
  if (result.finishReason && result.finishReason !== 'stop') {
    throw new LLMOutputError(`LLM 输出被中断 (${result.finishReason})`, 'LLM_OUTPUT_INTERRUPTED');
  }
  return parseJsonContent(result.content);
}

/** 输出层重试：空输出、非法 JSON 等带提示再请求一次。 */
async function requestJsonWithRetry(system, user, { attempts = 2, noRetryCodes = [], ...options } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const hint = attempt === 0
        ? ''
        : '\n\n上一次输出为空、被截断或不是合法 JSON。请精简文字，确保这次输出完整且只包含 JSON。';
      return await requestJson(system, `${user}${hint}`, options);
    } catch (error) {
      lastError = error;
      if (!(error instanceof LLMOutputError) || noRetryCodes.includes(error.code)) throw error;
      log.warn('llm.output_retry', { purpose: options.purpose, code: error.code });
    }
  }
  throw lastError;
}

// ───────────────────────────── 生成策略 ─────────────────────────────

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function formatDayList(days) {
  return days.length > 6 ? `${days.slice(0, 6).join('、')} 等` : days.join('、');
}

function streamReporter(onProgress, { message, expectedChars, from = 0, to = 1 }) {
  if (!onProgress) return null;
  let lastAt = 0;
  return (chars) => {
    const now = Date.now();
    if (now - lastAt < 700) return;
    lastAt = now;
    const ratio = Math.min(0.95, chars / Math.max(1, expectedChars));
    onProgress({ stage: 'generate', message: `${message}（已生成 ${chars.toLocaleString('en-US')} 字符）`, fraction: from + (to - from) * ratio });
  };
}

function clarificationQuestions(result) {
  const questions = Array.isArray(result?.clarification_questions)
    ? result.clarification_questions.map(item => text(item, 120)).filter(Boolean).slice(0, 3)
    : [];
  return questions.length ? questions : ['请补充目的地、天数，以及想去的地方或偏好。'];
}

function resolveExpectedDays(plan, intent) {
  const maxDays = getConfig().plan.maxTripDays;
  if (intent?.days) return Math.min(intent.days, maxDays);
  const lastDay = plan.daily_plans.length ? plan.daily_plans[plan.daily_plans.length - 1].day : 0;
  const expected = Math.max(plan.days || 0, lastDay);
  return expected ? Math.min(expected, maxDays) : null;
}

function buildRepairMessage(query, plan, missingDays, intent) {
  return `${buildUserMessage(query, { intent })}

【当前行程概要】
${JSON.stringify(planOutline(plan))}

【需要补全的天】
${missingDays.map(day => `Day ${day}`).join('、')}`;
}

/** 只为缺失（或空白）的天发起定向补全，最多两轮。 */
async function completeMissingDays(query, plan, { intent, compact, onProgress }) {
  const expected = resolveExpectedDays(plan, intent);
  if (!expected) throw new LLMOutputError('无法确定行程天数', 'LLM_INCOMPLETE_PLAN');
  let current = { ...plan, daily_plans: plan.daily_plans.filter(day => day.day <= expected) };
  let missing = findMissingDays(current, expected);

  for (let round = 0; round < 2 && missing.length > 0; round++) {
    log.warn('llm.repair_days', { round, missing });
    onProgress?.({ stage: 'generate', message: `正在补全第 ${formatDayList(missing)} 天…` });
    const groups = chunk(missing, DETAIL_CHUNK_SIZE);
    const responses = await mapWithConcurrency(groups, DETAIL_CONCURRENCY, async (group) => {
      try {
        return await requestJsonWithRetry(repairPrompt({ compact }), buildRepairMessage(query, current, group, intent), {
          maxTokens: compact ? DETAIL_MAX_TOKENS : DEFAULT_MAX_TOKENS,
          purpose: 'repair',
        });
      } catch (error) {
        if (!(error instanceof LLMOutputError)) throw error;
        log.warn('llm.repair_failed', { days: group, code: error.code });
        return null;
      }
    });
    const missingSet = new Set(missing);
    const repaired = responses
      .flatMap(response => (Array.isArray(response?.daily_plans) ? response.daily_plans : []))
      .map((raw) => {
        const dayNumber = positiveInt(raw?.day);
        if (!dayNumber || !missingSet.has(dayNumber)) return null;
        const destination = destinationForDay(current.destinations, dayNumber);
        return normalizeDay(raw, {
          dayNumber,
          city: destination?.city || (isMultiCityLabel(current.city) ? '' : current.city),
          country: destination?.country || singleCountry(current.country),
        });
      })
      .filter(Boolean);
    current = mergeDays(current, repaired);
    missing = findMissingDays(current, expected);
  }

  if (missing.length > 0) {
    throw new LLMOutputError(`行程缺少第 ${formatDayList(missing)} 天`, 'LLM_INCOMPLETE_PLAN');
  }
  return { ...current, days: expected };
}

async function finalizeGeneration(query, result, { intent, compact, onProgress }) {
  const hasDays = Array.isArray(result?.plan?.daily_plans) && result.plan.daily_plans.length > 0;
  if (result?.status === 'need_clarification' && !hasDays) {
    return { status: 'need_clarification', clarification_questions: clarificationQuestions(result) };
  }
  if (!result?.plan || typeof result.plan !== 'object') {
    throw new LLMOutputError('LLM 未返回行程', 'LLM_MISSING_PLAN');
  }
  const plan = normalizePlan(result.plan, { expectedDays: intent?.days || null });
  return { status: 'success', plan: await completeMissingDays(query, plan, { intent, compact, onProgress }) };
}

async function generateSinglePlan(query, { intent, feedback, onProgress }) {
  const days = intent?.days || intent?.approxDays || 3;
  onProgress?.({ stage: 'generate', message: 'AI 正在规划行程…', fraction: 0.02 });
  const result = await requestJsonWithRetry(SYSTEM_PROMPT, buildUserMessage(query, { intent, feedback }), {
    maxTokens: DEFAULT_MAX_TOKENS,
    purpose: 'plan',
    // 截断说明行程太长，直接降级为分段生成比“请写短一点”更可靠。
    noRetryCodes: ['LLM_OUTPUT_TRUNCATED'],
    onDelta: streamReporter(onProgress, { message: 'AI 正在规划行程', expectedChars: 1800 * days + 1200 }),
  });
  return finalizeGeneration(query, result, { intent, compact: false, onProgress });
}

function skeletonDay(day) {
  return {
    day: day.day,
    city: day.city,
    country: day.country,
    theme: day.theme,
    spots: day.spots.map(spot => ({
      name: spot.name,
      name_en: spot.name_en,
      city: spot.city,
      country: spot.country,
      type: spot.type,
    })),
    transport_notes: day.transport_notes,
  };
}

function withDetail(spot, detail) {
  return {
    ...spot,
    start_time: normalizeClock(detail.start_time) || spot.start_time || null,
    duration_hours: durationHours(detail.duration_hours) ?? spot.duration_hours ?? 2,
    cost: text(detail.cost, 40) || spot.cost || '',
    description: text(detail.description, 200) || spot.description || '',
    tips: text(detail.tips, 120) || spot.tips || '',
  };
}

const nameKey = value => String(value || '')
  .toLowerCase()
  .replace(/[（(][^）)]*[）)]/g, '')
  .replace(/[^\p{L}\p{N}]/gu, '');

/** 模型回填时常会改写名称（加括号注释、英文名、空格），按宽松规则判断是否同一地点。 */
export function sameSpotName(left, right) {
  const a = nameKey(left?.name);
  const b = nameKey(right?.name);
  if (a && b && (a === b || (Math.min(a.length, b.length) >= 2 && (a.includes(b) || b.includes(a))))) return true;
  const enA = nameKey(left?.name_en);
  const enB = nameKey(right?.name_en);
  return Boolean(enA && enB && (enA === enB || (Math.min(enA.length, enB.length) >= 4 && (enA.includes(enB) || enB.includes(enA)))));
}

/**
 * 合并细化结果：骨架地点全部保留（按名称匹配），细化阶段补充的餐厅按时间插入。
 * 细化输出明显没有遵循骨架时，退回按序号合并且不接受新增地点。
 */
export function mergeDetailedDay(outlineDay, detailedDay) {
  if (!detailedDay) return outlineDay;
  const outlineSpots = outlineDay.spots || [];
  const detailedSpots = (Array.isArray(detailedDay.spots) ? detailedDay.spots : []).filter(item => item && typeof item === 'object');
  const used = new Set();
  const merged = [];
  let matched = 0;
  for (const item of detailedSpots) {
    const index = outlineSpots.findIndex((spot, position) => !used.has(position) && sameSpotName(item, spot));
    if (index >= 0) {
      used.add(index);
      matched++;
      merged.push(withDetail(outlineSpots[index], item));
      continue;
    }
    const added = normalizeSpot(item, { city: outlineDay.city, country: outlineDay.country });
    if (added?.type === 'restaurant') merged.push(added);
  }

  let spots;
  if (outlineSpots.length > 0 && matched < Math.ceil(outlineSpots.length / 2)) {
    spots = outlineSpots.map((spot, index) => withDetail(spot, detailedSpots[index] || {}));
  } else {
    outlineSpots.forEach((spot, index) => {
      if (!used.has(index)) merged.push(spot);
    });
    spots = merged.slice(0, 12);
  }
  return {
    ...outlineDay,
    theme: text(detailedDay.theme, 40) || outlineDay.theme,
    transport_notes: text(detailedDay.transport_notes, 160) || outlineDay.transport_notes,
    spots,
  };
}

async function generateLongPlan(query, { intent, feedback, onProgress }) {
  const days = intent?.days || intent?.strategyDays || intent?.approxDays || 14;
  onProgress?.({ stage: 'generate', message: '正在生成完整行程骨架…', fraction: 0.02 });
  const outline = await requestJsonWithRetry(LONG_OUTLINE_PROMPT, buildUserMessage(query, { intent, feedback }), {
    maxTokens: DEFAULT_MAX_TOKENS,
    purpose: 'outline',
    onDelta: streamReporter(onProgress, { message: '正在生成完整行程骨架', expectedChars: 520 * days + 1600, to: 0.45 }),
  });
  const skeleton = await finalizeGeneration(query, outline, { intent, compact: true, onProgress });
  if (skeleton.status !== 'success') return skeleton;
  const plan = skeleton.plan;

  const chunks = chunk(plan.daily_plans, DETAIL_CHUNK_SIZE);
  let finished = 0;
  onProgress?.({ stage: 'generate', message: `正在细化每日行程（共 ${chunks.length} 段）…`, fraction: 0.5 });
  const detailed = await mapWithConcurrency(chunks, DETAIL_CONCURRENCY, async (days) => {
    try {
      return await requestJsonWithRetry(
        DETAIL_PROMPT,
        `【用户原需求】\n${query}\n\n【不可更改的行程骨架】\n${JSON.stringify({ daily_plans: days.map(skeletonDay) })}`,
        { maxTokens: DETAIL_MAX_TOKENS, purpose: 'detail' },
      );
    } catch (error) {
      if (isAbortError(error) || currentSignal()?.aborted) throw error;
      // 细化失败不影响行程主体：保留骨架（地点完整，只是缺少描述）。
      log.warn('llm.detail_failed', { from: days[0]?.day, to: days.at(-1)?.day, code: error.code, message: error.message });
      return null;
    } finally {
      finished++;
      onProgress?.({ stage: 'generate', message: `已细化 ${finished}/${chunks.length} 段行程`, fraction: 0.5 + 0.5 * (finished / chunks.length) });
    }
  });

  const detailByDay = new Map(
    detailed
      .flatMap(item => (Array.isArray(item?.daily_plans) ? item.daily_plans : []))
      .map(day => [positiveInt(day?.day), day]),
  );
  return {
    status: 'success',
    plan: { ...plan, daily_plans: plan.daily_plans.map(day => mergeDetailedDay(day, detailByDay.get(day.day))) },
  };
}

// ───────────────────────────── 细节质量闸门 ─────────────────────────────

const chars = value => [...String(value || '')].length;

/** 一天里让人“没法照着走”的缺口：介绍过短、缺餐、缺时间。 */
export function dayDetailGaps(day, { isLastDay = false } = {}) {
  const gaps = [];
  const spots = day.spots || [];
  const content = spots.filter(spot => spot.type !== 'transport');
  const thin = content.filter(spot => chars(spot.description) < MIN_DESCRIPTION_CHARS).length;
  if (content.length && thin / content.length > 0.3) gaps.push('地点介绍过于简短，请写足看点与体验');
  const mealAt = (from, to) => spots.some((spot) => {
    const minutes = toMinutes(spot.start_time);
    return spot.type === 'restaurant' && minutes !== null && minutes >= from && minutes <= to;
  });
  const lunch = mealAt(11 * 60, 14 * 60 + 30);
  const dinner = mealAt(17 * 60, 21 * 60);
  // 换城市的日子和最后一天允许只安排一顿。
  const relaxedMeals = isLastDay || spots.some(spot => spot.type === 'transport');
  if (!lunch && !dinner) gaps.push('缺少午餐和晚餐');
  else if (!relaxedMeals && !lunch) gaps.push('缺少午餐');
  else if (!relaxedMeals && !dinner) gaps.push('缺少晚餐');
  if (spots.some(spot => !spot.start_time)) gaps.push('缺少时间安排');
  if (spots.length >= 2 && chars(day.transport_notes) < 6) gaps.push('缺少当天交通建议');
  return gaps;
}

function detailScore(day, options) {
  const content = (day.spots || []).filter(spot => spot.type !== 'transport');
  const described = content.filter(spot => chars(spot.description) >= MIN_DESCRIPTION_CHARS).length;
  return described - 3 * dayDetailGaps(day, options).length;
}

/** 对未达标的天做一次定向细化；结果只在更好时才采用，不会变差。 */
async function enrichThinDays(query, plan, { onProgress }) {
  const total = plan.daily_plans.length;
  const options = index => ({ isLastDay: index === total - 1 });
  const targets = plan.daily_plans
    .map((day, index) => ({ day, gaps: dayDetailGaps(day, options(index)) }))
    .filter(item => item.gaps.length > 0);
  if (targets.length === 0) return plan;
  log.info('llm.enrich_days', { days: targets.map(item => item.day.day) });
  onProgress?.({ stage: 'generate', message: `正在补充 ${targets.length} 天的细节…` });

  const groups = chunk(targets, DETAIL_CHUNK_SIZE);
  const responses = await mapWithConcurrency(groups, DETAIL_CONCURRENCY, async (group) => {
    const issues = group.map(item => `Day ${item.day.day}：${item.gaps.join('；')}`).join('\n');
    try {
      return await requestJsonWithRetry(
        DETAIL_PROMPT,
        `【用户原需求】\n${query}\n\n【需要改进的地方】\n${issues}\n\n【不可更改的行程骨架】\n${JSON.stringify({ daily_plans: group.map(item => skeletonDay(item.day)) })}`,
        { maxTokens: DETAIL_MAX_TOKENS, purpose: 'enrich' },
      );
    } catch (error) {
      if (isAbortError(error) || currentSignal()?.aborted) throw error;
      log.warn('llm.enrich_failed', { days: group.map(item => item.day.day), code: error.code, message: error.message });
      return null;
    }
  });

  const byDay = new Map(responses
    .flatMap(response => (Array.isArray(response?.daily_plans) ? response.daily_plans : []))
    .map(day => [positiveInt(day?.day), day]));
  return {
    ...plan,
    daily_plans: plan.daily_plans.map((day, index) => {
      const detail = byDay.get(day.day);
      if (!detail) return day;
      const candidate = mergeDetailedDay(day, detail);
      return detailScore(candidate, options(index)) > detailScore(day, options(index)) ? candidate : day;
    }),
  };
}

/**
 * 生成结构化行程。返回 { status, plan?, clarification_questions?, strategy }。
 * 第二个参数 feedback 为自审/地图校验后的修正要求（重生成时使用）。
 */
export async function callLLM(userMessage, feedback = null, { intent = analyzeQuery(userMessage), onProgress = null } = {}) {
  const strategyDays = intent.strategyDays ?? intent.days ?? 0;
  let result;
  if (strategyDays >= LONG_TRIP_THRESHOLD_DAYS) {
    log.info('llm.strategy', { strategy: 'chunked', days: strategyDays });
    result = { ...(await generateLongPlan(userMessage, { intent, feedback, onProgress })), strategy: 'chunked' };
  } else {
    try {
      result = { ...(await generateSinglePlan(userMessage, { intent, feedback, onProgress })), strategy: 'single' };
    } catch (error) {
      if (!(error instanceof LLMOutputError) || !FALLBACK_TO_CHUNKED.has(error.code)) throw error;
      log.warn('llm.fallback_chunked', { code: error.code, message: error.message });
      onProgress?.({ stage: 'generate', message: '行程较长，改为分段生成…', fraction: 0.05 });
      result = { ...(await generateLongPlan(userMessage, { intent, feedback, onProgress })), strategy: 'chunked-fallback' };
    }
  }
  const usedWorkersAiFallback = (currentContext()?.stats?.llm_fallback_calls || 0) > 0;
  if (result.status === 'success' && result.plan && !usedWorkersAiFallback) {
    result.plan = await enrichThinDays(userMessage, result.plan, { onProgress });
  } else if (result.status === 'success' && result.plan && usedWorkersAiFallback) {
    // Workers AI 在免费 Worker 上一次推理通常需要约 20–30 秒；再做可选细化会超过
    // HTTP 请求的生命周期。保留首轮完整计划，把剩余时间留给 Google 地图落地与路线。
    log.info('llm.enrich_skipped', { reason: 'workers_ai_fallback' });
  }
  return result;
}
