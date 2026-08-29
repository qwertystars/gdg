/**
 * Typed HTTP errors for the Remote Runtime API boundary.
 *
 * Handlers throw ApiError; the app-level onError handler converts it to a
 * JSON response. 4xx outcomes are client mistakes handled correctly, so
 * they never reach the error log as service failures.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function apiError(status: number, message: string, code: string | null = null): ApiError {
  return new ApiError(status, message, code);
}
