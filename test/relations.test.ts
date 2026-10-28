import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { analyzeRequestSchema, calculateScore, validateAndScore } from '../src/schemas/relation.js';

const input = {
  interests: [
    { id: 'flutter', title: 'Flutter', logs: ['직접 앱 만드는 게 재밌다', '화면이 바로 보이는 게 좋다'] },
    { id: 'game', title: '게임 개발', logs: ['시스템 만드는 게 재밌다', '사람이 직접 플레이하는 결과물이 좋다'] },
  ],
};
const relation = {
  source: 'flutter', target: 'game',
  basis: 'shared_logs',
  scores: { topic: 40, motivation: 95, behavior: 80, temporal: 60 },
  type: 'motivation', summary: '결과물을 직접 만드는 즐거움이 공통됩니다.',
  evidence: ['직접 앱 만드는 게 재밌다', '시스템 만드는 게 재밌다'],
  suggestion: 'Flutter로 작은 게임 도구를 만들어보세요.',
};
const asRaw = (relations: unknown[] = [relation]) => JSON.stringify({ relations });

test('weighted score is 0.75; missing dates force temporal=0 and score=0.66', () => {
  assert.equal(calculateScore(relation.scores), 0.75);
  const result = validateAndScore(asRaw(), input);
  assert.equal(result.relations[0]?.score, 0.66);
  assert.ok(!('scores' in result.relations[0]!));
});

test('timestamps enable temporal scores and directed transitions', () => {
  const dated = structuredClone(input);
  const request = {
    interests: dated.interests.map((interest, index) => ({
      ...interest,
      logs: interest.logs.map((text) => ({ text, createdAt: `2026-10-${25 + index}T10:00:00+09:00` })),
    })),
  };
  assert.equal(validateAndScore(asRaw(), request).relations[0]?.score, 0.75);
  assert.equal(validateAndScore(asRaw([{ ...relation, type: 'transition' }]), request).relations[0]?.type, 'transition');
  assert.throws(() => validateAndScore(asRaw([{ ...relation, source: 'game', target: 'flutter', type: 'transition' }]), request), AppError);
  assert.throws(() => validateAndScore(asRaw([{ ...relation, type: 'transition' }]), input), AppError);
});

