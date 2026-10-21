import type pg from 'pg';
import { config } from '../config.js';
import { withTransaction, type Db } from '../db/pool.js';
import { D } from '../domain/money.js';
import {
  allowedTransitions,
  canTransition,
  CUSTOMER_STATUS_LABEL,
  type OrderStatus,
} from '../domain/orderStatus.js';
import { generateOrderReference, generateToken, safeEqual, sha256 } from '../domain/reference.js';
import { AppError, badRequest, conflict, notFound, unavailable } from '../lib/errors.js';
import { audit, type ActorContext } from './audit.js';
import { activeInstructions, corridorUnavailableReason, currentFeeSchedule, getCorridor } from './corridors.js';
import { enqueueAdminEmail, notifyCustomer, type OrderForEmail } from './notifications.js';
import type { Quote } from './quotes.js';
import { getSettings } from './settings.js';
import { ALLOWED_UPLOADS, sanitizeFilename, sniffMime, type EvidenceStorage } from './storage.js';
import { recordSystemEvent } from './systemEvents.js';

export interface Order extends OrderForEmail {
  tracking_token_hash: string;
  quote_id: string;
  corridor_id: number;
  status_changed_at: Date;
  rate_kind: string;
  rate_source: string;
  rate_timestamp: Date;
  fee_schedule_id: number;
  fee_rate: string;
  gross_amount: string;
  terms_version: string;
  terms_accepted_at: Date;
  payment_instruction_id: number;
  payout_sla_hours: number;
  recipient_name: string;
  recipient_phone: string;
  recipient_country: string;
  payout_method: 'mobile_money' | 'bank_transfer';
  mobile_money_provider: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_branch: string | null;
  customer_transfer_reference: string | null;
  verified_amount: string | null;
  verified_reference: string | null;
  verified_at: Date | null;
  verified_by: string | null;
  payout_started_at: Date | null;
  payout_actual_amount: string | null;
  payout_reference: string | null;
  payout_date: string | null;
  payout_discrepancy_note: string | null;
  completed_at: Date | null;
  refund_reason: string | null;
  refunded_at: Date | null;
  rejection_reason: string | null;
  cancellation_reason: string | null;
  flags: string[];
  pii_redacted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Recipient validation
// ---------------------------------------------------------------------------
export const MOBILE_MONEY_PROVIDERS = ['MTN MoMo', 'Telecel Cash', 'AirtelTigo Money'] as const;

export interface RecipientInput {
  recipientName?: unknown;
  recipientPhone?: unknown;
  recipientCountry?: unknown;
  payoutMethod?: unknown;
  mobileMoneyProvider?: unknown;
  bankName?: unknown;
  bankAccountNumber?: unknown;
  bankBranch?: unknown;
  customerEmail?: unknown;
}

export interface Recipient {
  recipientName: string;
  recipientPhone: string;
  recipientCountry: 'GH';
  payoutMethod: 'mobile_money' | 'bank_transfer';
  mobileMoneyProvider: string | null;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankBranch: string | null;
  customerEmail: string | null;
}

/** Normalises Ghanaian numbers to E.164 (+233XXXXXXXXX). Accepts 0XXXXXXXXX, 233…, +233…. */
export function normalizeGhanaPhone(raw: string): string | null {
  const digits = raw.replace(/[\s()-]/g, '');
  const m = /^(?:\+?233|0)([235]\d{8})$/.exec(digits);
  return m ? `+233${m[1]}` : null;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function validateRecipient(input: RecipientInput): Recipient {
  const errors: Record<string, string> = {};
  const name = str(input.recipientName).replace(/\s+/g, ' ');
  if (name.length < 3 || name.length > 100 || !/^[\p{L}][\p{L} .'-]+$/u.test(name))
    errors.recipientName = "Enter the recipient's full name as registered on the account.";
  const phone = normalizeGhanaPhone(str(input.recipientPhone));
  if (!phone) errors.recipientPhone = 'Enter a valid Ghana phone number, e.g. 024 123 4567 or +233 24 123 4567.';
  const country = str(input.recipientCountry || 'GH').toUpperCase();
  if (country !== 'GH') errors.recipientCountry = 'Payouts are currently only available in Ghana.';
  const method = str(input.payoutMethod);
  let mobileMoneyProvider: string | null = null;
  let bankName: string | null = null;
  let bankAccountNumber: string | null = null;
  let bankBranch: string | null = null;
  if (method === 'mobile_money') {
    const p = str(input.mobileMoneyProvider);
    if (!(MOBILE_MONEY_PROVIDERS as readonly string[]).includes(p)) errors.mobileMoneyProvider = 'Choose a mobile money provider.';
    else mobileMoneyProvider = p;
  } else if (method === 'bank_transfer') {
    bankName = str(input.bankName);
    if (bankName.length < 2 || bankName.length > 100) errors.bankName = 'Enter the bank name.';
    bankAccountNumber = str(input.bankAccountNumber).replace(/\s/g, '');
    if (!/^\d{6,20}$/.test(bankAccountNumber)) errors.bankAccountNumber = 'Account number must be 6–20 digits.';
    bankBranch = str(input.bankBranch) || null;
    if (bankBranch && bankBranch.length > 100) errors.bankBranch = 'Branch name is too long.';
  } else {
    errors.payoutMethod = 'Choose how the recipient will be paid.';
  }
  const email = str(input.customerEmail).toLowerCase() || null;
  if (email && (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) errors.customerEmail = 'Enter a valid email address.';
  if (Object.keys(errors).length) throw badRequest('invalid_recipient', 'Please correct the highlighted fields.', errors);
  return {
    recipientName: name,
    recipientPhone: phone!,
    recipientCountry: 'GH',
    payoutMethod: method as Recipient['payoutMethod'],
    mobileMoneyProvider,
    bankName,
    bankAccountNumber,
    bankBranch,
    customerEmail: email,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function lockOrder(client: pg.PoolClient, id: string): Promise<Order> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Order not found');
  const { rows } = await client.query<Order>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw notFound('Order not found');
  return rows[0];
}

const PATCHABLE = new Set([
  'status', 'status_changed_at', 'payout_due_at', 'customer_transfer_reference', 'verified_amount', 'verified_reference',
  'verified_at', 'verified_by', 'payout_started_at', 'payout_actual_amount', 'payout_reference', 'payout_date',
  'payout_discrepancy_note', 'completed_at', 'completed_by', 'refund_amount', 'refund_currency', 'refund_reason',
  'refund_reference', 'refunded_at', 'rejection_reason', 'cancellation_reason', 'operator_message', 'flags',
  'tracking_token_hash', 'payout_warning_sent_at', 'payout_overdue_sent_at',
]);

async function patchOrder(client: pg.PoolClient, id: string, patch: Record<string, unknown>): Promise<Order> {
  const keys = Object.keys(patch);
  for (const k of keys) if (!PATCHABLE.has(k)) throw new Error(`Column ${k} is not patchable`);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const { rows } = await client.query<Order>(`UPDATE orders SET ${sets} WHERE id = $1 RETURNING *`, [id, ...keys.map((k) => patch[k])]);
  return rows[0];
}

function pick(o: Order, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, (o as unknown as Record<string, unknown>)[k]]));
}

/**
 * The single path for status changes. Enforces the transition table, writes status
 * history + audit log, and enqueues notifications — all inside the caller's transaction.
 */
async function transition(
  client: pg.PoolClient,
  order: Order,
  to: OrderStatus,
  actor: ActorContext,
  opts: { patch?: Record<string, unknown>; customerNote?: string | null; action: string; reason?: string | null } = { action: 'order.transition' },
): Promise<Order> {
  if (!canTransition(order.status, to, actor.type)) {
    throw conflict(
      'invalid_transition',
      `Cannot change order from ${order.status} to ${to}. Allowed: ${allowedTransitions(order.status, actor.type).join(', ') || 'none'}.`,
    );
  }
  const patch = { ...(opts.patch ?? {}), status: to, status_changed_at: new Date() };
  const updated = await patchOrder(client, order.id, patch);
  await client.query(
    `INSERT INTO order_status_history (order_id, from_status, to_status, actor_type, actor_id, customer_note)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [order.id, order.status, to, actor.type, actor.id ?? null, opts.customerNote ?? null],
  );
  const changed = Object.keys(patch);
  await audit(client, actor, {
    action: opts.action,
    entityType: 'order',
    entityId: order.id,
    before: pick(order, changed),
    after: pick(updated, changed),
    reason: opts.reason ?? null,
  });
  return updated;
}

function trackingUrl(reference: string, token: string): string {
  return `${config.publicBaseUrl}/track/${encodeURIComponent(reference)}#t=${token}`;
}

// ---------------------------------------------------------------------------
// Customer operations
// ---------------------------------------------------------------------------
export async function createOrder(
  params: { quoteId: string; recipient: RecipientInput; termsAccepted: unknown; termsVersion: unknown; ip?: string | null },
  now: Date = new Date(),
): Promise<{ order: Order; trackingToken: string; trackingUrl: string }> {
  if (params.termsAccepted !== true) throw badRequest('terms_not_accepted', 'You must accept the displayed terms to continue.');
  const recipient = validateRecipient(params.recipient);
  if (!/^[0-9a-f-]{36}$/i.test(params.quoteId)) throw notFound('Quote not found');

  const result = await withTransaction(async (client) => {
    const { rows: qrows } = await client.query<Quote>('SELECT * FROM quotes WHERE id = $1 FOR UPDATE', [params.quoteId]);
    const quote = qrows[0];
    if (!quote) throw notFound('Quote not found');
    if (quote.accepted_at) {
      // Idempotency: a double-click or retried request must not create a second order.
      throw conflict('quote_already_used', 'This quote has already been confirmed. Check your tracking link or email.');
    }
    if (new Date(quote.expires_at) <= now) throw new AppError(410, 'quote_expired', 'This quote has expired. Please get a new quote.');

    const settings = await getSettings(client);
    if (params.termsVersion !== settings.terms_version) {
      throw conflict('terms_changed', 'The terms have been updated. Please review them again.');
    }
    const corridor = await getCorridor(client, quote.corridor_id);
    const instructions = await activeInstructions(client, corridor.id);
    const fee = await currentFeeSchedule(client, corridor.id);
    const reason = corridorUnavailableReason(corridor, !!instructions, !!fee);
    if (reason) throw unavailable('corridor_unavailable', reason);

    const token = generateToken();
    const paymentDueAt = new Date(now.getTime() + corridor.payment_window_minutes * 60_000);
    let order: Order | undefined;
    for (let attempt = 0; attempt < 5 && !order; attempt++) {
      const reference = generateOrderReference();
      await client.query('SAVEPOINT ref');
      try {
        const { rows } = await client.query<Order>(
          `INSERT INTO orders (reference, tracking_token_hash, quote_id, corridor_id, status,
             send_currency, receive_currency, send_amount, rate, rate_kind, rate_source, rate_timestamp, fee_schedule_id,
             fee_rate, gross_amount, fee_amount, payout_amount, terms_version, terms_accepted_at, payment_instruction_id,
             payout_sla_hours, customer_email, recipient_name, recipient_phone, recipient_country, payout_method,
             mobile_money_provider, bank_name, bank_account_number, bank_branch, payment_due_at, created_at, status_changed_at)
           VALUES ($1,$2,$3,$4,'awaiting_payment',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
                   $24,$25,$26,$27,$28,$29,$30,$31,$31)
           RETURNING *`,
          [
            reference, sha256(token), quote.id, corridor.id, quote.send_currency, quote.receive_currency, quote.send_amount,
            quote.rate, quote.rate_kind, quote.rate_source, quote.rate_timestamp, quote.fee_schedule_id, quote.fee_rate,
            quote.gross_amount, quote.fee_amount, quote.payout_amount, settings.terms_version, now, instructions!.id,
            corridor.payout_sla_hours, recipient.customerEmail, recipient.recipientName, recipient.recipientPhone,
            recipient.recipientCountry, recipient.payoutMethod, recipient.mobileMoneyProvider, recipient.bankName,
            recipient.bankAccountNumber, recipient.bankBranch, paymentDueAt, now,
          ],
        );
        order = rows[0];
        await client.query('RELEASE SAVEPOINT ref');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT ref');
        if ((err as { code?: string }).code !== '23505') throw err;
      }
    }
    if (!order) throw new Error('Could not allocate an order reference');

    await client.query('UPDATE quotes SET accepted_at = $2 WHERE id = $1', [quote.id, now]);
    await client.query(
      `INSERT INTO order_status_history (order_id, from_status, to_status, actor_type) VALUES ($1, NULL, 'awaiting_payment', 'customer')`,
      [order.id],
    );
    const customer: ActorContext = { type: 'customer', label: recipient.customerEmail ?? recipient.recipientPhone, ip: params.ip };
    await audit(client, customer, {
      action: 'order.create',
      entityType: 'order',
      entityId: order.id,
      after: {
        reference: order.reference, quote_id: quote.id, send_amount: order.send_amount, rate: order.rate,
        rate_source: order.rate_source, rate_timestamp: order.rate_timestamp, fee_rate: order.fee_rate,
        fee_schedule_id: order.fee_schedule_id, gross_amount: order.gross_amount, fee_amount: order.fee_amount,
        payout_amount: order.payout_amount, terms_version: order.terms_version, payment_instruction_id: order.payment_instruction_id,
      },
    });

    order = await screenNewOrder(client, order, settings);

    const url = trackingUrl(order.reference, token);
    await notifyCustomer(client, order, 'order_confirmed', { trackingUrl: url });
    await enqueueAdminEmail(client, {
      template: 'admin.new_order',
      subject: `New order ${order.reference}: ${order.send_amount} ${order.send_currency} → ${order.payout_amount} ${order.receive_currency}`,
      body: `A new exchange order was confirmed.\n\nReference: ${order.reference}\nSend: ${order.send_amount} ${order.send_currency}\nPayout: ${order.payout_amount} ${order.receive_currency}\nFee: ${order.fee_amount} ${order.receive_currency}\nFlags: ${order.flags.join(', ') || 'none'}`,
      orderId: order.id,
      dedupeKey: `admin.new_order:${order.id}`,
    });
    return { order, trackingToken: token, trackingUrl: url };
  });
  return result;
}

/** Unusual-activity checks. They flag and alert; they never silently block a customer. */
async function screenNewOrder(client: pg.PoolClient, order: Order, settings: Awaited<ReturnType<typeof getSettings>>): Promise<Order> {
  const flags: string[] = [];
  const threshold = settings.unusual_amount_threshold?.[order.send_currency];
  if (threshold && new D(order.send_amount).gte(threshold)) flags.push('large_amount');
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM orders WHERE recipient_phone = $1 AND created_at > now() - interval '24 hours'`,
    [order.recipient_phone],
  );
  if (Number(rows[0].n) > settings.max_orders_per_phone_24h) flags.push('high_frequency_recipient');
  if (!flags.length) return order;
  const updated = await patchOrder(client, order.id, { flags });
  await recordSystemEvent(client, {
    kind: 'unusual_order_activity',
    severity: 'warning',
    message: `Order ${order.reference} flagged for review: ${flags.join(', ')}`,
    detail: { flags },
    orderId: order.id,
  });
  return updated;
}

export async function findOrderForCustomer(db: Db, reference: string, token: string): Promise<Order> {
  const { rows } = await db.query<Order>('SELECT * FROM orders WHERE reference = $1', [reference.toUpperCase()]);
  const order = rows[0];
  // Same error for unknown reference and wrong token, compared in constant time.
  if (!order || !token || !safeEqual(order.tracking_token_hash, sha256(token))) throw notFound('Order not found. Check your tracking link.');
  return order;
}

function maskPhone(p: string): string {
  return p.length > 6 ? `${p.slice(0, 6)}•••${p.slice(-3)}` : '•••';
}

function maskAccount(a: string | null): string | null {
  return a ? `•••${a.slice(-4)}` : null;
}

/** What the customer sees on the private tracking page. */
export async function trackingView(db: Db, order: Order) {
  const [history, proofs, instr, settings] = await Promise.all([
    db.query<{ to_status: OrderStatus; customer_note: string | null; created_at: Date }>(
      'SELECT to_status, customer_note, created_at FROM order_status_history WHERE order_id = $1 ORDER BY id',
      [order.id],
    ),
    db.query<{ submitted_at: Date; review_status: string; original_filename: string }>(
      `SELECT submitted_at, review_status, original_filename FROM payment_proofs WHERE order_id = $1 AND deleted_at IS NULL ORDER BY submitted_at`,
      [order.id],
    ),
    db.query<{ method_label: string; instructions: string }>('SELECT method_label, instructions FROM payment_instructions WHERE id = $1', [
      order.payment_instruction_id,
    ]),
    getSettings(db),
  ]);
  const canUpload = canTransition(order.status, 'proof_submitted', 'customer');
  return {
    reference: order.reference,
    status: order.status,
    statusLabel: CUSTOMER_STATUS_LABEL[order.status],
    statusChangedAt: order.status_changed_at,
    updatedAt: order.updated_at,
    createdAt: order.created_at,
    terms: {
      sendAmount: order.send_amount,
      sendCurrency: order.send_currency,
      receiveCurrency: order.receive_currency,
      rate: order.rate,
      rateSource: order.rate_source,
      rateTimestamp: order.rate_timestamp,
      feeRate: order.fee_rate,
      grossAmount: order.gross_amount,
      feeAmount: order.fee_amount,
      payoutAmount: order.payout_amount,
      termsVersion: order.terms_version,
      acceptedAt: order.terms_accepted_at,
    },
    recipient: {
      name: order.recipient_name,
      phone: maskPhone(order.recipient_phone),
      payoutMethod: order.payout_method,
      mobileMoneyProvider: order.mobile_money_provider,
      bankName: order.bank_name,
      bankAccount: maskAccount(order.bank_account_number),
    },
    paymentDueAt: order.payment_due_at,
    payoutDueAt: order.payout_due_at,
    expectedPayoutHours: order.payout_sla_hours,
    paymentInstructions: ['awaiting_payment', 'proof_submitted', 'resubmission_requested'].includes(order.status) ? instr.rows[0] : null,
    customerTransferReference: order.customer_transfer_reference,
    operatorMessage: order.operator_message,
    canUploadProof: canUpload,
    canCancel: canTransition(order.status, 'cancelled', 'customer'),
    proofs: proofs.rows,
    timeline: history.rows.map((h) => ({ status: h.to_status, label: CUSTOMER_STATUS_LABEL[h.to_status], note: h.customer_note, at: h.created_at })),
    completion:
      order.status === 'completed'
        ? { payoutAmount: order.payout_actual_amount, payoutReference: order.payout_reference, payoutDate: order.payout_date }
        : null,
    refund:
      order.status === 'refunded'
        ? { amount: order.refund_amount, currency: order.refund_currency, reference: order.refund_reference, reason: order.refund_reason }
        : null,
    support: {
      email: settings.support_email,
      phone: settings.support_phone,
      whatsapp: settings.support_whatsapp,
      hours: settings.operating_hours,
    },
  };
}

export async function submitProof(
  storage: EvidenceStorage,
  params: { reference: string; token: string; file?: { buffer: Buffer; originalname: string; size: number }; transferReference?: unknown; ip?: string | null },
): Promise<Order> {
  const file = params.file;
  if (!file || !file.buffer?.length) throw badRequest('file_required', 'Attach a receipt (JPG, PNG or PDF).');
  if (file.size > config.storage.maxBytes)
    throw badRequest('file_too_large', `The file must be ${Math.floor(config.storage.maxBytes / 1024 / 1024)} MB or smaller.`);
  const mime = sniffMime(file.buffer);
  if (!mime) throw badRequest('unsupported_file', 'Only JPG, PNG or PDF receipts are accepted.');
  const transferReference = str(params.transferReference) || null;
  if (transferReference && (transferReference.length > 100 || !/^[\w\s./#:-]+$/.test(transferReference)))
    throw badRequest('invalid_reference', 'The transfer reference contains unsupported characters.');
  const hash = sha256(file.buffer);

  // Store first (outside the transaction); an orphaned file is harmless, a lost one is not.
  const key = await storage.put(file.buffer, ALLOWED_UPLOADS[mime]);
  try {
    return await withTransaction(async (client) => {
      const found = await findOrderForCustomer(client, params.reference, params.token);
      const order = await lockOrder(client, found.id);
      if (!canTransition(order.status, 'proof_submitted', 'customer'))
        throw conflict('proof_not_accepted', 'Payment proof cannot be submitted for this order in its current status.');
      const { rows: count } = await client.query<{ n: string }>('SELECT count(*) AS n FROM payment_proofs WHERE order_id = $1', [order.id]);
      if (Number(count[0].n) >= 10) throw conflict('too_many_proofs', 'Too many uploads for this order. Please contact support.');

      await client.query(`UPDATE payment_proofs SET review_status = 'superseded' WHERE order_id = $1 AND review_status = 'pending'`, [order.id]);
      const { rows: proofRows } = await client.query<{ id: string }>(
        `INSERT INTO payment_proofs (order_id, storage_key, original_filename, mime_type, size_bytes, sha256, transfer_reference)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [order.id, key, sanitizeFilename(file.originalname), mime, file.size, hash, transferReference],
      );

      // Duplicate checks: same file or same transfer reference used on a different order.
      const flags = new Set(order.flags);
      const dupFile = await client.query<{ reference: string }>(
        `SELECT DISTINCT o.reference FROM payment_proofs p JOIN orders o ON o.id = p.order_id WHERE p.sha256 = $1 AND p.order_id <> $2`,
        [hash, order.id],
      );
      const dupRef = transferReference
        ? await client.query<{ reference: string }>(
            `SELECT reference FROM orders WHERE id <> $2 AND (lower(customer_transfer_reference) = lower($1) OR lower(verified_reference) = lower($1))`,
            [transferReference, order.id],
          )
        : { rows: [] };
      if (dupFile.rows.length) flags.add('duplicate_receipt');
      if (dupRef.rows.length) flags.add('duplicate_transfer_reference');

      const actor: ActorContext = { type: 'customer', label: order.customer_email ?? order.recipient_phone, ip: params.ip };
      const updated = await transition(client, order, 'proof_submitted', actor, {
        action: 'order.proof_submitted',
        patch: { customer_transfer_reference: transferReference ?? order.customer_transfer_reference, flags: [...flags] },
      });
      await audit(client, actor, {
        action: 'proof.upload',
        entityType: 'payment_proof',
        entityId: proofRows[0].id,
        after: { order_id: order.id, sha256: hash, mime, size: file.size, transfer_reference: transferReference },
      });
      if (dupFile.rows.length || dupRef.rows.length) {
        await recordSystemEvent(client, {
          kind: 'duplicate_payment_evidence',
          severity: 'critical',
          message: `Order ${order.reference}: payment evidence matches other order(s) ${[...dupFile.rows, ...dupRef.rows].map((r) => r.reference).join(', ')}`,
          orderId: order.id,
        });
      }
      await notifyCustomer(client, updated, 'proof_submitted', { dedupeSuffix: proofRows[0].id });
      await enqueueAdminEmail(client, {
        template: 'admin.proof_submitted',
        subject: `Payment proof submitted for ${order.reference}`,
        body: `Proof uploaded for ${order.reference} (${order.send_amount} ${order.send_currency}). Transfer reference: ${transferReference ?? '—'}.\nVerify the funds in your account before approving.${flags.size ? `\nFlags: ${[...flags].join(', ')}` : ''}`,
        orderId: order.id,
        dedupeKey: `admin.proof:${proofRows[0].id}`,
      });
      return updated;
    });
  } catch (err) {
    await storage.delete(key).catch(() => {});
    throw err;
  }
}

