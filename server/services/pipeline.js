// 规划工作流编排（与 HTTP 无关，便于测试与复用）：
//
//   需求解析(确定性) → 生成(单次 / 分段) → [AI 自审 ∥ Google 地点落地]
//     → 必要时带反馈重生成一次（两版择优，质量只升不降）
//     → 当日顺序优化 → 城市间交通推断 → [城市间路线 → 逐段路线 ∥ 住宿附近交通站]
//     → 组装响应
//
// onProgress 事件：{ stage, message, progress(0-1) }，阶段为
// parse | generate | verify | regenerate | route。

import { getConfig } from '../config.js';
import { currentContext } from '../lib/context.js';
import { isAbortError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { geocodeAllSpots } from './geocode.js';
import { isGoogleConfigured } from './google.js';
import { analyzeQuery } from './intent.js';
import { callLLM } from './llm.js';
import { optimizePlanOrder } from './optimize.js';
import { deterministicWarnings } from './planSchema.js';
import { PROMPT_VERSION } from './prompts.js';
import { computeRoutes } from './route.js';
import { applySchedules } from './schedule.js';
import { findNearbyTransit } from './transit.js';
import { reconcileTransfers, routeTransfers, transferLeg, transferWarnings } from './transfers.js';
import { buildRegenFeedback, verifyPlan } from './verify.js';

const RANGES = {
  parse: [0, 0.04],
  generate: [0.04, 0.62],
  verify: [0.62, 0.8],
  regenerate: [0.8, 0.9],
  route: [0.9, 0.99],
};

function createProgress(onProgress) {
  let last = 0;
  return (stage, message, fraction = 0) => {
    const [from, to] = RANGES[stage] || [last, last];
    const ratio = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
    last = Math.max(last, from + (to - from) * ratio);
    try {
      onProgress({ stage, message, progress: Math.round(last * 1000) / 1000 });
    } catch (error) {
      log.warn('pipeline.progress_listener_failed', { message: error.message });
    }
  };
}

function groundingIssues(geocoding) {
  return geocoding.warnings.filter(item =>
    ['outside_target', 'name_mismatch', 'not_found'].includes(item.code) && Number.isInteger(item.day));
}

function scoreAssessment({ verification, geocoding }) {
  const stats = geocoding.stats;
  const verifiedRatio = stats.total ? stats.verified / stats.total : 0;
  return 100 * verifiedRatio
    - 15 * verification.missing_spots.length
    - 6 * verification.incorrect_spots.length
    - 4 * stats.removed;
}

function shouldRegenerate({ verification, geocoding }, groundingAvailable) {
  if (verification.needs_regeneration) return true;
  if (!groundingAvailable) return false;
  const stats = geocoding.stats;
  const problems = stats.removed + Math.max(0, stats.unverified - stats.maps_errors);
  // 四分之一的地点在地图上找不到就值得重来一次；择优策略保证不会因此变差。
  return stats.total >= 3 && problems >= 2 && problems / stats.total >= 0.25;
}

async function assess(query, plan, { progress, stage }) {
  let finished = 0;
  const step = (label) => {
    finished++;
    progress(stage, label, finished / 2);
  };
  const [verification, geocoding] = await Promise.all([
    verifyPlan(query, plan).then((result) => {
      step('AI 自审完成');
      return result;
    }),
    geocodeAllSpots(plan).then((result) => {
      step(`已在 Google 地图上定位 ${result.stats.verified}/${result.stats.total} 个地点`);
      return result;
    }),
  ]);
  const assessment = { plan, verification, geocoding };
  return { ...assessment, score: scoreAssessment(assessment) };
}

function mergeVerification(verification, geocoding, plan, extraWarnings = []) {
  const merged = {
    ...verification,
    warnings: [...new Set([...(verification.warnings || []), ...deterministicWarnings(plan), ...extraWarnings])].slice(0, 10),
  };
  if (geocoding.rejectedSpots.length > 0) {
    merged.passed = false;
    merged.needs_regeneration = false;
    merged.geocoding_filtered = true;
    merged.incorrect_spots = [
      ...(verification.incorrect_spots || []),
      ...geocoding.rejectedSpots.map(item => ({ name: item.spot.name, issue: `${item.reason}，已从行程中移除` })),
    ];
  }
  return merged;
}

function routePreference(intent, plan) {
  if (intent.transport) return intent.transport;
  const declared = plan.preferences?.transport;
  return declared === 'drive' || declared === 'walk' ? declared : 'public_transit';
}

function buildMeta(startedAt, extra = {}) {
  const context = currentContext();
  return {
    request_id: context?.requestId || null,
    duration_ms: Date.now() - startedAt,
    prompt_version: PROMPT_VERSION,
    stats: { ...(context?.stats || {}) },
    ...extra,
  };
}

export async function runPlanPipeline(query, { onProgress = () => {} } = {}) {
  const startedAt = Date.now();
  const config = getConfig();
  const progress = createProgress(onProgress);
  const timings = {};
  const time = async (name, task) => {
    const begin = Date.now();
    try {
      return await task();
    } finally {
      timings[name] = (timings[name] || 0) + (Date.now() - begin);
    }
  };

  progress('parse', '正在理解你的需求…', 0);
  const intent = analyzeQuery(query);
  log.info('plan.intent', { days: intent.days, approx_days: intent.approxDays, confidence: intent.dayConfidence, transport: intent.transport });
  if (intent.days && intent.days > config.plan.maxTripDays) {
    return {
      status: 'need_clarification',
      questions: [`单次最多规划 ${config.plan.maxTripDays} 天。请缩短天数，或把行程拆成几段分别规划。`],
      meta: buildMeta(startedAt),
    };
  }
  progress('parse', '需求解析完成', 1);

  const first = await time('generate_ms', () => callLLM(query, null, {
    intent,
    onProgress: event => progress('generate', event.message, event.fraction ?? 0),
  }));
  if (first.status === 'need_clarification') {
    return { status: 'need_clarification', questions: first.clarification_questions, meta: buildMeta(startedAt, { timings }) };
  }

  progress('verify', 'AI 自审并在 Google 地图上校验地点…', 0);
  let best = await time('verify_ms', () => assess(query, first.plan, { progress, stage: 'verify' }));
  let strategy = first.strategy;
  let regeneration = null;

  const groundingAvailable = isGoogleConfigured();
  const usedWorkersAiFallback = (currentContext()?.stats?.llm_fallback_calls || 0) > 0;
  if (!usedWorkersAiFallback && shouldRegenerate(best, groundingAvailable)) {
    progress('regenerate', '发现问题，正在根据校验结果自动修正…', 0);
    try {
      const feedback = buildRegenFeedback(best.verification, groundingIssues(best.geocoding));
      const retry = await time('regenerate_ms', () => callLLM(query, feedback, {
        intent,
        onProgress: event => progress('regenerate', event.message, (event.fraction ?? 0) * 0.7),
      }));
      if (retry.status === 'success' && retry.plan) {
        const second = await time('regenerate_ms', () => assess(query, retry.plan, { progress, stage: 'regenerate' }));
        const useSecond = second.score >= best.score;
        log.info('plan.regenerated', { first_score: best.score, second_score: second.score, applied: useSecond });
        regeneration = useSecond ? 'applied' : 'kept_original';
        if (useSecond) {
          best = second;
          strategy = retry.strategy;
        }
      }
    } catch (error) {
      if (isAbortError(error) || currentContext()?.signal?.aborted) throw error;
      regeneration = 'failed';
      log.warn('plan.regenerate_failed', { code: error.code, message: error.message });
    }
  }

  progress('route', '正在规划每日路线与交通…', 0);
  const ordered = optimizePlanOrder(best.geocoding.plan);
  const preference = routePreference(intent, ordered.plan);
  // 每次换城市（含一日游往返）都有一条城市间交通；先算城市间路线，
  // 出发站与到达站相邻时它直接成为当天的一段路程。
  const planned = { ...ordered.plan, transfers: reconcileTransfers(ordered.plan, { preference }) };
  const [[transfers, routes], transitMarkers] = await time('route_ms', () => Promise.all([
    (async () => {
      const routed = await routeTransfers(planned, planned.transfers, { preference });
      progress('route', `已规划 ${routed.length} 段城市间交通`, 0.4);
      const dayRoutes = await computeRoutes(planned, { preference, optimizations: ordered.results, transfers: routed, transferLeg });
      return [routed, dayRoutes];
    })(),
    findNearbyTransit(planned),
  ]));
  // 按真实路程校验并补全每天的时间线。
  const scheduled = applySchedules(planned, routes);
  const plan = scheduled.plan;
  progress('route', '路线规划完成', 1);

  const verification = mergeVerification(best.verification, best.geocoding, plan, [...scheduled.warnings, ...transferWarnings(plan, transfers)]);
  if (regeneration === 'applied') verification.regenerated = true;
  const stats = best.geocoding.stats;
  log.info('plan.done', {
    strategy,
    days: plan.days,
    transfers: transfers.length,
    spots: stats.total,
    verified: stats.verified,
    removed: stats.removed,
    regeneration,
    ms: Date.now() - startedAt,
  });

  return {
    status: 'success',
    parsed_request: {
      city: plan.city || null,
      country: plan.country || null,
      days: plan.days || null,
      destinations: plan.destinations || [],
      preferences: plan.preferences || null,
      constraints: {
        pace: plan.preferences?.pace || null,
        budget: plan.preferences?.budget || null,
        transport: preference,
      },
    },
    plan,
    routes,
    transfers,
    transit_markers: transitMarkers,
    verification,
    geocoding_warnings: best.geocoding.warnings,
    geocoded_count: best.geocoding.geocodedCount,
    quality: {
      total_spots: stats.total,
      verified_spots: stats.verified,
      unverified_spots: stats.unverified,
      removed_spots: stats.removed,
      grounding_available: groundingAvailable,
      regeneration,
    },
    map_provider: 'google',
    meta: buildMeta(startedAt, { strategy, timings }),
  };
}
