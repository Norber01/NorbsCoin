import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Private evidence storage. The default implementation writes to a directory that is never
 * served statically; files are only streamed to authenticated operators. Implement this
 * interface for S3/GCS/R2 (with private buckets + server-side encryption) in production.
 */
export interface EvidenceStorage {
  put(data: Buffer, ext: string): Promise<string>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export class LocalDiskStorage implements EvidenceStorage {
  constructor(private readonly dir: string = config.storage.dir) {}

  private resolve(key: string): string {
    if (!/^[a-f0-9]{2}\/[a-f0-9]{32}\.(jpg|png|pdf)$/.test(key)) throw new Error('Invalid storage key');
    return path.join(this.dir, key);
  }

  async put(data: Buffer, ext: string): Promise<string> {
    const id = crypto.randomBytes(16).toString('hex');
    const key = `${id.slice(0, 2)}/${id}.${ext}`;
    const file = this.resolve(key);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, data, { mode: 0o600, flag: 'wx' });
    return key;
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }
}

export const ALLOWED_UPLOADS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
} as const;
export type AllowedMime = keyof typeof ALLOWED_UPLOADS;

/** Detect the real type from magic bytes; the client-declared MIME type is not trusted. */
export function sniffMime(buf: Buffer): AllowedMime | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

export function sanitizeFilename(name: string): string {
  return path.basename(name).replace(/[^\w.\- ]/g, '_').slice(0, 120) || 'upload';
}
