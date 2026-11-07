import test from 'node:test';
import assert from 'node:assert/strict';
import { applySchedules, scheduleDay, toClock, toMinutes } from '../services/schedule.js';

const stop = (id, start_time, duration_hours = 1, extra = {}) => ({ location_id: id, name: id, start_time, duration_hours, ...extra });

test('时间格式互转', () => {
  assert.equal(toMinutes('09:30'), 570);
  assert.equal(toMinutes('9:30'), null);
  assert.equal(toClock(570), '09:30');
  assert.equal(toClock(573), '09:35', '取整到 5 分钟');
  assert.equal(toClock(30 * 60), '23:55', '不超过当天');
});

test('模型给出的时间完整且递增时原样保留', () => {
  const result = scheduleDay([stop('a', '08:00', 1), stop('b', '12:00', 1), stop('c', '19:30', 2)]);
  assert.deepEqual(result.spots.map(spot => spot.start_time), ['08:00', '12:00', '19:30']);
  assert.equal(result.rebuilt, false);
});

test('时间缺失或乱序时按停留时长和路上时间重新推算', () => {
  const missing = scheduleDay([stop('a', '10:00', 2), stop('b', null, 1), stop('c', null, 1)]);
  assert.deepEqual(missing.spots.map(spot => spot.start_time), ['10:00', '12:25', '13:50']);
  assert.equal(missing.rebuilt, true);

  const unordered = scheduleDay([stop('a', '14:00', 1), stop('b', '09:00', 1)], { pace: 'relaxed' });
  assert.deepEqual(unordered.spots.map(spot => spot.start_time), ['14:00', '15:25']);

  const none = scheduleDay([stop('a', null, 1), stop('b', null, 1)], { pace: 'relaxed' });
  assert.equal(none.spots[0].start_time, '09:30', '按节奏决定出发时间');
});

test('有真实路程时，来不及赶到就整体顺延；有余量则不动', () => {
  const legs = new Map([
    ['a', { from_id: 'a', to_id: 'b', duration_seconds: 60 * 60 }],
    ['b', { from_id: 'b', to_id: 'c', duration_seconds: 10 * 60 }],
  ]);
  const result = scheduleDay([stop('a', '09:00', 1), stop('b', '10:15', 1), stop('c', '13:00', 1)], { legs });
  assert.deepEqual(result.spots.map(spot => spot.start_time), ['09:00', '11:00', '13:00']);
  assert.equal(result.shifted, 1);
});

test('结束太晚会给出提示', () => {
  const plan = { preferences: { pace: 'moderate' }, daily_plans: [{ day: 1, spots: [stop('a', '20:00', 2), stop('b', '22:30', 1.5)] }] };
  const { warnings } = applySchedules(plan, []);
  assert.match(warnings[0], /Day 1 预计 00:00|Day 1 预计 23:55|安排偏满/);
});
