import pg from 'pg';
import { config } from '../config.js';

// Return NUMERIC as string (never JS float) and BIGINT as string.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
// An idle client losing its connection (DB restart, failover) must not crash the process.
pool.on('error', (err) => console.error('[db] idle client error', err.message));

export type Db = pg.Pool | pg.PoolClient;

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
