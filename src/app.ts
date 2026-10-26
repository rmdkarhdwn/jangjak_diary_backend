import Fastify, { LogController } from 'fastify';
import cors from '@fastify/cors';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import { registerAnalyzeRelations } from './routes/analyzeRelations.js';
import { createLlm, type RelationLlm } from './services/llm.js';

export async function buildApp(config: Config, llm: RelationLlm = createLlm(config), logger = false) {
  const app = Fastify({
    logger,
    bodyLimit: 128 * 1024,
    requestTimeout: 15_000,
    // 자동 요청 로깅을 끄고 결과 코드만 남겨 장작 원문이 로그에 섞이지 않게 합니다.
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      app.log.warn({ code: error.code, statusCode: error.statusCode }, '요청 처리 실패');
      return reply.code(error.statusCode).send({ error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      } });
    }

    const fastifyCode = (error as { code?: string }).code;
    const knownErrors: Record<string, [number, string, string]> = {
      FST_ERR_CTP_INVALID_JSON_BODY: [400, 'INVALID_REQUEST', '요청 본문이 올바른 JSON이 아닙니다.'],
      FST_ERR_CTP_EMPTY_JSON_BODY: [400, 'INVALID_REQUEST', 'JSON 요청 본문이 필요합니다.'],
      FST_ERR_CTP_BODY_TOO_LARGE: [413, 'PAYLOAD_TOO_LARGE', '요청 본문 크기가 제한을 초과했습니다.'],
      FST_ERR_CTP_INVALID_MEDIA_TYPE: [415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type: application/json으로 요청해 주세요.'],
    };
    const [status, code, message] = knownErrors[fastifyCode ?? '']
      ?? [500, 'INTERNAL_ERROR', '서버에서 오류가 발생했습니다.'];
    app.log.error({ code, statusCode: status }, '요청 처리 실패');
    return reply.code(status).send({ error: { code, message } });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({
    error: { code: 'NOT_FOUND', message: '요청한 API를 찾을 수 없습니다.' },
  }));

  // 경고: '*'는 모든 웹 출처를 허용합니다. 로컬 개발 전용이며 인증을 대신하지 않습니다.
  const allowAll = config.CORS_ORIGINS.includes('*');
  if (allowAll) app.log.warn('모든 웹 출처의 CORS 요청을 허용했습니다. 로컬 개발에서만 사용하세요.');
  await app.register(cors, {
    origin: allowAll ? '*' : config.CORS_ORIGINS,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    credentials: false,
  });

  app.get('/health', async () => ({ status: 'ok' }));
  registerAnalyzeRelations(app, llm);
  return app;
}
