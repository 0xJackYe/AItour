import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampSplitPercent,
  DEFAULT_SPLIT_PERCENT,
  splitPaneBounds,
  splitPercentFromKey,
  splitPercentFromPointer,
} from '../src/services/splitPane.js';

test('宽屏分栏保持双方最小宽度并限制在合理比例', () => {
  const bounds = splitPaneBounds(1440);
  assert.equal(bounds.min, 30);
  assert.equal(bounds.max, 70);
  assert.equal(clampSplitPercent(5, 1440), 30);
  assert.equal(clampSplitPercent(95, 1440), 70);
});

test('窄桌面根据像素下限自动收紧拖动范围', () => {
  const bounds = splitPaneBounds(769);
  assert.ok(bounds.min > 46);
  assert.ok(bounds.max < 52);
  assert.ok(bounds.min < bounds.max);
});

test('指针位置会转换为受边界约束的左栏比例', () => {
  assert.equal(splitPercentFromPointer(600, 100, 1000), 50);
  assert.equal(splitPercentFromPointer(-100, 100, 1000), 36);
  assert.equal(splitPercentFromPointer(2000, 100, 1000), 63);
});

test('键盘支持微调、加速和边界跳转', () => {
  assert.equal(splitPercentFromKey(DEFAULT_SPLIT_PERCENT, 'ArrowRight', 1440), 46);
  assert.equal(splitPercentFromKey(DEFAULT_SPLIT_PERCENT, 'ArrowLeft', 1440, { shiftKey: true }), 38);
  assert.equal(splitPercentFromKey(DEFAULT_SPLIT_PERCENT, 'Home', 1440), 30);
  assert.equal(splitPercentFromKey(DEFAULT_SPLIT_PERCENT, 'End', 1440), 70);
  assert.equal(splitPercentFromKey(DEFAULT_SPLIT_PERCENT, 'Escape', 1440), DEFAULT_SPLIT_PERCENT);
});
