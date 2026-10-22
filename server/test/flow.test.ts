import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { deliverPendingEmails } from '../src/services/notifications.js';
import { checkPayoutDeadlines, expireUnpaidOrders } from '../src/services/orders.js';
import { adminAgent, configureCorridor, makeApp, PNG, RECIPIENT, resetDb } from './helpers.js';

afterAll(async () => {
  await pool.end();
});

async function quoteAndOrder(ctx: ReturnType<typeof makeApp>, amount = '10000') {
  await ctx.rates.refresh('RUB', 'GHS');
  const quote = await ctx.request.post('/api/quotes').send({ from: 'RUB', to: 'GHS', sendAmount: amount });
  expect(quote.status).toBe(201);
  const cfg = await ctx.request.get('/api/config');
  const order = await ctx.request.post('/api/orders').send({
    quoteId: quote.body.quote.id,
    termsAccepted: true,
    termsVersion: cfg.body.settings.terms_version,
    recipient: RECIPIENT,
  });
  expect(order.status).toBe(201);
  return { quote: quote.body.quote, reference: order.body.reference as string, token: order.body.trackingToken as string };
}

async function orderId(reference: string) {
  const { rows } = await pool.query('SELECT id FROM orders WHERE reference = $1', [reference]);
  return rows[0].id as string;
}

describe('rates and quotes', () => {
  beforeEach(resetDb);

  it('refuses to quote when no rate is available (no demo fallback)', async () => {
    const ctx = makeApp();
    await configureCorridor();
    ctx.provider.fail = true;
    await ctx.rates.refresh('RUB', 'GHS');
    const rate = await ctx.request.get('/api/rates?from=RUB&to=GHS');
    expect(rate.body).toMatchObject({ rate: null, usable: false });
    const quote = await ctx.request.post('/api/quotes').send({ from: 'RUB', to: 'GHS', sendAmount: '5000' });
    expect(quote.status).toBe(503);
    expect(quote.body.error.code).toBe('rate_unavailable');
    const events = await pool.query(`SELECT * FROM system_events WHERE kind = 'rate_api_failure'`);
    expect(events.rows).toHaveLength(1);
  });

  it('backs off a failing provider instead of retrying every tick', async () => {
    const ctx = makeApp();
    ctx.provider.fail = true;
    await ctx.rates.refreshIfDue('RUB', 'GHS', 900);
    await ctx.rates.refreshIfDue('RUB', 'GHS', 900);
    expect(ctx.provider.calls).toBe(1);
  });

  it('flags a stale rate and refuses to quote with it', async () => {
    const ctx = makeApp();
    await configureCorridor();
    ctx.provider.timestamp = new Date(Date.now() - 30 * 3600_000);
    await ctx.rates.refresh('RUB', 'GHS');
    const rate = await ctx.request.get('/api/rates?from=RUB&to=GHS');
    expect(rate.body).toMatchObject({ rate: '0.132500000000', stale: true, usable: false, source: 'Fake provider' });
    const quote = await ctx.request.post('/api/quotes').send({ from: 'RUB', to: 'GHS', sendAmount: '5000' });
    expect(quote.body.error.code).toBe('rate_stale');
  });

  it('returns a full quote breakdown with source, timestamp and expiry', async () => {
    const ctx = makeApp();
    await configureCorridor();
    await ctx.rates.refresh('RUB', 'GHS');
    const res = await ctx.request.post('/api/quotes').send({ from: 'RUB', to: 'GHS', sendAmount: '10000' });
    expect(res.body.quote).toMatchObject({
      sendAmount: '10000.00',
      grossAmount: '1325.00',
      feeRate: '0.007000',
      feeAmount: '9.28',
      payoutAmount: '1315.72',
      rateSource: 'Fake provider',
      feeBasis: 'deducted_from_gross',
      payoutSlaHours: 24,
    });
    const ttl = new Date(res.body.quote.expiresAt).getTime() - new Date(res.body.quote.createdAt).getTime();
    expect(ttl).toBe(600_000);
  });

  it('enforces min/max amounts and corridor pause', async () => {
    const ctx = makeApp();
    await configureCorridor();
    await ctx.rates.refresh('RUB', 'GHS');
    expect((await ctx.request.post('/api/quotes').send({ from: 'RUB', to: 'GHS', sendAmount: '10' })).body.error.code).toBe('amount_below_minimum');
    expect((await ctx.request.post('/api/quotes').send({ from: 'RUB', to: 'GHS', sendAmount: '999999' })).body.error.code).toBe(
      'amount_above_maximum',
    );
    await pool.query(`UPDATE corridors SET paused = TRUE, pause_reason = 'Liquidity limit reached' WHERE id = 1`);
    const paused = await ctx.request.post('/api/quotes').send({ from: 'RUB', to: 'GHS', sendAmount: '5000' });
    expect(paused.status).toBe(503);
    expect(paused.body.error.message).toBe('Liquidity limit reached');
  });

  it('keeps the reverse corridor closed until configured', async () => {
    const ctx = makeApp();
    await configureCorridor();
    const res = await ctx.request.post('/api/quotes').send({ from: 'GHS', to: 'RUB', sendAmount: '500' });
    expect(res.status).toBe(503);
  });

  it('refuses orders without instructions configured', async () => {
    const ctx = makeApp();
    await ctx.rates.refresh('RUB', 'GHS');
    const res = await ctx.request.post('/api/quotes').send({ from: 'RUB', to: 'GHS', sendAmount: '5000' });
    expect(res.body.error.code).toBe('corridor_unavailable');
  });

  it('prefers an unexpired operator rate and labels it', async () => {
    const ctx = makeApp();
    await configureCorridor();
    await ctx.rates.refresh('RUB', 'GHS');
    await ctx.rates.setOperatorRate({ type: 'admin', label: 'op' }, { base: 'RUB', quote: 'GHS', rate: '0.13', validMinutes: 5 });
    const res = await ctx.request.post('/api/quotes').send({ from: 'RUB', to: 'GHS', sendAmount: '10000' });
    expect(res.body.quote).toMatchObject({ rateKind: 'operator', rateSource: 'Operator-set rate', grossAmount: '1300.00' });
    // Quote expiry is capped by the operator rate's validity (5 min < 10 min TTL).
    expect(new Date(res.body.quote.expiresAt).getTime() - new Date(res.body.quote.createdAt).getTime()).toBeLessThanOrEqual(300_000);
  });
});

