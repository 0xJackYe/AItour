// 行程质量评测：用真实的大模型（以及可选的 Google 地图）跑评测集，
// 输出每个用例的完整 JSON、可读的 Markdown 行程和汇总报告。
//
// 用法：
//   DEEPSEEK_API_KEY=... [GOOGLE_MAPS_API_KEY=...] node eval/run.mjs [--cases a,b] [--concurrency 3] [--label baseline]
// 结果写入 eval/results/<时间>-<label>/（已被 .gitignore 忽略）。

process.env.LOG_LEVEL ||= 'warn';

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { runPlanPipeline } = await import(join(root, 'server/services/pipeline.js'));
const { runWithContext } = await import(join(root, 'server/lib/context.js'));
const { getConfig } = await import(join(root, 'server/config.js'));
const { normalizeResult } = await import(join(root, 'client/src/lib/plan.js'));
const { planToMarkdown } = await import(join(root, 'client/src/lib/markdown.js'));

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]?.startsWith('--') ? 'true' : all[index + 1] ?? 'true']);
  return pairs;
}, []));

const config = getConfig();
if (!config.llm.apiKey) {
  console.error('需要 DEEPSEEK_API_KEY 才能运行评测。');
  process.exit(1);
}

const allCases = JSON.parse(readFileSync(join(root, 'eval/cases.json'), 'utf8'));
const wanted = args.cases ? new Set(args.cases.split(',')) : null;
const cases = allCases.filter(item => !wanted || wanted.has(item.id));
const concurrency = Number(args.concurrency || 3);
const label = args.label || 'run';
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = resolve(args.out || join(root, 'eval/results', `${stamp}-${label}`));
mkdirSync(outDir, { recursive: true });

// ───────────────────────────── 评分规则 ─────────────────────────────

const PACE_BOUNDS = { relaxed: [2, 4], moderate: [3, 5], intensive: [4, 7] };
// 每天主要活动的小时数上限：citywalk 这类“短站多”的日子按时长判断更合理。
const PACE_HOURS = { relaxed: 7, moderate: 9, intensive: 11 };
const NON_MAIN = new Set(['restaurant', 'transport', 'hotel']);
const textLength = value => [...String(value || '')].length;
const mean = values => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
const ratio = (part, total) => (total ? part / total : 0);
const pct = value => `${Math.round(value * 100)}%`;

function matchesAny(haystacks, aliases) {
  const list = Array.isArray(aliases) ? aliases : [aliases];
  return list.some(alias => haystacks.some(text => String(text || '').toLowerCase().includes(String(alias).toLowerCase())));
}

