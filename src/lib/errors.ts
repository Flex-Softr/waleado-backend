export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
    /** Extra machine-readable context returned to the client (e.g. which plan limit was hit). */
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
