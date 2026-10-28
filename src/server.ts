import 'dotenv/config';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { DailyAnalysisBudget } from './services/analysisBudget.js';

try {
  const config = loadConfig();
  const app = await buildApp(config, undefined, true,
    new DailyAnalysisBudget(config.AI_DAILY_LIMIT, config.AI_USAGE_FILE));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().catch(() => { process.exitCode = 1; });
    });
  }
  await app.listen({ host: config.HOST, port: config.PORT });
} catch {
  // 알 수 없는 에러 전체를 출력하면 환경 변수와 공급자 응답이 노출될 수 있습니다.
  console.error('서버를 시작하지 못했습니다. 환경 변수와 포트 사용 여부를 확인하세요.');
  process.exitCode = 1;
}
