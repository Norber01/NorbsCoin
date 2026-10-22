import { useState } from 'react';
import { ErrorAlert, Field, Spinner } from '../../components/ui';
import { adminApi } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { useAsync } from '../../lib/hooks';
import { isOwner, useMe } from './AdminApp';

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  mfa_enabled: boolean;
  active: boolean;
  last_login_at: string | null;
}

export function Users() {
  const me = useMe();
  const users = useAsync(() => adminApi.get<{ users: User[] }>('/users'), []);
  const [form, setForm] = useState({ email: '', name: '', password: '', role: 'operator' });
  const [error, setError] = useState<Error | null>(null);
  if (!isOwner(me)) return <div className="alert info">Only owners can manage users.</div>;
  if (users.loading && !users.data) return <Spinner />;

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await users.reload();
    } catch (err) {
      setError(err as Error);
    }
  }

  return (
    <div className="stack">
      <h1>Users</h1>
      <p className="small muted">Owner: full access. Operator: verify payments, payouts, refunds, pause corridor, set rates. Viewer: read-only.</p>
      <ErrorAlert error={error ?? users.error} />
      <div className="card table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>MFA</th>
              <th>Last login</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.data?.users.map((u) => (
              <tr key={u.id} style={{ opacity: u.active ? 1 : 0.5 }}>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td>
                  <select value={u.role} disabled={u.id === me.user.id} onChange={(e) => run(() => adminApi.patch(`/users/${u.id}`, { role: e.target.value }))} style={{ width: 'auto' }}>
                    <option value="owner">owner</option>
                    <option value="operator">operator</option>
                    <option value="viewer">viewer</option>
                  </select>
                </td>
                <td>{u.mfa_enabled ? '✓' : <span className="badge awaiting_payment">not set up</span>}</td>
                <td className="small">{dateTime(u.last_login_at)}</td>
                <td className="row">
                  {u.id !== me.user.id && (
                    <>
                      <button className="btn secondary small" onClick={() => run(() => adminApi.patch(`/users/${u.id}`, { active: !u.active }))}>
                        {u.active ? 'Deactivate' : 'Reactivate'}
                      </button>
                      {u.mfa_enabled && (
                        <button
                          className="btn secondary small"
                          onClick={() => window.confirm(`Reset MFA for ${u.email}? They will enrol again at next sign-in.`) && run(() => adminApi.patch(`/users/${u.id}`, { resetMfa: true }))}
                        >
                          Reset MFA
                        </button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await adminApi.post('/users', form);
            setForm({ email: '', name: '', password: '', role: 'operator' });
          });
        }}
      >
        <h2>Add user</h2>
        <div className="grid-2">
          <Field label="Name" htmlFor="u-name">
            <input id="u-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Email" htmlFor="u-email">
            <input id="u-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label="Temporary password" htmlFor="u-pw" hint="At least 12 characters. Share it securely; MFA setup is required at first sign-in.">
            <input id="u-pw" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
          <Field label="Role" htmlFor="u-role">
            <select id="u-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="operator">operator</option>
              <option value="viewer">viewer</option>
              <option value="owner">owner</option>
            </select>
          </Field>
        </div>
        <button className="btn" disabled={!form.email || !form.name || form.password.length < 12}>
          Create user
        </button>
      </form>
    </div>
  );
}
