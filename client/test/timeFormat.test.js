import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSegmentTime, formatTimeValue } from '../src/services/timeFormat.js';

test('RFC3339 UTC 时间会按指定时区转换而不是截取字符串', () => {
  const formatted = formatTimeValue('2026-10-02T00:10:00Z', {
    timeZone: 'Asia/Tokyo',
    locale: 'en-GB',
  });
  assert.match(formatted, /^09:10/);
  assert.doesNotMatch(formatted, /^00:10/);
  assert.match(formatted, /(GMT\+9|JST)/);
});

test('分段优先显示后端的本地化时间并标注时区', () => {
  const formatted = formatSegmentTime({
    departure_time: '2026-10-02T00:10:00Z',
    time_zone: 'Asia/Tokyo',
    localized_values: {
      departure_time: { text: '上午 9:10', time_zone: 'Asia/Tokyo' },
    },
  }, 'departure_time');
  assert.equal(formatted, '上午 9:10 · Asia/Tokyo');
});

test('优先读取后端真实 localized_departure_time 形状', () => {
  const formatted = formatSegmentTime({
    departure_time: '2026-10-02T00:10:00Z',
    localized_departure_time: { time: { text: '上午9:10' }, timeZone: 'Asia/Tokyo' },
    localized_values: {
      transit: { departureTime: { time: { text: '上午9:11' }, timeZone: 'Asia/Tokyo' } },
    },
  }, 'departure_time');
  assert.equal(formatted, '上午9:10 · Asia/Tokyo');
});

test('直接本地化字段缺失时读取 localized_values.transit.arrivalTime', () => {
  const formatted = formatSegmentTime({
    arrival_time: '2026-10-02T02:10:00Z',
    localized_values: {
      transit: { arrivalTime: { time: { text: '上午11:10' }, timeZone: 'Asia/Tokyo' } },
    },
  }, 'arrival_time');
  assert.equal(formatted, '上午11:10 · Asia/Tokyo');
});

test('无时区的纯时刻保持墙上时间语义', () => {
  assert.equal(formatTimeValue('09:30'), '09:30');
  assert.equal(formatTimeValue('2026-10-02T09:30:00', { timeZone: 'Asia/Tokyo' }), '09:30 · Asia/Tokyo');
});
