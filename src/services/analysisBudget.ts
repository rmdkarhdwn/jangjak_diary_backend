import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AppError } from '../errors.js';

export interface AnalysisBudget { reserve(): Promise<void> }

// A local-demo, server-wide budget. Production uses a durable file; app-factory
// tests use memory. One server process owns the file (not a distributed quota).
export class DailyAnalysisBudget implements AnalysisBudget {
  private state = { day: '', attempts: 0 };
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly limit: number, private readonly file?: string,
    private readonly now: () => Date = () => new Date()) {}

  reserve(): Promise<void> {
    const operation = this.queue.then(() => this.reserveSerial());
    this.queue = operation.catch(() => {});
    return operation;
  }

  private async reserveSerial(): Promise<void> {
    try {
      if (!this.loaded && this.file) {
        try {
          const saved: unknown = JSON.parse(await readFile(this.file, 'utf8'));
          if (!saved || typeof saved !== 'object' || !('day' in saved) || typeof saved.day !== 'string'
            || !('attempts' in saved) || !Number.isInteger(saved.attempts) || (saved.attempts as number) < 0) throw new Error('Invalid budget');
          this.state = { day: saved.day, attempts: saved.attempts as number };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      this.loaded = true;
      const now = this.now();
      const day = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
      const attempts = this.state.day === day ? this.state.attempts : 0;
      if (attempts >= this.limit) {
        const nextMidnight = Date.parse(`${day}T00:00:00+09:00`) + 24 * 3600_000;
        throw new AppError(429, 'DAILY_ANALYSIS_LIMIT', `오늘 서버 전체 분석 ${this.limit}회를 모두 사용했습니다. 내일 다시 시도해 주세요.`, undefined,
          Math.max(1, Math.ceil((nextMidnight - now.getTime()) / 1000)));
      }
      const next = { day, attempts: attempts + 1 };
      if (this.file) {
        await mkdir(dirname(this.file), { recursive: true });
        const temporary = `${this.file}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
        await rename(temporary, this.file);
      }
      this.state = next;
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Do not call the paid provider when the durable quota cannot be saved.
      throw new AppError(503, 'ANALYSIS_BUDGET_UNAVAILABLE', '분석 사용 횟수를 확인하지 못했습니다. 서버 저장 공간을 확인해 주세요.');
    }
  }
}
