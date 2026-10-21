import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { createApp } from './http/app.js';
import { startScheduler } from './jobs/scheduler.js';
import { createRateProvider } from './rates/index.js';
import { RateService } from './rates/rateService.js';
import { createTransport } from './services/notifications.js';
import { LocalDiskStorage } from './services/storage.js';

if (config.isProduction && (!config.appSecret || config.appSecret.length < 32)) {
  throw new Error('APP_SECRET (32+ chars) is required in production');
}

await migrate(pool);
const rates = new RateService(pool, createRateProvider());
const storage = new LocalDiskStorage();
const app = createApp({ rates, storage });
const stop = config.jobs.enabled ? startScheduler({ rates, transport: createTransport() }) : () => {};

const server = app.listen(config.port, () => console.log(`NorbsCoin API listening on :${config.port} (${config.nodeEnv})`));

const shutdown = () => {
  stop();
  server.close(() => void pool.end().then(() => process.exit(0)));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
