import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Breakdown } from '../components/Breakdown';
import { Countdown, ErrorAlert, Field, isApiError, Spinner } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { dateTime } from '../lib/format';
import { useAsync, useConfig } from '../lib/hooks';
import type { PayoutCountry, Quote } from '../lib/types';

type Step = 'quote' | 'recipient' | 'review';

interface RecipientForm {
  recipientName: string;
  recipientPhone: string;
  recipientCountry: string;
  payoutMethod: '' | 'mobile_money' | 'bank_transfer';
  mobileMoneyProvider: string;
  bankName: string;
  bankAccountNumber: string;
  bankBranch: string;
  customerEmail: string;
}

const EMPTY: RecipientForm = {
  recipientName: '',
  recipientPhone: '',
  recipientCountry: '',
  payoutMethod: 'mobile_money',
  mobileMoneyProvider: '',
  bankName: '',
  bankAccountNumber: '',
  bankBranch: '',
  customerEmail: '',
};

const DRAFT_KEY = 'nc_recipient_draft';

function loadDraft(): RecipientForm {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    return raw ? { ...EMPTY, ...JSON.parse(raw) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

/**
 * Client-side checks for fast feedback. Exact country rules (phone format, account format)
 * are enforced by the server, whose field errors are shown on the same inputs.
 */
function validate(f: RecipientForm, country: PayoutCountry | undefined): Record<string, string> {
  const e: Record<string, string> = {};
  if (f.recipientName.trim().length < 3) e.recipientName = "Enter the recipient's full name as registered on the account.";
  if (!country) e.recipientCountry = "Choose the recipient's country.";
  const digits = f.recipientPhone.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) e.recipientPhone = `Enter a valid phone number${country ? `, e.g. ${country.phoneExample}` : ''}.`;
  if (!f.payoutMethod) e.payoutMethod = 'Choose how the recipient will be paid.';
  if (f.payoutMethod === 'mobile_money' && !f.mobileMoneyProvider) e.mobileMoneyProvider = 'Choose a mobile money provider.';
  if (f.payoutMethod === 'bank_transfer') {
    if (f.bankName.trim().length < 2) e.bankName = 'Enter the bank name.';
    if (f.bankAccountNumber.replace(/[\s-]/g, '').length < 6) e.bankAccountNumber = `Enter the account number${country ? ` (${country.bankAccountHint})` : ''}.`;
  }
  if (f.customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.customerEmail)) e.customerEmail = 'Enter a valid email address.';
  return e;
}

function Steps({ step }: { step: Step }) {
  const order: Step[] = ['quote', 'recipient', 'review'];
  const labels = { quote: 'Quote', recipient: 'Receiving details', review: 'Review & confirm' };
  const idx = order.indexOf(step);
  return (
    <ol className="steps">
      {order.map((s, i) => (
        <li key={s} className={i < idx ? 'done' : i === idx ? 'current' : ''}>
          <span className="n">{i < idx ? '✓' : i + 1}</span>
          {labels[s]}
        </li>
      ))}
    </ol>
  );
}

