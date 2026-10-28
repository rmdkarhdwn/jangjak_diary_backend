import { z } from 'zod';
import { invalidLlmResponse } from '../errors.js';

const nonBlank = (max: number) => z.string().min(1).max(max)
  .refine((value) => value.trim().length > 0, '공백만 입력할 수 없습니다.');

const idSchema = z.string().trim().min(1).max(100);
const logTextSchema = nonBlank(2_000);
const logSchema = z.union([
  logTextSchema,
  z.strictObject({
    text: logTextSchema,
    createdAt: z.iso.datetime({ offset: true }).optional(),
  }),
]);

export const analyzeRequestSchema = z.strictObject({
  interests: z.array(z.strictObject({
    id: idSchema,
    title: z.string().trim().min(1).max(200),
    logs: z.array(logSchema).min(1).max(30),
  })).min(1).max(12),
  // Recordless interests provide identity/context without inventing an empty log.
  candidateInterests: z.array(z.strictObject({
    id: idSchema,
    title: z.string().trim().min(1).max(200),
  })).max(11).optional(),
}).superRefine(({ interests, candidateInterests = [] }, ctx) => {
  if (interests.length + candidateInterests.length > 12) {
    ctx.addIssue({ code: 'custom', path: ['candidateInterests'], message: '관심사는 합쳐서 최대 12개입니다.' });
  }
  const ids = new Set<string>();
  [...interests, ...candidateInterests].forEach(({ id }, index) => {
    if (ids.has(id)) {
      const path = index < interests.length ? ['interests', index, 'id'] : ['candidateInterests', index - interests.length, 'id'];
      ctx.addIssue({ code: 'custom', path, message: '관심사 id가 중복되었습니다.' });
    }
    ids.add(id);
  });
});

export type AnalyzeRequest = z.infer<typeof analyzeRequestSchema>;
export type Interest = AnalyzeRequest['interests'][number];
export type Log = Interest['logs'][number];

export const relationTypeSchema = z.enum(['topic', 'motivation', 'behavior', 'transition']);
export const componentScoresSchema = z.strictObject({
  topic: z.number().min(0).max(100),
  motivation: z.number().min(0).max(100),
  behavior: z.number().min(0).max(100),
  temporal: z.number().min(0).max(100),
});

// 출력 토큰 폭증을 막기 위해 가장 의미 있는 30개 관계까지만 요청합니다.
export const llmResponseSchema = z.strictObject({
  relations: z.array(z.strictObject({
    source: idSchema,
    target: idSchema,
    basis: z.enum(['shared_logs', 'explicit_reference']),
    scores: componentScoresSchema,
    type: relationTypeSchema,
    summary: nonBlank(1_000),
    evidence: z.array(logTextSchema).min(1).max(10),
    suggestion: nonBlank(1_000),
  })).max(30),
});

export type ComponentScores = z.infer<typeof componentScoresSchema>;
type LlmRelation = z.infer<typeof llmResponseSchema>['relations'][number];
export type Relation = Omit<LlmRelation, 'scores'> & { score: number };
export type AnalyzeResponse = { relations: Relation[] };

// 초기 제품 정책이며 확률이나 통계적으로 보정된 신뢰도가 아닙니다.
export const MIN_RELATION_SCORE = 0.60;
export const MIN_REFERENCE_SCORE = 0.80;

export function logText(log: Log): string {
  return typeof log === 'string' ? log : log.text;
}

function logTimes(interest: Interest): number[] {
  return interest.logs.flatMap((log) => (
    typeof log !== 'string' && log.createdAt ? [Date.parse(log.createdAt)] : []
  ));
}

export function calculateScore(scores: ComponentScores): number {
  return (scores.topic * 20 + scores.motivation * 40 + scores.behavior * 25 + scores.temporal * 15) / 10_000;
}

export function validateAndScore(raw: string, request: AnalyzeRequest): AnalyzeResponse {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidLlmResponse();
  }
  const parsed = llmResponseSchema.safeParse(value);
  if (!parsed.success) throw invalidLlmResponse();

  const interests = new Map(request.interests.map((interest) => [interest.id, interest]));
  for (const candidate of request.candidateInterests ?? []) {
    interests.set(candidate.id, { ...candidate, logs: [] });
  }
  const pairs = new Set<string>();
  const relations: Relation[] = [];

  for (const relation of parsed.data.relations) {
    const source = interests.get(relation.source);
    const target = interests.get(relation.target);
    const pair = JSON.stringify([relation.source, relation.target].sort());
    if (!source || !target || source.id === target.id || pairs.has(pair)) {
      throw invalidLlmResponse();
    }
    pairs.add(pair);

    const sourceLogs = new Set(source.logs.map(logText));
    const targetLogs = new Set(target.logs.map(logText));
    const evidence = new Set(relation.evidence);
    if (evidence.size !== relation.evidence.length) {
      throw invalidLlmResponse();
    }

    if (relation.basis === 'explicit_reference') {
      // A direct reference is a topic link grounded entirely in source records.
      // It says nothing about shared motivation, behavior, or a temporal shift.
      if (relation.type !== 'topic' || sourceLogs.size === 0 ||
        relation.evidence.some((text) => !sourceLogs.has(text))) throw invalidLlmResponse();
      const score = relation.scores.topic / 100;
      if (score >= MIN_REFERENCE_SCORE) {
        const { scores: _scores, ...publicRelation } = relation;
        relations.push({ ...publicRelation, score: Math.round(score * 10_000) / 10_000 });
      }
      continue;
    }

    if (relation.evidence.length < 2 ||
      relation.evidence.some((text) => !sourceLogs.has(text) && !targetLogs.has(text)) ||
      !relation.evidence.some((text) => sourceLogs.has(text)) ||
      !relation.evidence.some((text) => targetLogs.has(text))) throw invalidLlmResponse();

    const sourceTimes = logTimes(source);
    const targetTimes = logTimes(target);
    const hasTimes = sourceTimes.length > 0 && targetTimes.length > 0;
    if (relation.type === 'transition' && (
      !hasTimes || Math.min(...sourceTimes) >= Math.max(...targetTimes)
    )) {
      throw invalidLlmResponse();
    }

    // 날짜 없는 기록에서 시간적 관계를 만들지 않으며, 빠진 가중치를 재분배하지 않습니다.
    const scores = { ...relation.scores, temporal: hasTimes ? relation.scores.temporal : 0 };
    const score = calculateScore(scores);
    if (score >= MIN_RELATION_SCORE) {
      const { scores: _scores, ...publicRelation } = relation;
      relations.push({ ...publicRelation, score: Math.round(score * 10_000) / 10_000 });
    }
  }

  return { relations: relations.sort((a, b) => b.score - a.score) };
}
