import { migrate } from '../db/migrate.js';
import { pool } from '../db/pool.js';

const ran = await migrate(pool);
console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date');
await pool.end();
