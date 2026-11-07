import test from 'node:test';
import assert from 'node:assert/strict';
import { describeBudget, formatMoney } from '../src/lib/format.js';
import { markdownToPlainText, planToMarkdown } from '../src/lib/markdown.js';
import { isGroundingAvailable, numberStops, summarizeQuality } from '../src/lib/plan.js';

const RESULT = {
  plan: {
    title: '京都三日慢游',
    summary: '轻松游览清水寺与岚山',
    city: '京都',
    days: 1,
    preferences: { pace: 'relaxed', budget: 'moderate', interests: ['文化'] },
    destinations: [{ city: '京都', start_day: 1, end_day: 1 }],
    accommodations: [{ city: '京都', area: '四条乌丸', reason: '地铁枢纽', price_hint: '约 600-900 元/晚' }],
    budget_estimate: { currency: 'CNY', per_person: 3000, excludes: '往返大交通', breakdown: [{ item: '住宿', amount: 1800 }, { item: '餐饮', amount: 1200 }] },
    booking_tips: ['岚山小火车提前一个月购票'],
    daily_plans: [{
      day: 1,
      city: '京都',
      theme: '东山古寺',
      spots: [
        { name: '清水寺', type: 'attraction', start_time: '09:30', duration_hours: 2, cost: '门票约 400 日元', description: '清水舞台俯瞰京都', tips: '早到人少', coordinates: null, location_id: 'a' },
        { name: '奥丹清水', type: 'restaurant', start_time: '12:00', duration_hours: 1, cost: '人均约 3500 日元', coordinates: null, location_id: 'b' },
      ],
      transport_notes: '公交到清水道',
    }],
    practical_tips: ['带现金'],
  },
  routes: [],
  transitMarkers: [],
  verification: { passed: true },
  geocodingWarnings: [{ name: '地图服务', reason: '未配置', code: 'maps_unavailable' }],
  quality: { grounding_available: false },
};

test('金额与预算格式化', () => {
  assert.equal(formatMoney(4500), '¥4,500');
  assert.equal(formatMoney(120, 'EUR'), '€120');
  assert.equal(formatMoney(5000, 'JPY'), '5,000 JPY');
  const budget = describeBudget(RESULT.plan.budget_estimate);
  assert.equal(budget.total, '人均约 ¥3,000');
  assert.equal(budget.note, '不含往返大交通');
  assert.deepEqual(budget.items, ['住宿 ¥1,800', '餐饮 ¥1,200']);
  assert.equal(describeBudget(null), null);
});

test('未启用地图校验时：不逐条标“未定位”，按顺序编号，结论写明未启用', () => {
  assert.equal(isGroundingAvailable(RESULT), false);
  assert.deepEqual(numberStops(RESULT.plan.daily_plans[0].spots, 1, { numberAll: true }).map(item => item.order), [1, 2]);
  assert.match(summarizeQuality(RESULT).headline, /地图校验未启用/);
  const markdown = planToMarkdown(RESULT);
  assert.ok(!markdown.includes('地图上未能核实'));
});

test('可读文档包含时间、费用、预算、预订和住宿价格', () => {
  const markdown = planToMarkdown(RESULT);
  assert.match(markdown, /^# 京都三日慢游/);
  assert.match(markdown, /1\. 09:30 \*\*清水寺\*\*（景点 · 约 2 小时 · 门票约 400 日元）/);
  assert.match(markdown, /2\. 12:00 \*\*奥丹清水\*\*（餐饮 · 约 1 小时 · 人均约 3500 日元）/);
  assert.match(markdown, /- 预算：人均约 ¥3,000（不含往返大交通）/);
  assert.match(markdown, /- 预订：岚山小火车提前一个月购票/);
  assert.match(markdown, /四条乌丸\*\*（约 600-900 元\/晚）/);
  assert.ok(!markdown.includes('[object Object]'));
});

test('地图校验启用时，未能核实的地点会被标出', () => {
  const grounded = { ...RESULT, geocodingWarnings: [], quality: { grounding_available: true } };
  assert.match(planToMarkdown(grounded), /清水寺\*\*（[^）]+）（地图上未能核实）/);
});

test('纯文本导出去掉 Markdown 标记', () => {
  const plain = markdownToPlainText(planToMarkdown(RESULT));
  assert.match(plain, /^【京都三日慢游】/);
  assert.match(plain, /【第 1 天 · 东山古寺】/);
  assert.ok(!plain.includes('**'));
  assert.ok(!/^#/m.test(plain));
});
