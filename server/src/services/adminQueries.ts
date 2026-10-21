import type { Db } from '../db/pool.js';
import { ORDER_STATUSES } from '../domain/orderStatus.js';
import { notFound } from '../lib/errors.js';
import { allowedTransitions } from '../domain/orderStatus.js';
import type { Order } from './orders.js';

export interface OrderSearch {
  q?: string;
  status?: string;
  from?: string;
  to?: string;
  minAmount?: string;
  maxAmount?: string;
  flagged?: boolean;
  page?: number;
  pageSize?: number;
}

export async function searchOrders(db: Db, s: OrderSearch) {
  const where: string[] = [];
  const args: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    args.push(v);
    where.push(sql.replace('?', `$${args.length}`));
  };
  if (s.q) {
    const q = s.q.trim();
    const digits = q.replace(/\D/g, '');
    args.push(`%${q.toUpperCase()}%`);
    const i = args.length;
    const parts = [`reference ILIKE $${i}`, `customer_transfer_reference ILIKE $${i}`, `verified_reference ILIKE $${i}`, `customer_email ILIKE $${i}`, `recipient_name ILIKE $${i}`];
    if (/^[0-9a-f-]{36}$/i.test(q)) {
      args.push(q);
      parts.push(`id = $${args.length}`);
    }
    if (digits.length >= 4) {
      args.push(`%${digits.slice(-9)}%`);
      parts.push(`recipient_phone LIKE $${args.length}`);
    }
    where.push(`(${parts.join(' OR ')})`);
  }
  if (s.status && (ORDER_STATUSES as readonly string[]).includes(s.status)) add('status = ?', s.status);
  if (s.from && /^\d{4}-\d{2}-\d{2}$/.test(s.from)) add('created_at >= ?::date', s.from);
  if (s.to && /^\d{4}-\d{2}-\d{2}$/.test(s.to)) add("created_at < ?::date + interval '1 day'", s.to);
  if (s.minAmount && /^\d+(\.\d+)?$/.test(s.minAmount)) add('send_amount >= ?', s.minAmount);
  if (s.maxAmount && /^\d+(\.\d+)?$/.test(s.maxAmount)) add('send_amount <= ?', s.maxAmount);
  if (s.flagged) where.push("cardinality(flags) > 0");
  const pageSize = Math.min(Math.max(s.pageSize ?? 25, 1), 100);
  const page = Math.max(s.page ?? 1, 1);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [list, total] = await Promise.all([
    db.query(
      `SELECT id, reference, status, created_at, status_changed_at, send_amount, send_currency, payout_amount,
              receive_currency, fee_amount, recipient_name, recipient_phone, payout_method, payment_due_at, payout_due_at, flags
       FROM orders ${clause} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      args,
    ),
    db.query<{ n: string }>(`SELECT count(*) AS n FROM orders ${clause}`, args),
  ]);
  return { orders: list.rows, total: Number(total.rows[0].n), page, pageSize };
}

export async function orderDetail(db: Db, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Order not found');
  const { rows } = await db.query<Order & { verified_by_name: string | null; completed_by_name: string | null }>(
    `SELECT o.*, v.name AS verified_by_name, c.name AS completed_by_name
     FROM orders o LEFT JOIN admin_users v ON v.id = o.verified_by LEFT JOIN admin_users c ON c.id = o.completed_by
     WHERE o.id = $1`,
    [id],
  );
  const order = rows[0];
  if (!order) throw notFound('Order not found');
  const { tracking_token_hash: _omit, ...safe } = order;
  const [history, proofs, audit, instructions, events] = await Promise.all([
    db.query(
      `SELECT h.*, u.name AS actor_name FROM order_status_history h LEFT JOIN admin_users u ON u.id = h.actor_id
       WHERE order_id = $1 ORDER BY h.id`,
      [id],
    ),
    db.query(
      `SELECT p.id, p.original_filename, p.mime_type, p.size_bytes, p.sha256, p.transfer_reference, p.review_status, p.review_note,
              p.submitted_at, p.reviewed_at, p.deleted_at, u.name AS reviewed_by_name,
              (SELECT array_agg(DISTINCT o2.reference) FROM payment_proofs p2 JOIN orders o2 ON o2.id = p2.order_id
                WHERE p2.sha256 = p.sha256 AND p2.order_id <> p.order_id) AS duplicate_of
       FROM payment_proofs p LEFT JOIN admin_users u ON u.id = p.reviewed_by WHERE p.order_id = $1 ORDER BY p.submitted_at DESC`,
      [id],
    ),
    db.query(
      `SELECT id, occurred_at, actor_type, actor_label, action, before, after, reason FROM audit_log
       WHERE (entity_type = 'order' AND entity_id = $1)
          OR (entity_type = 'payment_proof' AND entity_id IN (SELECT id::text FROM payment_proofs WHERE order_id = $1::uuid))
       ORDER BY id`,
      [id],
    ),
    db.query('SELECT id, method_label, instructions, created_at FROM payment_instructions WHERE id = $1', [order.payment_instruction_id]),
    db.query('SELECT id, kind, severity, message, created_at, acknowledged_at FROM system_events WHERE order_id = $1 ORDER BY id DESC', [id]),
  ]);
  return {
    order: safe,
    allowedActions: allowedTransitions(order.status, 'admin'),
    history: history.rows,
    proofs: proofs.rows,
    audit: audit.rows,
    paymentInstructions: instructions.rows[0] ?? null,
    events: events.rows,
  };
}

/**
 * Dashboard figures. "Collected" fees are on completed orders only (the payout happened,
 * so the fee was earned). "Projected" fees are on orders still in progress and may not
 * materialise. Amounts are grouped by currency so different currencies are never summed.
 */
export async function dashboardMetrics(db: Db) {
  const [counts, fees, volume, recent, events, outbox] = await Promise.all([
    db.query<{ status: string; n: string }>('SELECT status, count(*) AS n FROM orders GROUP BY status'),
    db.query<{ currency: string; collected: string; projected: string; verified_unpaid: string }>(
      `SELECT receive_currency AS currency,
              COALESCE(SUM(fee_amount) FILTER (WHERE status = 'completed'), 0) AS collected,
              COALESCE(SUM(fee_amount) FILTER (WHERE status IN ('awaiting_payment','proof_submitted','resubmission_requested','payment_verified','payout_processing')), 0) AS projected,
              COALESCE(SUM(payout_amount) FILTER (WHERE status IN ('payment_verified','payout_processing')), 0) AS verified_unpaid
       FROM orders GROUP BY receive_currency`,
    ),
    db.query<{ currency: string; completed_send: string; completed_payout: string; avg_send: string; n: string }>(
      `SELECT send_currency AS currency, COALESCE(SUM(send_amount), 0) AS completed_send,
              COALESCE(SUM(payout_actual_amount), 0) AS completed_payout, COALESCE(ROUND(AVG(send_amount), 2), 0) AS avg_send, count(*) AS n
       FROM orders WHERE status = 'completed' GROUP BY send_currency`,
    ),
    db.query<{ day: string; orders: string; completed: string; fees: string }>(
      `SELECT to_char(d, 'YYYY-MM-DD') AS day,
              (SELECT count(*) FROM orders WHERE created_at::date = d) AS orders,
              (SELECT count(*) FROM orders WHERE status = 'completed' AND completed_at::date = d) AS completed,
              (SELECT COALESCE(SUM(fee_amount), 0) FROM orders WHERE status = 'completed' AND completed_at::date = d) AS fees
       FROM generate_series(current_date - 13, current_date, interval '1 day') AS d ORDER BY d`,
    ),
    db.query(
      `SELECT id, kind, severity, message, order_id, created_at FROM system_events WHERE acknowledged_at IS NULL ORDER BY id DESC LIMIT 20`,
    ),
    db.query<{ status: string; n: string }>(`SELECT status, count(*) AS n FROM email_outbox GROUP BY status`),
  ]);
  const byStatus = Object.fromEntries(counts.rows.map((r) => [r.status, Number(r.n)]));
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const avgDelay = await db.query<{ hours: string | null; late: string }>(
    `SELECT ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - verified_at)) / 3600)::numeric, 1) AS hours,
            count(*) FILTER (WHERE completed_at > payout_due_at) AS late
     FROM orders WHERE status = 'completed'`,
  );
  return {
    totals: {
      orders: total,
      pendingPayment: (byStatus.awaiting_payment ?? 0) + (byStatus.resubmission_requested ?? 0),
      awaitingVerification: byStatus.proof_submitted ?? 0,
      verifiedAwaitingPayout: (byStatus.payment_verified ?? 0) + (byStatus.payout_processing ?? 0),
      completed: byStatus.completed ?? 0,
      rejected: byStatus.rejected ?? 0,
      cancelled: byStatus.cancelled ?? 0,
      expired: byStatus.expired ?? 0,
      refunded: byStatus.refunded ?? 0,
    },
    byStatus,
    fees: fees.rows,
    volume: volume.rows,
    payoutTiming: { averageHoursVerifiedToPaid: avgDelay.rows[0]?.hours, completedLate: Number(avgDelay.rows[0]?.late ?? 0) },
    daily: recent.rows,
    openEvents: events.rows,
    emailOutbox: Object.fromEntries(outbox.rows.map((r) => [r.status, Number(r.n)])),
  };
}

export async function auditLog(db: Db, params: { entityType?: string; entityId?: string; before?: string; limit?: number }) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (params.entityType) {
    args.push(params.entityType);
    where.push(`entity_type = $${args.length}`);
  }
  if (params.entityId) {
    args.push(params.entityId);
    where.push(`entity_id = $${args.length}`);
  }
  if (params.before && /^\d+$/.test(params.before)) {
    args.push(params.before);
    where.push(`id < $${args.length}`);
  }
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
  const { rows } = await db.query(
    `SELECT id, occurred_at, actor_type, actor_label, action, entity_type, entity_id, before, after, reason, ip, hash
     FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`,
    args,
  );
  return rows;
}
