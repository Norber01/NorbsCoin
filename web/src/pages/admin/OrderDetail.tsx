import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Breakdown } from '../../components/Breakdown';
import { ErrorAlert, Spinner, StatusBadge } from '../../components/ui';
import { adminApi } from '../../lib/api';
import { dateTime, money } from '../../lib/format';
import { useAsync } from '../../lib/hooks';
import { canWrite, useMe } from './AdminApp';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Detail = {
  order: Record<string, any>;
  allowedActions: string[];
  history: { id: string; from_status: string | null; to_status: string; actor_type: string; actor_name: string | null; customer_note: string | null; created_at: string }[];
  proofs: {
    id: string;
    original_filename: string;
    mime_type: string;
    size_bytes: number;
    sha256: string;
    transfer_reference: string | null;
    review_status: string;
    review_note: string | null;
    submitted_at: string;
    reviewed_by_name: string | null;
    deleted_at: string | null;
    duplicate_of: string[] | null;
  }[];
  audit: { id: string; occurred_at: string; actor_type: string; actor_label: string | null; action: string; before: any; after: any; reason: string | null }[];
  paymentInstructions: { method_label: string; instructions: string } | null;
  events: { id: string; kind: string; severity: string; message: string; created_at: string }[];
};

interface FieldSpec {
  name: string;
  label: string;
  type?: 'text' | 'textarea' | 'date' | 'checkbox';
  initial?: string | boolean;
  required?: boolean;
  hint?: string;
}

function ActionForm(props: {
  title: string;
  description?: React.ReactNode;
  fields: FieldSpec[];
  submitLabel: string;
  danger?: boolean;
  confirm?: string;
  onSubmit: (values: Record<string, any>) => Promise<unknown>;
  open?: boolean;
}) {
  const [values, setValues] = useState<Record<string, any>>(() => Object.fromEntries(props.fields.map((f) => [f.name, f.initial ?? (f.type === 'checkbox' ? false : '')])));
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const missing = props.fields.some((f) => f.required && (f.type === 'checkbox' ? !values[f.name] : !String(values[f.name]).trim()));
  return (
    <details className="action" open={props.open}>
      <summary>{props.title}</summary>
      {props.description && <div className="small muted" style={{ marginBottom: '0.75rem' }}>{props.description}</div>}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (props.confirm && !window.confirm(props.confirm)) return;
          setBusy(true);
          setError(null);
          try {
            await props.onSubmit(values);
          } catch (err) {
            setError(err as Error);
          } finally {
            setBusy(false);
          }
        }}
      >
        {props.fields.map((f) =>
          f.type === 'checkbox' ? (
            <label key={f.name} className="check field">
              <input type="checkbox" checked={!!values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.checked })} />
              {f.label}
            </label>
          ) : (
            <div className="field" key={f.name}>
              <label htmlFor={`${props.title}-${f.name}`}>
                {f.label}
                {f.required ? '' : ' (optional)'}
              </label>
              {f.type === 'textarea' ? (
                <textarea id={`${props.title}-${f.name}`} value={values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
              ) : (
                <input
                  id={`${props.title}-${f.name}`}
                  type={f.type === 'date' ? 'date' : 'text'}
                  value={values[f.name]}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                />
              )}
              {f.hint && <div className="hint">{f.hint}</div>}
            </div>
          ),
        )}
        <ErrorAlert error={error} />
        <button className={`btn ${props.danger ? 'danger' : ''}`} disabled={busy || missing} style={{ marginTop: '0.5rem' }}>
          {busy ? 'Saving…' : props.submitLabel}
        </button>
      </form>
    </details>
  );
}

function Copy({ value }: { value: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="btn ghost small"
      type="button"
      onClick={() => navigator.clipboard?.writeText(value).then(() => (setOk(true), setTimeout(() => setOk(false), 1500)))}
    >
      {ok ? 'Copied' : 'Copy'}
    </button>
  );
}

