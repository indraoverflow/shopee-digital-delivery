/**
 * Errors carry a stable machine code, an HTTP status and a message that is safe
 * to show a user. Internal detail goes to the log, never to the response.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }

  static notFound(what: string): AppError {
    return new AppError("NOT_FOUND", `${what} tidak ditemukan`, 404);
  }

  static unauthorized(message = "Silakan masuk terlebih dahulu"): AppError {
    return new AppError("UNAUTHORIZED", message, 401);
  }

  static forbidden(message = "Anda tidak punya akses ke tindakan ini"): AppError {
    return new AppError("FORBIDDEN", message, 403);
  }

  static conflict(code: string, message: string): AppError {
    return new AppError(code, message, 409);
  }

  static validation(message: string, details?: unknown): AppError {
    return new AppError("VALIDATION_ERROR", message, 422, details);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
