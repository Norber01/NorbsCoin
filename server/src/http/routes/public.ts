import { Router } from 'express';
import multer from 'multer';
import { config } from '../../config.js';
import { pool } from '../../db/pool.js';
import { badRequest } from '../../lib/errors.js';
import type { RateService } from '../../rates/rateService.js';
import { listCorridors, activeInstructions, currentFeeSchedule, corridorUnavailableReason } from '../../services/corridors.js';
import {
  createOrder,
  customerCancel,
  findOrderForCustomer,
  MOBILE_MONEY_PROVIDERS,
  submitProof,
  trackingView,
} from '../../services/orders.js';
import { createQuote, getQuote, loadAvailableCorridor, presentQuote } from '../../services/quotes.js';
import { publicSettings } from '../../services/settings.js';
import type { EvidenceStorage } from '../../services/storage.js';
import { getCorridor } from '../../services/corridors.js';
import { clientIp, limiter } from '../middleware.js';

const currency = (v: unknown) => {
  const s = typeof v === 'string' ? v.toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(s)) throw badRequest('invalid_currency', 'Invalid currency code.');
  return s;
};
const text = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

export function publicRoutes(deps: { rates: RateService; storage: EvidenceStorage }) {
  const r = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.storage.maxBytes, files: 1, fields: 10 } });

  r.get('/config', limiter(1, 60), async (_req, res) => {
    const corridors = await listCorridors(pool);
    const items = await Promise.all(
      corridors
        .filter((c) => c.enabled)
        .map(async (c) => {
          const [instr, fee] = await Promise.all([activeInstructions(pool, c.id), currentFeeSchedule(pool, c.id)]);
          return {
            from: c.from_currency,
            to: c.to_currency,
            available: !corridorUnavailableReason(c, !!instr, !!fee),
            unavailableReason: corridorUnavailableReason(c, !!instr, !!fee),
            minSendAmount: c.min_send_amount,
            maxSendAmount: c.max_send_amount,
            feeRate: fee?.fee_rate ?? null,
            quoteTtlSeconds: c.quote_ttl_seconds,
            payoutSlaHours: c.payout_sla_hours,
            payoutTerms: c.payout_terms,
          };
        }),
    );
    res.json({
      corridors: items,
      settings: await publicSettings(pool),
      mobileMoneyProviders: MOBILE_MONEY_PROVIDERS,
      upload: { maxBytes: config.storage.maxBytes, types: ['image/jpeg', 'image/png', 'application/pdf'] },
    });
  });

  // Reference rate for the converter. Shows source + timestamp and flags stale data.
  r.get('/rates', limiter(1, 60), async (req, res) => {
    const from = currency(req.query.from);
    const to = currency(req.query.to);
    const { corridor, fee, reason } = await loadAvailableCorridor(pool, from, to);
    if (!corridor.enabled) throw badRequest('corridor_unavailable', reason ?? 'Not offered.');
    if (req.query.refresh === '1') await deps.rates.refreshIfDue(from, to, 60);
    const current = await deps.rates.current(from, to, corridor.rate_max_age_seconds);
    const s = current.snapshot;
    res.json({
      from,
      to,
      rate: s?.rate ?? null,
      kind: s?.kind ?? null,
      source: s?.source ?? null,
      providerTimestamp: s?.provider_timestamp ?? null,
      fetchedAt: s?.fetched_at ?? null,
      usable: current.usable,
      stale: current.stale,
      message: current.reason ?? null,
      feeRate: fee?.fee_rate ?? null,
      corridorAvailable: !reason,
      corridorMessage: reason,
    });
  });

  r.post('/quotes', limiter(1, 30), async (req, res) => {
    const quote = await createQuote(pool, deps.rates, {
      from: currency(req.body?.from),
      to: currency(req.body?.to),
      sendAmount: req.body?.sendAmount,
    });
    res.status(201).json({ quote: presentQuote(quote, await getCorridor(pool, quote.corridor_id)) });
  });

  r.get('/quotes/:id', limiter(1, 60), async (req, res) => {
    const quote = await getQuote(pool, String(req.params.id));
    res.json({ quote: presentQuote(quote, await getCorridor(pool, quote.corridor_id)) });
  });

  r.post('/orders', limiter(10, 10), async (req, res) => {
    const b = req.body ?? {};
    const { order, trackingToken } = await createOrder({
      quoteId: text(b.quoteId, 40),
      termsAccepted: b.termsAccepted,
      termsVersion: b.termsVersion,
      recipient: b.recipient ?? {},
      ip: clientIp(req),
    });
    res.status(201).json({ reference: order.reference, trackingToken });
  });

  // Tracking credentials travel in the POST body (never in a URL query) so they stay out of logs.
  r.post('/track', limiter(1, 30), async (req, res) => {
    const order = await findOrderForCustomer(pool, text(req.body?.reference, 20), text(req.body?.token, 100));
    res.json({ order: await trackingView(pool, order) });
  });

  r.post('/track/proof', limiter(10, 10), upload.single('file'), async (req, res) => {
    const order = await submitProof(deps.storage, {
      reference: text(req.body?.reference, 20),
      token: text(req.body?.token, 100),
      transferReference: req.body?.transferReference,
      file: req.file,
      ip: clientIp(req),
    });
    res.status(201).json({ order: await trackingView(pool, order) });
  });

  r.post('/track/cancel', limiter(10, 10), async (req, res) => {
    const order = await customerCancel({ reference: text(req.body?.reference, 20), token: text(req.body?.token, 100), ip: clientIp(req) });
    res.json({ order: await trackingView(pool, order) });
  });

  return r;
}
