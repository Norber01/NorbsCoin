# NorbsCoin

A currency exchange **order platform** for exchanging Russian rubles (RUB) for Ghanaian cedis (GHS),
Nigerian naira (NGN) and Central African CFA francs (XAF).
Customers get a firm, transparent quote, submit payment evidence and track their order privately.
Operators independently verify incoming funds, make the payout manually, and account for every
transaction from one dashboard.

> This software does not move money. Payment confirmation and payouts are manual by design for the
> first release. Before operating live, read [docs/OPERATIONS.md](docs/OPERATIONS.md), especially the
> legal and compliance section.

## Currencies

| Corridor | Payout countries | Default |
| --- | --- | --- |
| RUB → GHS | Ghana (MTN MoMo, Telecel Cash, AirtelTigo Money, banks) | enabled |
| RUB → NGN | Nigeria (OPay, PalmPay, Moniepoint, Paga, MTN MoMo PSB, banks — 10-digit NUBAN) | disabled |
| RUB → XAF | Cameroon, Gabon, Republic of the Congo, Chad, Central African Republic, Equatorial Guinea (MTN, Orange, Airtel, Moov where available, banks) | disabled |
| GHS → RUB | — | disabled |

Disabled corridors are switched on in **Settings → Enable corridor** once you have a rate, payment
instructions and a working way to pay out. XAF has no minor unit, so XAF amounts are whole francs.
Country rules (phone formats, providers, account formats) live in `server/src/domain/countries.ts`.

## What's in the first release

**Customer site**
- Currency converter with a live reference rate, its source and last-update time, stale-rate warnings,
  loading/unavailable/error states, and a manual refresh.
- Firm quotes (default 10 min) showing amount sent, rate + source, gross amount, 0.7% fee, other fees,
  exact payout, creation/expiry time and payout timeframe. Expired quotes can be re-quoted in one click.
- Receiving details for mobile money (MTN MoMo, Telecel Cash, AirtelTigo Money) or bank transfer, with
  validation and a review/edit step. Explicit consent to the displayed, versioned terms.
- Payment instructions with a unique order reference, payment deadline countdown, receipt upload
  (JPG/PNG/PDF, size-limited, content-sniffed) and corrected-evidence resubmission.
- Private tracking page (secret link) with status progress, timeline, operator messages, expected
  payout, support contacts, printable receipt and self-service cancellation before payment.

**Operator dashboard** (`/admin`)
- Overview: total orders, pending payments, proofs to verify, payouts due, completed, rejected, refunds,
  **collected vs projected** fee revenue, payout timing, 14-day activity, open alerts, email queue health.
- Order search by reference, phone, name, email, transfer reference, date range, amount, status, flags;
  CSV export for accounting.
- Payment verification: secure receipt viewing, duplicate-file / duplicate-reference detection, recorded
  verified amount + statement reference, explicit "funds independently confirmed" step.
- Manual payout: recipient details with copy buttons, actual amount / reference / date, mandatory
  discrepancy notes, payout-failed revert, refunds with amount, reason and reference.
- Settings: corridors (enable, pause with a customer message, limits, quote TTL, payment window, payout
  SLA, max rate age), **versioned** fees and payment instructions, operator-set rates, contact details,
  operating hours, notification recipients, terms text/version, fraud thresholds, retention period.
- Tamper-evident audit log (append-only, hash-chained, verifiable from the UI); user management with
  owner / operator / viewer roles.

**Platform**
- Controlled order state machine; a payout can never be completed while payment is unverified.
- Agreed terms are locked by database triggers once confirmed; fee changes never touch existing orders.
- Transactional email outbox with retries/backoff — a failed email never loses or duplicates an order.
- Background jobs: rate refresh, unpaid-order expiry, payout-due-soon and overdue alerts.
- Security: scrypt passwords, mandatory TOTP MFA, account lockout, server-side sessions in HttpOnly
  SameSite=Strict cookies, CSRF header, rate limiting, strict CSP/HSTS, private evidence storage,
  privacy retention job.

## Quick start (development)

Requirements: Node.js 20+, PostgreSQL 14+.

```bash
npm install
createdb norbscoin                       # or use docker compose up db
export DATABASE_URL=postgres://user:pass@localhost:5432/norbscoin
npm run migrate
npm run create-admin -w server -- --email you@example.com --name "Your Name" --role owner
npm run dev                               # API on :3000, web on :5173 (proxied)
```

Open http://localhost:5173/admin, sign in and enrol MFA. Then in **Settings**:

1. Enter approved **payment instructions** for RUB → GHS (orders are refused until you do).
2. Check the reference rate is live, or set an **operator rate** (the rate you can actually obtain).
3. Add your support contacts and the email addresses that should receive operator alerts.

In development emails are printed to the server log (`EMAIL_TRANSPORT=log`).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | API (tsx watch) + Vite dev server |
| `npm test` | Server unit + integration tests (needs Postgres; uses `norbscoin_test`) and web tests |
| `npm run typecheck` | TypeScript checks for both packages |
| `npm run build` | Builds the web app and compiles the server |
| `npm start` | Runs the compiled server; serves the built web app |
| `npm run migrate` | Applies database migrations |
| `npm run create-admin -w server -- …` | Creates an operator account (password from `ADMIN_PASSWORD` or prompt) |
| `npm run retention -w server [-- --dry-run]` | Deletes old evidence files and redacts personal data |

Integration tests expect `TEST_DATABASE_URL` (default `postgres://norbs:norbs@localhost:5432/norbscoin_test`);
the test run **drops and recreates** that database's schema.

## Deploying

**Free test copy from your phone:** follow [docs/RENDER.md](docs/RENDER.md) (Render blueprint, no card needed).


`Dockerfile` and `docker-compose.yml` are included; configuration is via environment variables
(see `.env.example`). Run behind a TLS-terminating reverse proxy. The production checklist is in
[docs/OPERATIONS.md](docs/OPERATIONS.md).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, data model, rate engine, state machine,
  how to add corridors and automate payments later.
- [docs/BUSINESS.md](docs/BUSINESS.md) — the fee definition and a stress test of the 0.7% assumption.
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — go-live checklist, daily operator workflow, security,
  backups, privacy and compliance.

## Repository layout

```
server/   Express API, rate engine, jobs, migrations (PostgreSQL), tests
web/      React (Vite) customer site + operator dashboard
docs/     Architecture, business and operations notes
```

## Screenshots

| Converter | Review & confirm | Tracking |
| --- | --- | --- |
| ![Converter](docs/screenshots/04-home-converter.png) | ![Review](docs/screenshots/07-review.png) | ![Tracking](docs/screenshots/08-track-awaiting.png) |

| Operator overview | Payment verification | Mobile |
| --- | --- | --- |
| ![Dashboard](docs/screenshots/10-admin-dashboard.png) | ![Verify](docs/screenshots/11-admin-order-verify.png) | ![Mobile](docs/screenshots/14-mobile-home.png) |
