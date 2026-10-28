import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createAnthropicLlm } from '../src/services/llm.js';

const input = { interests: [
  { id: 'flutter', title: 'Flutter', logs: ['직접 앱 만드는 게 재밌다'] },
  { id: 'game', title: '게임 개발', logs: ['시스템 만드는 게 재밌다'] },
] };
const output = { relations: [{
  source: 'flutter', target: 'game',
  basis: 'shared_logs',
  scores: { topic: 40, motivation: 95, behavior: 80, temporal: 60 },
  type: 'motivation', summary: '만드는 즐거움이 공통됩니다.',
  evidence: ['직접 앱 만드는 게 재밌다', '시스템 만드는 게 재밌다'],
  suggestion: '작은 게임 도구를 만들어보세요.',
}] };

function message(text = JSON.stringify(output), stopReason = 'end_turn') {
  return {
    id: 'msg_local_test', type: 'message', role: 'assistant', model: 'claude-haiku-5-5',
    content: [{ type: 'text', text }], stop_reason: stopReason, stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 100 },
  };
}

async function withUpstream(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
  run: (baseURL: string) => Promise<void>,
) {
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    handler(req, res, body);
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`);
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
}

test('real SDK sends model, structured output and input over HTTP, then backend computes score', async () => {
  let captured: { req: IncomingMessage; body: Record<string, any> } | undefined;
  await withUpstream((req, res, body) => {
    captured = { req, body: JSON.parse(body) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(message()));
  }, async (baseURL) => {
    const llm = createAnthropicLlm({ apiKey: 'local-test-key', model: 'claude-haiku-5-5', timeoutMs: 1000, baseURL });
    const app = await buildApp(loadConfig({}), llm);
    try {
      const res = await app.inject({ method: 'POST', url: '/analyze-relations', payload: input });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().relations[0].score, 0.66);
      assert.equal(captured?.req.method, 'POST');
      assert.equal(captured?.req.url, '/v1/messages');
      assert.equal(captured?.req.headers.authorization, 'Bearer local-test-key');
      assert.equal(captured?.req.headers['anthropic-version'], '2026-10-21');
      assert.equal(captured?.body.model, 'claude-haiku-5-5');
      assert.equal(captured?.body.output_config.format.type, 'json_schema');
      assert.deepEqual(JSON.parse(captured?.body.messages[0].content), input);
      assert.equal(captured?.body.temperature, undefined);
    } finally { await app.close(); }
  });
});

for (const [name, status, body, expectedStatus, expectedCode] of [
  ['upstream 500', 500, { error: { type: 'api_error', message: 'private provider details' } }, 502, 'LLM_API_ERROR'],
  ['upstream 401', 401, { error: { type: 'authentication_error', message: 'private provider details' } }, 502, 'LLM_API_ERROR'],
  ['rate limit', 429, { error: { type: 'rate_limit_error', message: 'private provider details' } }, 503, 'LLM_RATE_LIMITED'],
  ['invalid JSON text', 200, message('not JSON'), 502, 'INVALID_LLM_RESPONSE'],
  ['invalid envelope', 200, {}, 502, 'INVALID_LLM_RESPONSE'],
  ['truncated output', 200, message(JSON.stringify(output), 'max_tokens'), 502, 'INVALID_LLM_RESPONSE'],
  ['refused output', 200, message('refused', 'refusal'), 502, 'INVALID_LLM_RESPONSE'],
] as const) {
  test(`real SDK handles ${name} without leaking private data or retrying`, async () => {
    let calls = 0;
    await withUpstream((_req, res) => {
      calls++;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    }, async (baseURL) => {
      const app = await buildApp(loadConfig({}), createAnthropicLlm({ apiKey: 'local-test-key', model: 'claude-haiku-5-5', timeoutMs: 1000, baseURL }));
      try {
        const res = await app.inject({ method: 'POST', url: '/analyze-relations', payload: input });
        assert.equal(res.statusCode, expectedStatus);
        assert.equal(res.json().error.code, expectedCode);
        assert.ok(!res.body.includes('private provider details'));
        assert.ok(!res.body.includes('local-test-key'));
        assert.equal(calls, 1);
      } finally { await app.close(); }
    });
  });
}

test('real SDK timeout maps to 504, with no retry', async () => {
  let calls = 0;
  await withUpstream(() => { calls++; }, async (baseURL) => {
    const app = await buildApp(loadConfig({}), createAnthropicLlm({ apiKey: 'local-test-key', model: 'claude-haiku-5-5', timeoutMs: 100, baseURL }));
    try {
      const res = await app.inject({ method: 'POST', url: '/analyze-relations', payload: input });
      assert.equal(res.statusCode, 504);
      assert.equal(res.json().error.code, 'LLM_TIMEOUT');
      assert.equal(calls, 1);
    } finally { await app.close(); }
  });
});

test('unreachable upstream maps to a consistent 502', async () => {
  let closedBaseURL = '';
  await withUpstream(() => {}, async (baseURL) => { closedBaseURL = baseURL; });
  const app = await buildApp(loadConfig({}), createAnthropicLlm({ apiKey: 'local-test-key', model: 'claude-haiku-5-5', timeoutMs: 1000, baseURL: closedBaseURL }));
  try {
    const res = await app.inject({ method: 'POST', url: '/analyze-relations', payload: input });
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error.code, 'LLM_API_ERROR');
  } finally { await app.close(); }
});
