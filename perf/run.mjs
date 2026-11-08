// 性能测试：服务端（流水线 CPU 与延迟、并发闸门、内存）与前端（包体积、首屏加载、
// 30 天多城市行程的渲染与视图切换）。上游大模型和 Google 都用 mockUpstream 模拟：
// 这里衡量的是本项目自身代码的开销，不含真实网络与模型推理时间。
//
// 运行：npm run build && npm run perf
// 需要 Playwright；浏览器版本与 Playwright 不一致时设置 E2E_BROWSER_PATH。
// 结果打印到终端，并写入 perf/results/<时间>.json。

process.env.LOG_LEVEL = 'silent';

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const moduleHref = (...parts) => pathToFileURL(join(root, ...parts)).href;
const require = createRequire(import.meta.url);

const { createApp } = await import(moduleHref('server', 'app.js'));
const { getConfig } = await import(moduleHref('server', 'config.js'));
const { googleCacheStats, resetGoogleClient } = await import(moduleHref('server', 'services', 'google.js'));
const { createMockUpstream } = await import(moduleHref('server', 'testing', 'mockUpstream.js'));
const { runPlanPipeline } = await import(moduleHref('server', 'services', 'pipeline.js'));
const { normalizePlan } = await import(moduleHref('server', 'services', 'planSchema.js'));
const { optimizePlanOrder } = await import(moduleHref('server', 'services', 'optimize.js'));
const { reconcileTransfers, routeTransfers, transferLeg } = await import(moduleHref('server', 'services', 'transfers.js'));
const { computeRoutes } = await import(moduleHref('server', 'services', 'route.js'));
const { applySchedules } = await import(moduleHref('server', 'services', 'schedule.js'));

const report = { date: new Date().toISOString(), node: process.version, server: {}, frontend: {} };

// ───────────────────────────── 工具 ─────────────────────────────

const round = (value, digits = 1) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}
const summary = values => ({ p50: round(percentile(values, 50)), p95: round(percentile(values, 95)), max: round(Math.max(...values)) });
const mb = bytes => round(bytes / 1024 / 1024, 1);
const kb = bytes => round(bytes / 1024, 1);
const gc = () => globalThis.gc?.();

function withEnv(values, run) {
  const saved = { ...process.env };
  Object.assign(process.env, values);
  resetGoogleClient();
  return Promise.resolve(run()).finally(() => {
    process.env = saved;
    resetGoogleClient();
  });
}

function table(title, rows) {
  console.log(`\n${title}`);
  console.table(rows);
}

// ───────────────────────────── 30 天多城市示例行程 ─────────────────────────────

const ROUTE = [
  ['贝尔格莱德', 44.8176, 20.4569, 3], ['萨拉热窝', 43.8563, 18.4131, 3], ['莫斯塔尔', 43.3438, 17.8078, 1],
  ['杜布罗夫尼克', 42.6507, 18.0944, 3], ['斯普利特', 43.5081, 16.4402, 2], ['威尼斯', 45.4408, 12.3155, 3],
  ['佛罗伦萨', 43.7696, 11.2558, 2], ['罗马', 41.9028, 12.4964, 3], ['卢塞恩', 47.0502, 8.3093, 3],
  ['因特拉肯', 46.6863, 7.8632, 2], ['巴黎', 48.8566, 2.3522, 5],
];
const DESCRIPTION = '沿着老城的石板路慢慢走，看保存完好的中世纪建筑与广场，转角有咖啡馆和小店，适合拍照，也可以坐下来感受当地生活。';
const TIPS = '上午人少，建议 9 点前到；部分区域台阶较多，穿舒适的鞋。';

