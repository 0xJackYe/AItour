// 计划自审：生成后让大模型对照“用户原需求”复核覆盖度、准确性与节奏。
// 自审是增强项：失败时跳过而不是让整个请求失败；取消信号仍会向上抛出。

import { getConfig } from '../config.js';
import { currentContext, currentSignal } from '../lib/context.js';
import { isAbortError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { requestJson } from './llm.js';
import { hasWorkersAI } from './workersAi.js';
import { planOutline, text } from './planSchema.js';
import { VERIFY_SYSTEM_PROMPT } from './prompts.js';

function skippedVerification() {
  return { passed: true, missing_spots: [], incorrect_spots: [], warnings: [], needs_regeneration: false, skipped: true };
}

export function normalizeVerification(parsed) {
  const missing = Array.isArray(parsed?.missing_spots)
    ? parsed.missing_spots.map(item => text(item, 60)).filter(Boolean).slice(0, 10)
    : [];
  const incorrect = Array.isArray(parsed?.incorrect_spots)
    ? parsed.incorrect_spots
      .map(item => (typeof item === 'string'
        ? { name: text(item, 60), issue: '' }
        : { name: text(item?.name, 60), issue: text(item?.issue, 160) }))
      .filter(item => item.name)
      .slice(0, 10)
    : [];
  const warnings = Array.isArray(parsed?.warnings)
    ? parsed.warnings.map(item => text(item, 160)).filter(Boolean).slice(0, 8)
    : [];
  return {
    passed: parsed?.passed !== false && missing.length === 0 && incorrect.length === 0,
    missing_spots: missing,
    incorrect_spots: incorrect,
    warnings,
    // 没有列出任何具体问题时不重生成，避免无谓消耗。
    needs_regeneration: parsed?.needs_regeneration === true && (missing.length > 0 || incorrect.length > 0),
  };
}

export async function verifyPlan(userQuery, plan) {
  if (!getConfig().llm.apiKey && !hasWorkersAI()) return skippedVerification();
  if ((currentContext()?.stats?.llm_fallback_calls || 0) > 0) {
    log.info('verify.skipped', { reason: 'workers_ai_fallback' });
    return skippedVerification();
  }
  const userMessage = `【用户原始需求】\n${userQuery}\n\n【已生成的旅行计划】\n${JSON.stringify(planOutline(plan))}`;
  try {
    const parsed = await requestJson(VERIFY_SYSTEM_PROMPT, userMessage, {
      maxTokens: 6144,
      temperature: 0.1,
      purpose: 'verify',
      retries: 1,
    });
    return normalizeVerification(parsed);
  } catch (error) {
    if (isAbortError(error) || currentSignal()?.aborted) throw error;
    log.warn('verify.skipped', { code: error.code, message: error.message });
    return skippedVerification();
  }
}

/** 把自审结果和地图校验问题整理成重生成时给模型的修正要求。 */
export function buildRegenFeedback(verification, groundingIssues = []) {
  const lines = ['上一版计划存在以下问题，请修正后重新输出完整 JSON：'];
  if (verification?.missing_spots?.length) {
    lines.push(`- 缺少用户明确要求的地点：${verification.missing_spots.join('、')}（必须加入）`);
  }
  for (const item of verification?.incorrect_spots || []) {
    lines.push(`- “${item.name}”存在问题：${item.issue || '地点信息有误'}`);
  }
  for (const issue of groundingIssues.slice(0, 12)) {
    lines.push(`- “${issue.name}”（${issue.city || '目标城市'}）：${issue.reason}。请换成该城市内真实存在、可在 Google 地图搜索到的地点，或修正 name_en。`);
  }
  for (const warning of verification?.warnings || []) {
    lines.push(`- 注意：${warning}`);
  }
  lines.push('所有地点必须真实存在，并位于各自 spot.city 所写的城市；不要被其他城市的同名地点误导。');
  return lines.join('\n');
}
