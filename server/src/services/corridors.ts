import type { Db } from '../db/pool.js';
import { D } from '../domain/money.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit, type ActorContext } from './audit.js';

export interface Corridor {
  id: number;
  from_currency: string;
  to_currency: string;
  enabled: boolean;
  paused: boolean;
  pause_reason: string | null;
  min_send_amount: string;
  max_send_amount: string;
  quote_ttl_seconds: number;
  payment_window_minutes: number;
  payout_sla_hours: number;
  rate_max_age_seconds: number;
  payout_terms: string;
}

export interface FeeSchedule {
  id: number;
  corridor_id: number;
  version: number;
  fee_rate: string;
  fee_basis: string;
  effective_from: Date;
  note: string | null;
  created_at: Date;
}

export interface PaymentInstruction {
  id: number;
  corridor_id: number;
  method_label: string;
  instructions: string;
  active: boolean;
  created_at: Date;
}

export async function listCorridors(db: Db): Promise<Corridor[]> {
  const { rows } = await db.query<Corridor>('SELECT * FROM corridors ORDER BY id');
  return rows;
}

export async function getCorridorByPair(db: Db, from: string, to: string): Promise<Corridor | null> {
  const { rows } = await db.query<Corridor>('SELECT * FROM corridors WHERE from_currency = $1 AND to_currency = $2', [from, to]);
  return rows[0] ?? null;
}

export async function getCorridor(db: Db, id: number): Promise<Corridor> {
  const { rows } = await db.query<Corridor>('SELECT * FROM corridors WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Corridor not found');
  return rows[0];
}

export async function currentFeeSchedule(db: Db, corridorId: number): Promise<FeeSchedule | null> {
  const { rows } = await db.query<FeeSchedule>(
    `SELECT * FROM fee_schedules WHERE corridor_id = $1 AND effective_from <= now()
     ORDER BY effective_from DESC, version DESC LIMIT 1`,
    [corridorId],
  );
  return rows[0] ?? null;
}

export async function feeHistory(db: Db, corridorId: number): Promise<FeeSchedule[]> {
  const { rows } = await db.query<FeeSchedule>('SELECT * FROM fee_schedules WHERE corridor_id = $1 ORDER BY version DESC', [corridorId]);
  return rows;
}

export async function activeInstructions(db: Db, corridorId: number): Promise<PaymentInstruction | null> {
  const { rows } = await db.query<PaymentInstruction>(
    'SELECT * FROM payment_instructions WHERE corridor_id = $1 AND active ORDER BY id DESC LIMIT 1',
    [corridorId],
  );
  return rows[0] ?? null;
}

/** Why a corridor cannot take new orders right now, or null if it can. */
export function corridorUnavailableReason(c: Corridor, hasInstructions: boolean, hasFee: boolean): string | null {
  if (!c.enabled) return 'This currency pair is not offered.';
  if (c.paused) return c.pause_reason || 'New orders are temporarily paused.';
  if (!hasInstructions) return 'New orders are temporarily unavailable (payment instructions are not configured).';
  if (!hasFee) return 'New orders are temporarily unavailable (no fee schedule).';
  return null;
}

const EDITABLE = [
  'enabled',
  'paused',
  'pause_reason',
  'min_send_amount',
  'max_send_amount',
  'quote_ttl_seconds',
  'payment_window_minutes',
  'payout_sla_hours',
  'rate_max_age_seconds',
  'payout_terms',
] as const;

export async function updateCorridor(db: Db, actor: ActorContext, id: number, changes: Partial<Corridor>): Promise<Corridor> {
  const before = await getCorridor(db, id);
  const next = { ...before };
  for (const key of EDITABLE) {
    if (changes[key] !== undefined) (next as Record<string, unknown>)[key] = changes[key];
  }
  if (new D(next.min_send_amount).gt(next.max_send_amount)) throw badRequest('invalid_limits', 'Minimum must not exceed maximum');
  if (next.paused && !next.pause_reason) next.pause_reason = 'New orders are temporarily paused.';
  if (!next.paused) next.pause_reason = null;
  const { rows } = await db.query<Corridor>(
    `UPDATE corridors SET enabled = $2, paused = $3, pause_reason = $4, min_send_amount = $5, max_send_amount = $6,
       quote_ttl_seconds = $7, payment_window_minutes = $8, payout_sla_hours = $9, rate_max_age_seconds = $10,
       payout_terms = $11, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, next.enabled, next.paused, next.pause_reason, next.min_send_amount, next.max_send_amount,
     next.quote_ttl_seconds, next.payment_window_minutes, next.payout_sla_hours, next.rate_max_age_seconds, next.payout_terms],
  );
  await audit(db, actor, {
    action: before.paused !== rows[0].paused ? (rows[0].paused ? 'corridor.pause' : 'corridor.resume') : 'corridor.update',
    entityType: 'corridor',
    entityId: String(id),
    before,
    after: rows[0],
  });
  return rows[0];
}

export async function createFeeVersion(
  db: Db,
  actor: ActorContext,
  corridorId: number,
  params: { feeRate: string; note?: string; effectiveFrom?: Date },
): Promise<FeeSchedule> {
  const rate = new D(params.feeRate);
  if (!rate.isFinite() || rate.lt(0) || rate.gte(0.2)) throw badRequest('invalid_fee', 'Fee rate must be between 0 and 0.2');
  if (rate.decimalPlaces() > 6) throw badRequest('invalid_fee', 'Fee rate has too many decimal places');
  await getCorridor(db, corridorId);
  const { rows } = await db.query<FeeSchedule>(
    `INSERT INTO fee_schedules (corridor_id, version, fee_rate, note, effective_from, created_by)
     SELECT $1, COALESCE(MAX(version), 0) + 1, $2, $3, COALESCE($4, now()), $5 FROM fee_schedules WHERE corridor_id = $1
     RETURNING *`,
    [corridorId, rate.toFixed(), params.note ?? null, params.effectiveFrom ?? null, actor.id ?? null],
  );
  await audit(db, actor, { action: 'fee.new_version', entityType: 'corridor', entityId: String(corridorId), after: rows[0] });
  return rows[0];
}

export async function replaceInstructions(
  db: Db,
  actor: ActorContext,
  corridorId: number,
  params: { methodLabel: string; instructions: string },
): Promise<PaymentInstruction> {
  await getCorridor(db, corridorId);
  const before = await activeInstructions(db, corridorId);
  await db.query('UPDATE payment_instructions SET active = FALSE WHERE corridor_id = $1 AND active', [corridorId]);
  const { rows } = await db.query<PaymentInstruction>(
    `INSERT INTO payment_instructions (corridor_id, method_label, instructions, created_by) VALUES ($1, $2, $3, $4) RETURNING *`,
    [corridorId, params.methodLabel, params.instructions, actor.id ?? null],
  );
  await audit(db, actor, {
    action: 'payment_instructions.replace',
    entityType: 'corridor',
    entityId: String(corridorId),
    before,
    after: rows[0],
  });
  return rows[0];
}

export async function deactivateInstructions(db: Db, actor: ActorContext, corridorId: number): Promise<void> {
  const before = await activeInstructions(db, corridorId);
  if (!before) return;
  await db.query('UPDATE payment_instructions SET active = FALSE WHERE id = $1', [before.id]);
  await audit(db, actor, { action: 'payment_instructions.deactivate', entityType: 'corridor', entityId: String(corridorId), before });
}
