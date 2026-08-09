import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearFormDraft,
  emptyFormDraft,
  FORM_DRAFT_STORAGE_KEY,
  loadFormDraft,
  saveFormDraft,
} from '../src/services/formDraft.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
    values,
  };
}

test('完整表单草稿可以保存并恢复嵌套偏好', () => {
  const storage = memoryStorage();
  const draft = {
    query: '京都三日游',
    profile: {
      days: 3,
      startDate: '2026-10-03',
      budget: { level: 'moderate', amount: 3000, currency: 'CNY', basis: 'total', hardLimit: true },
      transport: {
        priority: 'time', allowedModes: ['TRANSIT'], avoidModes: ['DRIVE'],
        transitPreferences: { allowedModes: ['SUBWAY', 'TRAIN'], routingPreference: 'FEWER_TRANSFERS' },
        distancePolicy: { walkMaxKm: 0.8, localTransitMaxKm: 25, flightMinKm: 700 },
      },
      travelers: { adults: 2, children: 1, seniors: 0 },
      notes: '需要安静房间',
    },
  };

  assert.equal(saveFormDraft(draft, storage), true);
  const restored = loadFormDraft(storage);
  assert.equal(restored.query, draft.query);
  assert.equal(restored.profile.startDate, '2026-10-03');
  assert.deepEqual(restored.profile.budget, draft.profile.budget);
  assert.deepEqual(restored.profile.transport, draft.profile.transport);
  assert.deepEqual(restored.profile.travelers, draft.profile.travelers);
  assert.equal(restored.profile.notes, draft.profile.notes);
});

test('缺字段草稿会补齐当前默认结构', () => {
  const storage = memoryStorage();
  storage.setItem(FORM_DRAFT_STORAGE_KEY, JSON.stringify({
    version: 1,
    draft: { query: '上海一日游', profile: { days: 1 } },
  }));

  const restored = loadFormDraft(storage);
  assert.equal(restored.profile.days, 1);
  assert.equal(restored.profile.budget.currency, 'CNY');
  assert.ok(restored.profile.transport.allowedModes.includes('RAIL'));
  assert.deepEqual(restored.profile.transport.transitPreferences.allowedModes, ['BUS', 'SUBWAY', 'TRAIN', 'LIGHT_RAIL', 'RAIL']);
  assert.deepEqual(restored.profile.transport.distancePolicy, {
    walkMaxKm: 1, localTransitMaxKm: 30, flightMinKm: 800,
  });
});

test('字段类型损坏的草稿不会让表单渲染崩溃', () => {
  const storage = memoryStorage();
  storage.setItem(FORM_DRAFT_STORAGE_KEY, JSON.stringify({
    version: 1,
    draft: {
      query: '测试异常数据',
      profile: {
        transport: { allowedModes: {}, avoidModes: 'DRIVE' },
        interests: { invalid: true },
      },
    },
  }));

  const restored = loadFormDraft(storage);
  assert.deepEqual(restored.profile.transport.allowedModes, ['WALK', 'TRANSIT', 'RAIL']);
  assert.deepEqual(restored.profile.transport.avoidModes, []);
  assert.deepEqual(restored.profile.interests, []);
  assert.doesNotThrow(() => restored.profile.transport.allowedModes.includes('WALK'));
  assert.doesNotThrow(() => restored.profile.transport.avoidModes.filter(Boolean));
});

test('异常的公交子方式和距离阈值会安全规范化', () => {
  const storage = memoryStorage();
  storage.setItem(FORM_DRAFT_STORAGE_KEY, JSON.stringify({
    version: 1,
    draft: {
      profile: {
        transport: {
          transitPreferences: {
            allowedModes: ['subway', 'TRAIN', 'TELEPORT', 'SUBWAY'],
            routingPreference: 'INVALID',
          },
          distancePolicy: { walkMaxKm: -1, localTransitMaxKm: '20', flightMinKm: 'bad' },
        },
      },
    },
  }));
  const restored = loadFormDraft(storage);
  assert.deepEqual(restored.profile.transport.transitPreferences, {
    allowedModes: ['SUBWAY', 'TRAIN'], routingPreference: '',
  });
  assert.deepEqual(restored.profile.transport.distancePolicy, {
    walkMaxKm: 0, localTransitMaxKm: 20, flightMinKm: 800,
  });
});

test('损坏或不可用的存储会安全回退为空表单', () => {
  const corrupt = memoryStorage();
  corrupt.setItem(FORM_DRAFT_STORAGE_KEY, '{not-json');
  assert.deepEqual(loadFormDraft(corrupt), emptyFormDraft());

  const unavailable = { getItem() { throw new Error('blocked'); } };
  assert.deepEqual(loadFormDraft(unavailable), emptyFormDraft());
  assert.equal(saveFormDraft({ query: 'test' }, { setItem() { throw new Error('full'); } }), false);
});

test('清空只删除表单草稿键，不影响其它本地数据', () => {
  const storage = memoryStorage();
  storage.setItem('other-key', 'keep');
  saveFormDraft({ query: '巴黎', profile: { days: 2 } }, storage);

  assert.equal(clearFormDraft(storage), true);
  assert.equal(storage.getItem(FORM_DRAFT_STORAGE_KEY), null);
  assert.equal(storage.getItem('other-key'), 'keep');
  assert.deepEqual(loadFormDraft(storage), emptyFormDraft());
});

test('空表单不会留下无意义的持久化记录', () => {
  const storage = memoryStorage();
  assert.equal(saveFormDraft(emptyFormDraft(), storage), true);
  assert.equal(storage.getItem(FORM_DRAFT_STORAGE_KEY), null);
});