export function OrderDetail() {
  const { id } = useParams();
  const me = useMe();
  const detail = useAsync(() => adminApi.get<Detail>(`/orders/${id}`), [id]);
  const [link, setLink] = useState<{ trackingUrl: string; emailed: boolean } | null>(null);
  const [showProof, setShowProof] = useState<string | null>(null);

  if (detail.loading && !detail.data) return <Spinner />;
  if (detail.error) return <ErrorAlert error={detail.error} />;
  const d = detail.data!;
  const o = d.order;
  const act = (path: string) => async (body: Record<string, unknown>) => {
    await adminApi.post(`/orders/${id}/${path}`, body);
    await detail.reload();
  };
  const allowed = new Set(d.allowedActions);
  const writable = canWrite(me);
  const today = new Date().toISOString().slice(0, 10);
  const payoutTarget =
    o.payout_method === 'mobile_money' ? `${o.mobile_money_provider} · ${o.recipient_phone}` : `${o.bank_name} · ${o.bank_account_number}${o.bank_branch ? ` · ${o.bank_branch}` : ''}`;

  return (
    <div className="stack">
      <div className="small">
        <Link to="/admin/orders">← Orders</Link>
      </div>
      <div className="spread">
        <div>
          <h1 className="mono" style={{ marginBottom: '0.25rem' }}>
            {o.reference}
          </h1>
          <div className="row">
            <StatusBadge status={o.status} />
            {o.flags.map((f: string) => (
              <span key={f} className="badge flag">
                {f.replace(/_/g, ' ')}
              </span>
            ))}
            <span className="small muted">
              Created {dateTime(o.created_at)} · status since {dateTime(o.status_changed_at)}
            </span>
          </div>
        </div>
      </div>

      {d.events.length > 0 && (
        <div className="stack">
          {d.events.map((e) => (
            <div key={e.id} className={`alert ${e.severity === 'critical' ? 'error' : 'warn'}`}>
              <strong>{e.kind.replace(/_/g, ' ')}</strong>: {e.message}
            </div>
          ))}
        </div>
      )}

      <div className="grid-2">
        <div className="stack">
          <div className="card">
            <h2>Agreed terms</h2>
            <Breakdown
              sendAmount={o.send_amount}
              sendCurrency={o.send_currency}
              receiveCurrency={o.receive_currency}
              rate={o.rate}
              rateSource={`${o.rate_source}${o.rate_kind === 'operator' ? ' (operator)' : ''}`}
              rateTimestamp={o.rate_timestamp}
              grossAmount={o.gross_amount}
              feeRate={o.fee_rate}
              feeAmount={o.fee_amount}
              payoutAmount={o.payout_amount}
            />
            <p className="small muted" style={{ marginTop: '0.5rem' }}>
              Fee schedule #{o.fee_schedule_id} · terms {o.terms_version} accepted {dateTime(o.terms_accepted_at)} · quote {o.quote_id}
            </p>
          </div>

          <div className="card">
            <h2>Recipient & payout</h2>
            <dl className="kv">
              <dt>Name</dt>
              <dd>
                {o.recipient_name} <Copy value={o.recipient_name} />
              </dd>
              <dt>Phone</dt>
              <dd>
                {o.recipient_phone} <Copy value={o.recipient_phone} />
              </dd>
              <dt>Method</dt>
              <dd>{o.payout_method === 'mobile_money' ? 'Mobile money' : 'Bank transfer'}</dd>
              <dt>Pay to</dt>
              <dd>{payoutTarget}</dd>
              {o.bank_account_number && (
                <>
                  <dt>Account</dt>
                  <dd>
                    {o.bank_account_number} <Copy value={o.bank_account_number} />
                  </dd>
                </>
              )}
              <dt>Amount to pay</dt>
              <dd>
                <strong>{money(o.payout_amount, o.receive_currency)}</strong> <Copy value={o.payout_amount} />
              </dd>
              <dt>Payout due</dt>
              <dd style={{ color: o.payout_due_at && new Date(o.payout_due_at) < new Date() && !o.completed_at ? 'var(--danger)' : undefined }}>
                {o.payout_due_at ? dateTime(o.payout_due_at) : `${o.payout_sla_hours} h after verification`}
              </dd>
              <dt>Customer email</dt>
              <dd>{o.customer_email ?? '—'}</dd>
            </dl>
          </div>

          <div className="card">
            <h2>Payment</h2>
            <dl className="kv">
              <dt>Expected</dt>
              <dd>
                <strong>{money(o.send_amount, o.send_currency)}</strong> with reference <span className="mono">{o.reference}</span>
              </dd>
              <dt>Due by</dt>
              <dd>{dateTime(o.payment_due_at)}</dd>
              <dt>Customer ref</dt>
              <dd className="mono">{o.customer_transfer_reference ?? '—'}</dd>
              <dt>Verified</dt>
              <dd>
                {o.verified_at ? (
                  <>
                    {money(o.verified_amount, o.send_currency)} · ref <span className="mono">{o.verified_reference}</span> · {o.verified_by_name} ·{' '}
                    {dateTime(o.verified_at)}
                  </>
                ) : (
                  'Not verified'
                )}
              </dd>
              {o.completed_at && (
                <>
                  <dt>Paid out</dt>
                  <dd>
                    {money(o.payout_actual_amount, o.receive_currency)} · ref <span className="mono">{o.payout_reference}</span> · {o.payout_date} ·{' '}
                    {o.completed_by_name}
                    {o.payout_discrepancy_note && <div className="alert warn small">Discrepancy: {o.payout_discrepancy_note}</div>}
                  </dd>
                </>
              )}
              {o.refunded_at && (
                <>
                  <dt>Refund</dt>
                  <dd>
                    {money(o.refund_amount, o.refund_currency)} · ref <span className="mono">{o.refund_reference}</span> · {o.refund_reason}
                  </dd>
                </>
              )}
              {o.rejection_reason && (
                <>
                  <dt>Rejected</dt>
                  <dd>{o.rejection_reason}</dd>
                </>
              )}
              {o.cancellation_reason && (
                <>
                  <dt>Cancelled</dt>
                  <dd>{o.cancellation_reason}</dd>
                </>
              )}
            </dl>
            {d.paymentInstructions && (
              <details style={{ marginTop: '0.75rem' }}>
                <summary className="small">Instructions shown to customer ({d.paymentInstructions.method_label})</summary>
                <div className="instructions small">{d.paymentInstructions.instructions}</div>
              </details>
            )}
          </div>

          <div className="card">
            <h2>Payment evidence</h2>
            <p className="small muted">A receipt is not proof that funds arrived. Always check the receiving account before verifying.</p>
            {d.proofs.length === 0 && <p className="muted">No proof submitted yet.</p>}
            <div className="stack">
              {d.proofs.map((p) => {
                const url = `/api/admin/orders/${id}/proofs/${p.id}`;
                return (
                  <div key={p.id} className="card flat">
                    <div className="spread">
                      <div>
                        <strong>{p.original_filename}</strong> <span className={`badge ${p.review_status === 'accepted' ? 'completed' : p.review_status === 'rejected' ? 'rejected' : ''}`}>{p.review_status}</span>
                        <div className="small muted">
                          {dateTime(p.submitted_at)} · {(p.size_bytes / 1024).toFixed(0)} KB · {p.mime_type} · ref {p.transfer_reference ?? '—'}
                        </div>
                        {p.duplicate_of && <div className="badge flag">Same file used on {p.duplicate_of.join(', ')}</div>}
                        {p.review_note && <div className="small">Note: {p.review_note}</div>}
                      </div>
                      {!p.deleted_at && (
                        <span className="row">
                          {p.mime_type.startsWith('image/') && (
                            <button className="btn secondary small" onClick={() => setShowProof(showProof === p.id ? null : p.id)}>
                              {showProof === p.id ? 'Hide' : 'Preview'}
                            </button>
                          )}
                          <a className="btn secondary small" href={url} target="_blank" rel="noreferrer noopener">
                            Open
                          </a>
                        </span>
                      )}
                      {p.deleted_at && <span className="small muted">Deleted by retention policy</span>}
                    </div>
                    {showProof === p.id && <img className="proof" src={url} alt={`Payment proof ${p.original_filename}`} style={{ marginTop: '0.75rem' }} />}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="panel-actions">
          <h2 style={{ margin: 0 }}>Actions</h2>
          {!writable && <div className="alert info">Your role is read-only.</div>}
          {writable && (
            <>
              {allowed.has('payment_verified') && o.status !== 'payout_processing' && (
                <ActionForm
                  open
                  title="Verify payment"
                  description="Only verify after you have independently confirmed the funds in the receiving account. The bank/statement reference is checked for reuse across orders."
                  fields={[
                    { name: 'verifiedAmount', label: `Amount received (${o.send_currency})`, initial: o.send_amount, required: true },
                    { name: 'verifiedReference', label: 'Bank/statement transaction reference', initial: o.customer_transfer_reference ?? '', required: true },
                    { name: 'note', label: 'Note', type: 'textarea', hint: 'Required if more than the agreed amount was received.' },
                    { name: 'fundsConfirmed', label: 'I confirmed the funds arrived in our account (not just from the receipt).', type: 'checkbox', required: true },
                  ]}
                  submitLabel="Mark payment verified"
                  onSubmit={act('verify')}
                />
              )}
              {allowed.has('resubmission_requested') && (
                <ActionForm
                  title="Request corrected proof"
                  fields={[{ name: 'message', label: 'Message to the customer', type: 'textarea', required: true }]}
                  submitLabel="Request new proof"
                  onSubmit={act('request-resubmission')}
                />
              )}
              {allowed.has('payout_processing') && (
                <ActionForm
                  open
                  title="Start payout"
                  description={`Send ${money(o.payout_amount, o.receive_currency)} to ${o.recipient_name} (${payoutTarget}). Marks the order as payout processing so the customer sees progress.`}
                  fields={[]}
                  submitLabel="Mark payout processing"
                  onSubmit={act('start-payout')}
                />
              )}
              {allowed.has('completed') && (
                <ActionForm
                  open
                  title="Confirm payout completed"
                  fields={[
                    { name: 'actualAmount', label: `Actual amount paid (${o.receive_currency})`, initial: o.payout_amount, required: true },
                    { name: 'payoutReference', label: 'Payout transaction reference', required: true },
                    { name: 'payoutDate', label: 'Payout date', type: 'date', initial: today, required: true },
                    { name: 'discrepancyNote', label: 'Discrepancy note', type: 'textarea', hint: 'Required if the amount differs from the agreed payout.' },
                  ]}
                  submitLabel="Mark completed"
                  onSubmit={act('complete')}
                />
              )}
              {o.status === 'payout_processing' && allowed.has('payment_verified') && (
                <ActionForm
                  title="Payout failed — revert to verified"
                  fields={[{ name: 'reason', label: 'Reason', type: 'textarea', required: true }]}
                  submitLabel="Revert"
                  onSubmit={act('revert-payout')}
                />
              )}
              {allowed.has('refunded') && (
                <ActionForm
                  title="Record refund"
                  fields={[
                    { name: 'amount', label: `Refund amount (${o.send_currency})`, initial: o.verified_amount ?? o.send_amount, required: true },
                    { name: 'reference', label: 'Refund transaction reference', required: true },
                    { name: 'reason', label: 'Reason (shown to customer)', type: 'textarea', required: true },
                  ]}
                  submitLabel="Mark refunded"
                  danger
                  confirm="Record this refund? This is final."
                  onSubmit={act('refund')}
                />
              )}
              {allowed.has('rejected') && (
                <ActionForm
                  title="Reject order"
                  fields={[
                    { name: 'reason', label: 'Internal reason', type: 'textarea', required: true },
                    { name: 'customerMessage', label: 'Message to customer', type: 'textarea' },
                  ]}
                  submitLabel="Reject"
                  danger
                  confirm="Reject this order? This is final."
                  onSubmit={act('reject')}
                />
              )}
              {allowed.has('cancelled') && (
                <ActionForm
                  title="Cancel order"
                  fields={[{ name: 'reason', label: 'Reason', type: 'textarea', required: true }]}
                  submitLabel="Cancel order"
                  danger
                  confirm="Cancel this order?"
                  onSubmit={act('cancel')}
                />
              )}
              <ActionForm
                title="Customer-visible message"
                fields={[{ name: 'message', label: 'Message on tracking page', type: 'textarea', initial: o.operator_message ?? '' }]}
                submitLabel="Save message"
                onSubmit={act('message')}
              />
              <details className="action">
                <summary>Reissue tracking link</summary>
                <p className="small muted">Creates a new private link; the old one stops working. It is emailed if the customer gave an email.</p>
                <button
                  className="btn secondary small"
                  onClick={async () => {
                    if (!window.confirm('Invalidate the current tracking link and create a new one?')) return;
                    setLink(await adminApi.post(`/orders/${id}/reissue-link`));
                    void detail.reload();
                  }}
                >
                  Generate new link
                </button>
                {link && (
                  <div className="alert ok small" style={{ marginTop: '0.5rem', wordBreak: 'break-all' }}>
                    {link.trackingUrl} <Copy value={link.trackingUrl} />
                    <div>{link.emailed ? 'Emailed to the customer.' : 'No email on file — send it to the customer securely.'}</div>
                  </div>
                )}
              </details>
            </>
          )}

          <div className="card">
            <h3>Status history</h3>
            <ul className="timeline small">
              {d.history.map((h) => (
                <li key={h.id}>
                  <StatusBadge status={h.to_status} /> {dateTime(h.created_at)} · {h.actor_type}
                  {h.actor_name ? ` (${h.actor_name})` : ''}
                  {h.customer_note && <div>{h.customer_note}</div>}
                </li>
              ))}
            </ul>
          </div>
          <div className="card">
            <h3>Audit trail</h3>
            <div className="stack small">
              {d.audit.map((a) => (
                <div key={a.id}>
                  <strong>{a.action}</strong> · {dateTime(a.occurred_at)} · {a.actor_label ?? a.actor_type}
                  {a.reason && <div>Reason: {a.reason}</div>}
                  {(a.before || a.after) && (
                    <details>
                      <summary className="muted">Changes</summary>
                      <pre className="json">{JSON.stringify({ before: a.before, after: a.after }, null, 1)}</pre>
                    </details>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
