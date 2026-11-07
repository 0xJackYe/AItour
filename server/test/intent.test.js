import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDays, analyzeQuery, detectTransportPreference, parseChineseNumber } from '../services/intent.js';

test('中文数字解析', () => {
  assert.equal(parseChineseNumber('三'), 3);
  assert.equal(parseChineseNumber('十'), 10);
  assert.equal(parseChineseNumber('十二'), 12);
  assert.equal(parseChineseNumber('二十八'), 28);
  assert.equal(parseChineseNumber('两'), 2);
  assert.equal(parseChineseNumber('１４'), 14);
  assert.equal(parseChineseNumber('abc'), null);
});

// 前端示例与常见说法：旧版只识别阿拉伯数字，以下大部分都会解析失败。
const HIGH_CONFIDENCE = [
  ['我想去京都玩三天，想去清水寺、伏见稻荷、岚山', 3],
  ['东京五日游，带小孩，想去迪士尼、浅草寺', 5],
  ['巴黎四天三夜，想看埃菲尔铁塔', 4],
  ['成都三天美食之旅', 3],
  ['日本两周深度游', 14],
  ['欧洲一个月', 30],
  ['半个月的新疆自驾', 15],
  ['住三晚', 4],
  ['a 5-day trip to Rome', 5],
  ['one week in Japan', 7],
  ['十二天的环岛游', 12],
  ['总时长28天，预算中等', 28],
  ['前三天在东京，后四天在大阪', 7],
  ['我有七天，前三天在东京', 7],
  ['玩五天，一天两个景点就够', 5],
  ['10月1日出发，玩5天', 5],
  ['第二天想去奈良，一共四天', 4],
  ['去日本玩六天，预算1万日元', 6],
  ['两周，也就是14天', 14],
  ['三天半', 4],
  ['周末去杭州', 2],
  ['京都一日游', 1],
];

for (const [query, expected] of HIGH_CONFIDENCE) {
  test(`确定天数：${query}`, () => {
    const intent = analyzeQuery(query);
    assert.equal(intent.days, expected);
    assert.equal(intent.dayConfidence, 'high');
  });
}

test('含糊表述只作参考，不作为硬约束', () => {
  for (const query of ['两三天', '3-5天', '十天半个月都行', '东京三天，大阪两天']) {
    const intent = analyzeQuery(query);
    assert.equal(intent.days, null, query);
    assert.equal(intent.dayConfidence, 'low', query);
    assert.ok(intent.approxDays > 0, query);
  }
});

test('“东京三天，大阪两天”按总和选择生成策略', () => {
  assert.equal(analyzeDays('东京三天，大阪两天').strategyDays, 5);
});

test('没有天数信息时返回 null', () => {
  assert.equal(analyzeQuery('想去日本看樱花').days, null);
  assert.equal(analyzeQuery('想去日本看樱花').dayConfidence, 'none');
});

test('识别自驾与步行偏好', () => {
  assert.equal(detectTransportPreference('新疆自驾十天'), 'drive');
  assert.equal(detectTransportPreference('road trip in California'), 'drive');
  assert.equal(detectTransportPreference('上海 citywalk 两天'), 'walk');
  assert.equal(detectTransportPreference('东京三天，坐地铁'), null);
});