describe('additional corridors', () => {
  beforeEach(resetDb);

  it('keeps NGN and XAF disabled until enabled, then quotes and orders with local rules', async () => {
    const ctx = makeApp();
    await configureCorridor();
    expect((await ctx.request.post('/api/quotes').send({ from: 'RUB', to: 'XAF', sendAmount: '10000' })).status).toBe(503);
    const cfg0 = await ctx.request.get('/api/config');
    expect(cfg0.body.corridors.map((c: { to: string }) => c.to)).toEqual(['GHS']);

    const { rows } = await pool.query(`UPDATE corridors SET enabled = TRUE WHERE to_currency = 'XAF' RETURNING id`);
    await pool.query(`INSERT INTO payment_instructions (corridor_id, method_label, instructions) VALUES ($1, 'Card', 'Pay to card 0000')`, [rows[0].id]);
    ctx.provider.rate = '7.1234';
    await ctx.rates.refresh('RUB', 'XAF');
    const cfg = await ctx.request.get('/api/config');
    expect(cfg.body.payoutCountries.XAF.map((c: { code: string }) => c.code)).toContain('CM');
    const quote = await ctx.request.post('/api/quotes').send({ from: 'RUB', to: 'XAF', sendAmount: '10000' });
    expect(quote.body.quote).toMatchObject({ grossAmount: '71234', feeAmount: '499', payoutAmount: '70735' });

    const recipient = {
      recipientName: 'Jean Mbarga',
      recipientCountry: 'CM',
      recipientPhone: '6 71 23 45 67',
      payoutMethod: 'mobile_money',
      mobileMoneyProvider: 'MTN Mobile Money',
    };
    const tv = cfg.body.settings.terms_version;
    const ghanaian = await ctx.request
      .post('/api/orders')
      .send({ quoteId: quote.body.quote.id, termsAccepted: true, termsVersion: tv, recipient: RECIPIENT });
    expect(ghanaian.body.error.details.recipientCountry).toBeTruthy();
    const order = await ctx.request.post('/api/orders').send({ quoteId: quote.body.quote.id, termsAccepted: true, termsVersion: tv, recipient });
    expect(order.status).toBe(201);
    const { rows: o } = await pool.query('SELECT recipient_country, recipient_phone, receive_currency FROM orders WHERE reference = $1', [order.body.reference]);
    expect(o[0]).toEqual({ recipient_country: 'CM', recipient_phone: '+237671234567', receive_currency: 'XAF' });
  });
});