/** 确定性的 30 天、11 座城市、约 180 个地点的行程（含坐标），用于大数据量测试。 */
function buildLargePlan() {
  const dailyPlans = [];
  const destinations = [];
  const accommodations = [];
  let day = 0;
  ROUTE.forEach(([city, lat, lng, nights], cityIndex) => {
    destinations.push({ city, country: '欧洲', start_day: day + 1, end_day: day + nights });
    accommodations.push({ city, country: '欧洲', area: `${city}老城`, reason: '步行可达主要景点，交通方便', landmark: `${city}中央车站`, price_hint: '约 700-1000 元/晚', coordinates: { lat: lat + 0.004, lng: lng - 0.003 } });
    for (let n = 0; n < nights; n++) {
      day++;
      const at = (index, extra = {}) => {
        const angle = (day * 7 + index * 53) % 360;
        const radius = 0.006 + ((day * 13 + index * 29) % 17) * 0.0012;
        return { lat: lat + radius * Math.sin((angle * Math.PI) / 180), lng: lng + radius * Math.cos((angle * Math.PI) / 180), ...extra };
      };
      const spot = (index, name, type, time, extra = {}) => ({
        name, name_en: `${name}, ${city}`, city, country: '欧洲', type, start_time: time, duration_hours: type === 'restaurant' ? 1 : 1.5,
        cost: type === 'restaurant' ? '人均约 25 欧元' : '门票约 15 欧元', description: DESCRIPTION, tips: TIPS,
        coordinates: at(index), ...extra,
      });
      const spots = [];
      if (n === 0 && cityIndex > 0) {
        const [previous, plat, plng] = ROUTE[cityIndex - 1];
        spots.push(
          { ...spot(0, `${previous}中央车站`, 'transport', '08:00'), city: previous, coordinates: { lat: plat + 0.002, lng: plng + 0.002 }, description: `乘火车前往${city}，车程约 4 小时，沿途风景很好，建议提前在官网订座。`, cost: '火车票约 45 欧元' },
          spot(1, `${city}中央车站`, 'transport', '12:00', { description: `抵达${city}，出站后步行或乘公交到住处放行李。` }),
          spot(2, `${city}老城餐馆 ${day}`, 'restaurant', '13:00'),
          spot(3, `${city}主教堂 ${day}`, 'attraction', '14:30'),
          spot(4, `${city}晚餐 ${day}`, 'restaurant', '18:30'),
        );
      } else {
        spots.push(
          spot(0, `${city}博物馆 ${day}`, 'attraction', '09:00'),
          spot(1, `${city}老城广场 ${day}`, 'attraction', '10:45'),
          spot(2, `${city}午餐 ${day}`, 'restaurant', '12:30'),
          spot(3, `${city}观景台 ${day}`, 'attraction', '14:00'),
          spot(4, `${city}市场 ${day}`, 'shopping', '16:00'),
          spot(5, `${city}晚餐 ${day}`, 'restaurant', '18:30'),
        );
      }
      dailyPlans.push({ day, city, country: '欧洲', theme: `${city}第 ${n + 1} 天`, spots, transport_notes: n === 0 && cityIndex > 0 ? `乘火车约 4 小时到${city}` : '步行与公交结合' });
    }
  });
  return {
    title: '巴尔干到巴黎 30 天',
    city: '多城市',
    country: '塞尔维亚、波黑、克罗地亚、意大利、瑞士、法国',
    days: day,
    summary: '从贝尔格莱德一路坐火车到巴黎',
    preferences: { pace: 'moderate', budget: 'moderate', transport: 'public_transit', interests: ['历史', '美食'] },
    destinations,
    accommodations,
    budget_estimate: { currency: 'CNY', per_person: 36000, excludes: '往返大交通', breakdown: [{ item: '住宿', amount: 18000 }, { item: '餐饮', amount: 9000 }, { item: '交通', amount: 6000 }, { item: '门票', amount: 3000 }] },
    booking_tips: ['热门博物馆提前在官网预约时段票'],
    daily_plans: dailyPlans,
    route_reasoning: '由东向西一路坐火车，不走回头路',
    practical_tips: ['跨国火车提前订座'],
  };
}

