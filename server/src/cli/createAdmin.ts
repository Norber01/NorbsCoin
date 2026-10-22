// Usage: npm run create-admin -- --email you@example.com --name "Your Name" --role owner
// The password is read from the ADMIN_PASSWORD env var or prompted (never passed as an argument).
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { pool } from '../db/pool.js';
import { createAdminUser, type Role } from '../services/auth.js';

const { values } = parseArgs({
  options: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', default: 'owner' } },
});
if (!values.email || !values.name) {
  console.error('Usage: create-admin --email <email> --name <name> [--role owner|operator|viewer]');
  process.exit(1);
}
let password = process.env.ADMIN_PASSWORD;
if (!password) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question('Password (min 12 chars): ');
  rl.close();
}
const user = await createAdminUser(pool, { email: values.email, name: values.name, password, role: values.role as Role });
console.log(`Created ${user.role} ${user.email}. Sign in at /admin and set up multi-factor authentication.`);
await pool.end();