describe('order lifecycle', () => {
  beforeEach(resetDb);

  it('runs the full happy path from quote to completed payout', async () => {
    const ctx = makeApp();
    await configureCorridor();
    const { agent, h } = await adminAgent(ctx.app, 'operator');
    const { reference, token } = await quoteAndOrder(ctx);
    expect(reference).toMatch(/^NC-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    // Customer tracking: needs the token.
    expect((await ctx.request.post('/api/track').send({ reference, token: 'wrong' })).status).toBe(404);
    const track = await ctx.request.post('/api/track').send({ reference, token });
    expect(track.body.order).toMatchObject({ status: 'awaiting_payment', canUploadProof: true });
    expect(track.body.order.paymentInstructions.method_label).toBe('Sberbank card transfer');
    expect(track.body.order.recipient.phone).not.toContain('1234567');

    // Upload proof.
    const proof = await ctx.request
      .post('/api/track/proof')
      .field('reference', reference)
      .field('token', token)
      .field('transferReference', 'SBP-998877')
      .attach('file', PNG, 'receipt.png');
    expect(proof.status).toBe(201);
    expect(proof.body.order.status).toBe('proof_submitted');

    const id = await orderId(reference);
    // Cannot complete or start payout before verification.
    expect((await agent.post(`/api/admin/orders/${id}/start-payout`).set(h)).status).toBe(409);
    const early = await agent
      .post(`/api/admin/orders/${id}/complete`)
      .set(h)
      .send({ actualAmount: '1315.72', payoutReference: 'MOMO1', payoutDate: '2026-10-21' });
    expect(early.status).toBe(409);

    // Verification requires explicit independent confirmation and the full amount.
    expect((await agent.post(`/api/admin/orders/${id}/verify`).set(h).send({ verifiedAmount: '10000', verifiedReference: 'X' })).body.error.code).toBe(
      'funds_not_confirmed',
    );
    expect(
      (await agent.post(`/api/admin/orders/${id}/verify`).set(h).send({ verifiedAmount: '9000', verifiedReference: 'X', fundsConfirmed: true })).body
        .error.code,
    ).toBe('underpaid');
    const verified = await agent
      .post(`/api/admin/orders/${id}/verify`)
      .set(h)
      .send({ verifiedAmount: '10000.00', verifiedReference: 'SBP-998877', fundsConfirmed: true });
    expect(verified.status).toBe(200);
    expect(verified.body.order.status).toBe('payment_verified');
    expect(verified.body.order.payout_due_at).toBeTruthy();

    // Proof file is only available to authenticated admins.
    const detail = await agent.get(`/api/admin/orders/${id}`);
    const proofId = detail.body.proofs[0].id;
    expect(detail.body.proofs[0].review_status).toBe('accepted');
    const file = await agent.get(`/api/admin/orders/${id}/proofs/${proofId}`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect((await ctx.request.get(`/api/admin/orders/${id}/proofs/${proofId}`)).status).toBe(401);

    expect((await agent.post(`/api/admin/orders/${id}/start-payout`).set(h)).body.order.status).toBe('payout_processing');
    // Discrepancy requires a note.
    const noNote = await agent
      .post(`/api/admin/orders/${id}/complete`)
      .set(h)
      .send({ actualAmount: '1300.00', payoutReference: 'MOMO1', payoutDate: '2026-10-21' });
    expect(noNote.body.error.code).toBe('discrepancy_note_required');
    const done = await agent
      .post(`/api/admin/orders/${id}/complete`)
      .set(h)
      .send({ actualAmount: '1315.72', payoutReference: 'MOMO-55443', payoutDate: '2026-10-21' });
    expect(done.body.order.status).toBe('completed');

    const final = await ctx.request.post('/api/track').send({ reference, token });
    expect(final.body.order.completion).toMatchObject({ payoutAmount: '1315.72', payoutReference: 'MOMO-55443' });
    expect(final.body.order.timeline.map((t: { status: string }) => t.status)).toEqual([
      'awaiting_payment',
      'proof_submitted',
      'payment_verified',
      'payout_processing',
      'completed',
    ]);

    // Dashboard separates collected from projected fees.
    const dash = await agent.get('/api/admin/dashboard');
    expect(dash.body.totals.completed).toBe(1);
    expect(dash.body.fees[0]).toMatchObject({ currency: 'GHS', collected: '9.28', projected: '0' });

    // Audit chain is intact; customer + admin emails were queued.
    expect((await agent.get('/api/admin/audit/verify')).body.ok).toBe(true);
    const emails = await pool.query('SELECT template FROM email_outbox ORDER BY id');
    const templates = emails.rows.map((r) => r.template);
    expect(templates).toEqual(
      expect.arrayContaining([
        'customer.order_confirmed',
        'admin.new_order',
        'customer.proof_submitted',
        'admin.proof_submitted',
        'customer.payment_verified',
        'admin.payment_confirmed',
        'customer.completed',
        'admin.payout_completed',
      ]),
    );
    const confirmation = await pool.query(`SELECT body_text FROM email_outbox WHERE template = 'customer.order_confirmed'`);
    expect(confirmation.rows[0].body_text).toContain(`https://exchange.test/track/${reference}#t=${token}`);
  });

  it('locks agreed terms: DB refuses edits and fee changes do not affect existing orders', async () => {
    const ctx = makeApp();
    await configureCorridor();
    const { agent, h } = await adminAgent(ctx.app, 'owner');
    const { reference } = await quoteAndOrder(ctx);
    await expect(pool.query(`UPDATE orders SET payout_amount = 9999 WHERE reference = $1`, [reference])).rejects.toThrow(/immutable/);
    await expect(pool.query(`UPDATE quotes SET rate = 1`)).rejects.toThrow(/immutable/);
    await expect(pool.query(`UPDATE fee_schedules SET fee_rate = 0.5`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);

    const fee = await agent.post('/api/admin/corridors/1/fees').set(h).send({ feeRate: '0.01', note: 'test' });
    expect(fee.status).toBe(201);
    expect(fee.body.fee.version).toBe(2);
    const { rows } = await pool.query('SELECT fee_rate, fee_amount FROM orders WHERE reference = $1', [reference]);
    expect(rows[0]).toEqual({ fee_rate: '0.007000', fee_amount: '9.28' });
    const next = await ctx.request.post('/api/quotes').send({ from: 'RUB', to: 'GHS', sendAmount: '10000' });
    expect(next.body.quote).toMatchObject({ feeRate: '0.010000', feeAmount: '13.25' });
  });

  it('rejects expired quotes, reused quotes and missing consent', async () => {
    const ctx = makeApp();
    await configureCorridor();
    await ctx.rates.refresh('RUB', 'GHS');
    const cfg = await ctx.request.get('/api/config');
    const tv = cfg.body.settings.terms_version;
    const q = (await ctx.request.post('/api/quotes').send({ from: 'RUB', to: 'GHS', sendAmount: '5000' })).body.quote;
    const noConsent = await ctx.request.post('/api/orders').send({ quoteId: q.id, termsAccepted: false, termsVersion: tv, recipient: RECIPIENT });
    expect(noConsent.body.error.code).toBe('terms_not_accepted');
    const ok = await ctx.request.post('/api/orders').send({ quoteId: q.id, termsAccepted: true, termsVersion: tv, recipient: RECIPIENT });
    expect(ok.status).toBe(201);
    const again = await ctx.request.post('/api/orders').send({ quoteId: q.id, termsAccepted: true, termsVersion: tv, recipient: RECIPIENT });
    expect(again.body.error.code).toBe('quote_already_used');

    const q2 = (await ctx.request.post('/api/quotes').send({ from: 'RUB', to: 'GHS', sendAmount: '5000' })).body.quote;
    // Simulate time passing: quotes are immutable, so insert an already-expired copy.
    const { rows } = await pool.query(
      `INSERT INTO quotes (corridor_id, send_currency, receive_currency, send_amount, rate, rate_snapshot_id, rate_kind, rate_source,
         rate_timestamp, fee_schedule_id, fee_rate, gross_amount, fee_amount, payout_amount, created_at, expires_at)
       SELECT corridor_id, send_currency, receive_currency, send_amount, rate, rate_snapshot_id, rate_kind, rate_source, rate_timestamp,
         fee_schedule_id, fee_rate, gross_amount, fee_amount, payout_amount, now() - interval '20 minutes', now() - interval '10 minutes'
       FROM quotes WHERE id = $1 RETURNING id`,
      [q2.id],
    );
    const expired = await ctx.request.post('/api/orders').send({ quoteId: rows[0].id, termsAccepted: true, termsVersion: tv, recipient: RECIPIENT });
    expect(expired.status).toBe(410);

    const badRecipient = await ctx.request
      .post('/api/orders')
      .send({ quoteId: q2.id, termsAccepted: true, termsVersion: tv, recipient: { ...RECIPIENT, recipientPhone: '123' } });
    expect(badRecipient.body.error.details.recipientPhone).toBeTruthy();
  });

  it('validates uploads and supports resubmission', async () => {
    const ctx = makeApp();
    await configureCorridor();
    const { agent, h } = await adminAgent(ctx.app, 'operator');
    const { reference, token } = await quoteAndOrder(ctx);
    const bad = await ctx.request
      .post('/api/track/proof')
      .field('reference', reference)
      .field('token', token)
      .attach('file', Buffer.from('<html><script>alert(1)</script>'), 'receipt.png');
    expect(bad.body.error.code).toBe('unsupported_file');

    await ctx.request.post('/api/track/proof').field('reference', reference).field('token', token).attach('file', PNG, 'r.png');
    const id = await orderId(reference);
    const req = await agent.post(`/api/admin/orders/${id}/request-resubmission`).set(h).send({ message: 'Receipt is cropped; please upload the full screenshot.' });
    expect(req.body.order.status).toBe('resubmission_requested');
    const track = await ctx.request.post('/api/track').send({ reference, token });
    expect(track.body.order).toMatchObject({ canUploadProof: true, operatorMessage: 'Receipt is cropped; please upload the full screenshot.' });
    const pdf = Buffer.from('%PDF-1.4\n%fake');
    const again = await ctx.request.post('/api/track/proof').field('reference', reference).field('token', token).attach('file', pdf, 'r.pdf');
    expect(again.body.order.status).toBe('proof_submitted');
    const detail = await agent.get(`/api/admin/orders/${id}`);
    expect(detail.body.proofs.map((p: { review_status: string }) => p.review_status)).toEqual(['pending', 'rejected']);
  });

  it('detects duplicate evidence and refuses duplicate verified references', async () => {
    const ctx = makeApp();
    await configureCorridor();
    const { agent, h } = await adminAgent(ctx.app, 'operator');
    const a = await quoteAndOrder(ctx);
    const b = await quoteAndOrder(ctx);
    for (const o of [a, b]) {
      await ctx.request
        .post('/api/track/proof')
        .field('reference', o.reference)
        .field('token', o.token)
        .field('transferReference', 'SAME-REF')
        .attach('file', PNG, 'r.png');
    }
    const { rows } = await pool.query('SELECT flags FROM orders WHERE reference = $1', [b.reference]);
    expect(rows[0].flags).toEqual(expect.arrayContaining(['duplicate_receipt', 'duplicate_transfer_reference']));
    const ev = await pool.query(`SELECT * FROM system_events WHERE kind = 'duplicate_payment_evidence'`);
    expect(ev.rows.length).toBe(1);

    const verify = (ref: string) => (id: string) =>
      agent.post(`/api/admin/orders/${id}/verify`).set(h).send({ verifiedAmount: '10000', verifiedReference: ref, fundsConfirmed: true });
    expect((await verify('BANK-1')(await orderId(a.reference))).status).toBe(200);
    const dup = await verify('bank-1')(await orderId(b.reference));
    expect(dup.body.error.code).toBe('duplicate_reference');
  });

  it('expires unpaid orders and alerts on payout deadlines', async () => {
    const ctx = makeApp();
    await configureCorridor();
    const { agent, h } = await adminAgent(ctx.app, 'operator');
    const unpaid = await quoteAndOrder(ctx);
    expect(await expireUnpaidOrders(new Date(Date.now() + 3 * 3600_000))).toBe(1);
    const t = await ctx.request.post('/api/track').send(unpaid);
    expect(t.body.order.status).toBe('expired');

    const paid = await quoteAndOrder(ctx);
    await ctx.request.post('/api/track/proof').field('reference', paid.reference).field('token', paid.token).attach('file', PNG, 'r.png');
    const id = await orderId(paid.reference);
    await agent.post(`/api/admin/orders/${id}/verify`).set(h).send({ verifiedAmount: '10000', verifiedReference: 'R-2', fundsConfirmed: true });
    const res = await checkPayoutDeadlines(new Date(Date.now() + 25 * 3600_000));
    expect(res).toEqual({ warned: 1, overdue: 1 });
    expect(await checkPayoutDeadlines(new Date(Date.now() + 26 * 3600_000))).toEqual({ warned: 0, overdue: 0 });
  });

  it('refunds with amount, reason and reference; customer can cancel before paying', async () => {
    const ctx = makeApp();
    await configureCorridor();
    const { agent, h } = await adminAgent(ctx.app, 'operator');
    const o = await quoteAndOrder(ctx);
    await ctx.request.post('/api/track/proof').field('reference', o.reference).field('token', o.token).attach('file', PNG, 'r.png');
    const id = await orderId(o.reference);
    expect((await ctx.request.post('/api/track/cancel').send(o)).status).toBe(409);
    await agent.post(`/api/admin/orders/${id}/verify`).set(h).send({ verifiedAmount: '10000', verifiedReference: 'R-3', fundsConfirmed: true });
    expect((await agent.post(`/api/admin/orders/${id}/refund`).set(h).send({ amount: '20000', reason: 'x', reference: 'y' })).body.error.code).toBe(
      'refund_too_large',
    );
    const refund = await agent
      .post(`/api/admin/orders/${id}/refund`)
      .set(h)
      .send({ amount: '10000', reason: 'Payout route unavailable', reference: 'SBP-REFUND-1' });
    expect(refund.body.order).toMatchObject({ status: 'refunded', refund_amount: '10000.00', refund_currency: 'RUB' });

    const c = await quoteAndOrder(ctx);
    expect((await ctx.request.post('/api/track/cancel').send(c)).body.order.status).toBe('cancelled');
  });
});

describe('admin security', () => {
  beforeEach(resetDb);

  it('requires MFA, CSRF header and role permissions', async () => {
    const ctx = makeApp();
    await configureCorridor();
    const { agent, h } = await adminAgent(ctx.app, 'viewer');
    expect((await agent.get('/api/admin/dashboard')).status).toBe(200);
    expect((await agent.patch('/api/admin/settings').send({ support_phone: '1' })).status).toBe(403); // no CSRF header
    expect((await agent.patch('/api/admin/settings').set(h).send({ support_phone: '1' })).status).toBe(403); // viewer role

    // A fresh login with MFA enabled must pass the TOTP step before accessing data.
    const { default: supertest } = await import('supertest');
    const fresh = supertest.agent(ctx.app);
    const login = await fresh.post('/api/admin/auth/login').set(h).send({ email: 'viewer@exchange.test', password: 'correct horse battery' });
    expect(login.body.mfaRequired).toBe(true);
    expect((await fresh.get('/api/admin/dashboard')).status).toBe(401);
    expect((await fresh.post('/api/admin/auth/mfa').set(h).send({ code: '000000' })).status).toBe(401);
  });

  it('locks the account after repeated failed logins', async () => {
    const ctx = makeApp();
    await adminAgent(ctx.app, 'owner');
    const h = { 'X-Requested-With': 'norbscoin' };
    for (let i = 0; i < 5; i++) await ctx.request.post('/api/admin/auth/login').set(h).send({ email: 'owner@exchange.test', password: 'wrong password!!' });
    const res = await ctx.request.post('/api/admin/auth/login').set(h).send({ email: 'owner@exchange.test', password: 'correct horse battery' });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/locked/);
  });

  it('owner can pause the corridor and edit settings, all audited', async () => {
    const ctx = makeApp();
    await configureCorridor();
    const { agent, h } = await adminAgent(ctx.app, 'owner');
    const pause = await agent.patch('/api/admin/corridors/1').set(h).send({ paused: true, pause_reason: 'Bank holiday' });
    expect(pause.body.corridor.paused).toBe(true);
    const bad = await agent.patch('/api/admin/settings').set(h).send({ support_email: 'not-an-email' });
    expect(bad.status).toBe(400);
    await agent.patch('/api/admin/settings').set(h).send({ support_email: 'help@exchange.test' });
    const log = await agent.get('/api/admin/audit');
    const actions = log.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['corridor.pause', 'settings.update']));
  });
});