/** 用服务端的确定性步骤处理大行程（地点坐标已给定，路线走模拟的 Google）。 */
async function buildLargeResult() {
  const raw = buildLargePlan();
  const normalized = normalizePlan(raw);
  // normalizePlan 只保留白名单字段：把坐标与 location_id 补回来，模拟地点落地后的结果。
  normalized.accommodations = normalized.accommodations.map((item, index) => ({ ...item, coordinates: raw.accommodations[index].coordinates }));
  normalized.daily_plans = normalized.daily_plans.map((dayPlan, dayIndex) => ({
    ...dayPlan,
    spots: dayPlan.spots.map((spot, spotIndex) => ({
      ...spot,
      location_id: `day:${dayIndex}:spot:${spotIndex}`,
      location_status: 'verified',
      coordinates: raw.daily_plans[dayIndex].spots[spotIndex].coordinates,
    })),
  }));
  const ordered = optimizePlanOrder(normalized);
  const planned = { ...ordered.plan, transfers: reconcileTransfers(ordered.plan) };
  const transfers = await routeTransfers(planned, planned.transfers);
  const routes = await computeRoutes(planned, { optimizations: ordered.results, transfers, transferLeg });
  const scheduled = applySchedules(planned, routes);
  const spots = scheduled.plan.daily_plans.flatMap(item => item.spots);
  return {
    raw,
    result: {
      status: 'success',
      parsed_request: { city: '多城市', days: scheduled.plan.days, destinations: scheduled.plan.destinations, preferences: scheduled.plan.preferences, constraints: { transport: 'public_transit' } },
      plan: scheduled.plan,
      routes,
      transfers,
      transit_markers: [],
      verification: { passed: true, missing_spots: [], incorrect_spots: [], warnings: scheduled.warnings },
      geocoding_warnings: [],
      quality: { total_spots: spots.length, verified_spots: spots.length, unverified_spots: 0, removed_spots: 0, grounding_available: true, regeneration: null },
      map_provider: 'google',
      meta: { request_id: 'perf', duration_ms: 0, stats: {} },
    },
  };
}

// ───────────────────────────── 服务端 ─────────────────────────────

const SCENARIOS = [
  { name: '京都 3 天（单城市）', query: '我想去京都玩三天，想去清水寺、伏见稻荷、岚山' },
  { name: '北海道 5 天（多城市）', query: '北海道五天，先札幌再去函馆' },
  { name: '京都 14 天（分段生成）', query: '京都玩14天，慢慢逛' },
  { name: '京都 30 天（分段生成）', query: '京都玩30天，深度游' },
];

async function pipelineBench(runs = 12) {
  const rows = [];
  await withEnv({ DEEPSEEK_API_KEY: 'perf', GOOGLE_MAPS_API_KEY: 'perf' }, async () => {
    const upstream = createMockUpstream({ transitMaxKm: 50 }).install();
    try {
      for (const scenario of SCENARIOS) {
        for (const cache of ['cold', 'warm']) {
          const wall = [];
          const cpu = [];
          const loopMax = [];
          let bytes = 0;
          let googleCalls = 0;
          let transfers = 0;
          let spots = 0;
          for (let index = 0; index < runs; index++) {
            if (cache === 'cold') resetGoogleClient();
            const callsBefore = upstream.calls.places + upstream.calls.routes + upstream.calls.nearby;
            const loop = monitorEventLoopDelay({ resolution: 5 });
            loop.enable();
            const cpuBefore = process.cpuUsage();
            const started = performance.now();
            const result = await runPlanPipeline(scenario.query);
            wall.push(performance.now() - started);
            const used = process.cpuUsage(cpuBefore);
            cpu.push((used.user + used.system) / 1000);
            loop.disable();
            loopMax.push(loop.max / 1e6);
            bytes = Buffer.byteLength(JSON.stringify(result));
            googleCalls = upstream.calls.places + upstream.calls.routes + upstream.calls.nearby - callsBefore;
            transfers = result.transfers?.length || 0;
            spots = result.quality?.total_spots || 0;
          }
          rows.push({
            场景: scenario.name,
            缓存: cache === 'cold' ? '冷' : '热',
            地点: spots,
            城际交通: transfers,
            'Google 调用': googleCalls,
            '耗时 p50 ms': summary(wall).p50,
            '耗时 p95 ms': summary(wall).p95,
            'CPU p50 ms': summary(cpu).p50,
            'CPU p95 ms': summary(cpu).p95,
            '事件循环最大阻塞 ms': summary(loopMax).max,
            '响应 KB': kb(bytes),
          });
        }
      }
    } finally {
      upstream.restore();
    }
  });
  report.server.pipeline = rows;
  table('服务端流水线（上游零延迟，冷 = 每次清空 Google 缓存）', rows);
}

