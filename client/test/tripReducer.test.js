import test from 'node:test';
import assert from 'node:assert/strict';
import { initialTripState, tripReducer } from '../src/services/tripReducer.js';

function snapshot(id, day = 1) {
  return { id, plan: { daily_plans: [{ day }] } };
}

test('开始生成和生成失败都不会清空当前可用计划', () => {
  const current = snapshot('current');
  let state = { ...initialTripState, committed: current };
  state = tripReducer(state, { type: 'GENERATE_START', requestId: 1 });
  assert.equal(state.committed, current);
  state = tripReducer(state, { type: 'GENERATE_ERROR', requestId: 1, error: '网络失败' });
  assert.equal(state.committed, current);
  assert.equal(state.error, '网络失败');
});
test('较早请求的迟到结果不会覆盖较新的请求', () => {
  let state = tripReducer(initialTripState, { type: 'GENERATE_START', requestId: 2 });
  state = tripReducer(state, { type: 'COMMIT', requestId: 1, snapshot: snapshot('stale') });
  assert.equal(state.committed, null);
  state = tripReducer(state, { type: 'COMMIT', requestId: 2, snapshot: snapshot('fresh') });
  assert.equal(state.committed.id, 'fresh');
});

test('编辑提交后可以撤销和重做完整快照', () => {
  const original = snapshot('original');
  let state = { ...initialTripState, committed: original };
  state = tripReducer(state, { type: 'EDIT_START', requestId: 3 });
  state = tripReducer(state, { type: 'EDIT_COMMIT', requestId: 3, snapshot: snapshot('edited') });
  assert.equal(state.committed.id, 'edited');
  state = tripReducer(state, { type: 'UNDO' });
  assert.equal(state.committed.id, 'original');
  state = tripReducer(state, { type: 'REDO' });
  assert.equal(state.committed.id, 'edited');
});