describe('email outbox', () => {
  beforeEach(resetDb);

  it('retries failed deliveries with backoff without touching orders', async () => {
    const ctx = makeApp();
    await configureCorridor();
    await quoteAndOrder(ctx);
    const failing = { send: async () => Promise.reject(new Error('SMTP down')) };
    const r1 = await deliverPendingEmails(failing);
    expect(r1.failed).toBeGreaterThan(0);
    const { rows } = await pool.query(`SELECT status, attempts, next_attempt_at > now() AS later FROM email_outbox`);
    expect(rows.every((r) => r.status === 'pending' && r.attempts === 1 && r.later)).toBe(true);
    expect((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n).toBe(1);

    await pool.query('UPDATE email_outbox SET next_attempt_at = now()');
    const sent: string[] = [];
    const ok = { send: async (m: { to: string }) => void sent.push(m.to) };
    const r2 = await deliverPendingEmails(ok);
    expect(r2.sent).toBe(rows.length);
    expect(sent).toEqual(expect.arrayContaining(['customer@example.test', 'ops@exchange.test']));
  });
});

describe('database evidence storage', () => {
  beforeEach(resetDb);

  it('stores, reads and deletes receipts privately in PostgreSQL', async () => {
    const { DatabaseStorage } = await import('../src/services/storage.js');
    const storage = new DatabaseStorage(pool);
    const key = await storage.put(PNG, 'png');
    expect((await storage.get(key)).equals(PNG)).toBe(true);
    await storage.delete(key);
    await expect(storage.get(key)).rejects.toThrow();
    await expect(storage.get('../../etc/passwd')).rejects.toThrow(/Invalid/);
  });

  it('bootstraps the first owner only when no operators exist', async () => {
    const { bootstrapOwner } = await import('../src/services/auth.js');
    expect(await bootstrapOwner(pool, 'first@exchange.test', 'a-long-password-123')).toBe(true);
    expect(await bootstrapOwner(pool, 'second@exchange.test', 'a-long-password-123')).toBe(false);
    const { rows } = await pool.query(`SELECT email, role FROM admin_users`);
    expect(rows).toEqual([{ email: 'first@exchange.test', role: 'owner' }]);
  });
});
