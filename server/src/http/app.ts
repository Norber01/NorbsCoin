import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { notFound } from '../lib/errors.js';
import type { RateService } from '../rates/rateService.js';
import type { EvidenceStorage } from '../services/storage.js';
import { errorHandler } from './middleware.js';
import { adminRoutes } from './routes/admin.js';
import { publicRoutes } from './routes/public.js';

export function createApp(deps: { rates: RateService; storage: EvidenceStorage }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy === 'true' ? true : /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);

  if (config.isProduction) {
    // Enforce HTTPS behind the TLS-terminating proxy.
    app.use((req, res, next) =>
      req.secure || req.path === '/api/health' ? next() : res.redirect(301, `https://${req.get('host')}${req.originalUrl}`),
    );
  }
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          objectSrc: ["'none'"],
          frameSrc: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.isProduction ? [] : null,
        },
      },
      hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.use(express.json({ limit: '32kb' }));
  app.use(cookieParser());
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });
  app.use('/api/admin', adminRoutes(deps));
  app.use('/api', publicRoutes(deps));
  app.use('/api', (_req, _res, next) => next(notFound('Unknown API endpoint')));

  // Serve the built web app (single-page app) when present.
  const indexHtml = path.join(config.webDistDir, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(express.static(config.webDistDir, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(indexHtml));
  }

  app.use(errorHandler);
  return app;
}
