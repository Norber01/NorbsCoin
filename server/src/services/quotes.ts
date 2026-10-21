import type { Db } from '../db/pool.js';
import { calculateQuote, parseAmount, D } from '../domain/money.js';
import { badRequest, notFound, unavailable } from '../lib/errors.js';
import type { RateService } from '../rates/rateService.js';
import {
  activeInstructions,
  corridorUnavailableReason,
  currentFeeSchedule,
  getCorridorByPair,
  type Corridor,
} from './corridors.js';

export interface Quote {
  id: string;
  corridor_id: number;
  send_currency: string;
  receive_currency: string;
  send_amount: string;
  rate: string;
  rate_snapshot_id: string;
  rate_kind: string;
  rate_source: string;
  rate_timestamp: Date;
  fee_schedule_id: number;
  fee_rate: string;
  gross_amount: string;
  fee_amount: string;
  payout_amount: string;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
}

export async function loadAvailableCorridor(db: Db, from: string, to: string) {
  const corridor = await getCorridorByPair(db, from, to);
  if (!corridor) throw notFound(`${from} → ${to} is not supported`);
  const [instructions, fee] = await Promise.all([activeInstructions(db, corridor.id), currentFeeSchedule(db, corridor.id)]);
  const reason = corridorUnavailableReason(corridor, !!instructions, !!fee);
  return { corridor, instructions, fee, reason };
}

export function validateSendAmount(corridor: Corridor, raw: unknown) {
  const amount = parseAmount(raw, corridor.from_currency);
  if (!amount || amount.lte(0)) throw badRequest('invalid_amount', 'Enter a valid amount with at most 2 decimal places.');
  if (amount.lt(corridor.min_send_amount))
    throw badRequest('amount_below_minimum', `The minimum is ${corridor.min_send_amount} ${corridor.from_currency}.`);
  if (amount.gt(corridor.max_send_amount))
    throw badRequest('amount_above_maximum', `The maximum is ${corridor.max_send_amount} ${corridor.from_currency}.`);
  return amount;
}

/**
 * Creates a firm, time-limited quote. Quotes are only (re)calculated here — before the
 * customer confirms. Once an order exists the quote's numbers are locked by DB trigger.
 */
export async function createQuote(
  db: Db,
  rates: RateService,
  params: { from: string; to: string; sendAmount: unknown },
  now: Date = new Date(),
): Promise<Quote> {
  const { corridor, fee, reason } = await loadAvailableCorridor(db, params.from, params.to);
  if (reason) throw unavailable('corridor_unavailable', reason);
  const amount = validateSendAmount(corridor, params.sendAmount);
  const current = await rates.current(corridor.from_currency, corridor.to_currency, corridor.rate_max_age_seconds);
  if (!current.usable || !current.snapshot) {
    throw unavailable(current.stale ? 'rate_stale' : 'rate_unavailable', current.reason ?? 'Exchange rate unavailable.');
  }
  const snap = current.snapshot;
  const breakdown = calculateQuote({
    sendAmount: amount.toFixed(),
    rate: snap.rate,
    feeRate: fee!.fee_rate,
    sendCurrency: corridor.from_currency,
    receiveCurrency: corridor.to_currency,
  });
  if (new D(breakdown.payoutAmount).lte(0)) throw badRequest('invalid_amount', 'Amount is too small.');
  let expiresAt = new Date(now.getTime() + corridor.quote_ttl_seconds * 1000);
  // An operator rate must not outlive its own validity.
  if (snap.valid_until && new Date(snap.valid_until) < expiresAt) expiresAt = new Date(snap.valid_until);

  const { rows } = await db.query<Quote>(
    `INSERT INTO quotes (corridor_id, send_currency, receive_currency, send_amount, rate, rate_snapshot_id, rate_kind,
                         rate_source, rate_timestamp, fee_schedule_id, fee_rate, gross_amount, fee_amount, payout_amount,
                         created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [
      corridor.id, corridor.from_currency, corridor.to_currency, breakdown.sendAmount, snap.rate, snap.id, snap.kind,
      snap.source, snap.provider_timestamp, fee!.id, fee!.fee_rate, breakdown.grossAmount, breakdown.feeAmount,
      breakdown.payoutAmount, now, expiresAt,
    ],
  );
  return rows[0];
}

export async function getQuote(db: Db, id: string): Promise<Quote> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Quote not found');
  const { rows } = await db.query<Quote>('SELECT * FROM quotes WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Quote not found');
  return rows[0];
}

export function presentQuote(q: Quote, corridor: Corridor, now: Date = new Date()) {
  return {
    id: q.id,
    sendCurrency: q.send_currency,
    receiveCurrency: q.receive_currency,
    sendAmount: q.send_amount,
    rate: q.rate,
    rateKind: q.rate_kind,
    rateSource: q.rate_source,
    rateTimestamp: q.rate_timestamp,
    feeRate: q.fee_rate,
    feeBasis: 'deducted_from_gross',
    grossAmount: q.gross_amount,
    feeAmount: q.fee_amount,
    otherFees: [] as { label: string; amount: string }[],
    payoutAmount: q.payout_amount,
    createdAt: q.created_at,
    expiresAt: q.expires_at,
    expired: new Date(q.expires_at) <= now,
    accepted: !!q.accepted_at,
    payoutSlaHours: corridor.payout_sla_hours,
    payoutTerms: corridor.payout_terms,
    paymentWindowMinutes: corridor.payment_window_minutes,
  };
}