test('weak relations and single-interest requests return empty results', async () => {
  assert.deepEqual(validateAndScore(asRaw([{ ...relation, scores: { topic: 100, motivation: 0, behavior: 0, temporal: 0 } }]), input), { relations: [] });
  let calls = 0;
  const app = await buildApp(loadConfig({}), { async analyze() { calls++; return asRaw(); } });
  try {
    const res = await app.inject({ method: 'POST', url: '/analyze-relations', payload: { interests: [input.interests[0]] } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { relations: [] });
    assert.equal(calls, 0);
  } finally { await app.close(); }
});

test('threshold uses unrounded score; retained relations are sorted', () => {
  const thresholdRelation = { ...relation, scores: { topic: 0, motivation: 100, behavior: 79.999, temporal: 0 } };
  assert.deepEqual(validateAndScore(asRaw([thresholdRelation]), input), { relations: [] });
  const threeInterests = {
    interests: [...input.interests, { id: 'tools', title: '도구', logs: ['사람을 위한 도구를 만든다'] }],
  };
  const stronger = { ...relation, target: 'tools', evidence: [relation.evidence[0], '사람을 위한 도구를 만든다'], scores: { topic: 100, motivation: 100, behavior: 100, temporal: 100 } };
  const results = validateAndScore(asRaw([relation, stronger]), threeInterests).relations;
  assert.deepEqual(results.map((entry) => entry.target), ['tools', 'game']);
  assert.deepEqual(validateAndScore(asRaw([]), input), { relations: [] });
});

for (const [name, raw] of [
  ['non-JSON', '```json\n{}\n```'],
  ['missing field', JSON.stringify({ relations: [{}] })],
  ['unknown id', asRaw([{ ...relation, target: 'missing' }])],
  ['self relation', asRaw([{ ...relation, target: 'flutter' }])],
  ['out-of-range score', asRaw([{ ...relation, scores: { ...relation.scores, motivation: 101 } }])],
  ['string score', asRaw([{ ...relation, scores: { ...relation.scores, topic: '40' } }])],
  ['unknown type', asRaw([{ ...relation, type: 'guess' }])],
  ['invented evidence', asRaw([{ ...relation, evidence: [relation.evidence[0], '없는 기록'] }])],
  ['one-sided evidence', asRaw([{ ...relation, evidence: input.interests[0]!.logs }])],
  ['duplicate evidence', asRaw([{ ...relation, evidence: [relation.evidence[0], relation.evidence[1], relation.evidence[0]] }])],
  ['extra final score', asRaw([{ ...relation, score: 0.99 }])],
  ['duplicate reversed pair', asRaw([relation, { ...relation, source: 'game', target: 'flutter' }])],
] as const) {
  test(`rejects LLM output: ${name}`, () => {
    assert.throws(() => validateAndScore(raw, input), (error) => error instanceof AppError && error.code === 'INVALID_LLM_RESPONSE');
  });
}

test('HTTP errors have a consistent envelope and invalid requests never call LLM', async () => {
  let calls = 0;
  const app = await buildApp(loadConfig({}), { async analyze() { calls++; return asRaw(); } });
  try {
    const cases = [
      {}, { interests: [] },
      { interests: [input.interests[0], input.interests[0]] },
      { interests: [{ ...input.interests[0], logs: [] }] },
      { interests: [{ ...input.interests[0], logs: ['   '] }] },
      { interests: [{ ...input.interests[0], logs: [{ text: '기록', createdAt: '어제' }] }] },
      { interests: [{ ...input.interests[0], logs: [{ text: '기록', createdAt: '2026-10-26T10:00:00' }] }] },
      { interests: input.interests, unexpected: true },
    ];
    for (const payload of cases) {
      const res = await app.inject({ method: 'POST', url: '/analyze-relations', payload });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error.code, 'INVALID_REQUEST');
      assert.ok(Array.isArray(res.json().error.details));
    }
    assert.equal(calls, 0);
    const malformed = await app.inject({ method: 'POST', url: '/analyze-relations', headers: { 'content-type': 'application/json' }, payload: '{oops' });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.json().error.code, 'INVALID_REQUEST');
    const unsupported = await app.inject({ method: 'POST', url: '/analyze-relations', headers: { 'content-type': 'text/plain' }, payload: 'hi' });
    assert.equal(unsupported.statusCode, 415);
    assert.equal(unsupported.json().error.code, 'UNSUPPORTED_MEDIA_TYPE');
    const oversized = await app.inject({ method: 'POST', url: '/analyze-relations', payload: { text: 'x'.repeat(128 * 1024) } });
    assert.equal(oversized.statusCode, 413);
    assert.equal(oversized.json().error.code, 'PAYLOAD_TOO_LARGE');
    const missing = await app.inject('/missing');
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'NOT_FOUND');
  } finally { await app.close(); }
});

test('health works without key; actual analysis reports missing configuration', async () => {
  const app = await buildApp(loadConfig({}));
  try {
    const health = await app.inject('/health');
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: 'ok' });
    const res = await app.inject({ method: 'POST', url: '/analyze-relations', payload: input });
    assert.equal(res.statusCode, 500);
    assert.equal(res.json().error.code, 'LLM_NOT_CONFIGURED');
  } finally { await app.close(); }
});

test('CORS permits configured web origins, leaves unknown origins without permission', async () => {
  const app = await buildApp(loadConfig({}));
  try {
    const native = await app.inject('/health');
    assert.equal(native.statusCode, 200);
    const allowed = await app.inject({ url: '/health', headers: { origin: 'http://localhost:8080' } });
    assert.equal(allowed.headers['access-control-allow-origin'], 'http://localhost:8080');
    const denied = await app.inject({ url: '/health', headers: { origin: 'https://example.com' } });
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
    const preflight = await app.inject({ method: 'OPTIONS', url: '/analyze-relations', headers: {
      origin: 'http://localhost:8080', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type',
    } });
    assert.equal(preflight.statusCode, 204);
    assert.match(String(preflight.headers['access-control-allow-methods']), /POST/);
  } finally { await app.close(); }
});

test('environment defaults and invalid values', () => {
  assert.equal(loadConfig({}).HOST, '0.0.0.0');
  assert.equal(loadConfig({}).PORT, 3000);
  assert.equal(loadConfig({}).LLM_MODEL, 'claude-haiku-5-5');
  assert.throws(() => loadConfig({ PORT: 'oops' }));
  assert.throws(() => loadConfig({ LLM_PROVIDER: 'unknown' }));
  assert.throws(() => loadConfig({ CORS_ORIGINS: 'not-an-origin' }));
  assert.equal(analyzeRequestSchema.safeParse(input).success, true);
});
