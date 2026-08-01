import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPlan } from '../services/verify.js';

test('AI 审核不可用时 fail-closed 为 unknown，不伪称已通过', async () => {
  const previous = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const result = await verifyPlan('京都三天', { daily_plans: [] });
    assert.equal(result.status, 'unknown');
    assert.equal(result.passed, false);
    assert.equal(result.skipped, true);
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  }
});
