import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../config.js';

test('生产环境不会把 Google 服务端 Key 当作浏览器 Key 下发', () => {
  const config = getConfig({ NODE_ENV: 'production', GOOGLE_MAPS_API_KEY: 'server-only-key' });
  assert.equal(config.google.apiKey, 'server-only-key');
  assert.equal(config.google.browserKey, '');
});

test('生产环境只使用显式配置的浏览器 Key', () => {
  const config = getConfig({
    NODE_ENV: 'production',
    GOOGLE_MAPS_API_KEY: 'server-only-key',
    GOOGLE_MAPS_BROWSER_KEY: 'browser-restricted-key',
  });
  assert.equal(config.google.browserKey, 'browser-restricted-key');
});

test('开发环境仍可临时共用 Google Key', () => {
  const config = getConfig({ NODE_ENV: 'development', GOOGLE_MAPS_API_KEY: 'local-key' });
  assert.equal(config.google.browserKey, 'local-key');
});
