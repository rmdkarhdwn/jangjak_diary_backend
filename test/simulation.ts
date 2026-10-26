import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createAnthropicLlm } from '../src/services/llm.js';

test('listening Fastify service → real SDK → Postman simulation over HTTP', async () => {
  const llm = createAnthropicLlm({
    apiKey: 'simulation-only-placeholder',
    model: 'claude-haiku-5-5',
    timeoutMs: 2000,
    baseURL: process.env.SIMULATION_URL ?? 'http://127.0.0.1:4900/anthropic',
  });
  const app = await buildApp(loadConfig({}), llm, true);
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    assert.equal((await fetch(`${address}/health`)).status, 200);
    for (const [title, status, expected] of [
      ['Flutter', 200, null],
      ['__upstream_failure__', 502, 'LLM_API_ERROR'],
      ['__invalid_json__', 502, 'INVALID_LLM_RESPONSE'],
    ] as const) {
      const result = await fetch(`${address}/analyze-relations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interests: [
          { id: 'flutter', title, logs: ['직접 앱 만드는 게 재밌다'] },
          { id: 'game', title: '게임 개발', logs: ['시스템 만드는 게 재밌다'] },
        ] }),
      });
      assert.equal(result.status, status);
      const body = await result.json();
      if (expected) assert.equal(body.error.code, expected);
      else assert.equal(body.relations[0].score, 0.66);
    }
  } finally { await app.close(); }
});
