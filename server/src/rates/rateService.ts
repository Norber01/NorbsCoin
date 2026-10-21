import type { Db } from '../db/pool.js';
import { D } from '../domain/money.js';
import { audit, type ActorContext } from '../services/audit.js';
import { recordSystemEvent } from '../services/systemEvents.js';
import type { RateProvider } from './provider.js';

export interface RateSnapshot {
  id: string;
  base_currency: string;
  quote_currency: string;
  rate: string;
  kind: 'api' | 'operator';
  source: string;
  provider_timestamp: Date;
  fetched_at: Date;
  valid_until: Date | null;
}

export interface CurrentRate {
  snapshot: RateSnapshot | null;
  /** True when there is a rate that may be used for a new quote right now. */
  usable: boolean;
  stale: boolean;
  reason?: string;
}

export class RateService {
  constructor(
    private readonly db: Db,
    private readonly provider: RateProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get providerName() {
    return this.provider.name;
  }

  /** Fetch from the provider and store a snapshot. Failures are recorded, never papered over. */
  async refresh(base: string, quote: string): Promise<RateSnapshot | null> {
    try {
      const fetched = await this.provider.fetchRate(base, quote);
      const { rows } = await this.db.query<RateSnapshot>(
        `INSERT INTO rate_snapshots (base_currency, quote_currency, rate, kind, source, provider_timestamp, fetched_at)
         VALUES ($1, $2, $3, 'api', $4, $5, $6) RETURNING *`,
        [base, quote, fetched.rate, fetched.source, fetched.providerTimestamp, this.now()],
      );
      return rows[0];
    } catch (err) {
      await recordSystemEvent(this.db, {
        kind: 'rate_api_failure',
        severity: 'critical',
        message: `Could not fetch ${base}/${quote} rate from ${this.provider.name}: ${(err as Error).message}`,
        detail: { base, quote, provider: this.provider.name },
        dedupeWindowMinutes: 60,
      });
      return null;
    }
  }

  private inflight = new Map<string, Promise<RateSnapshot | null>>();

  /** Refreshes if the latest API fetch is older than minIntervalSeconds (single-flight). */
  async refreshIfDue(base: string, quote: string, minIntervalSeconds: number): Promise<void> {
    const { rows } = await this.db.query<{ fetched_at: Date }>(
      `SELECT fetched_at FROM rate_snapshots WHERE base_currency = $1 AND quote_currency = $2 AND kind = 'api'
       ORDER BY fetched_at DESC LIMIT 1`,
      [base, quote],
    );
    const last = rows[0]?.fetched_at;
    if (last && this.now().getTime() - new Date(last).getTime() < minIntervalSeconds * 1000) return;
    const key = `${base}/${quote}`;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.refresh(base, quote).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    await p;
  }

  /**
   * Picks the rate for new quotes: an unexpired operator rate takes precedence, otherwise
   * the latest API snapshot, provided its published timestamp is within maxAgeSeconds.
   * A stale or missing rate is reported as unusable — there is no fallback/demo value.
   */
  async current(base: string, quote: string, maxAgeSeconds: number): Promise<CurrentRate> {
    const now = this.now();
    const op = await this.db.query<RateSnapshot>(
      `SELECT * FROM rate_snapshots
       WHERE base_currency = $1 AND quote_currency = $2 AND kind = 'operator' AND valid_until > $3
       ORDER BY fetched_at DESC, id DESC LIMIT 1`,
      [base, quote, now],
    );
    if (op.rows[0]) return { snapshot: op.rows[0], usable: true, stale: false };

    const api = await this.db.query<RateSnapshot>(
      `SELECT * FROM rate_snapshots
       WHERE base_currency = $1 AND quote_currency = $2 AND kind = 'api'
       ORDER BY fetched_at DESC, id DESC LIMIT 1`,
      [base, quote],
    );
    const snap = api.rows[0];
    if (!snap) return { snapshot: null, usable: false, stale: false, reason: 'No exchange rate is available yet.' };
    const ageSeconds = (now.getTime() - new Date(snap.provider_timestamp).getTime()) / 1000;
    if (ageSeconds > maxAgeSeconds) {
      return {
        snapshot: snap,
        usable: false,
        stale: true,
        reason: 'The latest exchange rate is out of date, so new quotes are unavailable until it refreshes.',
      };
    }
    return { snapshot: snap, usable: true, stale: false };
  }

  async setOperatorRate(
    actor: ActorContext,
    params: { base: string; quote: string; rate: string; validMinutes: number; note?: string },
  ): Promise<RateSnapshot> {
    const rate = new D(params.rate);
    if (!rate.isFinite() || rate.lte(0)) throw new Error('Rate must be positive');
    const now = this.now();
    const validUntil = new Date(now.getTime() + params.validMinutes * 60_000);
    const { rows } = await this.db.query<RateSnapshot>(
      `INSERT INTO rate_snapshots (base_currency, quote_currency, rate, kind, source, provider_timestamp, fetched_at,
                                   valid_until, note, created_by)
       VALUES ($1, $2, $3, 'operator', 'Operator-set rate', $4, $4, $5, $6, $7) RETURNING *`,
      [params.base, params.quote, rate.toFixed(), now, validUntil, params.note ?? null, actor.id ?? null],
    );
    await audit(this.db, actor, {
      action: 'rate.operator_set',
      entityType: 'rate',
      entityId: `${params.base}/${params.quote}`,
      after: { rate: rows[0].rate, valid_until: validUntil, note: params.note ?? null },
    });
    return rows[0];
  }

  async clearOperatorRate(actor: ActorContext, base: string, quote: string): Promise<void> {
    // Snapshots are history; "clearing" ends validity by inserting nothing and expiring the active row.
    const { rows } = await this.db.query(
      `UPDATE rate_snapshots SET valid_until = $3
       WHERE base_currency = $1 AND quote_currency = $2 AND kind = 'operator' AND valid_until > $3
       RETURNING id`,
      [base, quote, this.now()],
    );
    if (rows.length) {
      await audit(this.db, actor, { action: 'rate.operator_cleared', entityType: 'rate', entityId: `${base}/${quote}` });
    }
  }
}
