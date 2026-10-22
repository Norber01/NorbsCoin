import { useEffect, type ReactNode } from 'react';
import { ApiError } from '../lib/api';
import { STATUS_LABEL } from '../lib/format';
import { useNow } from '../lib/hooks';

export function Field(props: { label: string; htmlFor: string; error?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={props.htmlFor}>{props.label}</label>
      {props.children}
      {props.hint && <div className="hint">{props.hint}</div>}
      {props.error && (
        <div className="err" id={`${props.htmlFor}-err`} role="alert">
          {props.error}
        </div>
      )}
    </div>
  );
}

export function ErrorAlert({ error }: { error?: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="alert error" role="alert">
      {message}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <span className="row muted" role="status">
      <span className="spinner" aria-hidden /> {label}
    </span>
  );
}

export function Countdown({ until, onExpire }: { until: string; onExpire?: () => void }) {
  const now = useNow(1000);
  const left = Math.max(0, Math.floor((new Date(until).getTime() - now) / 1000));
  const expired = left === 0;
  useEffect(() => {
    if (expired) onExpire?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expired]);
  const m = Math.floor(left / 60);
  const s = String(left % 60).padStart(2, '0');
  return (
    <span className={`countdown ${left < 60 ? 'low' : ''}`} aria-live="off">
      {left === 0 ? 'expired' : `${m}:${s}`}
    </span>
  );
}

export function isApiError(e: unknown, code?: string): e is ApiError {
  return e instanceof ApiError && (!code || e.code === code);
}
