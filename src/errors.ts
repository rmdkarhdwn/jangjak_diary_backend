export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: { path: string; message: string }[],
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function invalidLlmResponse(): AppError {
  return new AppError(502, 'INVALID_LLM_RESPONSE', '관계 분석 결과 형식이 올바르지 않습니다.');
}
