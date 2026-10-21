export function money(amount: string | null | undefined, currency: string): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  const [int, frac = ''] = amount.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${grouped}${frac ? '.' + frac.padEnd(2, '0').slice(0, 2) : '.00'} ${currency}`;
}

/** Display a rate with 6 significant decimals, trimming trailing zeros. */
export function rate(value: string | null | undefined): string {
  if (!value) return '—';
  const n = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
  const [i, f = ''] = n.split('.');
  return f ? `${i}.${f.slice(0, 6)}` : i;
}

export function percent(feeRate: string | null | undefined): string {
  if (!feeRate) return '—';
  return `${(Number(feeRate) * 100).toLocaleString('en-GB', { maximumFractionDigits: 3 })}%`;
}

export function dateTime(v: string | Date | null | undefined): string {
  if (!v) return '—';
  return new Date(v).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

export function relative(v: string | Date | null | undefined): string {
  if (!v) return '—';
  const s = Math.round((Date.now() - new Date(v).getTime()) / 1000);
  const abs = Math.abs(s);
  const fmt = (n: number, u: string) => `${n} ${u}${n === 1 ? '' : 's'}`;
  const text = abs < 60 ? fmt(abs, 'second') : abs < 3600 ? fmt(Math.floor(abs / 60), 'minute') : abs < 86400 ? fmt(Math.floor(abs / 3600), 'hour') : fmt(Math.floor(abs / 86400), 'day');
  return s >= 0 ? `${text} ago` : `in ${text}`;
}

export const STATUS_LABEL: Record<string, string> = {
  awaiting_payment: 'Awaiting payment',
  proof_submitted: 'Awaiting verification',
  resubmission_requested: 'New proof requested',
  payment_verified: 'Payment verified',
  payout_processing: 'Payout processing',
  completed: 'Completed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  expired: 'Expired',
  refunded: 'Refunded',
};
