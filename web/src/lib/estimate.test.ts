import { describe, expect, it } from 'vitest';
import { cleanAmount, estimate } from './estimate';
import { money, rate } from './format';

describe('estimate', () => {
  it('mirrors the server formula', () => {
    expect(estimate('10000', '0.1325', '0.007')).toEqual({ gross: '1325.00', fee: '9.28', payout: '1315.72' });
  });
  it('cleans amounts', () => {
    expect(cleanAmount('10 000')).toBe('10000');
    expect(cleanAmount('1.234')).toBeNull();
    expect(cleanAmount('0')).toBeNull();
  });
  it('formats', () => {
    expect(money('1315.7', 'GHS')).toBe('1 315.70 GHS');
    expect(rate('0.132500000000')).toBe('0.1325');
  });
});
