import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ErrorAlert, Spinner, StatusBadge } from '../../components/ui';
import { adminApi } from '../../lib/api';
import { dateTime, money, relative, STATUS_LABEL } from '../../lib/format';
import { useAsync } from '../../lib/hooks';

interface Row {
  id: string;
  reference: string;
  status: string;
  created_at: string;
  send_amount: string;
  send_currency: string;
  payout_amount: string;
  receive_currency: string;
  recipient_name: string;
  recipient_phone: string;
  payout_method: string;
  payment_due_at: string;
  payout_due_at: string | null;
  flags: string[];
}

const FILTER_KEYS = ['q', 'status', 'from', 'to', 'minAmount', 'maxAmount', 'flagged', 'page'] as const;

export function Orders() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [draft, setDraft] = useState(() => Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])));
  const qs = params.toString();
  const list = useAsync(() => adminApi.get<{ orders: Row[]; total: number; page: number; pageSize: number }>(`/orders?${qs}`), [qs]);

  function apply(e?: React.FormEvent, page = 1) {
    e?.preventDefault();
    const next = new URLSearchParams();
    for (const k of FILTER_KEYS) if (draft[k] && k !== 'page') next.set(k, draft[k]);
    if (page > 1) next.set('page', String(page));
    setParams(next);
  }

  const d = list.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setDraft({ ...draft, [k]: e.target instanceof HTMLInputElement && e.target.type === 'checkbox' ? (e.target.checked ? '1' : '') : e.target.value });

  return (
    <div className="stack">
      <div className="spread">
        <h1>Orders</h1>
        <a className="btn secondary small" href="/api/admin/orders.csv">
          Export CSV
        </a>
      </div>
      <form className="filters card flat" onSubmit={apply}>
        <div className="field">
          <label htmlFor="q">Search</label>
          <input id="q" placeholder="Reference, phone, name, transfer ref, email" value={draft.q} onChange={set('q')} />
        </div>
        <div className="field">
          <label htmlFor="status">Status</label>
          <select id="status" value={draft.status} onChange={set('status')}>
            <option value="">All</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="from">From</label>
          <input id="from" type="date" value={draft.from} onChange={set('from')} />
        </div>
        <div className="field">
          <label htmlFor="to">To</label>
          <input id="to" type="date" value={draft.to} onChange={set('to')} />
        </div>
        <div className="field">
          <label htmlFor="minAmount">Min amount</label>
          <input id="minAmount" inputMode="decimal" value={draft.minAmount} onChange={set('minAmount')} />
        </div>
        <div className="field">
          <label htmlFor="maxAmount">Max amount</label>
          <input id="maxAmount" inputMode="decimal" value={draft.maxAmount} onChange={set('maxAmount')} />
        </div>
        <div className="stack" style={{ gap: '0.3rem' }}>
          <label className="check small">
            <input type="checkbox" checked={draft.flagged === '1'} onChange={set('flagged')} /> Flagged
          </label>
          <button className="btn small">Apply</button>
        </div>
      </form>
      {list.loading && !d ? (
        <Spinner />
      ) : list.error ? (
        <ErrorAlert error={list.error} />
      ) : (
        <div className="card table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Status</th>
                <th>Created</th>
                <th className="num">Send</th>
                <th className="num">Payout</th>
                <th>Recipient</th>
                <th>Due</th>
              </tr>
            </thead>
            <tbody>
              {d!.orders.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    No orders match.
                  </td>
                </tr>
              )}
              {d!.orders.map((o) => (
                <tr key={o.id} className="clickable" onClick={() => navigate(`/admin/orders/${o.id}`)}>
                  <td className="mono nowrap">
                    {o.reference}
                    {o.flags.map((f) => (
                      <div key={f}>
                        <span className="badge flag">{f.replace(/_/g, ' ')}</span>
                      </div>
                    ))}
                  </td>
                  <td>
                    <StatusBadge status={o.status} />
                  </td>
                  <td className="nowrap small">{dateTime(o.created_at)}</td>
                  <td className="num">{money(o.send_amount, o.send_currency)}</td>
                  <td className="num">{money(o.payout_amount, o.receive_currency)}</td>
                  <td className="small">
                    {o.recipient_name}
                    <br />
                    <span className="muted">{o.recipient_phone}</span>
                  </td>
                  <td className="small nowrap">
                    {o.status === 'awaiting_payment' && <>Pay {relative(o.payment_due_at)}</>}
                    {['payment_verified', 'payout_processing'].includes(o.status) && o.payout_due_at && (
                      <span style={{ color: new Date(o.payout_due_at) < new Date() ? 'var(--danger)' : undefined }}>Payout {relative(o.payout_due_at)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="spread" style={{ marginTop: '0.75rem' }}>
            <span className="small muted">
              {d!.total} order(s) · page {d!.page} of {pages}
            </span>
            <span className="row">
              <button className="btn secondary small" disabled={d!.page <= 1} onClick={() => apply(undefined, d!.page - 1)}>
                Previous
              </button>
              <button className="btn secondary small" disabled={d!.page >= pages} onClick={() => apply(undefined, d!.page + 1)}>
                Next
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
