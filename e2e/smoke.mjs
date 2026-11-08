// 浏览器端到端冒烟测试：
//   - 使用真实 Express 应用托管 client/dist 生产构建；
//   - 大模型与 Google 服务端接口由 server/testing/mockUpstream.js 模拟；
//   - 浏览器中的 Google Maps JS 由轻量桩脚本替代，以便断言标记与路线。
// 运行：npm run build && npm run test:e2e
// 依赖：Playwright（npm i -D playwright && npx playwright install chromium）。
// 设置 E2E_SCREENSHOTS=目录 可保存截图；E2E_BROWSER_CHANNEL=chrome 可复用系统 Chrome。

process.env.LOG_LEVEL ||= 'warn';

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('未找到 Playwright。请先运行：npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}

const moduleHref = (...parts) => pathToFileURL(join(root, ...parts)).href;
const { createApp } = await import(moduleHref('server', 'app.js'));
const { getConfig } = await import(moduleHref('server', 'config.js'));
const { resetGoogleClient } = await import(moduleHref('server', 'services', 'google.js'));
const { createMockUpstream } = await import(moduleHref('server', 'testing', 'mockUpstream.js'));

const clientDist = join(root, 'client/dist');
if (!existsSync(join(clientDist, 'index.html'))) {
  execSync('npm --prefix client run build', { cwd: root, stdio: 'inherit' });
}

const screenshotDir = process.env.E2E_SCREENSHOTS ? resolve(process.env.E2E_SCREENSHOTS) : null;
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });

// 浏览器端 Google Maps JS 桩：实现本项目用到的最小 API，并把调用记录在 window.__mapStub。
const MAPS_STUB = `(() => {
  const calls = window.__mapStub = { maps: 0, markers: [], polylines: [], fitBounds: 0, panTo: [], opened: [] };
  class LatLngBounds { constructor() { this.points = []; } extend(p) { this.points.push(p); return this; } getCenter() { return this.points[0] || { lat: 0, lng: 0 }; } }
  class Map {
    constructor(el, options) { calls.maps++; this.el = el; this.zoom = options.zoom; el.dataset.stub = 'map'; el.style.background = '#dfe9df'; }
    addListener() { return { remove() {} }; }
    setCenter(c) { this.center = c; } setZoom(z) { this.zoom = z; } getZoom() { return this.zoom; }
    fitBounds() { calls.fitBounds++; this.zoom = 12; } panTo(p) { calls.panTo.push(p); }
    getRenderingType() { return 'RASTER'; }
  }
  class InfoWindow { setContent(c) { this.content = c; } open() { calls.opened.push(this.content && this.content.querySelector('strong') ? this.content.querySelector('strong').textContent : ''); } close() {} }
  class Polyline { constructor(o) { this.options = o; this.active = true; calls.polylines.push(this); } setMap(m) { if (!m) this.active = false; } }
  class AdvancedMarkerElement extends EventTarget { constructor(o) { super(); this._map = null; Object.assign(this, o); calls.markers.push(this); } set map(m) { this._map = m; } get map() { return this._map; } }
  class PinElement extends HTMLElement {}
  customElements.define('stub-pin', PinElement);
  const PinFactory = function (o) { const el = document.createElement('stub-pin'); el.dataset.glyph = o.glyphText || ''; return el; };
  window.google = window.google || {};
  const ns = window.google.maps = window.google.maps || {};
  Object.assign(ns, { Map, InfoWindow, Polyline, LatLngBounds, RenderingType: { VECTOR: 'VECTOR', RASTER: 'RASTER' }, event: { removeListener() {} } });
  ns.importLibrary = async (name) => name === 'marker' ? { AdvancedMarkerElement, PinElement: PinFactory } : ns;
  if (typeof ns.__ib__ === 'function') ns.__ib__();
})();`;

let server;
let baseUrl;
let upstream;
let browser;
const savedEnv = { ...process.env };

