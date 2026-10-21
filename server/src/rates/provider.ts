export interface FetchedRate {
  base: string;
  quote: string;
  rate: string;
  /** When the provider says the rate was published. */
  providerTimestamp: Date;
  source: string;
}

export interface RateProvider {
  readonly name: string;
  /** Throws on any failure. Never returns a made-up or default value. */
  fetchRate(base: string, quote: string): Promise<FetchedRate>;
}

/**
 * ExchangeRate-API open access endpoint (documented at https://www.exchangerate-api.com/docs/free).
 * Response: { result: "success", time_last_update_unix, base_code, rates: { GHS: 0.13, ... } }.
 * Free data refreshes daily; it is a *reference* rate, not necessarily the rate you can obtain.
 */
export class OpenErApiProvider implements RateProvider {
  readonly name = 'ExchangeRate-API (open.er-api.com)';

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchRate(base: string, quote: string): Promise<FetchedRate> {
    const res = await this.fetchImpl(`${this.baseUrl}/${encodeURIComponent(base)}`, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Rate provider HTTP ${res.status}`);
    const body = (await res.json()) as {
      result?: string;
      base_code?: string;
      time_last_update_unix?: number;
      rates?: Record<string, number>;
      'error-type'?: string;
    };
    if (body.result !== 'success') throw new Error(`Rate provider error: ${body['error-type'] ?? 'unknown'}`);
    if (body.base_code !== base) throw new Error(`Rate provider returned base ${body.base_code}, expected ${base}`);
    const value = body.rates?.[quote];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`Rate provider has no valid ${base}/${quote} rate`);
    }
    if (typeof body.time_last_update_unix !== 'number') throw new Error('Rate provider response has no timestamp');
    return {
      base,
      quote,
      // Number → string via toString keeps the provider's published digits.
      rate: value.toString(),
      providerTimestamp: new Date(body.time_last_update_unix * 1000),
      source: this.name,
    };
  }
}

/** Disables automatic fetching: only operator-entered rates can be quoted. */
export class ManualOnlyProvider implements RateProvider {
  readonly name = 'manual';
  async fetchRate(): Promise<FetchedRate> {
    throw new Error('Automatic rate fetching is disabled (RATE_PROVIDER=manual)');
  }
}
