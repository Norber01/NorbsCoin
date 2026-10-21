import { useState } from 'react';
import { ErrorAlert, Field, Spinner } from '../../components/ui';
import { adminApi } from '../../lib/api';
import { dateTime, percent, rate as fmtRate, relative } from '../../lib/format';
import { useAsync } from '../../lib/hooks';
import { canWrite, isOwner, useMe } from './AdminApp';

/* eslint-disable @typescript-eslint/no-explicit-any */
interface CorridorSettings {
  id: number;
  from_currency: string;
  to_currency: string;
  enabled: boolean;
  paused: boolean;
  pause_reason: string | null;
  min_send_amount: string;
  max_send_amount: string;
  quote_ttl_seconds: number;
  payment_window_minutes: number;
  payout_sla_hours: number;
  rate_max_age_seconds: number;
  payout_terms: string;
  currentFee: { id: number; version: number; fee_rate: string; effective_from: string; note: string | null } | null;
  feeHistory: { id: number; version: number; fee_rate: string; effective_from: string; note: string | null }[];
  instructions: { id: number; method_label: string; instructions: string; created_at: string } | null;
  rate: { snapshot: any; usable: boolean; stale: boolean; reason?: string };
}

function useSaver(after: () => unknown) {
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await fn();
      setSaved(true);
      await after();
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  }
  return { error, busy, saved, run };
}

