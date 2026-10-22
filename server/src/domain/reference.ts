import crypto from 'node:crypto';

// Crockford-style alphabet without easily-confused characters (0/O, 1/I/L, U).
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateOrderReference(): string {
  let out = '';
  for (let i = 0; i < 8; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `NC-${out.slice(0, 4)}-${out.slice(4)}`;
}

export function generateToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
