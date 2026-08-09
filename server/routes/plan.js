import { Router } from 'express';
import { callLLM } from '../services/llm.js';
import { geocodeAllSpots } from '../services/geocode.js';
import { getRouteForLegWithFallback } from '../services/route.js';
import { findNearbyTransit } from '../services/transit.js';
import { verifyPlan, buildRegenFeedback } from '../services/verify.js';
import { normalizeProfile, profileClarificationQuestions } from '../services/preferences.js';
import {
  applyLegRoutes,
  buildExecutableItinerary,
  flattenRoutes,
} from '../services/itinerary.js';
import { validatePlanHealth } from '../services/health.js';

const router = Router();

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

export function preparePlanRequest(body = {}) {
  if (!body || typeof body !== 'object' || typeof body.query !== 'string' || !body.query.trim()) {
    return { error: '请输入旅行需求' };
  }
  const query = body.query.trim();
  if (query.length > 12000) return { error: '旅行需求过长，请精简到 12000 字以内' };
  const profile = normalizeProfile(body.profile, query);
  return { query, profile, questions: profileClarificationQuestions(profile) };
}

function structuredLlmQuestions(questions = []) {
  return questions.map((question, index) => ({
    id: `llm_clarification_${index + 1}`,
    label: String(question),
    type: 'text',
    required: true,
  }));
}

export async function calculatePlanRoutes(plan, { routeProvider } = {}) {
  const dayLegJobs = (plan.daily_plans || []).flatMap(day => {
    const nodeMap = new Map((day.nodes || []).map(node => [node.id, node]));
    return (day.legs || []).map(leg => ({
      kind: 'leg',
      day,
      leg,
      from: nodeMap.get(leg.from_node_id),
      to: nodeMap.get(leg.to_node_id),
    }));
  });

  const connectionJobs = (plan.daily_plans || []).flatMap((day, index, days) => {
    const connection = day.connection_to_next;
    const next = days[index + 1];
    if (!connection || connection.type !== 'intercity' || !next) return [];
    return [{
      kind: 'connection',
      day,
      leg: connection,
      from: (day.nodes || []).find(node => node.id === connection.from_node_id),
      to: (next.nodes || []).find(node => node.id === connection.to_node_id),
    }];
  });
  const jobs = [...dayLegJobs, ...connectionJobs];

  const results = await mapWithConcurrency(jobs, 6, async (job) => {
    const route = await getRouteForLegWithFallback(job.from, job.to, job.leg.mode, {
      departureTime: job.leg.departure_time,
      routeProvider,
      allowedModes: plan.profile?.transport?.allowedModes,
      avoidModes: plan.profile?.transport?.avoidModes,
      transitPreferences: plan.profile?.transport?.transitPreferences,
      distancePolicy: plan.profile?.transport?.distancePolicy,
      maxWalkingKm: plan.profile?.maxWalkingKm,
    });
    return [job.leg.id, route];
  });
  const routeResults = new Map(results);
  return applyLegRoutes(plan, routeResults, plan.profile || {});
}

function parsedRequest(plan, profile) {
  return {
    city: plan.city || null,
    country: plan.country || null,
    days: plan.days || null,
    start_date: profile.startDate,
    destinations: plan.destinations || [],
    preferences: {
      ...(plan.preferences || {}),
      pace: profile.pace,
      budget: profile.budget,
      transport: profile.transport,
      maxWalkingKm: profile.maxWalkingKm,
      interests: profile.interests,
    },
    constraints: profile,
  };
}

