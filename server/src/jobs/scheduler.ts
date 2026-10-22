import { config } from '../config.js';
import { pool } from '../db/pool.js';
import type { RateService } from '../rates/rateService.js';
import { listCorridors } from '../services/corridors.js';
import { deliverPendingEmails, type MailTransport } from '../services/notifications.js';
import { checkPayoutDeadlines, expireUnpaidOrders } from '../services/orders.js';

/**
 * Background work. Each job is safe to run concurrently on several instances
 * (row locks with SKIP LOCKED, idempotent dedupe keys), and failures are isolated.
 */
export async function runJobsOnce(deps: { rates: RateService; transport: MailTransport }): Promise<void> {
  const jobs: [string, () => Promise<unknown>][] = [
    [
      'rates',
      async () => {
        for (const c of await listCorridors(pool)) {
          if (c.enabled) await deps.rates.refreshIfDue(c.from_currency, c.to_currency, config.rates.refreshSeconds);
        }
      },
    ],
    ['expire-orders', () => expireUnpaidOrders()],
    ['payout-deadlines', () => checkPayoutDeadlines()],
    ['emails', () => deliverPendingEmails(deps.transport)],
  ];
  for (const [name, job] of jobs) {
    try {
      await job();
    } catch (err) {
      console.error(`[job:${name}] failed`, err);
    }
  }
}

export function startScheduler(deps: { rates: RateService; transport: MailTransport }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    await runJobsOnce(deps).finally(() => {
      running = false;
    });
  };
  void tick();
  const handle = setInterval(tick, config.jobs.intervalSeconds * 1000);
  return () => clearInterval(handle);
}
