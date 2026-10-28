import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { DailyAnalysisBudget } from '../src/services/analysisBudget.js';

const input = { interests: [
  { id: 'flutter', title: 'Flutter', logs: ['직접 앱 만드는 게 재밌다'] },
  { id: 'game', title: '게임 개발', logs: ['시스템 만드는 게 재밌다'] },
] };

test('concurrent HTTP requests cannot exceed the daily provider budget; invalid requests and health use none', async () => {
  let calls = 0;
  const app = await buildApp(loadConfig({}), { async analyze() { calls++; return '{"relations":[]}'; } });
  try {
    assert.equal((await app.inject('/health')).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/analyze-relations', payload: {} })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/analyze-relations', payload: { interests: [input.interests[0]] } })).statusCode, 200);
    const responses = await Promise.all(Array.from({ length: 7 }, () => app.inject({ method: 'POST', url: '/analyze-relations', payload: input })));
    assert.equal(calls, 5);
    assert.equal(responses.filter((response) => response.statusCode === 200).length, 5);
    for (const rejected of responses.filter((response) => response.statusCode !== 200)) {
      assert.equal(rejected.statusCode, 429);
      assert.equal(rejected.json().error.code, 'DAILY_ANALYSIS_LIMIT');
      assert.ok(Number(rejected.headers['retry-after']) > 0);
    }
  } finally { await app.close(); }
});

test('failed provider calls consume attempts and are never converted to successful empty results', async () => {
  let calls = 0;
  const app = await buildApp(loadConfig({ AI_DAILY_LIMIT: '2' }), { async analyze() {
    calls++; throw new AppError(502, 'LLM_API_ERROR', '테스트 공급자 오류');
  } });
  try {
    for (const expected of [502, 502, 429]) {
      const response = await app.inject({ method: 'POST', url: '/analyze-relations', payload: input });
      assert.equal(response.statusCode, expected);
      assert.ok(!('relations' in response.json()));
    }
    assert.equal(calls, 2);
  } finally { await app.close(); }
});

test('budget survives a restart and resets at Korean midnight', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jangjak-quota-'));
  const file = join(directory, 'usage.json');
  let now = new Date('2026-10-26T14:59:59Z');
  try {
    await new DailyAnalysisBudget(1, file, () => now).reserve();
    const restarted = new DailyAnalysisBudget(1, file, () => now);
    await assert.rejects(restarted.reserve(), (error) => error instanceof AppError && error.code === 'DAILY_ANALYSIS_LIMIT' && error.retryAfterSeconds === 1);
    now = new Date('2026-10-26T15:00:00Z');
    await restarted.reserve();
    await assert.rejects(new DailyAnalysisBudget(1, file, () => now).reserve(), AppError);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unreadable or corrupt durable budgets fail closed before the provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jangjak-broken-quota-'));
  try {
    const file = join(directory, 'usage.json');
    await writeFile(file, 'broken');
    let calls = 0;
    const app = await buildApp(loadConfig({}), { async analyze() { calls++; return '{"relations":[]}'; } }, false, new DailyAnalysisBudget(5, file));
    try {
      const response = await app.inject({ method: 'POST', url: '/analyze-relations', payload: input });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, 'ANALYSIS_BUDGET_UNAVAILABLE');
      assert.equal(calls, 0);
    } finally { await app.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
