import { Router } from 'express';
import { callLLM } from '../services/llm.js';
import { geocodeAllSpots } from '../services/geocode.js';
import { getRouteGeometry } from '../services/route.js';
import { findNearbyTransit } from '../services/transit.js';
import { verifyPlan, buildRegenFeedback } from '../services/verify.js';

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

router.post('/plan', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({ error: '请输入旅行需求' });
    }

    const userQuery = query.trim();
    console.log(`[Plan] 收到请求: "${userQuery.substring(0, 80)}..."`);

    // ───── Step 1. 首次生成 ─────
    console.log('[Plan] 调用 DeepSeek...');
    const llmResult = await callLLM(userQuery);

    if (llmResult.status === 'need_clarification') {
      return res.json({
        status: 'need_clarification',
        questions: llmResult.clarification_questions || ['请提供更多旅行信息，比如目的地、天数、想去的地方。'],
      });
    }

    let plan = llmResult.plan;
    if (!plan) {
      return res.status(500).json({ error: 'LLM 未返回有效计划' });
    }

    // ───── Step 2. 自审：覆盖度 + 准确性 ─────
    console.log('[Plan] LLM 自审中...');
    let verification = await verifyPlan(userQuery, plan);

    // ───── Step 3. 必要时重生成一次（仅一次，避免无限循环）─────
    if (verification.needs_regeneration) {
      console.log('[Plan] 自审发现严重问题，重生成中...');
      console.log('[Plan] 反馈:', JSON.stringify({
        missing: verification.missing_spots,
        incorrect: verification.incorrect_spots,
      }));
      try {
        const feedback = buildRegenFeedback(verification);
        const retry = await callLLM(userQuery, feedback);
        if (retry.plan) {
          plan = retry.plan;
          verification = await verifyPlan(userQuery, plan);
          verification.regenerated = true;
        }
      } catch (err) {
        console.warn('[Plan] 重生成失败，沿用首版计划:', err.message);
      }
    }

    // ───── Step 4. 地理编码（逐日城市硬约束 + 外地同名点剔除）─────
    console.log('[Plan] 地理编码中...');
    const geocoding = await geocodeAllSpots(plan);
    const enrichedPlan = geocoding.plan;
    const geocodingWarnings = geocoding.warnings;

    if (geocoding.rejectedSpots.length > 0) {
      verification = {
        ...verification,
        passed: false,
        needs_regeneration: false,
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

    // ───── Step 5. 交通点位 + 路线 ─────
    const transitMarkers = await findNearbyTransit(
      enrichedPlan,
      enrichedPlan.accommodation?.coordinates || null,
    );

    const routes = await mapWithConcurrency(enrichedPlan.daily_plans || [], 4, async (day) => {
      const points = (day.spots || [])
        .filter(s => s.coordinates)
        .map(s => [s.coordinates.lat, s.coordinates.lng]);

      const routeData = await getRouteGeometry(points);
      return {
        day: day.day,
        provider: 'google',
        travel_mode: routeData?.travel_mode || 'WALK',
        points,
        geometry: routeData?.coordinates || points,
        distance_meters: routeData?.distance_meters ?? null,
        duration_seconds: routeData?.duration_seconds ?? null,
      };
    });

    console.log(
      `[Plan] 完成! 编码 ${geocoding.geocodedCount} 个地点, 校验 ${verification.passed ? '通过' : '存在问题'}, 编码警告 ${geocodingWarnings.length} 条`,
    );

    res.json({
      status: 'success',
      parsed_request: {
        city: enrichedPlan.city || null,
        country: enrichedPlan.country || null,
        days: enrichedPlan.days || null,
        destinations: enrichedPlan.destinations || [],
        preferences: enrichedPlan.preferences || null,
        constraints: {
          pace: enrichedPlan.preferences?.pace || null,
          budget: enrichedPlan.preferences?.budget || null,
        },
      },
      plan: enrichedPlan,
      routes,
      transit_markers: transitMarkers,
      verification,
      geocoding_warnings: geocodingWarnings,
      geocoded_count: geocoding.geocodedCount,
      map_provider: 'google',
    });
  } catch (err) {
    console.error('[Plan] 错误:', err);
    res.status(500).json({ error: err.message || '服务器内部错误' });
  }
});

export default router;
