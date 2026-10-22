import supertest from 'supertest';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { createApp } from '../src/http/app.js';
import type { FetchedRate, RateProvider } from '../src/rates/provider.js';
import { RateService } from '../src/rates/rateService.js';
import { createAdminUser, type Role } from '../src/services/auth.js';
import { LocalDiskStorage } from '../src/services/storage.js';
import { totp } from '../src/services/totp.js';

export class FakeProvider implements RateProvider {
  readonly name = 'Fake provider';
  rate = '0.1325';
  fail = false;
  timestamp = new Date();
  calls = 0;
  async fetchRate(base: string, quote: string): Promise<FetchedRate> {
    this.calls++;
    if (this.fail) throw new Error('provider down');
    return { base, quote, rate: this.rate, providerTimestamp: this.timestamp, source: this.name };
  }
}

export async function resetDb() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
}

export function makeApp() {
  const provider = new FakeProvider();
  const rates = new RateService(pool, provider);
  const storage = new LocalDiskStorage();
  const app = createApp({ rates, storage });
  return { app, provider, rates, storage, request: supertest(app) };
}

export async function configureCorridor() {
  await pool.query(
    `INSERT INTO payment_instructions (corridor_id, method_label, instructions) VALUES (1, 'Sberbank card transfer', 'Card 0000 0000 0000 0000, Test Recipient. Put your order reference in the comment.')`,
  );
  await pool.query(`UPDATE settings SET value = '["ops@exchange.test"]' WHERE key = 'admin_notification_emails'`);
}

/** Creates a user, logs in and completes MFA enrollment. Returns an agent holding the session. */
export async function adminAgent(app: Parameters<typeof supertest.agent>[0], role: Role = 'owner', email = `${role}@exchange.test`) {
  await createAdminUser(pool, { email, name: `Test ${role}`, password: 'correct horse battery', role });
  const agent = supertest.agent(app);
  const h = { 'X-Requested-With': 'norbscoin' };
  const login = await agent.post('/api/admin/auth/login').set(h).send({ email, password: 'correct horse battery' });
  if (login.status !== 200) throw new Error(`login failed ${login.status}`);
  const enroll = await agent.post('/api/admin/auth/mfa/enroll').set(h).send({});
  const verify = await agent.post('/api/admin/auth/mfa/enroll/verify').set(h).send({ code: totp(enroll.body.secret) });
  if (verify.status !== 200) throw new Error(`mfa failed ${verify.status} ${JSON.stringify(verify.body)}`);
  return { agent, secret: enroll.body.secret as string, h };
}

export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake image body')]);

export const RECIPIENT = {
  recipientName: 'Kwame Mensah',
  recipientPhone: '024 123 4567',
  recipientCountry: 'GH',
  payoutMethod: 'mobile_money',
  mobileMoneyProvider: 'MTN MoMo',
  customerEmail: 'customer@example.test',
};
