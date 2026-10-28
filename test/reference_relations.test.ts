import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { analyzeRequestSchema, validateAndScore } from '../src/schemas/relation.js';

const text = '오늘 기타를 치는 책을 읽었다. 여러가지 주법이 있는게 신기했다.';
const input = {
  interests: [{ id: 'books', title: '책 읽기', logs: [text] }],
  candidateInterests: [{ id: 'guitar', title: '기타 치기' }],
};
const reference = {
  source: 'books', target: 'guitar', basis: 'explicit_reference', type: 'topic',
  scores: { topic: 95, motivation: 0, behavior: 0, temporal: 0 },
  summary: '독서 기록에서 기타 주법을 직접 다루고 있습니다.',
  evidence: [text], suggestion: '책에서 본 기타 주법 하나를 연습해보세요.',
};
const raw = (value: unknown = reference) => JSON.stringify({ relations: [value] });

test('an explicit topic reference can use one source log and a recordless target', () => {
  assert.equal(analyzeRequestSchema.safeParse(input).success, true);
  const relation = validateAndScore(raw(), input).relations[0]!;
  assert.equal(relation.score, 0.95);
  assert.equal(relation.basis, 'explicit_reference');
  assert.deepEqual(relation.evidence, [text]);
});

test('one recorded interest plus a candidate calls the LLM instead of returning empty', async () => {
  let calls = 0;
  const app = await buildApp(loadConfig({}), { async analyze(request) {
    calls++;
    assert.deepEqual(request, input);
    return raw();
  } });
  try {
    const response = await app.inject({ method: 'POST', url: '/analyze-relations', payload: input });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().relations[0].target, 'guitar');
    assert.equal(calls, 1);
  } finally { await app.close(); }
});

test('candidates do not accept duplicate IDs, fake logs or more than 12 total interests', () => {
  for (const value of [
    { ...input, candidateInterests: [{ id: 'books', title: '중복' }] },
    { ...input, candidateInterests: [input.candidateInterests[0], input.candidateInterests[0]] },
    { ...input, candidateInterests: [{ id: 'guitar', title: '기타', logs: ['가짜'] }] },
    { ...input, candidateInterests: [{ id: 'guitar', title: ' ' }] },
    { ...input, candidateInterests: Array.from({ length: 12 }, (_, i) => ({ id: `${i}`, title: `관심사 ${i}` })) },
  ]) assert.equal(analyzeRequestSchema.safeParse(value).success, false);
});

test('one-sided evidence is restricted to explicit topic references and actual source logs', () => {
  for (const value of [
    { ...reference, basis: 'shared_logs' },
    { ...reference, type: 'motivation' },
    { ...reference, type: 'behavior' },
    { ...reference, type: 'transition' },
    { ...reference, source: 'guitar', target: 'books' },
    { ...reference, evidence: ['기타를 연습했다는 없는 기록'] },
    { ...reference, evidence: [text, text] },
    { ...reference, target: 'missing' },
  ]) assert.throws(() => validateAndScore(raw(value), input), AppError);
});

test('unclear references are filtered and an empty AI result remains empty', () => {
  assert.deepEqual(validateAndScore(raw({ ...reference, scores: { ...reference.scores, topic: 79 } }), input), { relations: [] });
  assert.deepEqual(validateAndScore('{"relations":[]}', input), { relations: [] });
});

test('direct references also work when the target already has separate logs', () => {
  const request = { interests: [...input.interests, { id: 'guitar', title: '기타 치기', logs: ['어제 코드를 연습했다.'] }] };
  assert.equal(validateAndScore(raw(), request).relations[0]?.basis, 'explicit_reference');
});
