import { describe, expect, it } from 'vitest';
import { canTransition } from '../src/domain/orderStatus.js';
import { findCountry, normalizePhone } from '../src/domain/countries.js';
import { calculateQuote } from '../src/domain/money.js';
import { validateRecipient } from '../src/services/orders.js';
import { sniffMime } from '../src/services/storage.js';
import { base32Encode, hotp, matchTotpStep, totp } from '../src/services/totp.js';

describe('order state machine', () => {
  it('requires verification before payout or completion', () => {
    expect(canTransition('awaiting_payment', 'completed', 'admin')).toBe(false);
    expect(canTransition('proof_submitted', 'completed', 'admin')).toBe(false);
    expect(canTransition('proof_submitted', 'payout_processing', 'admin')).toBe(false);
    expect(canTransition('payment_verified', 'completed', 'admin')).toBe(false);
    expect(canTransition('payout_processing', 'completed', 'admin')).toBe(true);
  });
  it('only operators can verify payment', () => {
    expect(canTransition('proof_submitted', 'payment_verified', 'customer')).toBe(false);
    expect(canTransition('proof_submitted', 'payment_verified', 'system')).toBe(false);
    expect(canTransition('proof_submitted', 'payment_verified', 'admin')).toBe(true);
  });
  it('terminal statuses are final', () => {
    for (const s of ['completed', 'rejected', 'cancelled', 'expired', 'refunded'] as const) {
      expect(canTransition(s, 'awaiting_payment', 'admin')).toBe(false);
      expect(canTransition(s, 'payment_verified', 'admin')).toBe(false);
    }
  });
  it('customers cannot cancel once payment is verified', () => {
    expect(canTransition('payment_verified', 'cancelled', 'customer')).toBe(false);
  });
});

describe('recipient validation', () => {
  const phone = (code: string, raw: string) => normalizePhone(findCountry(code)!, raw);

  it('normalises Ghana phone numbers', () => {
    expect(phone('GH', '024 123 4567')).toBe('+233241234567');
    expect(phone('GH', '+233 24 123 4567')).toBe('+233241234567');
    expect(phone('GH', '233201234567')).toBe('+233201234567');
    expect(phone('GH', '12345')).toBeNull();
    expect(phone('GH', '+79161234567')).toBeNull();
  });

  it('normalises Nigerian and CEMAC phone numbers', () => {
    expect(phone('NG', '0803 123 4567')).toBe('+2348031234567');
    expect(phone('NG', '+234 803 123 4567')).toBe('+2348031234567');
    expect(phone('NG', '0603 123 4567')).toBeNull();
    expect(phone('CM', '6 71 23 45 67')).toBe('+237671234567');
    expect(phone('CM', '00237 671234567')).toBe('+237671234567');
    expect(phone('CM', '571234567')).toBeNull();
    expect(phone('CG', '06 123 4567')).toBe('+242061234567');
    expect(phone('TD', '+235 66 12 34 56')).toBe('+23566123456');
  });

  it('applies country rules for the receive currency', () => {
    const base = { recipientName: 'Ada Obi', payoutMethod: 'bank_transfer', bankName: 'GTBank' };
    const ng = validateRecipient({ ...base, recipientCountry: 'NG', recipientPhone: '08031234567', bankAccountNumber: '0123456789' }, 'NGN');
    expect(ng).toMatchObject({ recipientCountry: 'NG', recipientPhone: '+2348031234567' });
    // NUBAN must be exactly 10 digits.
    expect(() => validateRecipient({ ...base, recipientCountry: 'NG', recipientPhone: '08031234567', bankAccountNumber: '12345678' }, 'NGN')).toThrow();
    // A Ghana recipient cannot be paid in naira.
    expect(() => validateRecipient({ ...base, recipientCountry: 'GH', recipientPhone: '0241234567', bankAccountNumber: '0123456789' }, 'NGN')).toThrow();
    const cm = validateRecipient(
      { recipientName: 'Jean Mbarga', recipientCountry: 'CM', recipientPhone: '671234567', payoutMethod: 'mobile_money', mobileMoneyProvider: 'Orange Money' },
      'XAF',
    );
    expect(cm).toMatchObject({ recipientCountry: 'CM', mobileMoneyProvider: 'Orange Money' });
    // Providers are per country.
    expect(() =>
      validateRecipient({ recipientName: 'Jean Mbarga', recipientCountry: 'CM', recipientPhone: '671234567', payoutMethod: 'mobile_money', mobileMoneyProvider: 'MTN MoMo' }, 'XAF'),
    ).toThrow();
  });

  it('rounds XAF to whole francs', () => {
    const r = calculateQuote({ sendAmount: '10000', rate: '7.1234', feeRate: '0.007', sendCurrency: 'RUB', receiveCurrency: 'XAF' });
    // 71234.00 gross; fee 498.638 → 499; payout 70735
    expect(r).toMatchObject({ grossAmount: '71234', feeAmount: '499', payoutAmount: '70735' });
  });

  it('reports every invalid field', () => {
    try {
      validateRecipient({ payoutMethod: 'bank_transfer', bankAccountNumber: 'abc', customerEmail: 'nope', recipientCountry: 'GH' }, 'GHS');
      expect.unreachable();
    } catch (err) {
      expect(Object.keys((err as { details: object }).details).sort()).toEqual(
        ['bankAccountNumber', 'bankName', 'customerEmail', 'recipientName', 'recipientPhone'].sort(),
      );
    }
  });
});

describe('upload sniffing', () => {
  it('detects by content, not name', () => {
    expect(sniffMime(Buffer.from('%PDF-1.7 ...'))).toBe('application/pdf');
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMime(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
    expect(sniffMime(Buffer.from('MZ\x90\x00'))).toBeNull();
  });
});

describe('TOTP', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it('matches RFC 4226 HOTP vectors', () => {
    expect(hotp(secret, 0)).toBe('755224');
    expect(hotp(secret, 1)).toBe('287082');
  });
  it('matches RFC 6238 at T=59s (last 6 digits)', () => {
    expect(totp(secret, 59_000)).toBe('287082');
  });
  it('accepts ±1 step and rejects others', () => {
    const now = 1_000_000_000_000;
    expect(matchTotpStep(secret, totp(secret, now - 30_000), now)).not.toBeNull();
    expect(matchTotpStep(secret, totp(secret, now - 90_000), now)).toBeNull();
    expect(matchTotpStep(secret, 'abcdef', now)).toBeNull();
  });
});
