import { Decimal } from 'decimal.js';

// Dedicated Decimal clone so global configuration elsewhere cannot change our arithmetic.
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof D>;

export const CURRENCY_DECIMALS: Record<string, number> = { RUB: 2, GHS: 2, USD: 2, EUR: 2 };

export function decimalsFor(currency: string): number {
  const d = CURRENCY_DECIMALS[currency];
  if (d === undefined) throw new Error(`Unsupported currency ${currency}`);
  return d;
}

export interface QuoteBreakdown {
  /** A: amount sent, in send currency */
  sendAmount: string;
  /** R: receive-currency units per one send-currency unit */
  rate: string;
  /** G = A × R, rounded half-up to the receive currency's minor unit */
  grossAmount: string;
  /** fee rate, e.g. "0.007" for 0.7% */
  feeRate: string;
  /** F = G × fee rate, rounded half-up to the minor unit */
  feeAmount: string;
  /** P = G − F (exact, no further rounding) */
  payoutAmount: string;
}

/**
 * The single definition of the fee used everywhere (UI, terms, accounting):
 * the service fee is DEDUCTED from the gross converted amount.
 *
 *   G = round(A × R)      F = round(G × feeRate)      P = G − F
 *
 * Rounding is ROUND_HALF_UP to the receive currency's minor unit, applied to G and F
 * only; P is then exact, so G − F = P always holds to the cent.
 */
export function calculateQuote(params: {
  sendAmount: string | number;
  rate: string | number;
  feeRate: string | number;
  sendCurrency: string;
  receiveCurrency: string;
}): QuoteBreakdown {
  const sendDp = decimalsFor(params.sendCurrency);
  const receiveDp = decimalsFor(params.receiveCurrency);
  const a = new D(params.sendAmount);
  const r = new D(params.rate);
  const feeRate = new D(params.feeRate);
  if (!a.isFinite() || a.lte(0)) throw new Error('Send amount must be positive');
  if (a.decimalPlaces() > sendDp) throw new Error(`Send amount has more than ${sendDp} decimal places`);
  if (!r.isFinite() || r.lte(0)) throw new Error('Rate must be positive');
  if (feeRate.lt(0) || feeRate.gte(1)) throw new Error('Fee rate must be in [0, 1)');

  const gross = a.mul(r).toDecimalPlaces(receiveDp, D.ROUND_HALF_UP);
  const fee = gross.mul(feeRate).toDecimalPlaces(receiveDp, D.ROUND_HALF_UP);
  const payout = gross.minus(fee);
  return {
    sendAmount: a.toFixed(sendDp),
    rate: r.toFixed(),
    grossAmount: gross.toFixed(receiveDp),
    feeRate: feeRate.toFixed(),
    feeAmount: fee.toFixed(receiveDp),
    payoutAmount: payout.toFixed(receiveDp),
  };
}

export function parseAmount(input: unknown, currency: string): Dec | null {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const text = String(input).trim().replace(/[\s,]/g, '');
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const value = new D(text);
  if (value.decimalPlaces() > decimalsFor(currency)) return null;
  return value;
}

export function sumAmounts(values: (string | null)[]): string {
  return values.reduce((acc: Dec, v) => (v ? acc.plus(v) : acc), new D(0)).toFixed(2);
}
