import { createContext, useContext, useState } from 'react';
import { Link, NavLink, Route, Routes } from 'react-router-dom';
import { ErrorAlert, Field, Spinner } from '../../components/ui';
import { adminApi, ApiError } from '../../lib/api';
import { useAsync } from '../../lib/hooks';
import { Audit } from './Audit';
import { Dashboard } from './Dashboard';
import { OrderDetail } from './OrderDetail';
import { Orders } from './Orders';
import { SettingsPage } from './Settings';
import { Users } from './Users';

export interface Me {
  user: { id: string; email: string; name: string; role: 'owner' | 'operator' | 'viewer'; mfa_enabled: boolean };
  mfaVerified: boolean;
  mfaEnrollmentRequired: boolean;
}

const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext)!;
export const canWrite = (me: Me) => me.user.role !== 'viewer';
export const isOwner = (me: Me) => me.user.role === 'owner';

async function loadMe(): Promise<Me | null> {
  try {
    return await adminApi.get<Me>('/auth/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="container">
      <div className="narrow card" style={{ maxWidth: 420, marginTop: '8vh' }}>
        <div className="logo" style={{ marginBottom: '1rem' }}>
          <span className="logo-mark">N</span> Operator console
        </div>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <AuthCard title="Sign in">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await adminApi.post('/auth/login', { email, password });
            onDone();
          } catch (err) {
            setError(err as Error);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Email" htmlFor="email">
          <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" htmlFor="password">
          <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <ErrorAlert error={error} />
        <button className="btn block" disabled={busy} style={{ marginTop: '0.5rem' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthCard>
  );
}

function CodeForm({ submit, label }: { submit: (code: string) => Promise<void>; label: string }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await submit(code);
        } catch (err) {
          setError(err as Error);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="6-digit code from your authenticator app" htmlFor="code">
        <input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
      </Field>
      <ErrorAlert error={error} />
      <button className="btn block" disabled={busy || code.length !== 6} style={{ marginTop: '0.5rem' }}>
        {label}
      </button>
    </form>
  );
}

function Enroll({ onDone }: { onDone: () => void }) {
  const secret = useAsync(() => adminApi.post<{ secret: string; otpauthUrl: string }>('/auth/mfa/enroll'), []);
  return (
    <AuthCard title="Set up multi-factor authentication">
      <p className="small">MFA is required for every operator. Add this key to an authenticator app (Google Authenticator, 1Password, Authy…).</p>
      {secret.loading ? (
        <Spinner />
      ) : secret.error ? (
        <ErrorAlert error={secret.error} />
      ) : (
        <>
          <div className="instructions mono" style={{ wordBreak: 'break-all' }}>
            {secret.data!.secret.match(/.{1,4}/g)!.join(' ')}
          </div>
          <p className="small">
            On a phone, you can <a href={secret.data!.otpauthUrl}>open it directly in your authenticator app</a>.
          </p>
          <CodeForm
            label="Verify and enable"
            submit={async (code) => {
              await adminApi.post('/auth/mfa/enroll/verify', { code });
              onDone();
            }}
          />
        </>
      )}
    </AuthCard>
  );
}

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  return (
    <MeContext.Provider value={me}>
      <div className="admin-shell">
        <aside className="admin-side">
          <Link to="/admin" className="logo">
            <span className="logo-mark">N</span> Operator
          </Link>
          <nav>
            <NavLink to="/admin" end>
              Overview
            </NavLink>
            <NavLink to="/admin/orders">Orders</NavLink>
            <NavLink to="/admin/settings">Settings</NavLink>
            <NavLink to="/admin/audit">Audit log</NavLink>
            {isOwner(me) && <NavLink to="/admin/users">Users</NavLink>}
          </nav>
          <div className="small muted" style={{ marginTop: 'auto' }}>
            {me.user.name}
            <br />
            {me.user.role}
            <br />
            <button
              className="btn ghost small"
              style={{ paddingLeft: 0 }}
              onClick={async () => {
                await adminApi.post('/auth/logout').catch(() => {});
                onLogout();
              }}
            >
              Sign out
            </button>
          </div>
        </aside>
        <main className="admin-main">
          <Routes>
            <Route index element={<Dashboard />} />
            <Route path="orders" element={<Orders />} />
            <Route path="orders/:id" element={<OrderDetail />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="audit" element={<Audit />} />
            <Route path="users" element={<Users />} />
          </Routes>
        </main>
      </div>
    </MeContext.Provider>
  );
}

export function AdminApp() {
  const me = useAsync(loadMe, []);
  const reload = () => void me.reload();
  if (me.loading && me.data === undefined) return <div className="container"><Spinner /></div>;
  if (me.error) return <div className="container"><ErrorAlert error={me.error} /></div>;
  const m = me.data;
  if (!m) return <Login onDone={reload} />;
  if (m.mfaEnrollmentRequired) return <Enroll onDone={reload} />;
  if (!m.mfaVerified)
    return (
      <AuthCard title="Two-step verification">
        <CodeForm
          label="Verify"
          submit={async (code) => {
            await adminApi.post('/auth/mfa', { code });
            reload();
          }}
        />
      </AuthCard>
    );
  return <Shell me={m} onLogout={() => me.setData(null)} />;
}