function CorridorCard({ c, reload }: { c: CorridorSettings; reload: () => unknown }) {
  const me = useMe();
  const owner = isOwner(me);
  const write = canWrite(me);
  const s = useSaver(reload);
  const [limits, setLimits] = useState({
    min_send_amount: c.min_send_amount,
    max_send_amount: c.max_send_amount,
    quote_ttl_seconds: String(c.quote_ttl_seconds),
    payment_window_minutes: String(c.payment_window_minutes),
    payout_sla_hours: String(c.payout_sla_hours),
    rate_max_age_seconds: String(c.rate_max_age_seconds),
    payout_terms: c.payout_terms,
  });
  const [fee, setFee] = useState({ percent: '', note: '' });
  const [instr, setInstr] = useState({ methodLabel: c.instructions?.method_label ?? '', instructions: c.instructions?.instructions ?? '' });
  const [op, setOp] = useState({ rate: '', validMinutes: '60', note: '' });
  const [pauseReason, setPauseReason] = useState(c.pause_reason ?? '');
  const snap = c.rate.snapshot;
  const pair = `${c.from_currency} → ${c.to_currency}`;

  return (
    <div className="card stack">
      <div className="spread">
        <h2 style={{ margin: 0 }}>{pair}</h2>
        <span className="row">
          <span className={`badge ${!c.enabled ? 'cancelled' : c.paused ? 'awaiting_payment' : 'completed'}`}>{!c.enabled ? 'Disabled' : c.paused ? 'Paused' : 'Live'}</span>
        </span>
      </div>
      <ErrorAlert error={s.error} />
      {s.saved && <div className="alert ok small">Saved.</div>}

      <div className="grid-2">
        <div className="stack">
          <h3>Availability</h3>
          {c.paused && <div className="alert warn small">Paused: {c.pause_reason}</div>}
          {!c.instructions && c.enabled && <div className="alert error small">No payment instructions — customers cannot place orders.</div>}
          <Field label="Pause message shown to customers" htmlFor={`pause-${c.id}`}>
            <input id={`pause-${c.id}`} value={pauseReason} onChange={(e) => setPauseReason(e.target.value)} placeholder="New orders are temporarily paused." />
          </Field>
          <div className="row">
            {!c.paused && write && (
              <button className="btn secondary small" disabled={s.busy} onClick={() => s.run(() => adminApi.post(`/corridors/${c.id}/pause`, { reason: pauseReason }))}>
                Pause new orders
              </button>
            )}
            {c.paused && owner && (
              <button className="btn small" disabled={s.busy} onClick={() => s.run(() => adminApi.patch(`/corridors/${c.id}`, { paused: false }))}>
                Resume orders
              </button>
            )}
            {owner && (
              <button
                className="btn secondary small"
                disabled={s.busy}
                onClick={() => {
                  if (!c.enabled && !window.confirm(`Enable ${pair}? Only do this when you have a valid rate and an approved way to fulfil it.`)) return;
                  void s.run(() => adminApi.patch(`/corridors/${c.id}`, { enabled: !c.enabled }));
                }}
              >
                {c.enabled ? 'Disable corridor' : 'Enable corridor'}
              </button>
            )}
          </div>
        </div>

        <div className="stack">
          <h3>Exchange rate</h3>
          {snap ? (
            <div className={`alert ${c.rate.usable ? 'ok' : 'warn'} small`}>
              <strong>
                1 {c.from_currency} = {fmtRate(snap.rate)} {c.to_currency}
              </strong>{' '}
              ({snap.kind === 'operator' ? `operator rate, valid until ${dateTime(snap.valid_until)}` : snap.source})
              <br />
              Published {dateTime(snap.provider_timestamp)} ({relative(snap.provider_timestamp)}) · fetched {relative(snap.fetched_at)}
              {!c.rate.usable && <div>{c.rate.reason}</div>}
            </div>
          ) : (
            <div className="alert error small">{c.rate.reason ?? 'No rate available.'}</div>
          )}
          {write && (
            <>
              <button className="btn secondary small" disabled={s.busy} onClick={() => s.run(() => adminApi.post('/rates/refresh', { from: c.from_currency, to: c.to_currency }))}>
                Fetch rate now
              </button>
              <details className="action">
                <summary>Set operator rate</summary>
                <p className="small muted">
                  Use the rate you can actually obtain. It overrides the reference feed for new quotes until it expires, and is labelled as an operator rate.
                </p>
                <div className="grid-2">
                  <Field label={`${c.to_currency} per 1 ${c.from_currency}`} htmlFor={`op-${c.id}`}>
                    <input id={`op-${c.id}`} inputMode="decimal" value={op.rate} onChange={(e) => setOp({ ...op, rate: e.target.value })} />
                  </Field>
                  <Field label="Valid for (minutes)" htmlFor={`opv-${c.id}`}>
                    <input id={`opv-${c.id}`} inputMode="numeric" value={op.validMinutes} onChange={(e) => setOp({ ...op, validMinutes: e.target.value })} />
                  </Field>
                </div>
                <Field label="Note" htmlFor={`opn-${c.id}`}>
                  <input id={`opn-${c.id}`} value={op.note} onChange={(e) => setOp({ ...op, note: e.target.value })} />
                </Field>
                <div className="row">
                  <button
                    className="btn small"
                    disabled={s.busy || !op.rate}
                    onClick={() => s.run(() => adminApi.post('/rates/operator', { from: c.from_currency, to: c.to_currency, rate: op.rate, validMinutes: Number(op.validMinutes), note: op.note }))}
                  >
                    Set rate
                  </button>
                  {snap?.kind === 'operator' && (
                    <button className="btn secondary small" disabled={s.busy} onClick={() => s.run(() => adminApi.del(`/rates/operator?from=${c.from_currency}&to=${c.to_currency}`))}>
                      End operator rate
                    </button>
                  )}
                </div>
              </details>
            </>
          )}
        </div>
      </div>

      <div className="grid-2">
        <div className="stack">
          <h3>Service fee</h3>
          <p style={{ margin: 0 }}>
            Current: <strong>{percent(c.currentFee?.fee_rate)}</strong> (version {c.currentFee?.version}) — deducted from the gross converted amount.
          </p>
          <p className="small muted" style={{ margin: 0 }}>
            Changing the fee creates a new version. Confirmed orders keep the fee they agreed to.
          </p>
          {owner && (
            <div className="row" style={{ alignItems: 'end' }}>
              <div style={{ flex: '0 0 120px' }}>
                <Field label="New fee %" htmlFor={`fee-${c.id}`}>
                  <input id={`fee-${c.id}`} inputMode="decimal" placeholder="0.7" value={fee.percent} onChange={(e) => setFee({ ...fee, percent: e.target.value })} />
                </Field>
              </div>
              <div style={{ flex: 1 }}>
                <Field label="Reason" htmlFor={`feen-${c.id}`}>
                  <input id={`feen-${c.id}`} value={fee.note} onChange={(e) => setFee({ ...fee, note: e.target.value })} />
                </Field>
              </div>
              <button
                className="btn small"
                style={{ marginBottom: '0.9rem' }}
                disabled={s.busy || !fee.percent || Number.isNaN(Number(fee.percent))}
                onClick={() => {
                  // Convert percent to a fraction with string math to avoid float noise.
                  const fraction = (Number(fee.percent) / 100).toFixed(6);
                  if (!window.confirm(`Set the ${pair} fee to ${fee.percent}% for new quotes?`)) return;
                  void s.run(async () => {
                    await adminApi.post(`/corridors/${c.id}/fees`, { feeRate: fraction, note: fee.note });
                    setFee({ percent: '', note: '' });
                  });
                }}
              >
                Save new version
              </button>
            </div>
          )}
          <details>
            <summary className="small">Fee history</summary>
            <table className="data small">
              <tbody>
                {c.feeHistory.map((f) => (
                  <tr key={f.id}>
                    <td>v{f.version}</td>
                    <td>{percent(f.fee_rate)}</td>
                    <td>{dateTime(f.effective_from)}</td>
                    <td>{f.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>

        <div className="stack">
          <h3>Payment instructions ({c.from_currency})</h3>
          <p className="small muted" style={{ margin: 0 }}>
            Shown to customers after they confirm. Saving creates a new version; existing orders keep the version they saw.
            {c.instructions && ` Current version saved ${dateTime(c.instructions.created_at)}.`}
          </p>
          <Field label="Method label" htmlFor={`ml-${c.id}`}>
            <input id={`ml-${c.id}`} value={instr.methodLabel} disabled={!owner} onChange={(e) => setInstr({ ...instr, methodLabel: e.target.value })} placeholder="e.g. Bank card transfer (SBP)" />
          </Field>
          <Field label="Instructions" htmlFor={`in-${c.id}`}>
            <textarea id={`in-${c.id}`} rows={5} value={instr.instructions} disabled={!owner} onChange={(e) => setInstr({ ...instr, instructions: e.target.value })} />
          </Field>
          {owner && (
            <div className="row">
              <button
                className="btn small"
                disabled={s.busy || !instr.methodLabel || !instr.instructions}
                onClick={() => s.run(() => adminApi.post(`/corridors/${c.id}/instructions`, instr))}
              >
                Save instructions
              </button>
              {c.instructions && (
                <button
                  className="btn secondary small"
                  disabled={s.busy}
                  onClick={() => window.confirm('Remove instructions? New orders will be blocked.') && s.run(() => adminApi.del(`/corridors/${c.id}/instructions`))}
                >
                  Remove
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <details className="action">
        <summary>Limits, timings & payout terms</summary>
        <div className="grid-3">
          {(
            [
              ['min_send_amount', `Minimum (${c.from_currency})`],
              ['max_send_amount', `Maximum (${c.from_currency})`],
              ['quote_ttl_seconds', 'Quote validity (seconds)'],
              ['payment_window_minutes', 'Payment window (minutes)'],
              ['payout_sla_hours', 'Payout promise (hours after verification)'],
              ['rate_max_age_seconds', 'Max rate age (seconds)'],
            ] as const
          ).map(([k, label]) => (
            <Field key={k} label={label} htmlFor={`${k}-${c.id}`}>
              <input id={`${k}-${c.id}`} value={limits[k]} disabled={!owner} onChange={(e) => setLimits({ ...limits, [k]: e.target.value })} />
            </Field>
          ))}
        </div>
        <Field label="Payout terms shown to customers" htmlFor={`pt-${c.id}`}>
          <textarea id={`pt-${c.id}`} value={limits.payout_terms} disabled={!owner} onChange={(e) => setLimits({ ...limits, payout_terms: e.target.value })} />
        </Field>
        {owner && (
          <button
            className="btn small"
            disabled={s.busy}
            onClick={() =>
              s.run(() =>
                adminApi.patch(`/corridors/${c.id}`, {
                  min_send_amount: limits.min_send_amount,
                  max_send_amount: limits.max_send_amount,
                  quote_ttl_seconds: Number(limits.quote_ttl_seconds),
                  payment_window_minutes: Number(limits.payment_window_minutes),
                  payout_sla_hours: Number(limits.payout_sla_hours),
                  rate_max_age_seconds: Number(limits.rate_max_age_seconds),
                  payout_terms: limits.payout_terms,
                }),
              )
            }
          >
            Save limits
          </button>
        )}
      </details>
    </div>
  );
}

const BUSINESS_FIELDS: { key: string; label: string; type?: 'textarea' | 'list' | 'number' | 'json'; hint?: string }[] = [
  { key: 'business_name', label: 'Business name' },
  { key: 'support_email', label: 'Support email' },
  { key: 'support_phone', label: 'Support phone' },
  { key: 'support_whatsapp', label: 'WhatsApp' },
  { key: 'operating_hours', label: 'Operating hours' },
  { key: 'admin_notification_emails', label: 'Operator notification emails', type: 'list', hint: 'Comma-separated. These receive new-order, proof, deadline and failure alerts.' },
  { key: 'terms_version', label: 'Terms version', hint: 'Change this whenever you change the terms text; customers mid-checkout will be asked to review again.' },
  { key: 'terms_text', label: 'Terms text', type: 'textarea' },
  { key: 'unusual_amount_threshold', label: 'Large-order alert thresholds', type: 'json', hint: 'JSON per send currency, e.g. {"RUB": 150000}' },
  { key: 'max_orders_per_phone_24h', label: 'Max orders per recipient phone in 24h before flagging', type: 'number' },
  { key: 'payout_warning_hours', label: 'Warn this many hours before a payout is due', type: 'number' },
  { key: 'retention_days', label: 'Delete evidence & redact personal data after (days)', type: 'number' },
];

function BusinessSettings({ settings, reload }: { settings: Record<string, any>; reload: () => unknown }) {
  const me = useMe();
  const owner = isOwner(me);
  const s = useSaver(reload);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      BUSINESS_FIELDS.map((f) => [
        f.key,
        f.type === 'list' ? (settings[f.key] ?? []).join(', ') : f.type === 'json' ? JSON.stringify(settings[f.key] ?? {}) : String(settings[f.key] ?? ''),
      ]),
    ),
  );

  function save() {
    void s.run(async () => {
      const body: Record<string, unknown> = {};
      for (const f of BUSINESS_FIELDS) {
        const v = values[f.key];
        body[f.key] =
          f.type === 'list'
            ? v.split(',').map((x) => x.trim()).filter(Boolean)
            : f.type === 'number'
              ? Number(v)
              : f.type === 'json'
                ? (() => {
                    try {
                      return JSON.parse(v);
                    } catch {
                      throw new Error(`${f.label} must be valid JSON`);
                    }
                  })()
                : v;
      }
      await adminApi.patch('/settings', body);
    });
  }

  return (
    <div className="card">
      <h2>Business settings</h2>
      <div className="grid-2">
        {BUSINESS_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} htmlFor={`bs-${f.key}`} hint={f.hint}>
            {f.type === 'textarea' ? (
              <textarea id={`bs-${f.key}`} value={values[f.key]} disabled={!owner} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            ) : (
              <input id={`bs-${f.key}`} value={values[f.key]} disabled={!owner} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            )}
          </Field>
        ))}
      </div>
      <ErrorAlert error={s.error} />
      {s.saved && <div className="alert ok small">Saved.</div>}
      {owner && (
        <button className="btn" disabled={s.busy} onClick={save} style={{ marginTop: '0.5rem' }}>
          Save business settings
        </button>
      )}
    </div>
  );
}

export function SettingsPage() {
  const data = useAsync(() => adminApi.get<{ corridors: CorridorSettings[]; settings: Record<string, any>; rateProvider: string }>('/settings'), []);
  if (data.loading && !data.data) return <Spinner />;
  if (data.error) return <ErrorAlert error={data.error} />;
  const d = data.data!;
  const reload = () => data.reload();
  return (
    <div className="stack">
      <h1>Settings</h1>
      <p className="muted small">Reference rate provider: {d.rateProvider}. Every change on this page is recorded in the audit log.</p>
      {d.corridors.map((c) => (
        <CorridorCard key={c.id} c={c} reload={reload} />
      ))}
      <BusinessSettings settings={d.settings} reload={reload} />
    </div>
  );
}
