import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ErrorAlert, Spinner } from '../../components/ui';
import { adminApi } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { useAsync } from '../../lib/hooks';

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Entry {
  id: string;
  occurred_at: string;
  actor_type: string;
  actor_label: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  before: any;
  after: any;
  reason: string | null;
  ip: string | null;
  hash: string;
}

export function Audit() {
  const [before, setBefore] = useState<string | undefined>();
  const [entityType, setEntityType] = useState('');
  const log = useAsync(
    () => adminApi.get<{ entries: Entry[] }>(`/audit?limit=100${before ? `&before=${before}` : ''}${entityType ? `&entityType=${entityType}` : ''}`),
    [before, entityType],
  );
  const chain = useAsync(() => adminApi.get<{ ok: boolean; firstBrokenId: string | null }>('/audit/verify'), []);
  const entries = log.data?.entries ?? [];
  return (
    <div className="stack">
      <h1>Audit log</h1>
      <div className="spread">
        <div>
          {chain.data &&
            (chain.data.ok ? (
              <span className="badge completed">Hash chain verified — no entries altered</span>
            ) : (
              <span className="badge flag">Chain broken at entry {chain.data.firstBrokenId}</span>
            ))}
        </div>
        <select value={entityType} onChange={(e) => (setBefore(undefined), setEntityType(e.target.value))} style={{ width: 'auto' }}>
          <option value="">All entities</option>
          <option value="order">Orders</option>
          <option value="payment_proof">Payment proofs</option>
          <option value="corridor">Corridors & fees</option>
          <option value="setting">Settings</option>
          <option value="rate">Rates</option>
          <option value="admin_user">Users & logins</option>
        </select>
      </div>
      {log.loading && !log.data ? (
        <Spinner />
      ) : log.error ? (
        <ErrorAlert error={log.error} />
      ) : (
        <div className="card table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>#</th>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="small muted">{e.id}</td>
                  <td className="small nowrap">{dateTime(e.occurred_at)}</td>
                  <td className="small">
                    {e.actor_label ?? e.actor_type}
                    {e.ip && <div className="muted">{e.ip}</div>}
                  </td>
                  <td className="mono small">{e.action}</td>
                  <td className="small">
                    {e.entity_type === 'order' ? <Link to={`/admin/orders/${e.entity_id}`}>order</Link> : e.entity_type} <span className="muted mono">{e.entity_id.slice(0, 8)}</span>
                  </td>
                  <td className="small" style={{ maxWidth: 380 }}>
                    {e.reason && <div>Reason: {e.reason}</div>}
                    {(e.before || e.after) && (
                      <details>
                        <summary className="muted">Changes</summary>
                        <pre className="json">{JSON.stringify({ before: e.before, after: e.after }, null, 1)}</pre>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {entries.length === 100 && (
            <button className="btn secondary small" style={{ marginTop: '0.75rem' }} onClick={() => setBefore(entries.at(-1)!.id)}>
              Older entries
            </button>
          )}
        </div>
      )}
    </div>
  );
}