function evaluate(testCase, response, elapsedMs) {
  const expect = testCase.expect || {};
  const checks = [];
  const add = (name, passed, detail = '') => checks.push({ name, passed: Boolean(passed), detail });
  const metrics = { seconds: Math.round(elapsedMs / 100) / 10 };

  if (expect.clarification) {
    add('信息不足时先澄清', response.status === 'need_clarification', response.status);
    return { checks, metrics };
  }
  add('成功生成', response.status === 'success', response.status === 'success' ? '' : (response.error || response.status));
  if (response.status !== 'success') return { checks, metrics };

  const { plan } = response;
  const days = plan.daily_plans || [];
  const spots = days.flatMap(day => day.spots || []);
  const haystack = [
    ...spots.flatMap(spot => [spot.name, spot.name_en, spot.description]),
    ...days.flatMap(day => [day.city, day.theme]),
    ...(plan.destinations || []).map(item => item.city),
  ];

  // 完整性
  const sequential = days.every((day, index) => day.day === index + 1);
  const emptyDays = days.filter(day => !(day.spots || []).length).length;
  add('天数完整', days.length === expect.days && sequential && emptyDays === 0, `${days.length}/${expect.days} 天，空白 ${emptyDays}`);

  // 用户点名的内容
  for (const group of expect.must || []) {
    const name = Array.isArray(group) ? group[0] : group;
    add(`包含：${name}`, matchesAny(haystack, group));
  }
  for (const city of expect.cities || []) {
    add(`覆盖城市：${city}`, matchesAny([...days.map(day => day.city), ...(plan.destinations || []).map(item => item.city)], city));
  }
  const countryOf = day => [day.country, ...(day.spots || []).map(spot => spot.country)].join(' ');
  for (const country of expect.countries || []) {
    const name = Array.isArray(country) ? country[0] : country;
    add(`覆盖国家：${name}`, matchesAny(days.map(countryOf), country));
  }
  if (expect.first_country) add(`从${expect.first_country}出发`, matchesAny([countryOf(days[0] || {})], expect.first_country));
  if (expect.last_country) add(`在${expect.last_country}结束`, matchesAny([countryOf(days.at(-1) || {})], expect.last_country));

  // 节奏：全天型景点（停留 ≥5 小时）和换城市的日子允许只有一个主要地点。
  const pace = expect.pace || plan.preferences?.pace || 'moderate';
  const [low, high] = PACE_BOUNDS[pace] || PACE_BOUNDS.moderate;
  const offPace = days.filter((day, index) => {
    const spotsOfDay = day.spots || [];
    const main = spotsOfDay.filter(spot => !NON_MAIN.has(spot.type));
    if (main.length >= low && main.length <= high) return false;
    const hours = main.reduce((sum, spot) => sum + (spot.duration_hours || 0), 0);
    const maxHours = PACE_HOURS[pace] || PACE_HOURS.moderate;
    // 地点多但都很短、总时长不超标；或地点少但都是半天级的大型地点：都算符合节奏。
    if (main.length > high && main.length <= high + 2 && hours <= maxHours) return false;
    if (main.length === low - 1 && hours >= 5 && hours <= maxHours) return false;
    const fullDay = main.some(spot => (spot.duration_hours || 0) >= 5);
    const travelDay = spotsOfDay.some(spot => spot.type === 'transport') || (index > 0 && days[index - 1].city !== day.city);
    return !(main.length >= 1 && main.length <= high && (fullDay || travelDay));
  });
  add(`节奏符合（${pace}）`, offPace.length <= Math.floor(days.length * 0.15), offPace.length ? `不符合：Day ${offPace.map(day => day.day).join('、')}` : '');
  if (expect.pace) add('识别出节奏偏好', plan.preferences?.pace === expect.pace, plan.preferences?.pace);
  if (expect.transport) add('识别出交通偏好', (response.parsed_request?.constraints?.transport || plan.preferences?.transport) === expect.transport);
  if (expect.budget) add('识别出预算偏好', plan.preferences?.budget === expect.budget, plan.preferences?.budget);

  // 详细度
  const contentSpots = spots.filter(spot => spot.type !== 'transport');
  metrics.spots = spots.length;
  metrics.avg_desc = Math.round(mean(contentSpots.map(spot => textLength(spot.description))));
  metrics.avg_tip = Math.round(mean(spots.map(spot => textLength(spot.tips))));
  const described = ratio(contentSpots.filter(spot => textLength(spot.description) >= 25).length, contentSpots.length);
  add('地点介绍具体（≥25 字）', described >= 0.9, pct(described));
  const tipped = ratio(spots.filter(spot => textLength(spot.tips) >= 8).length, spots.length);
  add('多数地点有实用提示', tipped >= 0.7, pct(tipped));
  const minutes = clock => (/^\d{2}:\d{2}$/.test(clock || '') ? Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3)) : null);
  const timedDays = days.filter(day => (day.spots || []).every((spot, index, all) =>
    minutes(spot.start_time) !== null && (index === 0 || minutes(spot.start_time) > minutes(all[index - 1].start_time)))).length;
  add('每天有连贯的时间安排', ratio(timedDays, days.length) >= 0.9, `${timedDays}/${days.length} 天`);
  const priced = ratio(spots.filter(spot => textLength(spot.cost) > 0).length, spots.length);
  metrics.priced = pct(priced);
  add('多数地点有费用信息', priced >= 0.7, pct(priced));

  // 可执行性
  const mealDays = days.filter((day, index) => {
    const spotsOfDay = day.spots || [];
    const meals = spotsOfDay.filter(spot => spot.type === 'restaurant').length;
    const relaxed = index === days.length - 1
      || spotsOfDay.some(spot => spot.type === 'transport' || (spot.duration_hours || 0) >= 5);
    return meals >= 2 || (relaxed && meals >= 1);
  }).length;
  add('每天安排午餐和晚餐', ratio(mealDays, days.length) >= 0.85, `${mealDays}/${days.length} 天`);
  add('每天有交通建议', days.every(day => textLength(day.transport_notes) >= 6));
  const destinationCities = [...new Set((plan.destinations || []).map(item => item.city).filter(Boolean))];
  const stayCities = (plan.accommodations || []).map(item => item.city);
  const uncovered = destinationCities.filter((city) => {
    if (stayCities.includes(city)) return false;
    const destination = plan.destinations.find(item => item.city === city);
    return destination.end_day > destination.start_day;
  });
  add('每个过夜城市都有住宿建议', destinationCities.length > 0 && uncovered.length === 0, uncovered.length ? `缺：${uncovered.join('、')}` : '');
  add('有预算估算', Number(plan.budget_estimate?.per_person) > 0);
  add('有提前预订提醒', (plan.booking_tips || []).length >= 1);
  add('有实用贴士（≥3 条）', (plan.practical_tips || []).length >= 3, `${(plan.practical_tips || []).length} 条`);
  add('有路线思路说明', textLength(plan.route_reasoning) >= 20);

  // 过程指标
  const stats = response.meta?.stats || {};
  Object.assign(metrics, {
    strategy: response.meta?.strategy,
    llm_calls: stats.llm_calls || 0,
    completion_tokens: stats.llm_completion_tokens || 0,
    verified: response.quality?.grounding_available ? `${response.quality.verified_spots}/${response.quality.total_spots}` : '未启用',
    regeneration: response.quality?.regeneration || '-',
  });
  return { checks, metrics };
}

