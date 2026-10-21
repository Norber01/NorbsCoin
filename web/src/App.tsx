import { NavLink, Link, Route, Routes } from 'react-router-dom';
import { api } from './lib/api';
import { ConfigContext, useAsync } from './lib/hooks';
import type { PublicConfig } from './lib/types';
import { Home } from './pages/Home';
import { Exchange } from './pages/Exchange';
import { Track, TrackLookup } from './pages/Track';
import { AdminApp } from './pages/admin/AdminApp';
import { Spinner, ErrorAlert } from './components/ui';

function PublicLayout({ children, config }: { children: React.ReactNode; config?: PublicConfig }) {
  const s = config?.settings;
  return (
    <>
      <header className="topbar">
        <div className="inner">
          <Link to="/" className="logo">
            <span className="logo-mark">N</span> {s?.business_name || 'NorbsCoin'}
          </Link>
          <nav className="nav">
            <NavLink to="/" end>
              Exchange
            </NavLink>
            <NavLink to="/track">Track order</NavLink>
          </nav>
        </div>
      </header>
      <main className="container">{children}</main>
      <footer className="site">
        {s && (
          <p>
            Support: {[s.support_email, s.support_phone, s.support_whatsapp && `WhatsApp ${s.support_whatsapp}`].filter(Boolean).join(' · ') || 'see your order page'}
            {s.operating_hours && <> · {s.operating_hours}</>}
          </p>
        )}
        <p>Exchange rates shown are reference rates. Your rate and payout are fixed only once you confirm a quote.</p>
      </footer>
    </>
  );
}

function PublicSite() {
  const config = useAsync(() => api.get<PublicConfig>('/api/config'), []);
  return (
    <ConfigContext.Provider value={config.data ?? null}>
      <PublicLayout config={config.data}>
        {config.loading && !config.data ? (
          <Spinner />
        ) : config.error ? (
          <ErrorAlert error={config.error} />
        ) : (
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/exchange/:quoteId" element={<Exchange />} />
            <Route path="/track" element={<TrackLookup />} />
            <Route path="/track/:reference" element={<Track />} />
            <Route path="*" element={<p>Page not found. <Link to="/">Go home</Link></p>} />
          </Routes>
        )}
      </PublicLayout>
    </ConfigContext.Provider>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/admin/*" element={<AdminApp />} />
      <Route path="/*" element={<PublicSite />} />
    </Routes>
  );
}