before(async () => {
  Object.assign(process.env, { DEEPSEEK_API_KEY: 'e2e-deepseek', GOOGLE_MAPS_API_KEY: 'e2e-google', SERVE_CLIENT: 'true' });
  resetGoogleClient();
  // transitMaxKm：城际距离没有公共交通数据（与日本的真实情况一致），城市间交通画示意线。
  upstream = createMockUpstream({ llmDelayMs: 120, transitMaxKm: 50 }).install();
  const app = createApp({ config: getConfig(), clientDist });
  server = await new Promise((resolveServer) => {
    const instance = app.listen(0, '127.0.0.1', () => resolveServer(instance));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browserChannel = String(process.env.E2E_BROWSER_CHANNEL || '').trim();
  const browserPath = String(process.env.E2E_BROWSER_PATH || '').trim();
  browser = await chromium.launch({
    ...(browserChannel ? { channel: browserChannel } : {}),
    ...(browserPath ? { executablePath: browserPath } : {}),
  });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise(resolveClose => (server ? server.close(resolveClose) : resolveClose()));
  upstream?.restore();
  process.env = savedEnv;
});

async function openPage({ viewport = { width: 1440, height: 900 }, isMobile = false, mapsAvailable = true } = {}) {
  const context = await browser.newContext({ viewport, isMobile, hasTouch: isMobile, deviceScaleFactor: 1, locale: 'zh-CN' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  await page.route('https://maps.googleapis.com/maps/api/js**', route => (mapsAvailable
    ? route.fulfill({ status: 200, contentType: 'application/javascript', body: MAPS_STUB })
    : route.abort()));
  await page.goto(baseUrl);
  return { page, context, errors };
}

async function shot(page, name) {
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `${name}.png`), fullPage: false });
}

async function generate(page, text) {
  await page.locator('#trip-query').fill(text);
  await page.getByRole('button', { name: /生成行程|重新生成/ }).click();
}

const activeMarkers = page => page.evaluate(() => window.__mapStub.markers.filter(marker => marker.map).length);
const activePolylines = page => page.evaluate(() => window.__mapStub.polylines.filter(line => line.active).length);

test('桌面端：示例 → 实时进度 → 行程、地图、历史、按天筛选、地点联动', async () => {
  const { page, context, errors } = await openPage();
  try {
    await page.getByRole('heading', { name: '想去哪里？' }).waitFor();
    await shot(page, '01-home-desktop');

    await page.getByRole('button', { name: '京都 · 3 天' }).click();
    assert.match(await page.locator('#trip-query').inputValue(), /京都玩三天/);
    await page.getByRole('button', { name: '生成行程' }).click();

    // 进度：步骤条出现并能看到阶段文字。
    await page.locator('.progress-card').waitFor();
    await shot(page, '02-progress');
    await page.locator('.plan-head h2').waitFor({ timeout: 15000 });

    assert.equal(await page.locator('.plan-head h2').textContent(), '京都3日游');
    assert.equal(await page.locator('article.day:visible').count(), 3);
    assert.equal(await page.locator('.timeline .stop').count(), 15);
    assert.ok(await page.locator('.timeline .leg').count() >= 12, '每天的地点之间应有交通段');
    assert.match(await page.locator('.quality').textContent(), /15\/15 个地点已在 Google 地图上核实/);
    // 人能直接照着走：每站有时间、费用；有出发前准备（预算 + 预订）。
    assert.equal(await page.locator('.stop-time').count(), 15);
    assert.equal(await page.locator('.stop-time').first().textContent(), '09:30');
    assert.match(await page.locator('.stop-facts').first().textContent(), /约 1\.5 小时 · 门票约 500 日元/);
    assert.match(await page.locator('.prep').textContent(), /人均约 ¥3,300（不含往返大交通）/);
    assert.match(await page.locator('.prep').textContent(), /预订清水寺旺季/);
    assert.match(await page.locator('.prep').textContent(), /四条河原町约 600-900 元\/晚/);
    assert.match(await page.locator('.prep').textContent(), /附近：京都河原町站/);
    assert.match(await page.locator('.facts').textContent(), /3 天/);
    assert.ok(await page.locator('.day-head a[href^="https://www.google.com/maps/dir/"]').count() === 3);
    await shot(page, '03-plan-desktop');

    // 地图：15 个地点 + 1 个住宿 + 交通站点；每天 4 段路程逐段绘制。
    assert.ok(await activeMarkers(page) >= 17);
    assert.equal(await activePolylines(page), 12);

    // 复制：剪贴板中是去掉 Markdown 标记、可直接粘贴的完整行程。
    await page.getByRole('button', { name: '复制行程文字' }).click();
    await page.getByRole('status').filter({ hasText: '已复制' }).waitFor();
    const copied = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n?/g, '\n');
    assert.match(copied, /^【京都3日游】/);
    assert.match(copied, /【第 3 天 · 京都第3天】/);
    assert.match(copied, /1\. 09:30 /);
    assert.ok(!copied.includes('**'));

    // 打印：只保留完整行程（隐藏地图、输入框和操作按钮）。
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.locator('.map-pane').isVisible(), false);
    assert.equal(await page.locator('.composer-wrap').isVisible(), false);
    assert.equal(await page.locator('article.day:visible').count(), 3);
    await page.emulateMedia({ media: 'screen' });

    // 按天筛选：只显示第 2 天。
    await page.getByRole('button', { name: '第 2 天' }).click();
    assert.equal(await page.locator('article.day:visible').count(), 1);
    assert.equal(await activePolylines(page), 4);
    await page.getByRole('button', { name: '全部' }).click();
    assert.equal(await page.locator('article.day:visible').count(), 3);

    // 点击行程中的地点 → 地图平移并打开信息窗口。
    await page.locator('button.stop-name').first().click();
    const opened = await page.evaluate(() => window.__mapStub.opened.at(-1));
    assert.match(opened, /第 1 天 · 1\./);
    assert.ok(await page.evaluate(() => window.__mapStub.panTo.length) > 0);

    // 历史：自动保存一条，抽屉可打开 / 关闭。
    await page.getByRole('button', { name: /历史行程，共 1 条/ }).click();
    await page.getByRole('dialog', { name: '历史行程' }).waitFor();
    assert.equal(await page.locator('.history-item').count(), 1);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);

    // 重新规划巴黎：凡尔赛宫保留并定位。
    await generate(page, '巴黎四天三夜，想看埃菲尔铁塔、卢浮宫、凡尔赛宫');
    await page.locator('.plan-head h2', { hasText: '巴黎' }).waitFor({ timeout: 15000 });
    assert.equal(await page.locator('article.day:visible').count(), 4);
    const versailles = page.locator('.stop', { hasText: '凡尔赛宫' }).first();
    assert.equal(await versailles.locator('.tag-warn').count(), 0, '凡尔赛宫不应显示“未定位”');

    // 从历史恢复京都行程。
    await page.getByRole('button', { name: /历史行程，共 2 条/ }).click();
    await page.locator('.history-item', { hasText: '京都' }).locator('.history-open').click();
    await page.locator('.plan-head h2', { hasText: '京都' }).waitFor();
    assert.equal(await page.locator('article.day:visible').count(), 3);
    assert.match(await page.locator('#trip-query').inputValue(), /京都/);

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

const markerCount = (page, className) => page.evaluate(name => window.__mapStub.markers
  .filter(marker => marker.map && marker.content?.classList?.contains(name)).length, className);

test('多城市：路线卡片、城市间交通、总览 / 城市 / 某一天三级地图', async () => {
  const { page, context, errors } = await openPage();
  try {
    await generate(page, '北海道五天，先札幌再去函馆，想看函馆山夜景');
    await page.locator('.plan-head h2', { hasText: '北海道' }).waitFor({ timeout: 15000 });

    // 路线卡片：札幌 → JR 特急北斗号 → 函馆。
    const routeCard = page.locator('.route-card');
    assert.match(await routeCard.textContent(), /札幌第 1–3 天.*JR 特急北斗号 · 约 3 小时 45 分钟.*第 4 天 · 每人约 9000 日元.*函馆第 4–5 天/);

    // 总览地图：两座城市 + 一条城市间交通（日本没有铁路数据 → 虚线示意）+ 方式标记，不画单个地点。
    assert.equal(await markerCount(page, 'city-pin'), 2);
    assert.equal(await markerCount(page, 'transfer-pin'), 1);
    const lines = await page.evaluate(() => window.__mapStub.polylines.filter(line => line.active)
      .map(line => ({ dashed: Boolean(line.options.icons), color: line.options.strokeColor })));
    assert.deepEqual(lines, [{ dashed: true, color: '#3c4043' }]);
    assert.equal(await page.locator('article.day:visible').count(), 5);

    // 换城市当天：两座车站之间是车次，而不是“打车参考”。
    const transferRow = page.locator('.transfer', { hasText: 'JR 特急北斗号' });
    assert.match(await transferRow.textContent(), /札幌 → 函馆火车JR 特急北斗号 · 约 3 小时 45 分钟 · 每人约 9000 日元08:00 札幌站 → 11:45 函馆站/);
    assert.match(await transferRow.textContent(), /地图上为示意直线/);
    assert.ok(!(await page.locator('article.day:visible').nth(3).textContent()).includes('打车'));
    await shot(page, '08-multi-city-overview');

    // 点城市：只看函馆两天的地点与路线；第二行可以再选某一天。
    await page.locator('.day-filter').getByRole('button', { name: /^函馆/ }).click();
    assert.equal(await page.locator('article.day:visible').count(), 2);
    assert.equal(await markerCount(page, 'city-pin'), 0);
    assert.ok(await activePolylines(page) >= 4);
    await page.locator('.day-filter').getByRole('button', { name: '第 4 天' }).click();
    assert.equal(await page.locator('article.day:visible').count(), 1);
    await shot(page, '09-multi-city-day');

    // 在地图上查看这段交通：回到总览并打开信息窗口。
    await transferRow.getByRole('button', { name: '在地图上查看' }).click();
    assert.equal(await page.locator('article.day:visible').count(), 5);
    assert.equal(await page.evaluate(() => window.__mapStub.opened.at(-1)), '札幌 → 函馆 · 火车');

    // 点地图上的城市标记：进入该城市。
    await page.evaluate(() => window.__mapStub.markers
      .find(marker => marker.map && marker.content?.classList?.contains('city-pin') && marker.content.textContent.includes('札幌'))
      .dispatchEvent(new Event('gmp-click')));
    assert.equal(await page.locator('article.day:visible').count(), 3);

    // 总览里点某个地点：自动切到该地点所在城市并在地图上打开。
    await page.locator('.day-filter').getByRole('button', { name: '总览' }).click();
    await page.locator('article.day:visible').nth(4).locator('button.stop-name').first().click();
    assert.equal(await page.locator('article.day:visible').count(), 2);
    assert.match(await page.evaluate(() => window.__mapStub.opened.at(-1)), /^第 5 天 · 1\./);

    // 复制的文字版包含城市间交通。
    await page.getByRole('button', { name: '复制行程文字' }).click();
    await page.getByRole('status').filter({ hasText: '已复制' }).waitFor();
    const copied = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n?/g, '\n');
    assert.match(copied, /【城市间交通】\n\n- 第 4 天 · 札幌 → 函馆：JR 特急北斗号/);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('返回输入页：“新行程”按钮、浏览器后退 / 前进、刷新后恢复行程', async () => {
  const { page, context, errors } = await openPage();
  try {
    await generate(page, '我想去京都玩三天，想去清水寺、伏见稻荷、岚山');
    await page.locator('.plan-head h2').waitFor({ timeout: 15000 });
    await page.waitForFunction(() => /[?&]trip=\d+/.test(window.location.search));
    const tripUrl = page.url();

    // 新行程：回到输入页，输入框清空并获得焦点。
    await page.getByRole('button', { name: '新行程' }).click();
    await page.getByRole('heading', { name: '想去哪里？' }).waitFor();
    assert.equal(await page.locator('#trip-query').inputValue(), '');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'trip-query');
    assert.equal(new URL(page.url()).search, '');
    assert.equal(await page.getByRole('button', { name: '新行程' }).count(), 0);

    // 浏览器后退：回到刚才的行程；前进：回到输入页。
    await page.goBack();
    await page.locator('.plan-head h2', { hasText: '京都' }).waitFor();
    assert.equal(page.url(), tripUrl);
    await page.goForward();
    await page.getByRole('heading', { name: '想去哪里？' }).waitFor();

    // 刷新：从本地历史恢复同一份行程。
    await page.goBack();
    await page.locator('.plan-head h2', { hasText: '京都' }).waitFor();
    await page.reload();
    await page.locator('.plan-head h2', { hasText: '京都' }).waitFor();
    assert.equal(await page.locator('article.day:visible').count(), 3);

    // 点标志同样回到输入页；不存在的行程编号直接回到输入页。
    await page.getByRole('link', { name: /AItour/ }).click();
    await page.getByRole('heading', { name: '想去哪里？' }).waitFor();
    await page.goto(`${baseUrl}/?trip=99999`);
    await page.getByRole('heading', { name: '想去哪里？' }).waitFor();
    assert.equal(new URL(page.url()).search, '');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('错误、澄清与取消', async () => {
  const { page, context, errors } = await openPage();
  try {
    // 澄清：信息不足。
    await generate(page, '帮我规划一个旅行');
    await page.locator('.alert-info').waitFor({ timeout: 15000 });
    assert.match(await page.locator('.alert-info').textContent(), /你想去哪个城市/);

    // 错误：接口限流 → 友好提示 + 重试按钮。
    await page.route('**/api/plan', route => route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({ error: '请求过于频繁，请稍后再试', code: 'RATE_LIMITED', retryable: true, request_id: 'req-12345678' }),
    }));
    await generate(page, '京都三天');
    await page.locator('.alert-error').waitFor();
    assert.match(await page.locator('.alert-error').textContent(), /请求过于频繁/);
    assert.match(await page.locator('.alert-error').textContent(), /req-1234/);
    await shot(page, '04-error');
    await page.unroute('**/api/plan');

    // 重试成功。
    await page.getByRole('button', { name: '重试' }).click();
    await page.locator('.plan-head h2').waitFor({ timeout: 15000 });

    // 取消：生成中点“停止”，回到上一次的行程且不报错。
    await page.route('**/api/plan', async (route) => {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 3000));
      await route.continue().catch(() => {});
    });
    await page.locator('#trip-query').fill('东京五天');
    await page.getByRole('button', { name: '重新生成' }).click();
    await page.locator('.progress-card').waitFor();
    await page.getByRole('button', { name: '停止' }).click();
    await page.locator('.plan-head h2', { hasText: '京都' }).waitFor();
    assert.equal(await page.locator('.alert-error').count(), 0);
    await page.unroute('**/api/plan');

    assert.deepEqual(errors.filter(item => !item.includes('429')), []);
  } finally {
    await context.close();
  }
});

test('移动端：无横向滚动，地图固定在顶部，行程可读', async () => {
  const { page, context, errors } = await openPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  try {
    await page.getByRole('heading', { name: '想去哪里？' }).waitFor();
    // 还没有行程时不显示空地图；触屏上不提示 Ctrl + Enter。
    assert.equal(await page.locator('.map-pane').isVisible(), false);
    assert.equal(await page.locator('.kbd-hint').isVisible(), false);
    await shot(page, '05-home-mobile');
    await generate(page, '东京五日游，带小孩，想去迪士尼、浅草寺、秋叶原、台场，预算中等');
    await page.locator('.plan-head h2').waitFor({ timeout: 20000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `页面不应横向滚动（溢出 ${overflow}px）`);
    assert.ok(await page.locator('.stop', { hasText: '东京迪士尼乐园' }).count() > 0);
    assert.ok(await page.locator('.map-pane').isVisible());
    assert.ok(await page.getByRole('button', { name: '新行程' }).isVisible());
    await page.mouse.wheel(0, 900);
    const mapBox = await page.locator('.map-pane').boundingBox();
    assert.ok(mapBox && mapBox.y >= 0 && mapBox.y < 120, '滚动后地图仍固定在顶部');
    await shot(page, '06-plan-mobile');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('地图脚本无法加载时降级：显示提示，行程照常可用', async () => {
  const { page, context, errors } = await openPage({ mapsAvailable: false });
  try {
    await page.locator('.map-fallback').waitFor();
    assert.match(await page.locator('.map-fallback').textContent(), /地图暂不可用/);
    await generate(page, '京都三天');
    await page.locator('.plan-head h2').waitFor({ timeout: 15000 });
    assert.equal(await page.locator('article.day:visible').count(), 3);
    await shot(page, '07-map-unavailable');
    assert.deepEqual(errors.filter(item => !/maps\.googleapis|Failed to load resource|could not load/i.test(item)), []);
  } finally {
    await context.close();
  }
});
