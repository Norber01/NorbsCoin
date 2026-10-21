import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Breakdown } from '../components/Breakdown';
import { Countdown, ErrorAlert, Field, Spinner, StatusBadge } from '../components/ui';
import { api } from '../lib/api';
import { dateTime, money, relative } from '../lib/format';
import { useAsync, useConfig } from '../lib/hooks';
import type { TrackingOrder } from '../lib/types';

const PROGRESS = ['awaiting_payment', 'proof_submitted', 'payment_verified', 'payout_processing', 'completed'];
const PROGRESS_LABELS = ['Payment', 'Verification', 'Verified', 'Payout', 'Completed'];

function progressIndex(status: string) {
  if (status === 'resubmission_requested') return 0;
  return PROGRESS.indexOf(status);
}

export function TrackLookup() {
  const navigate = useNavigate();
  const [reference, setReference] = useState('');
  const [code, setCode] = useState('');
  return (
    <form
      className="narrow card"
      onSubmit={(e) => {
        e.preventDefault();
        const link = code.trim();
        // Accept a pasted full tracking link as well as just the code.
        const m = /\/track\/([^#/?]+)#t=([\w-]+)/.exec(link);
        if (m) navigate(`/track/${m[1]}#t=${m[2]}`);
        else navigate(`/track/${reference.trim().toUpperCase()}#t=${link}`);
      }}
    >
      <h2>Track your order</h2>
      <p className="muted">Open the private link you received when you confirmed your order, or paste it below.</p>
      <Field label="Order reference" htmlFor="ref" hint="Looks like NC-AB12-CD34. Not needed if you paste the full link.">
        <input id="ref" value={reference} onChange={(e) => setReference(e.target.value)} autoComplete="off" />
      </Field>
      <Field label="Tracking link or code" htmlFor="code">
        <input id="code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" />
      </Field>
      <button className="btn" type="submit" disabled={!code.trim()}>
        Track order
      </button>
    </form>
  );
}

function UploadProof({ order, token, onDone, maxBytes }: { order: TrackingOrder; token: string; onDone: (o: TrackingOrder) => void; maxBytes: number }) {
  const [file, setFile] = useState<File | null>(null);
  const [transferReference, setTransferReference] = useState(order.customerTransferReference ?? '');
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function pick(f: File | null) {
    setError(null);
    setDone(false);
    if (!f) return setFile(null);
    if (!['image/jpeg', 'image/png', 'application/pdf'].includes(f.type)) {
      setError(new Error('Please choose a JPG, PNG or PDF file.'));
      return setFile(null);
    }
    if (f.size > maxBytes) {
      setError(new Error(`The file must be ${Math.floor(maxBytes / 1024 / 1024)} MB or smaller.`));
      return setFile(null);
    }
    setFile(f);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.set('reference', order.reference);
    fd.set('token', token);
    fd.set('transferReference', transferReference);
    fd.set('file', file);
    try {
      const res = await api.post<{ order: TrackingOrder }>('/api/track/proof', fd);
      setDone(true);
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
      onDone(res.order);
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <h3>{order.proofs.length ? 'Upload corrected / additional proof' : 'Upload payment proof'}</h3>
      <Field label="Transfer reference (optional)" htmlFor="transferReference" hint="The transaction ID shown in your banking app.">
        <input id="transferReference" value={transferReference} onChange={(e) => setTransferReference(e.target.value)} maxLength={100} />
      </Field>
      <Field label="Receipt (JPG, PNG or PDF)" htmlFor="file" hint={`Max ${Math.floor(maxBytes / 1024 / 1024)} MB. Make sure the amount, date and recipient are visible.`}>
        <input id="file" ref={inputRef} type="file" accept="image/jpeg,image/png,application/pdf" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
      </Field>
      <ErrorAlert error={error} />
      {done && <div className="alert ok">Proof received. We will check that the funds arrived — this page updates automatically.</div>}
      <button className="btn" type="submit" disabled={!file || busy} style={{ marginTop: '0.5rem' }}>
        {busy ? 'Uploading…' : 'Submit proof'}
      </button>
      <p className="small muted" style={{ marginTop: '0.5rem' }}>
        Uploading a receipt does not confirm payment. Your order is verified only after we see the funds in our account.
      </p>
    </form>
  );
}

export function Track() {
  const { reference = '' } = useParams();
  const location = useLocation();
  const config = useConfig()!;
  const token = new URLSearchParams(location.hash.slice(1)).get('t') ?? '';
  const justCreated = (location.state as { justCreated?: boolean } | null)?.justCreated;
  const order = useAsync(() => api.post<{ order: TrackingOrder }>('/api/track', { reference, token }).then((r) => r.order), [reference, token]);
  const [copied, setCopied] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<Error | null>(null);

  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void order.reload();
    }, 60_000);
    return () => clearInterval(t);
  }, [reference, token]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!token) return <TrackLookup />;
  if (order.loading && !order.data) return <Spinner label="Loading your order…" />;
  if (order.error && !order.data)
    return (
      <div className="narrow stack">
        <ErrorAlert error={order.error} />
        <TrackLookup />
      </div>
    );
  const o = order.data!;
  const link = window.location.href;
  const idx = progressIndex(o.status);
  const s = o.support;

  async function cancel() {
    if (!window.confirm('Cancel this order? Only do this if you have NOT sent any payment.')) return;
    setCancelling(true);
    try {
      const res = await api.post<{ order: TrackingOrder }>('/api/track/cancel', { reference, token });
      order.setData(res.order);
    } catch (err) {
      setCancelError(err as Error);
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="stack">
      {justCreated && (
        <div className="alert ok no-print">
          <strong>Order created.</strong> Save this private page link — it is the only way to view the order without contacting us
          {o.terms && ' (we also emailed it if you gave an email)'}.
          <div className="row" style={{ marginTop: '0.5rem' }}>
            <input readOnly value={link} onFocus={(e) => e.target.select()} style={{ flex: 1, minWidth: 200 }} />
            <button
              className="btn small"
              onClick={() => navigator.clipboard?.writeText(link).then(() => setCopied(true), () => setCopied(false))}
            >
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="spread">
          <div>
            <div className="small muted">Order reference</div>
            <span className="reference-box">{o.reference}</span>
          </div>
          <div className="right">
            <StatusBadge status={o.status} />
            <div className="small muted">Updated {relative(o.updatedAt)}</div>
          </div>
        </div>
        {idx >= 0 && (
          <>
            <div className="progress" aria-hidden>
              {PROGRESS.map((p, i) => (
                <span key={p} className={i <= idx ? 'on' : ''} />
              ))}
            </div>
            <div className="progress-labels" aria-hidden>
              {PROGRESS_LABELS.map((l) => (
                <span key={l}>{l}</span>
              ))}
            </div>
          </>
        )}
        <p style={{ marginTop: '0.75rem', marginBottom: 0 }}>
          <strong>{o.statusLabel}.</strong>{' '}
          {o.status === 'awaiting_payment' && <>Send your payment using the instructions below, then upload the receipt.</>}
          {o.status === 'proof_submitted' && <>We are checking that your payment arrived. No action needed.</>}
          {o.status === 'payment_verified' && <>Your payment is confirmed. Expected payout by {dateTime(o.payoutDueAt)}.</>}
          {o.status === 'payout_processing' && <>We are sending the cedis to the recipient. Expected by {dateTime(o.payoutDueAt)}.</>}
          {o.status === 'completed' && <>The payout has been sent.</>}
          {o.status === 'expired' && <>No payment proof arrived within the payment window. If you already paid, contact support with your reference.</>}
        </p>
      </div>

      {o.operatorMessage && (
        <div className={`alert ${o.status === 'resubmission_requested' ? 'warn' : 'info'}`}>
          <strong>Message from us:</strong> {o.operatorMessage}
        </div>
      )}

      <div className="grid-2">
        <div className="stack">
          {o.paymentInstructions && (
            <div className="card stack">
              <h2>Payment instructions</h2>
              <dl className="kv">
                <dt>Amount to pay</dt>
                <dd>
                  <strong>{money(o.terms.sendAmount, o.terms.sendCurrency)}</strong>
                </dd>
                <dt>Method</dt>
                <dd>{o.paymentInstructions.method_label}</dd>
                <dt>Reference</dt>
                <dd>
                  <span className="mono">{o.reference}</span> — include this in the payment comment
                </dd>
                {o.status === 'awaiting_payment' && (
                  <>
                    <dt>Pay within</dt>
                    <dd>
                      <Countdown until={o.paymentDueAt} /> (by {dateTime(o.paymentDueAt)})
                    </dd>
                  </>
                )}
              </dl>
              <div className="instructions">{o.paymentInstructions.instructions}</div>
              <p className="small muted">Only pay to the details shown here. We will never ask you to pay to a different account by message.</p>
            </div>
          )}

          {o.canUploadProof && (
            <div className="card no-print">
              <UploadProof order={o} token={token} onDone={(n) => order.setData(n)} maxBytes={config.upload.maxBytes} />
            </div>
          )}

          {o.proofs.length > 0 && (
            <div className="card">
              <h3>Submitted proof</h3>
              <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
                {o.proofs.map((p, i) => (
                  <li key={i}>
                    {p.original_filename} — {dateTime(p.submitted_at)}{' '}
                    <span className="muted small">
                      ({p.review_status === 'pending' ? 'under review' : p.review_status === 'rejected' ? 'not accepted' : p.review_status})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {o.completion && (
            <div className="card">
              <h2>Payout completed</h2>
              <dl className="kv">
                <dt>Amount paid</dt>
                <dd>{money(o.completion.payoutAmount, o.terms.receiveCurrency)}</dd>
                <dt>Payout reference</dt>
                <dd className="mono">{o.completion.payoutReference}</dd>
                <dt>Date</dt>
                <dd>{o.completion.payoutDate}</dd>
              </dl>
            </div>
          )}
          {o.refund && (
            <div className="card">
              <h2>Refund</h2>
              <dl className="kv">
                <dt>Amount</dt>
                <dd>{money(o.refund.amount, o.refund.currency)}</dd>
                <dt>Reference</dt>
                <dd className="mono">{o.refund.reference}</dd>
                <dt>Reason</dt>
                <dd>{o.refund.reason}</dd>
              </dl>
            </div>
          )}

          <div className="card">
            <h2>History</h2>
            <ul className="timeline">
              {o.timeline.map((t, i) => (
                <li key={i}>
                  <strong>{t.label}</strong> <span className="small muted">{dateTime(t.at)}</span>
                  {t.note && <div className="small">{t.note}</div>}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <h2>Agreed terms</h2>
            <Breakdown {...o.terms} payoutLabel="Recipient gets" />
            <p className="small muted" style={{ marginTop: '0.5rem' }}>
              Confirmed {dateTime(o.terms.acceptedAt)} · terms {o.terms.termsVersion}. These amounts are fixed.
            </p>
          </div>
          <div className="card">
            <h2>Recipient</h2>
            <dl className="kv">
              <dt>Name</dt>
              <dd>{o.recipient.name}</dd>
              <dt>Phone</dt>
              <dd>{o.recipient.phone}</dd>
              <dt>Payout to</dt>
              <dd>{o.recipient.payoutMethod === 'mobile_money' ? `${o.recipient.mobileMoneyProvider}` : `${o.recipient.bankName} ${o.recipient.bankAccount ?? ''}`}</dd>
              <dt>Expected payout</dt>
              <dd>{o.payoutDueAt ? `By ${dateTime(o.payoutDueAt)}` : `Within ${o.expectedPayoutHours} hours after verification`}</dd>
            </dl>
          </div>
          <div className="card">
            <h2>Need help?</h2>
            <dl className="kv small">
              {s.email && (
                <>
                  <dt>Email</dt>
                  <dd>
                    <a href={`mailto:${s.email}?subject=${encodeURIComponent(`Order ${o.reference}`)}`}>{s.email}</a>
                  </dd>
                </>
              )}
              {s.phone && (
                <>
                  <dt>Phone</dt>
                  <dd>{s.phone}</dd>
                </>
              )}
              {s.whatsapp && (
                <>
                  <dt>WhatsApp</dt>
                  <dd>{s.whatsapp}</dd>
                </>
              )}
              {s.hours && (
                <>
                  <dt>Hours</dt>
                  <dd>{s.hours}</dd>
                </>
              )}
            </dl>
            <p className="small muted">Always quote your order reference. Never share this page's link publicly.</p>
          </div>
          <div className="row no-print">
            <button className="btn secondary" onClick={() => window.print()}>
              Download / print receipt
            </button>
            {o.canCancel && (
              <button className="btn secondary" onClick={cancel} disabled={cancelling}>
                {cancelling ? 'Cancelling…' : 'Cancel order'}
              </button>
            )}
          </div>
          <ErrorAlert error={cancelError} />
        </div>
      </div>
    </div>
  );
}
