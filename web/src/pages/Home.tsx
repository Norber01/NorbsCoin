import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ErrorAlert, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { cleanAmount, estimate } from '../lib/estimate';
import { dateTime, decimalsFor, money, percent, rate as fmtRate, relative } from '../lib/format';
import { useAsync, useConfig } from '../lib/hooks';
import type { Quote, RateInfo } from '../lib/types';

export function Home() {
  const config = useConfig()!;
  const navigate = useNavigate();
  const corridors = config.corridors;
  const sendCurrencies = [...new Set(corridors.map((c) => c.from))];
  const [from, setFrom] = useState(sendCurrencies[0] ?? 'RUB');
  const receiveOptions = corridors.filter((c) => c.from === from).map((c) => c.to);
  const [to, setTo] = useState(receiveOptions[0] ?? 'GHS');
  const corridor = corridors.find((c) => c.from === from && c.to === to);
  const [amountText, setAmountText] = useState('10000');
  const [submitting, setSubmitting] = useState(false);
  const [quoteError, setQuoteError] = useState<Error | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!receiveOptions.includes(to) && receiveOptions[0]) setTo(receiveOptions[0]);
  }, [from]); // eslint-disable-line react-hooks/exhaustive-deps

  const rate = useAsync(() => api.get<RateInfo>(`/api/rates?from=${from}&to=${to}`), [from, to]);
  // Re-check the rate every minute so a stale rate is flagged without a page reload.
  useEffect(() => {
    const t = setInterval(() => void rate.reload(), 60_000);
    return () => clearInterval(t);
  }, [from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  const amount = cleanAmount(amountText);
  const allReceive = [...new Set(corridors.map((c) => c.to))];
  const CURRENCY_WORD: Record<string, string> = { GHS: 'cedis', NGN: 'naira', XAF: 'CFA francs' };
  const joinWords = (w: string[]) => (w.length <= 1 ? w.join('') : `${w.slice(0, -1).join(', ')} or ${w.at(-1)}`);
  const receiveWords = joinWords(allReceive.map((c) => CURRENCY_WORD[c] ?? c));
  const countryWords = joinWords(
    allReceive.map((c) => {
      const countries = config.payoutCountries[c] ?? [];
      return countries.length === 1 ? `${c} in ${countries[0].name}` : `${c} (${config.currencies[c]?.name ?? c})`;
    }),
  );
  const amountError = useMemo(() => {
    if (!amountText.trim()) return 'Enter an amount.';
    if (!amount) return 'Enter a valid amount (up to 2 decimals).';
    if (corridor && Number(amount) < Number(corridor.minSendAmount)) return `Minimum is ${money(corridor.minSendAmount, from)}.`;
    if (corridor && Number(amount) > Number(corridor.maxSendAmount)) return `Maximum is ${money(corridor.maxSendAmount, from)}.`;
    return null;
  }, [amountText, amount, corridor, from]);

  const r = rate.data;
  const est = r?.usable && r.rate && r.feeRate && amount && !amountError ? estimate(amount, r.rate, r.feeRate, decimalsFor(to)) : null;
  const canQuote = !!est && !!corridor?.available && !submitting;

  async function refresh() {
    setRefreshing(true);
    try {
      rate.setData(await api.get<RateInfo>(`/api/rates?from=${from}&to=${to}&refresh=1`));
    } catch {
      await rate.reload();
    } finally {
      setRefreshing(false);
    }
  }

  async function getQuote(e: React.FormEvent) {
    e.preventDefault();
    if (!canQuote) return;
    setSubmitting(true);
    setQuoteError(null);
    try {
      const { quote } = await api.post<{ quote: Quote }>('/api/quotes', { from, to, sendAmount: amount });
      navigate(`/exchange/${quote.id}`);
    } catch (err) {
      setQuoteError(err as Error);
      void rate.reload();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid-2 home">
      <section>
        <div className="hero">
          <h1>Send rubles, receive {receiveWords}.</h1>
          <p className="muted">
            Exchange RUB to {countryWords} — paid to mobile money or a bank account. See the exact rate, our {percent(corridor?.feeRate)} fee and
            the amount your recipient receives before you commit.
          </p>
        </div>
        <ol className="stack" style={{ paddingLeft: '1.2rem' }}>
          <li>
            <strong>Get a quote</strong> — the rate is fixed for {Math.round((corridor?.quoteTtlSeconds ?? 600) / 60)} minutes.
          </li>
          <li>
            <strong>Confirm and pay</strong> — using the payment instructions and your unique order reference.
          </li>
          <li>
            <strong>Upload your receipt</strong> — we independently confirm the funds arrived.
          </li>
          <li>
            <strong>Recipient is paid</strong> — {(corridor?.payoutTerms || `typically within ${corridor?.payoutSlaHours ?? 24} hours of verification.`).replace(/\.?$/, '.')}
          </li>
        </ol>
      </section>

      <form className="card" onSubmit={getQuote} noValidate>
        <h2>Currency converter</h2>
        {!corridor?.available && corridor?.unavailableReason && <div className="alert warn" style={{ marginBottom: '1rem' }}>{corridor.unavailableReason}</div>}
        <div className="field">
          <label htmlFor="amount">You send</label>
          <div className="amount-input">
            <input
              id="amount"
              inputMode="decimal"
              autoComplete="off"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              aria-invalid={!!amountError}
              aria-describedby="amount-err"
            />
            <select aria-label="Send currency" value={from} onChange={(e) => setFrom(e.target.value)}>
              {sendCurrencies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
          {amountError && (
            <div className="err" id="amount-err">
              {amountError}
            </div>
          )}
          {corridor && (
            <div className="hint">
              Limits: {money(corridor.minSendAmount, from)} – {money(corridor.maxSendAmount, from)}
            </div>
          )}
        </div>
        <div className="field">
          <label htmlFor="receive">Recipient gets (estimate)</label>
          <div className="amount-display" id="receive">
            <span>{est ? money(est.payout, to).replace(` ${to}`, '') : '—'}</span>
            <select aria-label="Receive currency" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 'auto', border: 0, fontWeight: 600, background: 'transparent' }}>
              {receiveOptions.map((c) => (
                <option key={c} value={c} title={config.currencies[c]?.name}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="card flat" style={{ background: 'var(--surface-2)', marginBottom: '1rem' }}>
          {rate.loading && !r ? (
            <Spinner label="Fetching current rate…" />
          ) : rate.error ? (
            <div className="alert error">Exchange rate unavailable: {rate.error.message}</div>
          ) : r && !r.rate ? (
            <div className="alert error">{r.message ?? 'Exchange rate unavailable. Please try again later.'}</div>
          ) : r ? (
            <>
              <div className="spread">
                <span className="row">
                  <span className={`dot ${r.stale ? 'stale' : ''}`} aria-hidden />
                  <strong>
                    1 {from} = {fmtRate(r.rate)} {to}
                  </strong>
                </span>
                <button type="button" className="btn ghost small" onClick={refresh} disabled={refreshing}>
                  {refreshing ? 'Refreshing…' : 'Refresh rate'}
                </button>
              </div>
              <div className="small muted">
                {r.kind === 'operator' ? 'Rate set by our desk' : `Source: ${r.source}`} · updated {dateTime(r.providerTimestamp)} ({relative(r.providerTimestamp)})
              </div>
              {r.stale && <div className="alert warn" style={{ marginTop: '0.5rem' }}>{r.message}</div>}
              {est && (
                <table className="breakdown" style={{ marginTop: '0.75rem' }}>
                  <tbody>
                    <tr>
                      <td>Converted amount</td>
                      <td>{money(est.gross, to)}</td>
                    </tr>
                    <tr>
                      <td>Service fee ({percent(r.feeRate)})</td>
                      <td>− {money(est.fee, to)}</td>
                    </tr>
                    <tr>
                      <td>Estimated payout</td>
                      <td>{money(est.payout, to)}</td>
                    </tr>
                  </tbody>
                </table>
              )}
            </>
          ) : null}
        </div>

        <ErrorAlert error={quoteError} />
        <button className="btn block" type="submit" disabled={!canQuote} style={{ marginTop: '0.75rem' }}>
          {submitting ? 'Creating quote…' : 'Get a firm quote'}
        </button>
        <p className="small muted" style={{ marginTop: '0.75rem' }}>
          The estimate above may change. A firm quote locks the rate and fee for a limited time.
        </p>
      </form>
    </div>
  );
}
