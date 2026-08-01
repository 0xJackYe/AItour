// 计划自审：在生成完计划后，再让 LLM 对照"用户原需求"做一次质量审查。
// 目标：
//   1. 覆盖度——用户明确点名的景点是否都进了 daily_plans
//   2. 准确性——景点是否真实存在、是否属于指定城市、name/name_en 是否对应
//   3. 合理性——天数与节奏是否匹配
//
// 返回 verification 对象给前端展示；若 needs_regeneration 为 true，路由层会
// 把问题清单作为反馈，调用一次 LLM 重生成。

const VERIFY_SYSTEM_PROMPT = `你是旅行规划质量审核员。给定用户的"原始自然语言需求"和已生成的"结构化旅行计划"，请逐项检查并严格按 JSON 输出。

检查维度：
1. coverage（覆盖度）：用户在原始需求中明确点名的景点 / 区域 / 体验，是否都出现在 daily_plans 的 spots 里？
2. accuracy（准确性）：每个 spot 是否真实存在？name 与 name_en 是否对应同一个真实地点？是否的确位于该 spot 所属 day.city / day.country 行政范围内（特别警惕同名地点位于其他城市的情况，比如东京和静冈都有重名地名）？
3. consistency（一致性）：天数与景点数量是否匹配用户偏好的节奏（relaxed/moderate/intensive）？

严格按以下 JSON 输出，不要任何额外文字：
{
  "passed": true | false,
  "missing_spots": ["用户明确提到但计划中没有的景点名（中文）"],
  "incorrect_spots": [
    { "name": "景点名", "issue": "具体问题，如：name_en 不是该景点的官方英文名 / 该景点位于 XX 而非 plan.city / 不存在该景点 等" }
  ],
  "warnings": ["其他不严重但值得提醒用户的问题（如：节奏偏紧、某天景点过多）"],
  "needs_regeneration": true | false
}

判定规则：
- 仅当用户原文里明确写出的景点漏掉了，或景点出现明显错误（不存在 / 在错误城市 / name_en 错误），才算失败 (passed=false)。
- 仅当 missing_spots 或 incorrect_spots 中存在影响计划主体的严重问题时，needs_regeneration=true；否则即便 passed=false，也可设 false（避免无谓重试）。
- 不要编造问题。如果计划没有问题，直接 {"passed": true, "missing_spots": [], "incorrect_spots": [], "warnings": [], "needs_regeneration": false}。`;

function unknownVerification(reason) {
  return {
    status: 'unknown',
    passed: false,
    missing_spots: [],
    incorrect_spots: [],
    warnings: [`AI 内容审核未完成：${reason}；这不代表计划已通过确定性校验。`],
    needs_regeneration: false,
    skipped: true,
  };
}

function buildPlanSummary(plan) {
  return {
    city: plan.city,
    country: plan.country,
    days: plan.days,
    preferences: plan.preferences,
    accommodation: plan.accommodation
      ? { area: plan.accommodation.area, landmark: plan.accommodation.landmark }
      : null,
    daily_plans: (plan.daily_plans || []).map(d => ({
      day: d.day,
      city: d.city,
      country: d.country,
      theme: d.theme,
      spots: (d.spots || []).map(s => ({
        name: s.name,
        name_en: s.name_en,
        city: s.city,
        country: s.country,
        type: s.type,
      })),
    })),
  };
}

export async function verifyPlan(userQuery, plan) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return unknownVerification('未配置 DeepSeek API');
  }

  const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  const userMsg = `【用户原始需求】\n${userQuery}\n\n【已生成的旅行计划】\n${JSON.stringify(buildPlanSummary(plan), null, 2)}`;

  let response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        messages: [
          { role: 'system', content: VERIFY_SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ],
        temperature: 0.1,
        max_tokens: 2048,
        response_format: { type: 'json_object' },
      }),
    });
  } catch (err) {
    console.warn('[Verify] 调用失败，跳过校验:', err.message);
    return unknownVerification(err.name === 'AbortError' ? '请求超时' : '服务不可用');
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    return unknownVerification(`服务返回 HTTP ${response.status}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    return unknownVerification('审核模型未返回内容');
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try { parsed = JSON.parse(match[1].trim()); } catch { /* ignore */ }
    }
  }
  if (!parsed) {
    return unknownVerification('审核输出不是合法 JSON');
  }

  return {
    status: parsed.passed === false ? 'failed' : 'passed',
    passed: parsed.passed !== false,
    missing_spots: Array.isArray(parsed.missing_spots) ? parsed.missing_spots : [],
    incorrect_spots: Array.isArray(parsed.incorrect_spots) ? parsed.incorrect_spots : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    needs_regeneration: parsed.needs_regeneration === true,
  };
}

/**
 * 把审核结果序列化成给 LLM 重生成时的反馈文本。
 */
export function buildRegenFeedback(verification) {
  const lines = ['上一版计划存在以下问题，请修正后重新输出完整 JSON：'];
  if (verification.missing_spots?.length) {
    lines.push(`- 缺失了用户明确要求的景点：${verification.missing_spots.join('、')}（必须加入）`);
  }
  for (const item of verification.incorrect_spots || []) {
    lines.push(`- "${item.name}" 存在问题：${item.issue}`);
  }
  for (const w of verification.warnings || []) {
    lines.push(`- 注意：${w}`);
  }
  lines.push('请确保所有景点都真实存在、确实位于各自 day.city/day.country 行政范围内（不要被同名地点误导，如东京 vs 静冈）。');
  return lines.join('\n');
}
