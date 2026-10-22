import { Router, type Request } from 'express';
import { config } from '../../config.js';
import { pool, withTransaction } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import type { RateService } from '../../rates/rateService.js';
import { auditLog, dashboardMetrics, orderDetail, searchOrders } from '../../services/adminQueries.js';
import { audit, verifyAuditChain } from '../../services/audit.js';
import {
  actorFor,
  beginMfaEnrollment,
  completeMfaEnrollment,
  createAdminUser,
  listUsers,
  login,
  logout,
  updateUser,
  verifyMfa,
  type Role,
} from '../../services/auth.js';
import {
  activeInstructions,
  createFeeVersion,
  currentFeeSchedule,
  deactivateInstructions,
  feeHistory,
  listCorridors,
  replaceInstructions,
  updateCorridor,
} from '../../services/corridors.js';
import * as orders from '../../services/orders.js';
import { getSettings, updateSettings } from '../../services/settings.js';
import type { EvidenceStorage } from '../../services/storage.js';
import { clientIp, limiter, requireAdmin, requireCsrfHeader, requirePermission, SESSION_COOKIE } from '../middleware.js';

const actor = (req: Request) => actorFor(req.session!, clientIp(req));
const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function adminRoutes(deps: { rates: RateService; storage: EvidenceStorage }) {
  const r = Router();
  r.use(requireCsrfHeader);

  const cookieOpts = {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict' as const,
    path: '/api/admin',
    maxAge: config.sessionTtlHours * 3600_000,
  };

  // ----- Authentication ---------------------------------------------------
  r.post('/auth/login', limiter(15, 10), async (req, res) => {
    const result = await login(pool, str(req.body?.email, 200), typeof req.body?.password === 'string' ? req.body.password : '', {
      ip: clientIp(req) ?? undefined,
      userAgent: req.get('user-agent'),
    });
    res.cookie(SESSION_COOKIE, result.token, cookieOpts);
    res.json({ mfaRequired: result.mfaRequired, mfaEnrollmentRequired: result.mfaEnrollmentRequired });
  });

  r.post('/auth/mfa', limiter(15, 10), requireAdmin({ allowUnverified: true }), async (req, res) => {
    await verifyMfa(pool, req.session!, str(req.body?.code, 10), clientIp(req) ?? undefined);
    res.json({ ok: true });
  });

  r.post('/auth/mfa/enroll', limiter(15, 10), requireAdmin({ allowUnverified: true }), async (req, res) => {
    res.json(await beginMfaEnrollment(pool, req.session!));
  });

  r.post('/auth/mfa/enroll/verify', limiter(15, 10), requireAdmin({ allowUnverified: true }), async (req, res) => {
    await completeMfaEnrollment(pool, req.session!, str(req.body?.code, 10), clientIp(req) ?? undefined);
    res.json({ ok: true });
  });

  r.post('/auth/logout', requireAdmin({ allowUnverified: true }), async (req, res) => {
    await logout(pool, req.session!.sessionId);
    res.clearCookie(SESSION_COOKIE, { path: '/api/admin' });
    res.json({ ok: true });
  });

  r.get('/auth/me', requireAdmin({ allowUnverified: true }), (req, res) => {
    const s = req.session!;
    res.json({
      user: s.user,
      mfaVerified: s.mfaVerified,
      mfaEnrollmentRequired: !s.user.mfa_enabled && config.requireMfa,
    });
  });

  // Everything below requires a fully authenticated (MFA-verified) session.
  r.use(requireAdmin(), limiter(1, 300));

  // ----- Dashboard & orders ----------------------------------------------
  r.get('/dashboard', requirePermission('orders.read'), async (_req, res) => {
    res.json(await dashboardMetrics(pool));
  });

  r.get('/orders', requirePermission('orders.read'), async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    res.json(
      await searchOrders(pool, {
        q: q.q?.slice(0, 100),
        status: q.status,
        from: q.from,
        to: q.to,
        minAmount: q.minAmount,
        maxAmount: q.maxAmount,
        flagged: q.flagged === '1',
        page: Number(q.page) || 1,
        pageSize: Number(q.pageSize) || 25,
      }),
    );
  });

  r.get('/orders.csv', requirePermission('orders.read'), async (req, res) => {
    const { rows } = await pool.query(
      `SELECT reference, status, created_at, send_amount, send_currency, rate, rate_source, gross_amount, fee_rate, fee_amount,
              payout_amount, receive_currency, verified_amount, verified_reference, verified_at, payout_actual_amount,
              payout_reference, payout_date, refund_amount, refund_reference, completed_at
       FROM orders ORDER BY created_at`,
    );
    await audit(pool, actor(req), { action: 'orders.export', entityType: 'orders', entityId: 'csv', after: { rows: rows.length } });
    const cols = rows.length ? Object.keys(rows[0]) : ['reference'];
    const esc = (v: unknown) => {
      if (v === null || v === undefined) return '';
      let s = v instanceof Date ? v.toISOString() : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send([cols.join(','), ...rows.map((row) => cols.map((c) => esc(row[c])).join(','))].join('\n'));
  });

  r.get('/orders/:id', requirePermission('orders.read'), async (req, res) => {
    res.json(await orderDetail(pool, String(req.params.id)));
  });

  r.get('/orders/:id/proofs/:proofId', requirePermission('orders.read'), async (req, res) => {
    const { rows } = await pool.query<{ storage_key: string; mime_type: string; original_filename: string; deleted_at: Date | null }>(
      'SELECT storage_key, mime_type, original_filename, deleted_at FROM payment_proofs WHERE id = $1 AND order_id = $2',
      [/^[0-9a-f-]{36}$/i.test(String(req.params.proofId)) ? String(req.params.proofId) : '00000000-0000-0000-0000-000000000000', /^[0-9a-f-]{36}$/i.test(String(req.params.id)) ? String(req.params.id) : '00000000-0000-0000-0000-000000000000'],
    );
    const proof = rows[0];
    if (!proof || proof.deleted_at) throw notFound('Proof not found');
    const data = await deps.storage.get(proof.storage_key);
    await audit(pool, actor(req), { action: 'proof.view', entityType: 'payment_proof', entityId: String(req.params.proofId) });
    res.setHeader('Content-Type', proof.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${proof.original_filename.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    res.send(data);
  });

  const W = requirePermission('orders.write');
  r.post('/orders/:id/verify', W, async (req, res) => res.json({ order: await orders.verifyPayment(actor(req), String(req.params.id), req.body ?? {}) }));
  r.post('/orders/:id/request-resubmission', W, async (req, res) =>
    res.json({ order: await orders.requestResubmission(actor(req), String(req.params.id), req.body ?? {}) }),
  );
  r.post('/orders/:id/reject', W, async (req, res) => res.json({ order: await orders.rejectOrder(actor(req), String(req.params.id), req.body ?? {}) }));
  r.post('/orders/:id/cancel', W, async (req, res) => res.json({ order: await orders.adminCancel(actor(req), String(req.params.id), req.body ?? {}) }));
  r.post('/orders/:id/start-payout', W, async (req, res) => res.json({ order: await orders.startPayout(actor(req), String(req.params.id)) }));
  r.post('/orders/:id/revert-payout', W, async (req, res) => res.json({ order: await orders.revertPayout(actor(req), String(req.params.id), req.body ?? {}) }));
  r.post('/orders/:id/complete', W, async (req, res) => res.json({ order: await orders.completePayout(actor(req), String(req.params.id), req.body ?? {}) }));
  r.post('/orders/:id/refund', W, async (req, res) => res.json({ order: await orders.refundOrder(actor(req), String(req.params.id), req.body ?? {}) }));
  r.post('/orders/:id/message', W, async (req, res) => res.json({ order: await orders.setOperatorMessage(actor(req), String(req.params.id), req.body ?? {}) }));
  r.post('/orders/:id/reissue-link', W, async (req, res) => res.json(await orders.reissueTrackingLink(actor(req), String(req.params.id))));

  r.post('/events/:id/ack', W, async (req, res) => {
    const { rowCount } = await pool.query(
      'UPDATE system_events SET acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1 AND acknowledged_at IS NULL',
      [/^\d+$/.test(String(req.params.id)) ? String(req.params.id) : '0', req.session!.user.id],
    );
    if (rowCount) await audit(pool, actor(req), { action: 'event.ack', entityType: 'system_event', entityId: String(req.params.id) });
    res.json({ ok: true });
  });

  // ----- Business settings ----------------------------------------------
  r.get('/settings', requirePermission('orders.read'), async (_req, res) => {
    const corridors = await listCorridors(pool);
    const detailed = await Promise.all(
      corridors.map(async (c) => {
        const [fee, fees, instructions, rate] = await Promise.all([
          currentFeeSchedule(pool, c.id),
          feeHistory(pool, c.id),
          activeInstructions(pool, c.id),
          deps.rates.current(c.from_currency, c.to_currency, c.rate_max_age_seconds),
        ]);
        return { ...c, currentFee: fee, feeHistory: fees, instructions, rate };
      }),
    );
    res.json({ corridors: detailed, settings: await getSettings(pool), rateProvider: deps.rates.providerName });
  });

  const OWNER = requirePermission('settings.write');
  r.patch('/settings', OWNER, async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('invalid_body', 'Expected an object of settings.');
    const settings = await withTransaction((c) => updateSettings(c, actor(req), body));
    res.json({ settings });
  });

  r.patch('/corridors/:id', OWNER, async (req, res) => {
    const b = req.body ?? {};
    const changes: Record<string, unknown> = {};
    for (const k of ['enabled', 'paused'] as const) if (typeof b[k] === 'boolean') changes[k] = b[k];
    for (const k of ['quote_ttl_seconds', 'payment_window_minutes', 'payout_sla_hours', 'rate_max_age_seconds'] as const) {
      if (b[k] !== undefined) {
        if (!Number.isInteger(b[k]) || b[k] <= 0) throw badRequest('invalid_field', `${k} must be a positive integer.`);
        changes[k] = b[k];
      }
    }
    for (const k of ['min_send_amount', 'max_send_amount'] as const) {
      if (b[k] !== undefined) {
        if (!/^\d+(\.\d{1,2})?$/.test(String(b[k]))) throw badRequest('invalid_field', `${k} must be an amount.`);
        changes[k] = String(b[k]);
      }
    }
    if (b.pause_reason !== undefined) changes.pause_reason = str(b.pause_reason, 300) || null;
    if (b.payout_terms !== undefined) changes.payout_terms = str(b.payout_terms, 2000);
    const corridor = await withTransaction((c) => updateCorridor(c, actor(req), Number(String(req.params.id)), changes));
    res.json({ corridor });
  });

  // Pausing is an operational control any operator may use; resuming requires an owner.
  r.post('/corridors/:id/pause', W, async (req, res) => {
    const corridor = await withTransaction((c) =>
      updateCorridor(c, actor(req), Number(String(req.params.id)), { paused: true, pause_reason: str(req.body?.reason, 300) || null }),
    );
    res.json({ corridor });
  });

  r.post('/corridors/:id/fees', OWNER, async (req, res) => {
    const fee = await withTransaction((c) =>
      createFeeVersion(c, actor(req), Number(String(req.params.id)), { feeRate: String(req.body?.feeRate ?? ''), note: str(req.body?.note) || undefined }),
    );
    res.status(201).json({ fee });
  });

  r.post('/corridors/:id/instructions', OWNER, async (req, res) => {
    const methodLabel = str(req.body?.methodLabel, 100);
    const instructions = str(req.body?.instructions, 3000);
    if (!methodLabel || !instructions) throw badRequest('missing_field', 'Method label and instructions are required.');
    const result = await withTransaction((c) => replaceInstructions(c, actor(req), Number(String(req.params.id)), { methodLabel, instructions }));
    res.status(201).json({ instructions: result });
  });

  r.delete('/corridors/:id/instructions', OWNER, async (req, res) => {
    await withTransaction((c) => deactivateInstructions(c, actor(req), Number(String(req.params.id))));
    res.json({ ok: true });
  });

  // ----- Rates ---------------------------------------------------------------
  r.post('/rates/refresh', requirePermission('rates.write'), async (req, res) => {
    const from = str(req.body?.from, 3).toUpperCase();
    const to = str(req.body?.to, 3).toUpperCase();
    const snap = await deps.rates.refresh(from, to);
    res.status(snap ? 200 : 502).json({ snapshot: snap, ok: !!snap });
  });

  r.post('/rates/operator', requirePermission('rates.write'), async (req, res) => {
    const rate = String(req.body?.rate ?? '');
    if (!/^\d+(\.\d{1,12})?$/.test(rate) || Number(rate) <= 0) throw badRequest('invalid_rate', 'Enter a positive rate (max 12 decimals).');
    const validMinutes = Number(req.body?.validMinutes);
    if (!Number.isInteger(validMinutes) || validMinutes < 5 || validMinutes > 1440)
      throw badRequest('invalid_validity', 'Validity must be 5–1440 minutes.');
    const snap = await deps.rates.setOperatorRate(actor(req), {
      base: str(req.body?.from, 3).toUpperCase(),
      quote: str(req.body?.to, 3).toUpperCase(),
      rate,
      validMinutes,
      note: str(req.body?.note) || undefined,
    });
    res.status(201).json({ snapshot: snap });
  });

  r.delete('/rates/operator', requirePermission('rates.write'), async (req, res) => {
    await deps.rates.clearOperatorRate(actor(req), str(req.query.from, 3).toUpperCase(), str(req.query.to, 3).toUpperCase());
    res.json({ ok: true });
  });

  // ----- Audit ---------------------------------------------------------------
  r.get('/audit', requirePermission('orders.read'), async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    res.json({ entries: await auditLog(pool, { entityType: q.entityType, entityId: q.entityId, before: q.before, limit: Number(q.limit) || 100 }) });
  });
  r.get('/audit/verify', requirePermission('orders.read'), async (_req, res) => res.json(await verifyAuditChain(pool)));

  // ----- Users ---------------------------------------------------------------
  const USERS = requirePermission('users.manage');
  r.get('/users', USERS, async (_req, res) => res.json({ users: await listUsers(pool) }));
  r.post('/users', USERS, async (req, res) => {
    const role = str(req.body?.role, 20) as Role;
    if (!['owner', 'operator', 'viewer'].includes(role)) throw badRequest('invalid_role', 'Invalid role.');
    const user = await createAdminUser(
      pool,
      { email: str(req.body?.email, 200), name: str(req.body?.name, 100), password: String(req.body?.password ?? ''), role },
      actor(req),
    );
    res.status(201).json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  });
  r.patch('/users/:id', USERS, async (req, res) => {
    await updateUser(pool, actor(req), String(req.params.id), {
      role: req.body?.role,
      active: typeof req.body?.active === 'boolean' ? req.body.active : undefined,
      resetMfa: req.body?.resetMfa === true,
    });
    res.json({ ok: true });
  });

  return r;
}
