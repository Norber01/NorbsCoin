import type { Db } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { audit, type ActorContext } from './audit.js';

/** Every editable business setting, with its validator. Unknown keys are refused. */
const VALIDATORS: Record<string, (v: unknown) => boolean> = {
  business_name: (v) => typeof v === 'string' && v.length > 0 && v.length <= 80,
  support_email: (v) => typeof v === 'string' && (v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)),
  support_phone: (v) => typeof v === 'string' && v.length <= 40,
  support_whatsapp: (v) => typeof v === 'string' && v.length <= 40,
  operating_hours: (v) => typeof v === 'string' && v.length <= 200,
  admin_notification_emails: (v) =>
    Array.isArray(v) && v.length <= 10 && v.every((e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)),
  terms_version: (v) => typeof v === 'string' && /^[\w.-]{1,40}$/.test(v),
  terms_text: (v) => typeof v === 'string' && v.length > 0 && v.length <= 5000,
  unusual_amount_threshold: (v) =>
    typeof v === 'object' && v !== null && !Array.isArray(v) &&
    Object.values(v).every((n) => typeof n === 'number' && n > 0),
  max_orders_per_phone_24h: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 100,
  payout_warning_hours: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 72,
  retention_days: (v) => Number.isInteger(v) && (v as number) >= 30,
};

export const PUBLIC_SETTING_KEYS = [
  'business_name',
  'support_email',
  'support_phone',
  'support_whatsapp',
  'operating_hours',
  'terms_version',
  'terms_text',
] as const;

export type Settings = {
  business_name: string;
  support_email: string;
  support_phone: string;
  support_whatsapp: string;
  operating_hours: string;
  admin_notification_emails: string[];
  terms_version: string;
  terms_text: string;
  unusual_amount_threshold: Record<string, number>;
  max_orders_per_phone_24h: number;
  payout_warning_hours: number;
  retention_days: number;
};

export async function getSettings(db: Db): Promise<Settings> {
  const { rows } = await db.query<{ key: string; value: unknown }>('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value])) as Settings;
}

export async function publicSettings(db: Db) {
  const all = await getSettings(db);
  return Object.fromEntries(PUBLIC_SETTING_KEYS.map((k) => [k, all[k]]));
}

export async function updateSettings(db: Db, actor: ActorContext, changes: Record<string, unknown>) {
  const current = await getSettings(db);
  for (const [key, value] of Object.entries(changes)) {
    const validate = VALIDATORS[key];
    if (!validate) throw badRequest('unknown_setting', `Unknown setting ${key}`);
    if (!validate(value)) throw badRequest('invalid_setting', `Invalid value for ${key}`);
  }
  for (const [key, value] of Object.entries(changes)) {
    const before = (current as Record<string, unknown>)[key];
    if (JSON.stringify(before) === JSON.stringify(value)) continue;
    await db.query(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(value), actor.id ?? null],
    );
    await audit(db, actor, { action: 'settings.update', entityType: 'setting', entityId: key, before, after: value });
  }
  return getSettings(db);
}
