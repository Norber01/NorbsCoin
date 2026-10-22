# Operations

## Before going live (checklist)

### Legal and compliance — do this first
Currency exchange and money transfer are regulated activities in many jurisdictions. Before taking
real customer money, establish with qualified legal and compliance advisers (and any regulated payment
partner) what applies to you in Russia, Ghana and anywhere else you operate, including:

- licensing / registration requirements for exchange or remittance services;
- customer identification (KYC) and when it is required;
- anti-money-laundering (AML) obligations, record keeping and suspicious-activity reporting;
- sanctions screening of customers, recipients and payment routes;
- transaction monitoring and limits;
- data protection rules for the personal data you collect, and cross-border data transfer;
- consumer terms, refund and complaints obligations.

The platform's flags (large amounts, high-frequency recipients, duplicate receipts and references) are
operational alerts, **not** an AML or sanctions-screening programme. Adjust the data you collect and the
flow (e.g. add identity verification before payout) to what your advisers require.

### Technical
- [ ] Managed PostgreSQL with **automated daily backups and point-in-time recovery**; test a restore.
- [ ] Evidence storage on a private, persistent, backed-up volume (or implement `EvidenceStorage` for a
      private object-storage bucket with server-side encryption). Never serve `UPLOAD_DIR` statically.
- [ ] HTTPS via a reverse proxy/load balancer; set `TRUST_PROXY` correctly; `NODE_ENV=production`
      (enables HTTPS redirect, HSTS, secure cookies, mandatory MFA).
- [ ] `APP_SECRET` set to 32+ random characters, stored in your host's secret manager. Losing it means
      operators must re-enrol MFA (owner can reset MFA per user).
- [ ] Transactional email provider configured (`EMAIL_TRANSPORT=smtp`, `SMTP_URL`), with SPF/DKIM/DMARC
      on your sending domain. Send yourself a test order.
- [ ] Rate provider: decide between the reference feed and operator rates; consider an intraday,
      contractually supported provider and lower `rate_max_age_seconds`.
- [ ] Uptime monitoring on `/api/health` and alerting on server logs (`[error]`, `[job:*] failed`).
- [ ] Schedule `npm run retention -w server` daily (cron / scheduled job).
- [ ] Create one owner account, enrol MFA, store recovery procedure (a second owner, or DB access to
      reset). Give day-to-day staff the **operator** role, accountants **viewer**.
- [ ] Fill in Settings: payment instructions, support contacts, operating hours, notification emails,
      terms text (have it reviewed), limits and payout SLA.
- [ ] Run a supervised pilot with small amounts and known customers before opening publicly.

## Daily operator workflow

1. **Overview** — check alerts (rate failures, duplicate evidence, overdue payouts, unusual orders,
   failed emails) and acknowledge them once handled.
2. **Proof to verify** — open each order. Look at the receipt, then **check your actual account
   statement**. Only if the money is there: enter the received amount and the statement's transaction
   reference, tick the confirmation and verify. The system refuses underpayments and references already
   used on another order. Otherwise request a corrected proof (with a message) or reject.
3. **Payouts due** — for each verified order, "Start payout", send exactly the shown GHS amount to the
   shown recipient, then "Confirm payout completed" with the provider's reference and date. If you had to
   send a different amount, the discrepancy note is mandatory. If the payout fails, revert to verified.
4. **Refunds** — when an order cannot be fulfilled after payment, record the refund amount, reason and
   reference. The customer is notified.
5. **Pause** the corridor whenever you cannot honour new quotes.

Deadlines: unpaid orders expire automatically after the payment window. Operators get a "payout due
soon" email `payout_warning_hours` before the promised payout time and an alert when it is overdue.

## Security model

| Control | Implementation |
| --- | --- |
| Operator login | scrypt password hashing; generic errors; lockout for 15 min after 5 failures |
| MFA | TOTP (RFC 6238), mandatory in production; secrets AES-256-GCM encrypted; replay of a code rejected |
| Sessions | Random 256-bit token in HttpOnly, Secure, SameSite=Strict cookie scoped to `/api/admin`; only its hash is stored; 12 h expiry |
| CSRF | SameSite=Strict + mandatory `X-Requested-With` header on state-changing admin requests |
| Roles | owner (settings, fees, users), operator (orders, rates, pause), viewer (read-only) |
| Rate limiting | Per-IP limits on quoting, ordering, uploads, tracking and login |
| Transport | HTTPS redirect, HSTS, strict CSP, no-referrer, `Cache-Control: no-store` on API |
| Customer access | Unguessable tracking token in the URL fragment (not sent to servers in logs/referrers); only its hash is stored; operators can reissue it |
| Uploads | 5 MB limit, type detected from file content (JPG/PNG/PDF only), random storage names, private storage, served only to operators with a sandbox CSP; every view is audited |
| Duplicate payments | SHA-256 of each receipt and transfer references compared across orders; verified statement references must be unique |
| Integrity | Agreed terms immutable via DB triggers; fee schedules, status history and audit log append-only; audit log hash-chained and verifiable |
| Privacy | Minimal recipient data; phone masked on tracking page; retention job deletes evidence and redacts personal data after `retention_days` while keeping financial records |

## Backups and recovery

- The database is the system of record (orders, audit log, outbox). Back it up continuously.
- Back up the evidence volume on the same schedule; evidence keys are stored in `payment_proofs`.
- Emails are in the outbox table: after a restore, pending emails are simply retried.
- Check the audit chain after any restore: **Audit log** page shows "Hash chain verified".

## Disputes and support

The tracking page shows support contacts on every order. When a customer disputes an order, find it by
reference or phone, read the full history and audit trail, and use the customer-visible message to keep
them informed. Record outcomes through the normal actions (refund, payout with discrepancy note) so the
audit trail stays complete.
