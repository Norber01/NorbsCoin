import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { can, getSession, type Permission, type SessionInfo } from '../services/auth.js';

// Firebase Hosting forwards only a cookie named __session to the backend, so use that name everywhere.
export const SESSION_COOKIE = '__session';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: SessionInfo;
    }
  }
}

export function limiter(windowMinutes: number, limit: number) {
  return rateLimit({
    windowMs: windowMinutes * 60_000,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => process.env.DISABLE_RATE_LIMIT === 'true',
    handler: (_req, res) => res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests. Please wait and try again.' } }),
  });
}

/** CSRF defence for cookie-authenticated admin API: SameSite=Strict cookie + required custom header. */
export function requireCsrfHeader(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'norbscoin') return next(forbidden('Missing CSRF header'));
  next();
}

/** Loads the session. `allowUnverified` permits only the MFA step/enrollment endpoints. */
export function requireAdmin(opts: { allowUnverified?: boolean } = {}) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const session = await getSession(pool, req.cookies?.[SESSION_COOKIE]);
      if (!session) return next(unauthorized());
      if (!session.mfaVerified && !opts.allowUnverified) return next(new AppError(401, 'mfa_required', 'Complete multi-factor authentication.'));
      req.session = session;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.session || !can(req.session.user.role, permission)) return next(forbidden('Your role does not allow this action.'));
    next();
  };
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if ((err as { type?: string }).type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'invalid_json', message: 'Malformed request body.' } });
  }
  if ((err as { type?: string }).type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'too_large', message: 'Request body too large.' } });
  }
  if ((err as { code?: string }).code === '23505') {
    // Unique constraint raced past an application check (e.g. the same statement reference twice).
    return res.status(409).json({ error: { code: 'duplicate', message: 'This conflicts with an existing record (duplicate reference).' } });
  }
  console.error(`[error] ${req.method} ${req.path}`, err);
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong. Your data has not been lost; please try again.' } });
}

export const clientIp = (req: Request) => req.ip ?? null;
