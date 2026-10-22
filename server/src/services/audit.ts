import type { Db } from '../db/pool.js';
import type { Actor } from '../domain/orderStatus.js';

export interface ActorContext {
  type: Actor;
  id?: string | null;
  label?: string | null;
  ip?: string | null;
}

export const SYSTEM: ActorContext = { type: 'system', label: 'system' };

export async function audit(
  db: Db,
  actor: ActorContext,
  entry: {
    action: string;
    entityType: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
    reason?: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_type, actor_id, actor_label, action, entity_type, entity_id, before, after, reason, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      actor.type,
      actor.id ?? null,
      actor.label ?? null,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      entry.reason ?? null,
      actor.ip ?? null,
    ],
  );
}

export async function verifyAuditChain(db: Db): Promise<{ ok: boolean; firstBrokenId: string | null }> {
  const { rows } = await db.query<{ id: string | null }>('SELECT audit_log_first_broken() AS id');
  return { ok: rows[0].id === null, firstBrokenId: rows[0].id };
}
