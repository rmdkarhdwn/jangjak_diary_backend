import { z } from 'zod';

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().trim().min(1).default('0.0.0.0'),
  LLM_PROVIDER: z.literal('anthropic').default('anthropic'),
  ANTHROPIC_API_KEY: z.string().trim().default(''),
  ANTHROPIC_WORKSPACE_ID: z.string().trim().default(''),
  LLM_MODEL: z.string().trim().min(1).default('claude-haiku-5-5'),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1).max(120_000).default(45_000),
  CORS_ORIGINS: z.string().default('http://localhost:8080,http://127.0.0.1:8080')
    .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean))
    .refine((origins) => origins.every((origin) => {
      if (origin === '*') return true;
      try {
        const url = new URL(origin);
        return ['http:', 'https:'].includes(url.protocol) && url.origin === origin;
      } catch {
        return false;
      }
    }), 'CORS_ORIGINS에는 쉼표로 구분한 HTTP 출처 또는 *를 지정하세요.'),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    // 환경 변수 값(키 등)은 절대 출력하지 않습니다.
    throw new Error(`환경 변수 설정을 확인하세요: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  }
  return result.data;
}
