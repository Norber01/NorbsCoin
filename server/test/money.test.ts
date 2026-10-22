import { describe, expect, it } from 'vitest';
import { calculateQuote, parseAmount } from '../src/domain/money.js';

const q = (sendAmount: string, rate: string, feeRate = '0.007') =>
  calculateQuote({ sendAmount, rate, feeRate, sendCurrency: 'RUB', receiveCurrency: 'GHS' });

describe('calculateQuote', () => {
  it('applies G = A×R, F = G×0.007, P = G−F with half-up rounding', () => {
    const r = q('10000', '0.1325');
    expect(r).toMatchObject({ sendAmount: '10000.00', grossAmount: '1325.00', feeAmount: '9.28', payoutAmount: '1315.72' });
  });

  it('rounds the gross amount half-up to 2 decimals before taking the fee', () => {
    const r = q('1234.56', '0.13254321');
    // 1234.56 × 0.13254321 = 163.6316… → 163.63; fee 1.14541 → 1.15
    expect(r.grossAmount).toBe('163.63');
    expect(r.feeAmount).toBe('1.15');
    expect(r.payoutAmount).toBe('162.48');
  });

  it('keeps G − F = P exactly for many inputs', () => {
    for (let i = 1; i < 500; i++) {
      const amount = (i * 137.31).toFixed(2);
      const r = q(amount, '0.1298765');
      const cents = (s: string) => Math.round(Number(s) * 100);
      expect(cents(r.grossAmount) - cents(r.feeAmount)).toBe(cents(r.payoutAmount));
    }
  });

  it('does not use floating point', () => {
    expect(q('0.10', '3').grossAmount).toBe('0.30');
  });

  it('rejects invalid input', () => {
    expect(() => q('0', '0.13')).toThrow();
    expect(() => q('10.001', '0.13')).toThrow();
    expect(() => q('10', '0')).toThrow();
  });
});

describe('parseAmount', () => {
  it('accepts plain and grouped numbers', () => {
    expect(parseAmount('10 000', 'RUB')?.toFixed(2)).toBe('10000.00');
    expect(parseAmount('1,500.5', 'RUB')?.toFixed(2)).toBe('1500.50');
  });
  it('rejects junk', () => {
    expect(parseAmount('1e5', 'RUB')).toBeNull();
    expect(parseAmount('-5', 'RUB')).toBeNull();
    expect(parseAmount('1.234', 'RUB')).toBeNull();
    expect(parseAmount({}, 'RUB')).toBeNull();
  });
});
