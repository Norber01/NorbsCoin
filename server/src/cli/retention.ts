// Privacy retention: deletes payment evidence files and redacts recipient details for orders
// that reached a final status more than `retention_days` ago. Financial records (amounts,
// rates, references, audit log) are kept for accounting. Run daily, e.g. via cron.
import { pool, withTransaction } from '../db/pool.js';
import { audit, SYSTEM } from '../services/audit.js';
import { getSettings } from '../services/settings.js';
import { createStorage } from '../services/storage.js';

const storage = createStorage(pool);
const settings = await getSettings(pool);
const days = settings.retention_days;
const dryRun = process.argv.includes('--dry-run');

const { rows } = await pool.query<{ id: string; reference: string }>(
  `SELECT id, reference FROM orders
   WHERE status IN ('completed', 'rejected', 'cancelled', 'expired', 'refunded')
     AND pii_redacted_at IS NULL AND status_changed_at < now() - make_interval(days => $1)`,
  [days],
);
console.log(`${rows.length} order(s) past ${days}-day retention${dryRun ? ' (dry run)' : ''}`);
if (!dryRun) {
  for (const order of rows) {
    await withTransaction(async (c) => {
      const proofs = await c.query<{ id: string; storage_key: string }>(
        'SELECT id, storage_key FROM payment_proofs WHERE order_id = $1 AND deleted_at IS NULL',
        [order.id],
      );
      for (const p of proofs.rows) await storage.delete(p.storage_key);
      await c.query('UPDATE payment_proofs SET deleted_at = now() WHERE order_id = $1 AND deleted_at IS NULL', [order.id]);
      await c.query(
        `UPDATE orders SET recipient_name = '[redacted]', recipient_phone = '[redacted]', customer_email = NULL,
           bank_account_number = CASE WHEN bank_account_number IS NULL THEN NULL ELSE '[redacted]' END,
           bank_branch = NULL, pii_redacted_at = now()
         WHERE id = $1`,
        [order.id],
      );
      await audit(c, SYSTEM, { action: 'retention.redact', entityType: 'order', entityId: order.id, after: { proofs_deleted: proofs.rows.length } });
    });
  }
}
await pool.end();