async function deterministicBench() {
  await withEnv({ GOOGLE_MAPS_API_KEY: 'perf' }, async () => {
    const upstream = createMockUpstream({ transitMaxKm: 50 }).install();
    try {
      const { raw, result } = await buildLargeResult();
      const time = (fn, iterations = 50) => {
        fn();
        const started = performance.now();
        for (let index = 0; index < iterations; index++) fn();
        return (performance.now() - started) / iterations;
      };
      const normalized = normalizePlan(raw);
      const located = result.plan;
      const rows = [
        { 步骤: '规范化（normalizePlan）', 'ms / 次': round(time(() => normalizePlan(raw)), 2) },
        { 步骤: '顺序优化（optimizePlanOrder）', 'ms / 次': round(time(() => optimizePlanOrder(located)), 2) },
        { 步骤: '城际交通推断（reconcileTransfers）', 'ms / 次': round(time(() => reconcileTransfers(normalized)), 2) },
        { 步骤: '排程（applySchedules）', 'ms / 次': round(time(() => applySchedules(located, result.routes)), 2) },
        { 步骤: '序列化响应（JSON.stringify）', 'ms / 次': round(time(() => JSON.stringify(result)), 2) },
      ];
      report.server.deterministic = {
        plan: { days: located.days, spots: located.daily_plans.reduce((sum, day) => sum + day.spots.length, 0), transfers: result.transfers.length, response_kb: kb(Buffer.byteLength(JSON.stringify(result))) },
        steps: rows,
      };
      table(`确定性步骤 CPU（30 天 / ${report.server.deterministic.plan.spots} 个地点 / ${result.transfers.length} 段城际交通，响应 ${report.server.deterministic.plan.response_kb} KB）`, rows);
    } finally {
      upstream.restore();
    }
  });
}

