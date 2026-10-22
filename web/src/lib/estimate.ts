import { Decimal } from 'decimal.js';

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/**
 * Client-side ESTIMATE only, mirroring the server formula (fee deducted from gross,
 * half-up to 2 decimals). The binding numbers always come from the server quote.
 */
export function estimate(amount: string, rate: string, feeRate: string, decimals = 2) {
  const a = new D(amount);
  const gross = a.mul(rate).toDecimalPlaces(decimals, D.ROUND_HALF_UP);
  const fee = gross.mul(feeRate).toDecimalPlaces(decimals, D.ROUND_HALF_UP);
  return { gross: gross.toFixed(decimals), fee: fee.toFixed(decimals), payout: gross.minus(fee).toFixed(decimals) };
}

export function cleanAmount(input: string): string | null {
  const t = input.replace(/[\s, ]/g, '');
  return /^\d+(\.\d{1,2})?$/.test(t) && Number(t) > 0 ? t : null;
}