export function Exchange() {
  const { quoteId } = useParams();
  const navigate = useNavigate();
  const config = useConfig()!;
  const quote = useAsync(() => api.get<{ quote: Quote }>(`/api/quotes/${quoteId}`).then((r) => r.quote), [quoteId]);
  const [step, setStep] = useState<Step>('quote');
  const [form, setForm] = useState<RecipientForm>(loadDraft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [agreed, setAgreed] = useState(false);
  const [expired, setExpired] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<Error | null>(null);
  const [requoting, setRequoting] = useState(false);

  useEffect(() => {
    try {
      // Email/name/phone are kept only for this browser tab session, to survive a re-quote.
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(form));
    } catch {
      /* storage unavailable */
    }
  }, [form]);

  useEffect(() => setExpired(!!quote.data?.expired), [quote.data]);

  // Keep the chosen country valid for this quote's receive currency.
  const countries: PayoutCountry[] = quote.data ? (config.payoutCountries[quote.data.receiveCurrency] ?? []) : [];
  useEffect(() => {
    if (!quote.data) return;
    if (!countries.some((c) => c.code === form.recipientCountry)) {
      setForm((f) => ({ ...f, recipientCountry: countries.length === 1 ? countries[0].code : '', mobileMoneyProvider: '' }));
    }
  }, [quote.data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (quote.loading) return <Spinner label="Loading your quote…" />;
  if (quote.error) return <div className="narrow stack"><ErrorAlert error={quote.error} /><Link to="/">Start again</Link></div>;
  const q = quote.data!;

  const set = (k: keyof RecipientForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setForm({ ...form, [k]: e.target.value });
    if (errors[k]) setErrors({ ...errors, [k]: '' });
  };

  async function requote() {
    setRequoting(true);
    try {
      const { quote: nq } = await api.post<{ quote: Quote }>('/api/quotes', { from: q.sendCurrency, to: q.receiveCurrency, sendAmount: q.sendAmount });
      setAgreed(false);
      setSubmitError(null);
      navigate(`/exchange/${nq.id}`, { replace: true });
    } catch (err) {
      setSubmitError(err as Error);
    } finally {
      setRequoting(false);
    }
  }

  const country = countries.find((c) => c.code === form.recipientCountry);

  function toReview(e: React.FormEvent) {
    e.preventDefault();
    const errs = validate(form, country);
    setErrors(errs);
    if (Object.keys(errs).length === 0) setStep('review');
  }

  async function confirm() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await api.post<{ reference: string; trackingToken: string }>('/api/orders', {
        quoteId: q.id,
        termsAccepted: agreed,
        termsVersion: config.settings.terms_version,
        recipient: {
          ...form,
          customerEmail: form.customerEmail || undefined,
          ...(form.payoutMethod === 'mobile_money' ? { bankName: undefined, bankAccountNumber: undefined, bankBranch: undefined } : { mobileMoneyProvider: undefined }),
        },
      });
      try {
        sessionStorage.removeItem(DRAFT_KEY);
      } catch {
        /* ignore */
      }
      navigate(`/track/${res.reference}#t=${res.trackingToken}`, { state: { justCreated: true } });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_recipient' && err.details) {
        setErrors(err.details);
        setStep('recipient');
      }
      if (isApiError(err, 'quote_expired')) setExpired(true);
      setSubmitError(err as Error);
    } finally {
      setSubmitting(false);
    }
  }

  const expiryBox = (
    <div className={`alert ${expired ? 'warn' : 'info'}`}>
      {expired ? (
        <div className="spread">
          <span>This quote has expired. Rates may have moved.</span>
          <button className="btn small" onClick={requote} disabled={requoting}>
            {requoting ? 'Getting new quote…' : 'Get a new quote'}
          </button>
        </div>
      ) : (
        <span>
          Quote valid for <Countdown until={q.expiresAt} onExpire={() => setExpired(true)} /> · created {dateTime(q.createdAt)}, expires {dateTime(q.expiresAt)}
        </span>
      )}
    </div>
  );

  if (q.accepted) {
    return (
      <div className="narrow card">
        <h2>This quote has already been confirmed</h2>
        <p>Use the tracking link from your confirmation (or your email) to follow the order.</p>
        <Link className="btn" to="/track">Track an order</Link>
      </div>
    );
  }

  return (
    <div className="narrow">
      <Steps step={step} />
      {step === 'quote' && (
        <div className="card stack">
          <h2>Your quote</h2>
          {expiryBox}
          <Breakdown {...q} />
          {q.rateKind === 'operator' && <p className="small muted">This rate was set by our exchange desk and is guaranteed for this quote only.</p>}
          <dl className="kv small">
            <dt>Payment window</dt>
            <dd>Pay within {q.paymentWindowMinutes} minutes of confirming</dd>
            <dt>Expected payout</dt>
            <dd>{q.payoutTerms || `Within ${q.payoutSlaHours} hours after your payment is verified`}</dd>
          </dl>
          <ErrorAlert error={submitError} />
          <div className="spread">
            <Link to="/">Change amount</Link>
            <button className="btn" disabled={expired} onClick={() => setStep('recipient')}>
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 'recipient' && (
        <form className="card" onSubmit={toReview} noValidate>
          <h2>Receiving details</h2>
          <p className="small muted">We only ask for what is needed to pay the recipient. Details are stored securely and shown only to our operators.</p>
          <Field label="Recipient full name" htmlFor="recipientName" error={errors.recipientName} hint="As registered on the mobile money or bank account.">
            <input id="recipientName" autoComplete="name" value={form.recipientName} onChange={set('recipientName')} aria-invalid={!!errors.recipientName} />
          </Field>
          <Field label="Country" htmlFor="recipientCountry" error={errors.recipientCountry}>
            <select
              id="recipientCountry"
              value={form.recipientCountry}
              onChange={(e) => {
                const next = countries.find((c) => c.code === e.target.value);
                setForm({
                  ...form,
                  recipientCountry: e.target.value,
                  mobileMoneyProvider: '',
                  payoutMethod: next && !next.mobileMoneyProviders.length ? 'bank_transfer' : form.payoutMethod,
                });
                setErrors({ ...errors, recipientCountry: '', recipientPhone: '' });
              }}
              aria-invalid={!!errors.recipientCountry}
            >
              {countries.length !== 1 && <option value="">Select…</option>}
              {countries.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Recipient phone number"
            htmlFor="recipientPhone"
            error={errors.recipientPhone}
            hint={country ? `${country.name} number, e.g. ${country.phoneExample} or +${country.dial} ${country.phoneExample.replace(/^0/, '')}.` : 'Choose the country first.'}
          >
            <input id="recipientPhone" type="tel" autoComplete="tel" value={form.recipientPhone} onChange={set('recipientPhone')} aria-invalid={!!errors.recipientPhone} />
          </Field>
          <div className="field">
            <label>Payout method</label>
            <div className="choice-group" role="radiogroup">
              {(!country || country.mobileMoneyProviders.length > 0) && (
                <label className="choice">
                  <input type="radio" name="payoutMethod" value="mobile_money" checked={form.payoutMethod === 'mobile_money'} onChange={set('payoutMethod')} />
                  Mobile money
                </label>
              )}
              <label className="choice">
                <input type="radio" name="payoutMethod" value="bank_transfer" checked={form.payoutMethod === 'bank_transfer'} onChange={set('payoutMethod')} />
                Bank account
              </label>
            </div>
            {errors.payoutMethod && <div className="err">{errors.payoutMethod}</div>}
          </div>
          {form.payoutMethod === 'mobile_money' && (
            <Field label="Mobile money provider" htmlFor="mobileMoneyProvider" error={errors.mobileMoneyProvider} hint="The phone number above must be registered with this provider.">
              <select id="mobileMoneyProvider" value={form.mobileMoneyProvider} onChange={set('mobileMoneyProvider')} aria-invalid={!!errors.mobileMoneyProvider}>
                <option value="">Select…</option>
                {(country?.mobileMoneyProviders ?? []).map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </Field>
          )}
          {form.payoutMethod === 'bank_transfer' && (
            <>
              <Field label="Bank name" htmlFor="bankName" error={errors.bankName}>
                <input id="bankName" value={form.bankName} onChange={set('bankName')} aria-invalid={!!errors.bankName} />
              </Field>
              <Field label="Account number" htmlFor="bankAccountNumber" error={errors.bankAccountNumber} hint={country?.bankAccountHint}>
                <input id="bankAccountNumber" inputMode={country?.code === 'NG' || country?.code === 'GH' ? 'numeric' : 'text'} value={form.bankAccountNumber} onChange={set('bankAccountNumber')} aria-invalid={!!errors.bankAccountNumber} />
              </Field>
              <Field label="Branch (optional)" htmlFor="bankBranch" error={errors.bankBranch}>
                <input id="bankBranch" value={form.bankBranch} onChange={set('bankBranch')} />
              </Field>
            </>
          )}
          <Field label="Your email (optional)" htmlFor="customerEmail" error={errors.customerEmail} hint="For order updates and your private tracking link.">
            <input id="customerEmail" type="email" autoComplete="email" value={form.customerEmail} onChange={set('customerEmail')} aria-invalid={!!errors.customerEmail} />
          </Field>
          <div className="spread">
            <button type="button" className="btn secondary" onClick={() => setStep('quote')}>
              Back
            </button>
            <button className="btn" type="submit">
              Review
            </button>
          </div>
        </form>
      )}

      {step === 'review' && (
        <div className="card stack">
          <h2>Review and confirm</h2>
          {expiryBox}
          <Breakdown {...q} />
          <div>
            <div className="spread">
              <h3>Recipient</h3>
              <button className="btn ghost small" onClick={() => setStep('recipient')}>
                Edit
              </button>
            </div>
            <dl className="kv">
              <dt>Name</dt>
              <dd>{form.recipientName}</dd>
              <dt>Country</dt>
              <dd>{country?.name}</dd>
              <dt>Phone</dt>
              <dd>{form.recipientPhone}</dd>
              <dt>Payout to</dt>
              <dd>
                {form.payoutMethod === 'mobile_money'
                  ? `${form.mobileMoneyProvider} mobile money`
                  : `${form.bankName}, account ${form.bankAccountNumber}${form.bankBranch ? `, ${form.bankBranch}` : ''}`}
              </dd>
              <dt>Updates to</dt>
              <dd>{form.customerEmail || <span className="muted">No email — save your tracking link</span>}</dd>
            </dl>
          </div>
          <div className="alert info small">
            <strong>Terms ({config.settings.terms_version})</strong>
            <p style={{ margin: '0.3rem 0 0' }}>{config.settings.terms_text}</p>
            <p style={{ margin: '0.3rem 0 0' }}>{q.payoutTerms}</p>
          </div>
          <label className="check">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            I agree to these terms. I understand that the recipient will receive exactly the amount shown, and that payout happens only after my payment is
            independently verified.
          </label>
          <ErrorAlert error={submitError} />
          <div className="spread">
            <button className="btn secondary" onClick={() => setStep('recipient')}>
              Back
            </button>
            <button className="btn" disabled={!agreed || expired || submitting} onClick={confirm}>
              {submitting ? 'Confirming…' : 'Confirm order'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
