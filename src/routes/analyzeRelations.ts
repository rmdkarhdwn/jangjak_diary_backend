import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors.js';
import { analyzeRequestSchema, validateAndScore } from '../schemas/relation.js';
import type { RelationLlm } from '../services/llm.js';

export function registerAnalyzeRelations(app: FastifyInstance, llm: RelationLlm): void {
  app.post('/analyze-relations', async (request) => {
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type: application/json으로 요청해 주세요.');
    }
    const parsed = analyzeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(400, 'INVALID_REQUEST', '관심사와 장작 기록을 확인해 주세요.',
        parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
    }
    if (parsed.data.interests.length + (parsed.data.candidateInterests?.length ?? 0) === 1) return { relations: [] };

    const raw = await llm.analyze(parsed.data);
    return validateAndScore(raw, parsed.data);
  });
}
