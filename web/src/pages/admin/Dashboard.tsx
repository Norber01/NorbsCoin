import { Link } from 'react-router-dom';
import { ErrorAlert, Spinner } from '../../components/ui';
import { adminApi } from '../../lib/api';
import { dateTime, money } from '../../lib/format';
import { useAsync } from '../../lib/hooks';
import { canWrite, useMe } from './AdminApp';

interface Metrics {
  totals: Record<string, number>;
  fees: { currency: string; collected: string; projected: string; verified_unpaid: string }[];
  volume: { currency: string; completed_send: string; completed_payout: string; avg_send: string; n: string }[];
  payoutTiming: { averageHoursVerifiedToPaid: string | null; completedLate: number };
  daily: { day: string; orders: string; completed: string; fees: string }[];
  openEvents: { id: string; kind: string; severity: string; message: string; order_id: string | null; created_at: string }[];
  emailOutbox: Record<string, number>;
}

function Stat({ label, value, to, attention }: { label: string; value: React.ReactNode; to?: string; attention?: boolean }) {
  const body = (
    <>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </>
  );
  return to ? (
    <Link to={to} className={`stat ${attention ? 'attention' : ''}`}>
      {body}
    </Link>
  ) : (
    <div className="stat">{body}</div>
  );
}

export function Dashboard() {
  const me = useMe();
  const m = useAsync(() => adminApi.get<Metrics>('/dashboard'), []);
  if (m.loading && !m.data) return <Spinner />;
  if (m.error) return <ErrorAlert error={m.error} />;
  const d = m.data!;
  const t = d.totals;
  const maxDaily = Math.max(1, ...d.daily.map((x) => Number(x.orders)));
  return (
    <div className="stack">
      <div className="spread">
        <h1>Overview</h1>
        <button className="btn secondary small" onClick={() => m.reload()}>
          Refresh
        </button>
      </div>

      {d.openEvents.length > 0 && (
        <div className="card stack">
          <h2>Alerts</h2>
          {d.openEvents.map((e) => (
            <div key={e.id} className={`alert ${e.severity === 'critical' ? 'error' : e.severity === 'warning' ? 'warn' : 'info'}`}>
              <div className="spread">
                <span>
                  <strong>{e.kind.replace(/_/g, ' ')}</strong> · {dateTime(e.created_at)}
                  <br />
                  {e.message} {e.order_id && <Link to={`/admin/orders/${e.order_id}`}>Open order</Link>}
                </span>
                {canWrite(me) && (
                  <button
                    className="btn secondary small"
                    onClick={async () => {
                      await adminApi.post(`/events/${e.id}/ack`);
                      m.reload();
                    }}
                  >
                    Acknowledge
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="stats">
        <Stat label="Total orders" value={t.orders} to="/admin/orders" />
        <Stat label="Awaiting payment" value={t.pendingPayment} to="/admin/orders?status=awaiting_payment" />
        <Stat label="Proof to verify" value={t.awaitingVerification} to="/admin/orders?status=proof_submitted" attention={t.awaitingVerification > 0} />
        <Stat label="Verified · payout due" value={t.verifiedAwaitingPayout} to="/admin/orders?status=payment_verified" attention={t.verifiedAwaitingPayout > 0} />
        <Stat label="Completed" value={t.completed} to="/admin/orders?status=completed" />
        <Stat label="Rejected" value={t.rejected} to="/admin/orders?status=rejected" />
        <Stat label="Cancelled / expired" value={t.cancelled + t.expired} />
        <Stat label="Refunded" value={t.refunded} to="/admin/orders?status=refunded" />
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>Service-fee revenue</h2>
          <p className="small muted">
            Collected = fees on completed orders. Projected = fees on orders still in progress (may not materialise). Gross fees are not profit:
            subtract spread, transfer charges and operating costs.
          </p>
          <table className="data">
            <thead>
              <tr>
                <th>Currency</th>
                <th className="num">Collected</th>
                <th className="num">Projected</th>
                <th className="num">Payouts owed</th>
              </tr>
            </thead>
            <tbody>
              {d.fees.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    No orders yet
                  </td>
                </tr>
              )}
              {d.fees.map((f) => (
                <tr key={f.currency}>
                  <td>{f.currency}</td>
                  <td className="num">
                    <strong>{money(f.collected, f.currency)}</strong>
                  </td>
                  <td className="num">{money(f.projected, f.currency)}</td>
                  <td className="num">{money(f.verified_unpaid, f.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.volume.map((v) => (
            <p key={v.currency} className="small" style={{ marginTop: '0.75rem' }}>
              Completed volume: <strong>{money(v.completed_send, v.currency)}</strong> across {v.n} orders · average {money(v.avg_send, v.currency)}
            </p>
          ))}
          <p className="small">
            Average verification → payout: {d.payoutTiming.averageHoursVerifiedToPaid ?? '—'} h · completed late: {d.payoutTiming.completedLate}
          </p>
        </div>
        <div className="card">
          <h2>Last 14 days</h2>
          <div className="bars" aria-label="Orders per day">
            {d.daily.map((x) => (
              <div key={x.day} title={`${x.day}: ${x.orders} orders, ${x.completed} completed`} style={{ height: `${(Number(x.orders) / maxDaily) * 100}%` }} />
            ))}
          </div>
          <div className="spread small muted">
            <span>{d.daily[0]?.day}</span>
            <span>{d.daily.at(-1)?.day}</span>
          </div>
          <p className="small" style={{ marginTop: '0.75rem' }}>
            Email queue: {d.emailOutbox.pending ?? 0} pending · {d.emailOutbox.sent ?? 0} sent ·{' '}
            <span style={{ color: d.emailOutbox.failed ? 'var(--danger)' : undefined }}>{d.emailOutbox.failed ?? 0} failed</span>
          </p>
        </div>
      </div>
    </div>
  );
}
