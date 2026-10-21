import type { Db } from '../db/pool.js';
import { enqueueAdminEmail } from './notifications.js';

export async function recordSystemEvent(
  db: Db,
  event: {
    kind: string;
    severity: 'info' | 'warning' | 'critical';
    message: string;
    detail?: unknown;
    orderId?: string | null;
    /** Skip if an identical kind (and order) was recorded within this window. */
    dedupeWindowMinutes?: number;
    notifyAdmins?: boolean;
  },
): Promise<boolean> {
  if (event.dedupeWindowMinutes) {
    const { rows } = await db.query(
      `SELECT 1 FROM system_events
       WHERE kind = $1 AND order_id IS NOT DISTINCT FROM $2 AND created_at > now() - make_interval(mins => $3)
       LIMIT 1`,
      [event.kind, event.orderId ?? null, event.dedupeWindowMinutes],
    );
    if (rows.length) return false;
  }
  await db.query(
    `INSERT INTO system_events (kind, severity, message, detail, order_id) VALUES ($1, $2, $3, $4, $5)`,
    [event.kind, event.severity, event.message, event.detail ? JSON.stringify(event.detail) : null, event.orderId ?? null],
  );
  if (event.notifyAdmins !== false && event.severity !== 'info') {
    await enqueueAdminEmail(db, {
      template: `system.${event.kind}`,
      subject: `[${event.severity.toUpperCase()}] ${event.kind.replace(/_/g, ' ')}`,
      body: event.message,
      orderId: event.orderId ?? null,
    });
  }
  return true;
}
