import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { pool, type Db } from '../db/pool.js';
import { formatAmount } from '../domain/money.js';
import { CUSTOMER_STATUS_LABEL, type OrderStatus } from '../domain/orderStatus.js';
import { getSettings } from './settings.js';

/**
 * Emails go through a transactional outbox: they are inserted in the same DB transaction
 * as the order change and delivered later with retries. A failed email can therefore never
 * roll back or lose an order, and a retry never creates a second order.
 */
export async function enqueueEmail(
  db: Db,
  email: {
    to: string;
    audience: 'customer' | 'admin';
    template: string;
    subject: string;
    body: string;
    orderId?: string | null;
    dedupeKey?: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO email_outbox (to_address, audience, template, subject, body_text, order_id, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [email.to, email.audience, email.template, email.subject, email.body, email.orderId ?? null, email.dedupeKey ?? null],
  );
}

export async function enqueueAdminEmail(
  db: Db,
  email: { template: string; subject: string; body: string; orderId?: string | null; dedupeKey?: string | null },
): Promise<void> {
  const settings = await getSettings(db);
  const recipients = settings.admin_notification_emails ?? [];
  for (const to of recipients) {
    await enqueueEmail(db, {
      to,
      audience: 'admin',
      template: email.template,
      subject: `[${settings.business_name}] ${email.subject}`,
      body: `${email.body}\n\nAdmin dashboard: ${config.publicBaseUrl}/admin`,
      orderId: email.orderId,
      dedupeKey: email.dedupeKey ? `${email.dedupeKey}:${to}` : null,
    });
  }
}

export interface OrderForEmail {
  id: string;
  reference: string;
  status: OrderStatus;
  customer_email: string | null;
  send_amount: string;
  send_currency: string;
  payout_amount: string;
  receive_currency: string;
  rate: string;
  fee_amount: string;
  payment_due_at: Date;
  payout_due_at: Date | null;
  operator_message: string | null;
  refund_amount?: string | null;
  refund_currency?: string | null;
  refund_reference?: string | null;
}

function summary(o: OrderForEmail): string {
  return [
    `Order reference: ${o.reference}`,
    `You send: ${formatAmount(o.send_amount, o.send_currency)}`,
    `Exchange rate: 1 ${o.send_currency} = ${Number(o.rate)} ${o.receive_currency}`,
    `Service fee: ${formatAmount(o.fee_amount, o.receive_currency)}`,
    `Recipient gets: ${formatAmount(o.payout_amount, o.receive_currency)}`,
  ].join('\n');
}

/** Customer notification for a status change (or the initial confirmation). */
export async function notifyCustomer(
  db: Db,
  order: OrderForEmail,
  event: OrderStatus | 'order_confirmed',
  extra: { trackingUrl?: string; dedupeSuffix?: string } = {},
): Promise<void> {
  if (!order.customer_email) return;
  const settings = await getSettings(db);
  const contact = [settings.support_email, settings.support_phone, settings.support_whatsapp && `WhatsApp ${settings.support_whatsapp}`]
    .filter(Boolean)
    .join(' · ');
  const lines: string[] = [];
  let subject: string;
  if (event === 'order_confirmed') {
    subject = `Order ${order.reference} confirmed — payment instructions`;
    lines.push(
      'Thank you. Your exchange order has been created with the terms below, which are now fixed.',
      '',
      summary(order),
      '',
      `Please pay by ${order.payment_due_at.toISOString()} and include your order reference ${order.reference} in the transfer.`,
      `Track your order and upload payment proof here (keep this link private):`,
      extra.trackingUrl ?? '',
    );
  } else {
    subject = `Order ${order.reference}: ${CUSTOMER_STATUS_LABEL[event]}`;
    lines.push(`Your order status is now: ${CUSTOMER_STATUS_LABEL[event]}.`, '');
    if (event === 'proof_submitted') lines.push('We received your payment proof. We will check that the funds arrived before paying out.');
    if (event === 'resubmission_requested') lines.push('Please upload a corrected payment proof using your tracking link.');
    if (event === 'payment_verified' && order.payout_due_at)
      lines.push(`Your payment is confirmed. Expected payout by ${order.payout_due_at.toISOString()}.`);
    if (event === 'completed') lines.push(`Your payout of ${formatAmount(order.payout_amount, order.receive_currency)} has been sent.`);
    if (event === 'refunded' && order.refund_amount)
      lines.push(`A refund of ${order.refund_amount} ${order.refund_currency} was sent (reference ${order.refund_reference}).`);
    if (order.operator_message) lines.push('', `Message from us: ${order.operator_message}`);
    lines.push('', summary(order), '', 'Use the private tracking link from your confirmation email to see full details.');
  }
  if (contact) lines.push('', `Support: ${contact}`);
  await enqueueEmail(db, {
    to: order.customer_email,
    audience: 'customer',
    template: `customer.${event}`,
    subject: `[${settings.business_name}] ${subject}`,
    body: lines.join('\n'),
    orderId: order.id,
    dedupeKey: `customer.${event}:${order.id}:${extra.dedupeSuffix ?? ''}`,
  });
}

// ---------------------------------------------------------------------------
// Delivery worker
// ---------------------------------------------------------------------------
export interface MailTransport {
  send(msg: { from: string; to: string; subject: string; text: string }): Promise<void>;
}

export function createTransport(): MailTransport {
  if (config.email.transport === 'smtp') {
    if (!config.email.smtpUrl) throw new Error('EMAIL_TRANSPORT=smtp requires SMTP_URL');
    const t = nodemailer.createTransport(config.email.smtpUrl);
    return { send: async (m) => void (await t.sendMail(m)) };
  }
  return {
    send: async (m) => {
      console.log(`[email:log] to=${m.to} subject=${JSON.stringify(m.subject)}\n${m.text}\n`);
    },
  };
}

export function backoffMinutes(attempts: number): number {
  return Math.min(2 ** attempts, 360);
}

export async function deliverPendingEmails(transport: MailTransport, batchSize = 20): Promise<{ sent: number; failed: number }> {
  const client = await pool.connect();
  let sent = 0;
  let failed = 0;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string; to_address: string; subject: string; body_text: string; attempts: number }>(
      `SELECT id, to_address, subject, body_text, attempts FROM email_outbox
       WHERE status = 'pending' AND next_attempt_at <= now()
       ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    for (const row of rows) {
      try {
        await transport.send({ from: config.email.from, to: row.to_address, subject: row.subject, text: row.body_text });
        await client.query(`UPDATE email_outbox SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1`, [row.id]);
        sent++;
      } catch (err) {
        const attempts = row.attempts + 1;
        const giveUp = attempts >= config.email.maxAttempts;
        await client.query(
          `UPDATE email_outbox SET attempts = $2, last_error = $3, status = $4,
             next_attempt_at = now() + make_interval(mins => $5) WHERE id = $1`,
          [row.id, attempts, String((err as Error).message).slice(0, 500), giveUp ? 'failed' : 'pending', backoffMinutes(attempts)],
        );
        if (giveUp) {
          await client.query(
            `INSERT INTO system_events (kind, severity, message, detail) VALUES ('email_delivery_failed', 'warning', $1, $2)`,
            [`Email to ${row.to_address} failed after ${attempts} attempts: ${row.subject}`, JSON.stringify({ outbox_id: row.id })],
          );
        }
        failed++;
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { sent, failed };
}
