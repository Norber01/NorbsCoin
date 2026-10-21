# Architecture

```
 Browser ──HTTPS──▶ reverse proxy ──▶ Node.js (Express)
                                        ├─ /api/*        public JSON API (quotes, orders, tracking)
                                        ├─ /api/admin/*  operator API (session + MFA + role checks)
                                        ├─ static SPA    customer site + /admin dashboard
                                        └─ scheduler     rates · expiry · payout deadlines · email outbox
                                             │
                     PostgreSQL ◀────────────┤
                     Private evidence store ◀┘  (local volume by default; swap for object storage)
                     Rate provider API, SMTP provider (outbound)
```

The server is one deployable. Every background job is safe to run on several instances at once
(`FOR UPDATE SKIP LOCKED`, idempotent dedupe keys), so it can scale horizontally later.

## Code map (`server/src`)

| Path | Responsibility |
| --- | --- |
| `domain/money.ts` | The one fee/rounding formula. Decimal arithmetic only — no floats. |
| `domain/orderStatus.ts` | Status list, allowed transitions and who may perform them. |
| `rates/` | Provider interface, ExchangeRate-API implementation, `RateService` (fetch, staleness, operator rates). |
| `services/quotes.ts` | Corridor availability checks, amount limits, firm quote creation. |
| `services/orders.ts` | Order creation, tracking view, proof upload, every operator action, expiry/deadline jobs. |
| `services/corridors.ts` | Corridor settings, versioned fees, versioned payment instructions. |
| `services/notifications.ts` | Outbox enqueueing, templates, delivery worker with backoff. |
| `services/auth.ts`, `totp.ts` | Passwords, sessions, MFA, roles. |
| `services/audit.ts` | Audit writer + chain verification. |
| `http/` | Express app, middleware (CSRF, auth, rate limits, errors), routes. |
| `db/migrations` | Plain SQL migrations, applied in order at startup or via `npm run migrate`. |

## Rate engine

* `RateProvider.fetchRate()` either returns a rate **with the provider's publication timestamp** or
  throws. There is no default, cached-in-code or demo value anywhere.
* Every successful fetch is stored in `rate_snapshots` (rate, source, provider timestamp, fetch time).
* `RateService.current()` chooses the rate for new quotes:
  1. an unexpired **operator rate** (kind `operator`, always labelled "Operator-set rate"), else
  2. the latest API snapshot **if** its published timestamp is within the corridor's `rate_max_age_seconds`.
  Otherwise the rate is reported unusable and quoting returns `503 rate_unavailable` / `rate_stale`.
* Failures create a `rate_api_failure` system event (dashboard alert + operator email, deduped hourly)
  and are retried on the refresh interval without hammering the provider.
* The default provider is the ExchangeRate-API open endpoint (`open.er-api.com`), which updates once
  a day — hence the seeded 26-hour max age. For production, use an intraday provider (implement
  `RateProvider`, register it in `rates/index.ts`) and lower the max age.

## Fee and quote calculation

```
G = round_half_up(A × R, 2)      gross converted amount (GHS)
F = round_half_up(G × fee, 2)    service fee (GHS), fee = 0.007 by default
P = G − F                        payout (exact; G − F = P is also a DB CHECK constraint)
```

The fee is **deducted from the gross converted amount**. The same definition is used in the UI,
the terms text, the database (`fee_schedules.fee_basis = 'deducted_from_gross'` is the only allowed
value) and accounting exports. `web/src/lib/estimate.ts` mirrors the formula for the non-binding
estimate on the home page; binding numbers always come from the server quote.

A quote stores the exact rate, its snapshot id, source and timestamp, the fee schedule id and rate, all
amounts and an expiry. Quotes and orders are protected by triggers: the agreed columns cannot be
updated after creation. Recalculation only happens by creating a **new** quote before confirmation.

## Order state machine

```
 awaiting_payment ──customer uploads──▶ proof_submitted ──operator verifies──▶ payment_verified
   │  │  │                                │      │                               │        │
   │  │  └─system: payment window─▶ expired│      └─operator─▶ resubmission_requested     │
   │  └─customer/operator─▶ cancelled      │                    (customer re-uploads ↺)   │
   └─operator─▶ rejected ◀──operator───────┘                                              │
                                                     payout_processing ◀──operator────────┘
                                                       │      │   └─payout failed─▶ payment_verified
                                                       │      └─operator─▶ refunded ◀─ (also from payment_verified)
                                                       └─operator records payout─▶ completed
```

Terminal: `completed`, `rejected`, `cancelled`, `expired`, `refunded`. All changes go through one
function (`transition()` in `services/orders.ts`) which checks the table, writes status history and the
audit log, and enqueues notifications in the same transaction. Database CHECK constraints back this up
(e.g. `completed` requires `verified_at`, a payout reference and actual amount).

## Data model (main tables)

| Table | Notes |
| --- | --- |
| `corridors` | Currency pair, enabled/paused, limits, quote TTL, payment window, payout SLA, max rate age, payout terms. |
| `fee_schedules` | Insert-only versions per corridor. |
| `payment_instructions` | Versioned; orders reference the exact version shown. |
| `rate_snapshots` | Every fetched or operator-entered rate. |
| `quotes` | Firm quotes; immutable terms. |
| `orders` | Agreed terms (immutable), recipient, timeline, verification, payout, refund, flags. |
| `order_status_history` | Customer-visible timeline (append-only). |
| `payment_proofs` | Evidence metadata, SHA-256 (duplicate detection), review status. Files live in private storage. |
| `audit_log` | Append-only and hash-chained (`audit_log_first_broken()` verifies it). |
| `email_outbox` | Pending/sent/failed emails with attempts and backoff. |
| `system_events` | Alerts: rate failures, unusual activity, duplicate evidence, overdue payouts, email failures. |
| `admin_users`, `admin_sessions` | Operators (scrypt hash, encrypted TOTP secret), hashed session ids. |
| `settings` | Business settings (validated key list). |

## Extending

* **New currency pair**: insert a `corridors` row + `fee_schedules` v1 (migration or SQL), add the
  currency's minor units to `CURRENCY_DECIMALS`, add recipient validation for the destination country
  and payment instructions in Settings. The reverse GHS → RUB corridor is already seeded, disabled.
* **Automated payment confirmation**: add a webhook route from the payment partner that calls the same
  `verifyPayment()` with a system/partner actor, so all checks, history, audit and notifications still apply.
* **Automated payouts**: replace the manual "start payout / complete" actions with a payout-provider
  adapter that drives `payout_processing → completed` (or reverts to `payment_verified` on failure).
* **Object storage**: implement `EvidenceStorage` (private bucket, server-side encryption).
* **Customer accounts, saved recipients, rate alerts, SMS/WhatsApp**: orders already carry a customer
  email; add a `customers` table and link orders; notifications already go through one outbox, so a new
  channel is a new transport plus consent capture.