router.post('/plan', async (req, res) => {
  const prepared = preparePlanRequest(req.body);
  if (prepared.error) return res.status(400).json({ error: prepared.error });
  if (prepared.questions.length) {
    return res.json({
      status: 'need_clarification',
      questions: prepared.questions,
      profile: prepared.profile,
    });
  }

  try {
    const { query: userQuery, profile } = prepared;
    console.log(`[Plan] 收到 ${profile.days} 天规划请求`);

    let llmResult = await callLLM(userQuery, null, profile);
    if (llmResult.status === 'need_clarification') {
      return res.json({
        status: 'need_clarification',
        questions: structuredLlmQuestions(llmResult.clarification_questions || ['请补充目的地和出发地。']),
        profile,
      });
    }
    let plan = llmResult.plan;
    if (!plan) return res.status(502).json({ error: 'AI 未返回有效计划', code: 'LLM_PLAN_MISSING' });

    // LLM 审核只负责内容覆盖度；最终通过与否由路线后的确定性 health 判定。
    let verification = await verifyPlan(userQuery, plan);
    if (verification.needs_regeneration) {
      try {
        const retry = await callLLM(userQuery, buildRegenFeedback(verification), profile);
        if (retry.plan) {
          plan = retry.plan;
          verification = await verifyPlan(userQuery, plan);
          verification.regenerated = true;
        }
      } catch (error) {
        verification.warnings = [...(verification.warnings || []), `AI 局部修正失败：${error.message}`];
      }
    }

    const geocoding = await geocodeAllSpots(plan);
    if (geocoding.rejectedSpots.length) {
      verification = {
        ...verification,
        status: 'failed',
        passed: false,
        geocoding_filtered: true,
        incorrect_spots: [
          ...(verification.incorrect_spots || []),
          ...geocoding.rejectedSpots.map(item => ({
            name: item.spot.name,
            issue: `${item.reason}（目标：${item.city}, ${item.country}）`,
          })),
        ],
      };
    }

    let executablePlan = buildExecutableItinerary(geocoding.plan, profile);
    executablePlan = await calculatePlanRoutes(executablePlan);
    const health = validatePlanHealth(executablePlan, profile);
    verification.deterministic_status = health.status;

    const transitMarkers = await findNearbyTransit(
      executablePlan,
      executablePlan.accommodation?.coordinates || null,
    );
    const routes = flattenRoutes(executablePlan);

    return res.json({
      status: 'success',
      plan: executablePlan,
      routes,
      health,
      parsed_request: parsedRequest(executablePlan, profile),
      verification,
      geocoding_warnings: geocoding.warnings,
      geocoded_count: geocoding.geocodedCount,
      transit_markers: transitMarkers,
      profile,
      map_provider: 'google',
    });
  } catch (error) {
    console.error('[Plan] 生成失败:', error);
    return res.status(500).json({ error: '旅行计划生成失败，请稍后重试', code: error.code || 'PLAN_GENERATION_FAILED' });
  }
});

router.post('/plan/recalculate', async (req, res) => {
  try {
    const sourcePlan = req.body?.plan;
    if (!sourcePlan || typeof sourcePlan !== 'object' || !Array.isArray(sourcePlan.daily_plans)) {
      return res.status(400).json({ error: '请提供需要重算的有效 plan' });
    }
    const profile = normalizeProfile(req.body?.profile || sourcePlan.profile || {}, req.body?.query || '');
    const questions = profileClarificationQuestions(profile);
    if (questions.length) return res.json({ status: 'need_clarification', questions, profile });

    let plan = buildExecutableItinerary(sourcePlan, profile);
    plan = await calculatePlanRoutes(plan);
    const health = validatePlanHealth(plan, profile);
    return res.json({
      status: 'success',
      plan,
      routes: flattenRoutes(plan),
      health,
      profile,
      parsed_request: parsedRequest(plan, profile),
      verification: {
        status: 'unknown',
        passed: false,
        skipped: true,
        deterministic_status: health.status,
        warnings: ['编辑后已重新执行路线、时间轴、预算与健康检查；AI 内容覆盖复核需在重新生成完整计划时执行。'],
      },
    });
  } catch (error) {
    console.error('[Plan] 重算失败:', error);
    return res.status(500).json({ error: '行程重算失败', code: error.code || 'PLAN_RECALCULATION_FAILED' });
  }
});

export default router;
