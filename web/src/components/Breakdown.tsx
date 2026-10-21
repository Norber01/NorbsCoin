import { dateTime, money, percent, rate } from '../lib/format';

export function Breakdown(props: {
  sendAmount: string;
  sendCurrency: string;
  receiveCurrency: string;
  rate: string;
  rateSource: string;
  rateTimestamp: string;
  grossAmount: string;
  feeRate: string;
  feeAmount: string;
  payoutAmount: string;
  otherFees?: { label: string; amount: string }[];
  payoutLabel?: string;
}) {
  const p = props;
  return (
    <table className="breakdown">
      <tbody>
        <tr>
          <td>You send</td>
          <td>{money(p.sendAmount, p.sendCurrency)}</td>
        </tr>
        <tr>
          <td>
            Exchange rate
            <div className="small muted">
              {p.rateSource} · {dateTime(p.rateTimestamp)}
            </div>
          </td>
          <td>
            1 {p.sendCurrency} = {rate(p.rate)} {p.receiveCurrency}
          </td>
        </tr>
        <tr>
          <td>Converted amount</td>
          <td>{money(p.grossAmount, p.receiveCurrency)}</td>
        </tr>
        <tr>
          <td>
            Service fee ({percent(p.feeRate)})
            <div className="small muted">Deducted from the converted amount</div>
          </td>
          <td>− {money(p.feeAmount, p.receiveCurrency)}</td>
        </tr>
        {(p.otherFees ?? []).map((f) => (
          <tr key={f.label}>
            <td>{f.label}</td>
            <td>− {money(f.amount, p.receiveCurrency)}</td>
          </tr>
        ))}
        {!p.otherFees?.length && (
          <tr>
            <td>Other fees</td>
            <td>None</td>
          </tr>
        )}
        <tr className="total">
          <td>{p.payoutLabel ?? 'Recipient gets'}</td>
          <td>{money(p.payoutAmount, p.receiveCurrency)}</td>
        </tr>
      </tbody>
    </table>
  );
}
