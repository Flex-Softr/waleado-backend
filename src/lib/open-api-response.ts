import type { Response } from "express";

export type OpenApiEnvelope<T> = {
  success: boolean;
  message: string;
  error: string | null;
  errors: unknown | null;
  data: T | null;
};

export function openApiSuccess<T>(
  res: Response,
  message: string,
  data: T,
  statusCode = 200
): void {
  const body: OpenApiEnvelope<T> = {
    success: true,
    message,
    error: null,
    errors: null,
    data,
  };
  res.status(statusCode).json(body);
}

export function openApiFail(
  res: Response,
  statusCode: number,
  message: string,
  error: string | null = null,
  errors: unknown | null = null
): void {
  const body: OpenApiEnvelope<null> = {
    success: false,
    message,
    error: error ?? message,
    errors,
    data: null,
  };
  res.status(statusCode).json(body);
}