async function startServer(env, mockOptions) {
  const saved = { ...process.env };
  Object.assign(process.env, { DEEPSEEK_API_KEY: 'perf', GOOGLE_MAPS_API_KEY: 'perf', SERVE_CLIENT: 'false', PLAN_RATE_LIMIT: '0', ...env });
  resetGoogleClient();
  const upstream = createMockUpstream(mockOptions).install();
  const app = createApp({ config: getConfig() });
  const server = await new Promise((resolveServer) => {
    const instance = app.listen(0, '127.0.0.1', () => resolveServer(instance));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    upstream,
    async close() {
      server.closeAllConnections?.();
      await new Promise(resolveClose => server.close(resolveClose));
      upstream.restore();
      process.env = saved;
      resetGoogleClient();
    },
  };
}

async function timedPlan(base, query, realFetch) {
  const started = performance.now();
  const response = await realFetch(`${base}/api/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  await response.arrayBuffer();
  return { status: response.status, ms: performance.now() - started };
}

async function loadBench() {
  const realFetch = globalThis.fetch;
  // 模拟上游延迟：每次大模型调用 800ms、每次 Google 调用 40ms。
  const server = await startServer({}, { llmDelayMs: 800, googleDelayMs: 40, transitMaxKm: 50 });
  const rows = [];
  try {
    const query = '我想去京都玩三天，想去清水寺、伏见稻荷、岚山';
    await timedPlan(server.base, query, realFetch);

    // 稳态：8 个并发客户端（等于并发上限），每个连续发 8 次。
    const latencies = [];
    let failures = 0;
    const cpuBefore = process.cpuUsage();
    const started = performance.now();
    await Promise.all(Array.from({ length: 8 }, async () => {
      for (let index = 0; index < 8; index++) {
        const result = await timedPlan(server.base, query, realFetch);
        if (result.status === 200) latencies.push(result.ms);
        else failures++;
      }
    }));
    const elapsed = (performance.now() - started) / 1000;
    const cpu = process.cpuUsage(cpuBefore);
    rows.push({
      场景: '稳态：8 并发 × 8 次',
      成功: latencies.length,
      失败: failures,
      '吞吐 次/秒': round(latencies.length / elapsed, 2),
      '延迟 p50 ms': summary(latencies).p50,
      '延迟 p95 ms': summary(latencies).p95,
      '进程 CPU 占用': `${round(((cpu.user + cpu.system) / 1000 / (elapsed * 1000)) * 100)}%`,
    });

    // 突发：40 个请求同时到达，超出并发上限的应立即返回 503。
    const burst = await Promise.all(Array.from({ length: 40 }, () => timedPlan(server.base, query, realFetch)));
    const accepted = burst.filter(item => item.status === 200);
    const rejected = burst.filter(item => item.status === 503);
    rows.push({
      场景: '突发：40 个同时到达',
      成功: accepted.length,
      失败: rejected.length,
      '吞吐 次/秒': null,
      '延迟 p50 ms': summary(accepted.map(item => item.ms)).p50,
      '延迟 p95 ms': summary(rejected.map(item => item.ms)).p95,
      '进程 CPU 占用': '—',
    });
    report.server.load = { rows, burst_rejected_p95_ms: summary(rejected.map(item => item.ms)).p95, burst_other_statuses: burst.filter(item => item.status !== 200 && item.status !== 503).length };
    table('HTTP 并发（上游：大模型 800ms / 次、Google 40ms / 次；突发行的第二个延迟是 503 的 p95）', rows);
  } finally {
    await server.close();
  }
}

async function memoryBench() {
  const realFetch = globalThis.fetch;
  const server = await startServer({}, { transitMaxKm: 50 });
  const samples = [];
  try {
    const queries = ['我想去京都玩三天', '北海道五天，先札幌再去函馆', '巴黎四天三夜，想看埃菲尔铁塔、卢浮宫', '东京五日游，带小孩'];
    for (let index = 1; index <= 300; index++) {
      await timedPlan(server.base, queries[index % queries.length], realFetch);
      if (index % 100 === 0) {
        gc();
        const usage = process.memoryUsage();
        samples.push({ 请求数: index, '堆内存 MB': mb(usage.heapUsed), 'RSS MB': mb(usage.rss), 'Google 缓存条目': googleCacheStats().size });
      }
    }
  } finally {
    await server.close();
  }
  report.server.memory = { gc_available: Boolean(globalThis.gc), samples };
  table(`内存（连续 300 个请求${globalThis.gc ? '，每 100 次后强制 GC' : '，未开启 --expose-gc'}）`, samples);
}

// ───────────────────────────── 前端 ─────────────────────────────

function bundleSizes() {
  const dir = join(root, 'client', 'dist', 'assets');
  const rows = readdirSync(dir).filter(name => /\.(js|css)$/.test(name)).map((name) => {
    const content = readFileSync(join(dir, name));
    return { 文件: name, 'KB': kb(content.length), 'gzip KB': kb(gzipSync(content).length), 'brotli KB': kb(brotliCompressSync(content).length) };
  });
  report.frontend.bundle = rows;
  table('前端包体积', rows);
}

// 记录调用的轻量 Google Maps 桩：只衡量本项目代码，不含 Google 地图自身的绘制开销。
const MAPS_STUB = `(() => {
  const calls = window.__mapStub = { markers: [], polylines: [] };
  class LatLngBounds { constructor() { this.points = []; } extend(p) { this.points.push(p); return this; } getCenter() { return this.points[0] || { lat: 0, lng: 0 }; } }
  class Map { constructor(el, o) { this.zoom = o.zoom; } addListener() { return { remove() {} }; } setCenter() {} setZoom(z) { this.zoom = z; } getZoom() { return this.zoom; } fitBounds() {} panTo() {} getRenderingType() { return 'RASTER'; } }
  class InfoWindow { setContent() {} open() {} close() {} }
  class Polyline { constructor(o) { this.active = true; calls.polylines.push(this); } setMap(m) { if (!m) this.active = false; } }
  class AdvancedMarkerElement extends EventTarget { constructor(o) { super(); Object.assign(this, o); calls.markers.push(this); } }
  const PinElement = function () { return document.createElement('span'); };
  window.google = window.google || {};
  const ns = window.google.maps = window.google.maps || {};
  Object.assign(ns, { Map, InfoWindow, Polyline, LatLngBounds, RenderingType: { VECTOR: 'VECTOR', RASTER: 'RASTER' }, event: { removeListener() {} } });
  ns.importLibrary = async (name) => name === 'marker' ? { AdvancedMarkerElement, PinElement } : ns;
  if (typeof ns.__ib__ === 'function') ns.__ib__();
})();`;

const PROFILES = {
  桌面: { viewport: { width: 1440, height: 900 }, cpu: 1, network: null },
  '手机（CPU 4× 降速 + 慢速 4G）': {
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, cpu: 4,
    network: { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
  },
};

async function frontendBench() {
  const clientDist = join(root, 'client', 'dist');
  if (!existsSync(join(clientDist, 'index.html'))) throw new Error('请先运行 npm run build');
  bundleSizes();

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.log('\n未安装 Playwright，跳过前端性能测试');
    return;
  }
  const saved = { ...process.env };
  Object.assign(process.env, { DEEPSEEK_API_KEY: 'perf', GOOGLE_MAPS_API_KEY: 'perf', SERVE_CLIENT: 'true', PLAN_RATE_LIMIT: '0' });
  resetGoogleClient();
  const upstream = createMockUpstream({ transitMaxKm: 50 }).install();
  const app = createApp({ config: getConfig(), clientDist });
  const server = await new Promise((resolveServer) => {
    const instance = app.listen(0, '127.0.0.1', () => resolveServer(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.E2E_BROWSER_PATH || undefined;
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const { result: large } = await buildLargeResult();
  const largeBody = `event: progress\ndata: ${JSON.stringify({ stage: 'route', message: '路线规划完成', progress: 0.99 })}\n\nevent: result\ndata: ${JSON.stringify(large)}\n\n`;

  const loadRows = [];
  const renderRows = [];
  const switchRows = [];
  try {
    for (const [name, profile] of Object.entries(PROFILES)) {
      const context = await browser.newContext({ viewport: profile.viewport, isMobile: profile.isMobile, hasTouch: profile.hasTouch, locale: 'zh-CN' });
      const page = await context.newPage();
      await page.addInitScript(() => {
        window.__perf = { longTasks: [], lcp: 0 };
        new PerformanceObserver(list => list.getEntries().forEach(entry => window.__perf.longTasks.push({ start: entry.startTime, duration: entry.duration })))
          .observe({ type: 'longtask', buffered: true });
        new PerformanceObserver((list) => { const entries = list.getEntries(); window.__perf.lcp = entries[entries.length - 1].startTime; })
          .observe({ type: 'largest-contentful-paint', buffered: true });
      });
      await page.route('https://maps.googleapis.com/maps/api/js**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: MAPS_STUB }));
      const cdp = await context.newCDPSession(page);
      if (profile.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
      if (profile.network) {
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', profile.network);
      }

      // 首屏加载。
      await page.goto(base, { waitUntil: 'load' });
      await page.getByRole('heading', { name: '想去哪里？' }).waitFor();
      await page.waitForTimeout(500);
      const load = await page.evaluate(() => {
        const navigation = performance.getEntriesByType('navigation')[0];
        const paint = performance.getEntriesByName('first-contentful-paint')[0];
        const transferred = performance.getEntriesByType('resource').reduce((sum, entry) => sum + (entry.transferSize || 0), navigation.transferSize || 0);
        return {
          fcp: paint?.startTime ?? null,
          lcp: window.__perf.lcp,
          dcl: navigation.domContentLoadedEventEnd,
          load: navigation.loadEventEnd,
          transferred,
          heap: performance.memory?.usedJSHeapSize ?? null,
        };
      });
      loadRows.push({ 设备: name, 'FCP ms': round(load.fcp, 0), 'LCP ms': round(load.lcp, 0), 'DOMContentLoaded ms': round(load.dcl, 0), 'load ms': round(load.load, 0), '传输 KB': kb(load.transferred), 'JS 堆 MB': load.heap ? mb(load.heap) : null });

      // 30 天多城市行程：从点击“生成”到全部 30 天渲染完成。
      await page.route('**/api/plan', route => route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: largeBody }));
      await page.locator('#trip-query').fill('巴尔干到巴黎 30 天');
      const renderStart = await page.evaluate(() => performance.now());
      await page.getByRole('button', { name: '生成行程' }).click();
      await page.waitForFunction(count => document.querySelectorAll('article.day').length === count, large.plan.daily_plans.length, { timeout: 60000 });
      const render = await page.evaluate(async (start) => {
        await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
        const end = performance.now();
        const tasks = window.__perf.longTasks.filter(task => task.start >= start - 5);
        return {
          ms: end - start,
          tbt: tasks.reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0),
          longest: Math.max(0, ...tasks.map(task => task.duration)),
          nodes: document.getElementsByTagName('*').length,
          heap: performance.memory?.usedJSHeapSize ?? null,
          markers: window.__mapStub.markers.filter(marker => marker.map).length,
          lines: window.__mapStub.polylines.filter(line => line.active).length,
        };
      }, renderStart);
      renderRows.push({ 设备: name, '渲染完成 ms': round(render.ms, 0), '总阻塞时间 TBT ms': round(render.tbt, 0), '最长任务 ms': round(render.longest, 0), 'DOM 节点': render.nodes, 'JS 堆 MB': render.heap ? mb(render.heap) : null, '总览地图 标记/线': `${render.markers}/${render.lines}` });

      // 视图切换：总览 → 城市 → 某一天 → 总览，每次测到下一帧。
      // 在页面内触发点击并等到下一帧，排除测试工具自身的往返耗时。
      const measureClick = async (locator) => {
        await locator.scrollIntoViewIfNeeded();
        const handle = await locator.elementHandle();
        return page.evaluate(element => new Promise((done) => {
          const start = performance.now();
          element.click();
          requestAnimationFrame(() => requestAnimationFrame(() => done(performance.now() - start)));
        }), handle);
      };
      const filter = page.locator('.day-filter');
      const timings = { city: [], day: [], overview: [] };
      for (let round = 0; round < 3; round++) {
        timings.city.push(await measureClick(filter.getByRole('button', { name: /^罗马/ })));
        timings.day.push(await measureClick(filter.getByRole('button', { name: /^第 \d+ 天/ }).first()));
        timings.overview.push(await measureClick(filter.getByRole('button', { name: '总览' })));
      }
      const overlays = await page.evaluate(() => ({ markers: window.__mapStub.markers.filter(marker => marker.map).length, lines: window.__mapStub.polylines.filter(line => line.active).length }));
      switchRows.push({ 设备: name, '切到城市 ms': round(percentile(timings.city, 50), 0), '切到某一天 ms': round(percentile(timings.day, 50), 0), '回到总览 ms': round(percentile(timings.overview, 50), 0), '总览 标记/线': `${overlays.markers}/${overlays.lines}` });
      await context.close();
    }
  } finally {
    await browser.close();
    server.closeAllConnections?.();
    await new Promise(resolveClose => server.close(resolveClose));
    upstream.restore();
    process.env = saved;
    resetGoogleClient();
  }
  report.frontend.load = loadRows;
  report.frontend.largePlan = { days: large.plan.daily_plans.length, spots: large.plan.daily_plans.reduce((sum, day) => sum + day.spots.length, 0), transfers: large.transfers.length, render: renderRows, viewSwitch: switchRows };
  table('首屏加载', loadRows);
  table(`超长行程渲染（${report.frontend.largePlan.days} 天 / ${report.frontend.largePlan.spots} 个地点 / ${report.frontend.largePlan.transfers} 段城际交通）`, renderRows);
  table('视图切换（点击到下一帧，取 3 次的中位数）', switchRows);
}

// ───────────────────────────── 主流程 ─────────────────────────────

const only = new Set(process.argv.slice(2));
const want = name => only.size === 0 || only.has(name);
if (want('server')) {
  await pipelineBench();
  await deterministicBench();
  await loadBench();
  await memoryBench();
}
if (want('frontend')) await frontendBench();

const outDir = join(root, 'perf', 'results');
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${report.date.replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`\n结果已写入 ${file}`);