// ───────────────────────────── 运行 ─────────────────────────────

async function runCase(testCase) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.plan.timeoutMs);
  const started = Date.now();
  try {
    const response = await runWithContext(
      { requestId: `eval-${testCase.id}`, signal: controller.signal, stats: {} },
      () => runPlanPipeline(testCase.query),
    );
    return { response, elapsedMs: Date.now() - started };
  } catch (error) {
    return { response: { status: 'error', error: `${error.code || ''} ${error.message}`.trim() }, elapsedMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

const results = new Array(cases.length);
let next = 0;
const rescoreDir = args.rescore ? resolve(args.rescore) : null;
if (rescoreDir) {
  // 不调用大模型：用当前评分规则重新评估已保存的结果（便于新旧版本同口径对比）。
  cases.forEach((testCase, index) => {
    let response;
    try {
      response = JSON.parse(readFileSync(join(rescoreDir, `${testCase.id}.json`), 'utf8'));
    } catch {
      response = { status: 'missing' };
    }
    const seconds = response.meta?.duration_ms ? response.meta.duration_ms : 0;
    results[index] = { testCase, response, ...evaluate(testCase, response, seconds) };
  });
  next = cases.length;
}
await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
  while (next < cases.length) {
    const index = next++;
    const testCase = cases[index];
    process.stdout.write(`▶ ${testCase.id} …\n`);
    const { response, elapsedMs } = await runCase(testCase);
    const evaluation = evaluate(testCase, response, elapsedMs);
    results[index] = { testCase, response, ...evaluation };
    writeFileSync(join(outDir, `${testCase.id}.json`), JSON.stringify(response, null, 2));
    if (response.status === 'success') {
      writeFileSync(join(outDir, `${testCase.id}.md`), planToMarkdown(normalizeResult(response, testCase.query)));
    }
    const passed = evaluation.checks.filter(item => item.passed).length;
    process.stdout.write(`✔ ${testCase.id}: ${response.status} · ${passed}/${evaluation.checks.length} 项通过 · ${evaluation.metrics.seconds}s\n`);
  }
}));

// ───────────────────────────── 报告 ─────────────────────────────

const totalChecks = results.reduce((sum, item) => sum + item.checks.length, 0);
const totalPassed = results.reduce((sum, item) => sum + item.checks.filter(check => check.passed).length, 0);
const lines = [
  `# 行程质量评测：${label}`,
  '',
  `- 时间：${new Date().toISOString()}`,
  `- 模型：${config.llm.model}`,
  `- Google 地图校验：${config.google.apiKey ? '已启用' : '未启用（只评估大模型生成的行程内容）'}`,
  `- 总体：${totalPassed}/${totalChecks} 项检查通过（${pct(ratio(totalPassed, totalChecks))}）`,
  '',
  '| 用例 | 状态 | 通过 | 地点数 | 介绍均长 | 提示均长 | 有价格 | 策略 | LLM 调用 | 输出 tokens | 耗时 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...results.map(({ testCase, response, checks, metrics }) => {
    const passed = checks.filter(item => item.passed).length;
    return `| ${testCase.id} | ${response.status} | ${passed}/${checks.length} | ${metrics.spots ?? '-'} | ${metrics.avg_desc ?? '-'} | ${metrics.avg_tip ?? '-'} | ${metrics.priced ?? '-'} | ${metrics.strategy ?? '-'} | ${metrics.llm_calls ?? '-'} | ${metrics.completion_tokens ?? '-'} | ${metrics.seconds}s |`;
  }),
  '',
  '## 未通过的检查',
  '',
];
const failureCounts = new Map();
for (const { testCase, checks } of results) {
  const failed = checks.filter(item => !item.passed);
  if (!failed.length) continue;
  lines.push(`- **${testCase.id}**：${failed.map(item => `${item.name}${item.detail ? `（${item.detail}）` : ''}`).join('；')}`);
  for (const item of failed) {
    const key = item.name.replace(/：.*$/, '');
    failureCounts.set(key, (failureCounts.get(key) || 0) + 1);
  }
}
lines.push('', '## 按检查项汇总（失败次数）', '');
for (const [name, count] of [...failureCounts.entries()].sort((a, b) => b[1] - a[1])) lines.push(`- ${name}：${count}`);
lines.push('');
writeFileSync(join(outDir, 'summary.md'), lines.join('\n'));
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(results.map(({ testCase, checks, metrics, response }) => ({
  id: testCase.id, status: response.status, checks, metrics,
})), null, 2));
console.log(`\n${totalPassed}/${totalChecks} 项通过 → ${join(outDir, 'summary.md')}`);
