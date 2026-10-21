import { describe, expect, it } from 'vitest';
import { canTransition } from '../src/domain/orderStatus.js';
import { normalizeGhanaPhone, validateRecipient } from '../src/services/orders.js';
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
  it('normalises Ghana phone numbers', () => {
    expect(normalizeGhanaPhone('024 123 4567')).toBe('+233241234567');
    expect(normalizeGhanaPhone('+233 24 123 4567')).toBe('+233241234567');
    expect(normalizeGhanaPhone('233201234567')).toBe('+233201234567');
    expect(normalizeGhanaPhone('12345')).toBeNull();
    expect(normalizeGhanaPhone('+79161234567')).toBeNull();
  });
  it('reports every invalid field', () => {
    try {
      validateRecipient({ payoutMethod: 'bank_transfer', bankAccountNumber: 'abc', customerEmail: 'nope' });
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
