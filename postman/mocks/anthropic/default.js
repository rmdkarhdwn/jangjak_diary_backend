// Local-only contract stand-in; generated sample replaced with the Messages API shape.
// Official reference: https://platform.claude.com/docs/en/api/messages/create
const http = require('http');
const headers = { 'Content-Type': 'application/json' };

http.createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'POST' || req.url !== '/v1/messages') {
    return send(501, { error: { type: 'api_error', message: 'Endpoint not modelled' } });
  }
  const body = req.body;
  if (!body || body.model !== 'claude-haiku-5-5' || !body.messages?.[0] ||
    body.output_config?.format?.type !== 'json_schema' || !req.headers['anthropic-version']) {
    return send(400, { error: { type: 'invalid_request_error', message: 'Invalid mock request contract' } });
  }
  const request = JSON.parse(body.messages[0].content);
  // Only this local fixture recognises these markers, never the real provider.
  const marker = request.interests[0]?.title;
  if (marker === '__upstream_failure__') {
    return send(500, { type: 'error', error: { type: 'api_error', message: 'Simulated upstream failure' } });
  }
  let result = { relations: [{
    source: 'flutter', target: 'game',
    basis: 'shared_logs',
    scores: { topic: 40, motivation: 95, behavior: 80, temporal: 60 },
    type: 'motivation', summary: '직접 만들어 결과물을 확인하는 즐거움이 공통됩니다.',
    evidence: ['직접 앱 만드는 게 재밌다', '시스템 만드는 게 재밌다'],
    suggestion: 'Flutter로 작은 게임 도구를 만들어보세요.',
  }] };
  if (request.interests[0]?.id === 'books' && request.candidateInterests?.some((item) => item.id === 'guitar')) {
    result = { relations: [{
      source: 'books', target: 'guitar', basis: 'explicit_reference', type: 'topic',
      scores: { topic: 95, motivation: 0, behavior: 0, temporal: 0 },
      summary: '독서 기록에서 기타 주법을 직접 다루고 있습니다.',
      evidence: [request.interests[0].logs[0]],
      suggestion: '책에서 본 기타 주법 하나를 연습해보세요.',
    }] };
  }
  send(200, {
    id: 'msg_local_simulation', type: 'message', role: 'assistant', model: body.model,
    content: [{ type: 'text', text: marker === '__invalid_json__' ? 'not JSON' : JSON.stringify(result) }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 100 },
  });
}).listen(process.env.PORT || 4901);
