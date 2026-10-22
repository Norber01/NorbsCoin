export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const unavailable = (code: string, message: string) => new AppError(503, code, message);
export const unauthorized = (message = 'Authentication required') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Not allowed') => new AppError(403, 'forbidden', message);