export async function customerCancel(params: { reference: string; token: string; ip?: string | null }): Promise<Order> {
  return withTransaction(async (client) => {
    const found = await findOrderForCustomer(client, params.reference, params.token);
    const order = await lockOrder(client, found.id);
    const updated = await transition(client, order, 'cancelled', { type: 'customer', label: order.customer_email ?? order.recipient_phone, ip: params.ip }, {
      action: 'order.cancel',
      patch: { cancellation_reason: 'Cancelled by customer' },
      reason: 'Cancelled by customer',
    });
    await notifyCustomer(client, updated, 'cancelled');
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Operator operations
// ---------------------------------------------------------------------------
function requireText(v: unknown, field: string, max = 500): string {
  const s = str(v);
  if (!s) throw badRequest('missing_field', `${field} is required.`);
  if (s.length > max) throw badRequest('invalid_field', `${field} is too long.`);
  return s;
}

function requireAmount(v: unknown, field: string) {
  const s = str(typeof v === 'number' ? String(v) : v);
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw badRequest('invalid_amount', `${field} must be an amount with up to 2 decimals.`);
  return new D(s);
}

export async function verifyPayment(
  actor: ActorContext,
  orderId: string,
  input: { verifiedAmount: unknown; verifiedReference: unknown; fundsConfirmed: unknown; note?: unknown },
): Promise<Order> {
  if (input.fundsConfirmed !== true)
    throw badRequest('funds_not_confirmed', 'Confirm that you independently checked the funds arrived in the receiving account.');
  const amount = requireAmount(input.verifiedAmount, 'Verified amount');
  const reference = requireText(input.verifiedReference, 'Payment reference', 100);
  const note = str(input.note) || null;
  return withTransaction(async (client) => {
    const order = await lockOrder(client, orderId);
    if (amount.lt(order.send_amount))
      throw badRequest('underpaid', `Received ${amount.toFixed(2)} is less than the agreed ${order.send_amount} ${order.send_currency}. Request a top-up, or reject and refund.`);
    if (amount.gt(order.send_amount) && !note)
      throw badRequest('note_required', 'The received amount exceeds the agreed amount. Add a note explaining how the difference is handled.');
    const dup = await client.query<{ reference: string }>(
      'SELECT reference FROM orders WHERE id <> $1 AND lower(verified_reference) = lower($2)',
      [order.id, reference],
    );
    if (dup.rows.length)
      throw conflict('duplicate_reference', `Payment reference already used to verify order ${dup.rows[0].reference}.`);
    const now = new Date();
    const updated = await transition(client, order, 'payment_verified', actor, {
      action: 'order.payment_verified',
      reason: note,
      customerNote: 'Your payment has been confirmed.',
      patch: {
        verified_amount: amount.toFixed(2),
        verified_reference: reference,
        verified_at: now,
        verified_by: actor.id,
        payout_due_at: new Date(now.getTime() + order.payout_sla_hours * 3600_000),
      },
    });
    await client.query(
      `UPDATE payment_proofs SET review_status = 'accepted', reviewed_by = $2, reviewed_at = now(), review_note = $3
       WHERE order_id = $1 AND review_status = 'pending'`,
      [order.id, actor.id, note],
    );
    await notifyCustomer(client, updated, 'payment_verified');
    await enqueueAdminEmail(client, {
      template: 'admin.payment_confirmed',
      subject: `Payment confirmed for ${order.reference} — payout due by ${updated.payout_due_at?.toISOString()}`,
      body: `Payment of ${amount.toFixed(2)} ${order.send_currency} verified (ref ${reference}) by ${actor.label}.\nPay ${order.payout_amount} ${order.receive_currency} to the recipient.`,
      orderId: order.id,
      dedupeKey: `admin.verified:${order.id}`,
    });
    return updated;
  });
}

export async function requestResubmission(actor: ActorContext, orderId: string, input: { message: unknown }): Promise<Order> {
  const message = requireText(input.message, 'Message to customer');
  return withTransaction(async (client) => {
    const order = await lockOrder(client, orderId);
    const updated = await transition(client, order, 'resubmission_requested', actor, {
      action: 'order.resubmission_requested',
      reason: message,
      customerNote: message,
      patch: { operator_message: message },
    });
    await client.query(
      `UPDATE payment_proofs SET review_status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_note = $3
       WHERE order_id = $1 AND review_status = 'pending'`,
      [order.id, actor.id, message],
    );
    await notifyCustomer(client, updated, 'resubmission_requested', { dedupeSuffix: String(Date.now()) });
    await enqueueAdminEmail(client, {
      template: 'admin.verification_failed',
      subject: `Verification failed for ${order.reference}: new proof requested`,
      body: `${actor.label} requested new payment proof: ${message}`,
      orderId: order.id,
    });
    return updated;
  });
}

export async function rejectOrder(actor: ActorContext, orderId: string, input: { reason: unknown; customerMessage?: unknown }): Promise<Order> {
  const reason = requireText(input.reason, 'Reason');
  const customerMessage = str(input.customerMessage) || null;
  return withTransaction(async (client) => {
    const order = await lockOrder(client, orderId);
    const updated = await transition(client, order, 'rejected', actor, {
      action: 'order.reject',
      reason,
      customerNote: customerMessage,
      patch: { rejection_reason: reason, operator_message: customerMessage ?? order.operator_message },
    });
    await client.query(
      `UPDATE payment_proofs SET review_status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_note = $3
       WHERE order_id = $1 AND review_status = 'pending'`,
      [order.id, actor.id, reason],
    );
    await notifyCustomer(client, updated, 'rejected');
    await enqueueAdminEmail(client, {
      template: 'admin.verification_failed',
      subject: `Order ${order.reference} rejected`,
      body: `${actor.label} rejected ${order.reference}: ${reason}`,
      orderId: order.id,
    });
    return updated;
  });
}

export async function adminCancel(actor: ActorContext, orderId: string, input: { reason: unknown }): Promise<Order> {
  const reason = requireText(input.reason, 'Reason');
  return withTransaction(async (client) => {
    const order = await lockOrder(client, orderId);
    const updated = await transition(client, order, 'cancelled', actor, {
      action: 'order.cancel',
      reason,
      customerNote: reason,
      patch: { cancellation_reason: reason },
    });
    await notifyCustomer(client, updated, 'cancelled');
    return updated;
  });
}

export async function startPayout(actor: ActorContext, orderId: string): Promise<Order> {
  return withTransaction(async (client) => {
    const order = await lockOrder(client, orderId);
    if (!order.verified_at) throw conflict('payment_unverified', 'Payment must be verified before payout.');
    const updated = await transition(client, order, 'payout_processing', actor, {
      action: 'order.payout_started',
      patch: { payout_started_at: new Date() },
    });
    await notifyCustomer(client, updated, 'payout_processing');
    return updated;
  });
}

export async function revertPayout(actor: ActorContext, orderId: string, input: { reason: unknown }): Promise<Order> {
  const reason = requireText(input.reason, 'Reason');
  return withTransaction(async (client) => {
    const order = await lockOrder(client, orderId);
    return transition(client, order, 'payment_verified', actor, { action: 'order.payout_reverted', reason, patch: { payout_started_at: null } });
  });
}

export async function completePayout(
  actor: ActorContext,
  orderId: string,
  input: { actualAmount: unknown; payoutReference: unknown; payoutDate: unknown; discrepancyNote?: unknown },
): Promise<Order> {
  const actual = requireAmount(input.actualAmount, 'Actual payout amount');
  const reference = requireText(input.payoutReference, 'Payout reference', 100);
  const date = str(input.payoutDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw badRequest('invalid_date', 'Payout date must be YYYY-MM-DD.');
  if (new Date(date).getTime() > Date.now() + 86_400_000) throw badRequest('invalid_date', 'Payout date cannot be in the future.');
  const note = str(input.discrepancyNote) || null;
  return withTransaction(async (client) => {
    const order = await lockOrder(client, orderId);
    if (!order.verified_at) throw conflict('payment_unverified', 'Cannot complete an order whose payment is unverified.');
    if (!actual.eq(order.payout_amount) && !note)
      throw badRequest('discrepancy_note_required', `Actual payout differs from the agreed ${order.payout_amount} ${order.receive_currency}. Explain the discrepancy.`);
    const flags = new Set(order.flags);
    if (!actual.eq(order.payout_amount)) flags.add('payout_discrepancy');
    const updated = await transition(client, order, 'completed', actor, {
      action: 'order.completed',
      reason: note,
      customerNote: 'Your payout has been sent.',
      patch: {
        payout_actual_amount: actual.toFixed(2),
        payout_reference: reference,
        payout_date: date,
        payout_discrepancy_note: note,
        completed_at: new Date(),
        completed_by: actor.id,
        flags: [...flags],
      },
    });
    await notifyCustomer(client, updated, 'completed');
    await enqueueAdminEmail(client, {
      template: 'admin.payout_completed',
      subject: `Payout completed for ${order.reference}`,
      body: `${actor.label} paid ${actual.toFixed(2)} ${order.receive_currency} (ref ${reference}) on ${date}.${note ? `\nDiscrepancy: ${note}` : ''}`,
      orderId: order.id,
      dedupeKey: `admin.completed:${order.id}`,
    });
    return updated;
  });
}

export async function refundOrder(
  actor: ActorContext,
  orderId: string,
  input: { amount: unknown; currency?: unknown; reason: unknown; reference: unknown },
): Promise<Order> {
  const amount = requireAmount(input.amount, 'Refund amount');
  const reason = requireText(input.reason, 'Reason');
  const reference = requireText(input.reference, 'Refund reference', 100);
  return withTransaction(async (client) => {
    const order = await lockOrder(client, orderId);
    const currency = str(input.currency) || order.send_currency;
    if (currency !== order.send_currency) throw badRequest('invalid_currency', `Refunds are recorded in ${order.send_currency}.`);
    if (order.verified_amount && amount.gt(order.verified_amount))
      throw badRequest('refund_too_large', `Refund cannot exceed the verified amount ${order.verified_amount}.`);
    const updated = await transition(client, order, 'refunded', actor, {
      action: 'order.refunded',
      reason,
      customerNote: reason,
      patch: { refund_amount: amount.toFixed(2), refund_currency: currency, refund_reason: reason, refund_reference: reference, refunded_at: new Date() },
    });
    await notifyCustomer(client, updated, 'refunded');
    return updated;
  });
}

export async function setOperatorMessage(actor: ActorContext, orderId: string, input: { message: unknown }): Promise<Order> {
  const message = str(input.message) || null;
  if (message && message.length > 500) throw badRequest('invalid_field', 'Message is too long.');
  return withTransaction(async (client) => {
    const order = await lockOrder(client, orderId);
    const updated = await patchOrder(client, order.id, { operator_message: message });
    await audit(client, actor, {
      action: 'order.operator_message',
      entityType: 'order',
      entityId: order.id,
      before: { operator_message: order.operator_message },
      after: { operator_message: message },
    });
    return updated;
  });
}

/** Issues a new private tracking link (the old one stops working). */
export async function reissueTrackingLink(actor: ActorContext, orderId: string): Promise<{ trackingUrl: string; emailed: boolean }> {
  return withTransaction(async (client) => {
    const order = await lockOrder(client, orderId);
    const token = generateToken();
    await patchOrder(client, order.id, { tracking_token_hash: sha256(token) });
    await audit(client, actor, { action: 'order.tracking_link_reissued', entityType: 'order', entityId: order.id });
    const url = trackingUrl(order.reference, token);
    if (order.customer_email) {
      await notifyCustomer(client, order, 'order_confirmed', { trackingUrl: url, dedupeSuffix: `reissue:${token.slice(0, 8)}` });
    }
    return { trackingUrl: url, emailed: !!order.customer_email };
  });
}

// ---------------------------------------------------------------------------
// System jobs
// ---------------------------------------------------------------------------
export async function expireUnpaidOrders(now: Date = new Date()): Promise<number> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<Order>(
      `SELECT * FROM orders WHERE status = 'awaiting_payment' AND payment_due_at < $1 FOR UPDATE SKIP LOCKED LIMIT 100`,
      [now],
    );
    for (const order of rows) {
      const updated = await transition(client, order, 'expired', { type: 'system', label: 'system' }, {
        action: 'order.expired',
        customerNote: 'No payment proof was received within the payment window.',
      });
      await notifyCustomer(client, updated, 'expired');
    }
    return rows.length;
  });
}

export async function checkPayoutDeadlines(now: Date = new Date()): Promise<{ warned: number; overdue: number }> {
  return withTransaction(async (client) => {
    const settings = await getSettings(client);
    const warnBefore = settings.payout_warning_hours ?? 4;
    const due = await client.query<Order>(
      `SELECT * FROM orders WHERE status IN ('payment_verified', 'payout_processing') AND payout_due_at IS NOT NULL
         AND payout_warning_sent_at IS NULL AND payout_due_at - make_interval(hours => $2) < $1
       FOR UPDATE SKIP LOCKED`,
      [now, warnBefore],
    );
    for (const o of due.rows) {
      await patchOrder(client, o.id, { payout_warning_sent_at: now });
      await enqueueAdminEmail(client, {
        template: 'admin.payout_due_soon',
        subject: `Payout due soon: ${o.reference} by ${o.payout_due_at?.toISOString()}`,
        body: `Pay ${o.payout_amount} ${o.receive_currency} for ${o.reference} before ${o.payout_due_at?.toISOString()} to meet the promised timeframe.`,
        orderId: o.id,
        dedupeKey: `admin.payout_due:${o.id}`,
      });
    }
    const overdue = await client.query<Order>(
      `SELECT * FROM orders WHERE status IN ('payment_verified', 'payout_processing') AND payout_due_at < $1
         AND payout_overdue_sent_at IS NULL FOR UPDATE SKIP LOCKED`,
      [now],
    );
    for (const o of overdue.rows) {
      await patchOrder(client, o.id, { payout_overdue_sent_at: now });
      await recordSystemEvent(client, {
        kind: 'payout_overdue',
        severity: 'critical',
        message: `Payout for ${o.reference} is past its promised deadline (${o.payout_due_at?.toISOString()}).`,
        orderId: o.id,
      });
    }
    return { warned: due.rows.length, overdue: overdue.rows.length };
  });
}
