import path from 'node:path';

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';

export const config = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port: Number(env('PORT', '3000')),
  databaseUrl: env('DATABASE_URL', 'postgres://norbs:norbs@localhost:5432/norbscoin'),
  // Public base URL, used in email links (tracking pages).
  publicBaseUrl: env('PUBLIC_BASE_URL', 'http://localhost:5173'),
  // Behind a reverse proxy / load balancer that terminates TLS.
  trustProxy: env('TRUST_PROXY', '1'),
  // Encrypts MFA secrets at rest. Must be set (32+ random chars) in production.
  appSecret: process.env.APP_SECRET ?? (nodeEnv === 'production' ? '' : 'dev-only-insecure-secret-change-me'),
  sessionTtlHours: Number(env('ADMIN_SESSION_TTL_HOURS', '12')),
  // Require MFA for all operators in production. Can only be relaxed outside production.
  requireMfa: nodeEnv === 'production' || env('REQUIRE_MFA', 'true') === 'true',
  rates: {
    provider: env('RATE_PROVIDER', 'open_er_api'),
    openErApiUrl: env('OPEN_ER_API_URL', 'https://open.er-api.com/v6/latest'),
    refreshSeconds: Number(env('RATE_REFRESH_SECONDS', '900')),
    timeoutMs: Number(env('RATE_TIMEOUT_MS', '8000')),
  },
  storage: {
    backend: env('STORAGE_BACKEND', 'disk'), // 'disk' | 'db'
    // Private directory outside any web root. Swap for object storage via storage.ts.
    dir: path.resolve(env('UPLOAD_DIR', path.join(process.cwd(), 'var', 'uploads'))),
    maxBytes: Number(env('UPLOAD_MAX_BYTES', String(5 * 1024 * 1024))),
  },
  email: {
    transport: env('EMAIL_TRANSPORT', 'log'), // 'smtp' | 'log'
    from: env('EMAIL_FROM', 'NorbsCoin <no-reply@localhost>'),
    smtpUrl: process.env.SMTP_URL ?? '',
    maxAttempts: Number(env('EMAIL_MAX_ATTEMPTS', '8')),
  },
  // Creates the first owner account at startup if there are no operators yet (hosts without a shell).
  bootstrapOwner: {
    email: process.env.BOOTSTRAP_OWNER_EMAIL ?? '',
    password: process.env.BOOTSTRAP_OWNER_PASSWORD ?? '',
  },
  jobs: {
    enabled: env('JOBS_ENABLED', 'true') === 'true',
    intervalSeconds: Number(env('JOBS_INTERVAL_SECONDS', '30')),
  },
  webDistDir: path.resolve(env('WEB_DIST_DIR', path.join(process.cwd(), '..', 'web', 'dist'))),
};

export type Config = typeof config;
