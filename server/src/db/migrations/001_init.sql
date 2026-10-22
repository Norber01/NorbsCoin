-- NorbsCoin initial schema.
-- Money columns are NUMERIC (never floating point). Rates keep 12 decimal places;
-- currency amounts keep 2 (both RUB and GHS use 2 minor-unit digits).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Operators
-- ---------------------------------------------------------------------------
CREATE TABLE admin_users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('owner', 'operator', 'viewer')),
  mfa_secret      TEXT,
  mfa_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  mfa_last_step   BIGINT,
  failed_logins   INTEGER NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Session id is the SHA-256 of the cookie token, so a database leak does not leak live sessions.
CREATE TABLE admin_sessions (
  id              TEXT PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  mfa_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  ip              TEXT,
  user_agent      TEXT
);
CREATE INDEX admin_sessions_user_idx ON admin_sessions(user_id);

-- ---------------------------------------------------------------------------
-- Corridors, fees, payment instructions, settings
-- ---------------------------------------------------------------------------
CREATE TABLE corridors (
  id                      SERIAL PRIMARY KEY,
  from_currency           CHAR(3) NOT NULL,
  to_currency             CHAR(3) NOT NULL,
  enabled                 BOOLEAN NOT NULL DEFAULT FALSE,
  paused                  BOOLEAN NOT NULL DEFAULT FALSE,
  pause_reason            TEXT,
  min_send_amount         NUMERIC(18,2) NOT NULL CHECK (min_send_amount > 0),
  max_send_amount         NUMERIC(18,2) NOT NULL,
  quote_ttl_seconds       INTEGER NOT NULL DEFAULT 600 CHECK (quote_ttl_seconds BETWEEN 60 AND 3600),
  payment_window_minutes  INTEGER NOT NULL DEFAULT 120 CHECK (payment_window_minutes > 0),
  payout_sla_hours        INTEGER NOT NULL DEFAULT 24 CHECK (payout_sla_hours > 0),
  rate_max_age_seconds    INTEGER NOT NULL DEFAULT 3600 CHECK (rate_max_age_seconds > 0),
  payout_terms            TEXT NOT NULL DEFAULT '',
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_currency, to_currency),
  CHECK (max_send_amount >= min_send_amount),
  CHECK (from_currency <> to_currency)
);

-- Fee schedules are insert-only. A change creates a new version; confirmed orders keep
-- the fee_schedule_id and fee_rate they were quoted with.
CREATE TABLE fee_schedules (
  id              SERIAL PRIMARY KEY,
  corridor_id     INTEGER NOT NULL REFERENCES corridors(id),
  version         INTEGER NOT NULL,
  fee_rate        NUMERIC(8,6) NOT NULL CHECK (fee_rate >= 0 AND fee_rate < 0.2),
  -- Only one basis is supported: the fee is deducted from the gross converted amount.
  fee_basis       TEXT NOT NULL DEFAULT 'deducted_from_gross' CHECK (fee_basis = 'deducted_from_gross'),
  effective_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
  note            TEXT,
  created_by      UUID REFERENCES admin_users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (corridor_id, version)
);

-- Payment instructions are versioned the same way: editing deactivates the old row and
-- inserts a new one, so an order always points at the exact text the customer saw.
CREATE TABLE payment_instructions (
  id              SERIAL PRIMARY KEY,
  corridor_id     INTEGER NOT NULL REFERENCES corridors(id),
  method_label    TEXT NOT NULL,
  instructions    TEXT NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_by      UUID REFERENCES admin_users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payment_instructions_active_idx ON payment_instructions(corridor_id) WHERE active;

CREATE TABLE settings (
  key             TEXT PRIMARY KEY,
  value           JSONB NOT NULL,
  updated_by      UUID REFERENCES admin_users(id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Rates
-- ---------------------------------------------------------------------------
-- kind = 'api'      : reference rate fetched from the documented provider
-- kind = 'operator' : a rate an operator entered (e.g. the rate actually obtainable),
--                     valid only until valid_until and always labelled as such.
CREATE TABLE rate_snapshots (
  id                  BIGSERIAL PRIMARY KEY,
  base_currency       CHAR(3) NOT NULL,
  quote_currency      CHAR(3) NOT NULL,
  rate                NUMERIC(24,12) NOT NULL CHECK (rate > 0),
  kind                TEXT NOT NULL CHECK (kind IN ('api', 'operator')),
  source              TEXT NOT NULL,
  provider_timestamp  TIMESTAMPTZ NOT NULL,
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until         TIMESTAMPTZ,
  note                TEXT,
  created_by          UUID REFERENCES admin_users(id),
  CHECK (kind = 'api' OR valid_until IS NOT NULL)
);
CREATE INDEX rate_snapshots_pair_idx ON rate_snapshots(base_currency, quote_currency, kind, fetched_at DESC);

-- ---------------------------------------------------------------------------
-- Quotes and orders
-- ---------------------------------------------------------------------------
CREATE TABLE quotes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  corridor_id         INTEGER NOT NULL REFERENCES corridors(id),
  send_currency       CHAR(3) NOT NULL,
  receive_currency    CHAR(3) NOT NULL,
  send_amount         NUMERIC(18,2) NOT NULL CHECK (send_amount > 0),
  rate                NUMERIC(24,12) NOT NULL,
  rate_snapshot_id    BIGINT NOT NULL REFERENCES rate_snapshots(id),
  rate_kind           TEXT NOT NULL,
  rate_source         TEXT NOT NULL,
  rate_timestamp      TIMESTAMPTZ NOT NULL,
  fee_schedule_id     INTEGER NOT NULL REFERENCES fee_schedules(id),
  fee_rate            NUMERIC(8,6) NOT NULL,
  gross_amount        NUMERIC(18,2) NOT NULL,
  fee_amount          NUMERIC(18,2) NOT NULL,
  payout_amount       NUMERIC(18,2) NOT NULL CHECK (payout_amount > 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  accepted_at         TIMESTAMPTZ,
  CHECK (gross_amount - fee_amount = payout_amount)
);

CREATE TABLE orders (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference                 TEXT NOT NULL UNIQUE,
  tracking_token_hash       TEXT NOT NULL,
  quote_id                  UUID NOT NULL UNIQUE REFERENCES quotes(id),
  corridor_id               INTEGER NOT NULL REFERENCES corridors(id),
  status                    TEXT NOT NULL CHECK (status IN (
                              'awaiting_payment', 'proof_submitted', 'resubmission_requested',
                              'payment_verified', 'payout_processing', 'completed',
                              'rejected', 'cancelled', 'expired', 'refunded')),
  status_changed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Agreed terms: copied from the quote at confirmation and locked by trigger below.
  send_currency             CHAR(3) NOT NULL,
  receive_currency          CHAR(3) NOT NULL,
  send_amount               NUMERIC(18,2) NOT NULL,
  rate                      NUMERIC(24,12) NOT NULL,
  rate_kind                 TEXT NOT NULL,
  rate_source               TEXT NOT NULL,
  rate_timestamp            TIMESTAMPTZ NOT NULL,
  fee_schedule_id           INTEGER NOT NULL REFERENCES fee_schedules(id),
  fee_rate                  NUMERIC(8,6) NOT NULL,
  gross_amount              NUMERIC(18,2) NOT NULL,
  fee_amount                NUMERIC(18,2) NOT NULL,
  payout_amount             NUMERIC(18,2) NOT NULL,
  terms_version             TEXT NOT NULL,
  terms_accepted_at         TIMESTAMPTZ NOT NULL,
  payment_instruction_id    INTEGER NOT NULL REFERENCES payment_instructions(id),
  payout_sla_hours          INTEGER NOT NULL,

  -- Recipient & contact (minimum needed to pay out; redacted by retention job).
  customer_email            TEXT,
  recipient_name            TEXT NOT NULL,
  recipient_phone           TEXT NOT NULL,
  recipient_country         CHAR(2) NOT NULL,
  payout_method             TEXT NOT NULL CHECK (payout_method IN ('mobile_money', 'bank_transfer')),
  mobile_money_provider     TEXT,
  bank_name                 TEXT,
  bank_account_number       TEXT,
  bank_branch               TEXT,

  -- Timeline
  payment_due_at            TIMESTAMPTZ NOT NULL,
  payout_due_at             TIMESTAMPTZ,
  customer_transfer_reference TEXT,

  -- Verification (independently confirmed incoming funds)
  verified_amount           NUMERIC(18,2),
  verified_reference        TEXT,
  verified_at               TIMESTAMPTZ,
  verified_by               UUID REFERENCES admin_users(id),

  -- Payout
  payout_started_at         TIMESTAMPTZ,
  payout_actual_amount      NUMERIC(18,2),
  payout_reference          TEXT,
  payout_date               DATE,
  payout_discrepancy_note   TEXT,
  completed_at              TIMESTAMPTZ,
  completed_by              UUID REFERENCES admin_users(id),

  -- Refund
  refund_amount             NUMERIC(18,2),
  refund_currency           CHAR(3),
  refund_reason             TEXT,
  refund_reference          TEXT,
  refunded_at               TIMESTAMPTZ,

  rejection_reason          TEXT,
  cancellation_reason       TEXT,
  operator_message          TEXT,
  flags                     TEXT[] NOT NULL DEFAULT '{}',

  payout_warning_sent_at    TIMESTAMPTZ,
  payout_overdue_sent_at    TIMESTAMPTZ,
  pii_redacted_at           TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (status <> 'completed' OR (verified_at IS NOT NULL AND payout_reference IS NOT NULL AND payout_actual_amount IS NOT NULL)),
  CHECK (status NOT IN ('payment_verified', 'payout_processing') OR verified_at IS NOT NULL),
  CHECK (status <> 'refunded' OR (refund_amount IS NOT NULL AND refund_reference IS NOT NULL AND refund_reason IS NOT NULL))
);
CREATE INDEX orders_status_idx ON orders(status, created_at DESC);
CREATE INDEX orders_phone_idx ON orders(recipient_phone);
CREATE INDEX orders_created_idx ON orders(created_at DESC);
CREATE INDEX orders_transfer_ref_idx ON orders(lower(customer_transfer_reference));
-- A bank/statement reference can verify at most one order (race-proof duplicate-payment guard).
CREATE UNIQUE INDEX orders_verified_ref_unique ON orders(lower(verified_reference)) WHERE verified_reference IS NOT NULL;

CREATE OR REPLACE FUNCTION orders_lock_agreed_terms() RETURNS trigger AS $$
BEGIN
  IF (NEW.quote_id, NEW.send_currency, NEW.receive_currency, NEW.send_amount, NEW.rate,
      NEW.rate_kind, NEW.rate_source, NEW.rate_timestamp, NEW.fee_schedule_id, NEW.fee_rate,
      NEW.gross_amount, NEW.fee_amount, NEW.payout_amount, NEW.terms_version,
      NEW.terms_accepted_at, NEW.payment_instruction_id, NEW.reference, NEW.created_at)
     IS DISTINCT FROM
     (OLD.quote_id, OLD.send_currency, OLD.receive_currency, OLD.send_amount, OLD.rate,
      OLD.rate_kind, OLD.rate_source, OLD.rate_timestamp, OLD.fee_schedule_id, OLD.fee_rate,
      OLD.gross_amount, OLD.fee_amount, OLD.payout_amount, OLD.terms_version,
      OLD.terms_accepted_at, OLD.payment_instruction_id, OLD.reference, OLD.created_at) THEN
    RAISE EXCEPTION 'agreed order terms are immutable (order %)', OLD.reference;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER orders_lock_agreed_terms BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_lock_agreed_terms();

CREATE OR REPLACE FUNCTION quotes_lock_terms() RETURNS trigger AS $$
BEGIN
  IF (NEW.send_amount, NEW.rate, NEW.fee_rate, NEW.gross_amount, NEW.fee_amount,
      NEW.payout_amount, NEW.expires_at, NEW.created_at, NEW.rate_snapshot_id, NEW.fee_schedule_id)
     IS DISTINCT FROM
     (OLD.send_amount, OLD.rate, OLD.fee_rate, OLD.gross_amount, OLD.fee_amount,
      OLD.payout_amount, OLD.expires_at, OLD.created_at, OLD.rate_snapshot_id, OLD.fee_schedule_id) THEN
    RAISE EXCEPTION 'quote terms are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER quotes_lock_terms BEFORE UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION quotes_lock_terms();

CREATE TABLE order_status_history (
  id              BIGSERIAL PRIMARY KEY,
  order_id        UUID NOT NULL REFERENCES orders(id),
  from_status     TEXT,
  to_status       TEXT NOT NULL,
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('customer', 'admin', 'system')),
  actor_id        UUID,
  customer_note   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_status_history_order_idx ON order_status_history(order_id, created_at);

CREATE TABLE payment_proofs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            UUID NOT NULL REFERENCES orders(id),
  storage_key         TEXT NOT NULL,
  original_filename   TEXT NOT NULL,
  mime_type           TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'application/pdf')),
  size_bytes          INTEGER NOT NULL,
  sha256              TEXT NOT NULL,
  transfer_reference  TEXT,
  review_status       TEXT NOT NULL DEFAULT 'pending'
                        CHECK (review_status IN ('pending', 'accepted', 'rejected', 'superseded')),
  review_note         TEXT,
  reviewed_by         UUID REFERENCES admin_users(id),
  reviewed_at         TIMESTAMPTZ,
  deleted_at          TIMESTAMPTZ,
  submitted_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payment_proofs_order_idx ON payment_proofs(order_id, submitted_at DESC);
CREATE INDEX payment_proofs_sha_idx ON payment_proofs(sha256);

-- ---------------------------------------------------------------------------
-- Audit log: append-only and hash-chained (tamper-evident).
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id              BIGSERIAL PRIMARY KEY,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('customer', 'admin', 'system')),
  actor_id        UUID,
  actor_label     TEXT,
  action          TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  before          JSONB,
  after           JSONB,
  reason          TEXT,
  ip              TEXT,
  prev_hash       TEXT NOT NULL,
  hash            TEXT NOT NULL
);
CREATE INDEX audit_log_entity_idx ON audit_log(entity_type, entity_id, id);

-- Timezone-independent timestamp text so the chain can be re-verified from any session.
CREATE OR REPLACE FUNCTION audit_ts(ts TIMESTAMPTZ) RETURNS TEXT AS $$
  SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION audit_row_hash(prev TEXT, a audit_log) RETURNS TEXT AS $$
  SELECT encode(sha256(convert_to(
    prev || '|' || audit_ts(a.occurred_at) || '|' || a.actor_type || '|' ||
    COALESCE(a.actor_id::text, '') || '|' || a.action || '|' || a.entity_type || '|' ||
    a.entity_id || '|' || COALESCE(a.before::text, '') || '|' || COALESCE(a.after::text, '') || '|' ||
    COALESCE(a.reason, ''), 'UTF8')), 'hex');
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS trigger AS $$
DECLARE
  last_hash TEXT;
BEGIN
  -- Serialise inserts so the chain is linear.
  PERFORM pg_advisory_xact_lock(727274);
  SELECT hash INTO last_hash FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := COALESCE(last_hash, 'genesis');
  NEW.hash := audit_row_hash(NEW.prev_hash, NEW);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- Returns the first audit row whose stored hash does not match a recomputation, or NULL.
CREATE OR REPLACE FUNCTION audit_log_first_broken() RETURNS BIGINT AS $$
DECLARE
  r audit_log;
  prev TEXT := 'genesis';
BEGIN
  FOR r IN SELECT * FROM audit_log ORDER BY id LOOP
    IF r.prev_hash <> prev OR r.hash <> audit_row_hash(prev, r) THEN
      RETURN r.id;
    END IF;
    prev := r.hash;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER fee_schedules_append_only BEFORE UPDATE OR DELETE ON fee_schedules
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER order_status_history_append_only BEFORE UPDATE OR DELETE ON order_status_history
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ---------------------------------------------------------------------------
-- Notifications: transactional outbox. Rows are written in the same transaction as the
-- business change, then delivered (with retries) by a background worker.
-- ---------------------------------------------------------------------------
CREATE TABLE email_outbox (
  id              BIGSERIAL PRIMARY KEY,
  to_address      TEXT NOT NULL,
  audience        TEXT NOT NULL CHECK (audience IN ('customer', 'admin')),
  template        TEXT NOT NULL,
  subject         TEXT NOT NULL,
  body_text       TEXT NOT NULL,
  order_id        UUID REFERENCES orders(id),
  dedupe_key      TEXT UNIQUE,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ
);
CREATE INDEX email_outbox_due_idx ON email_outbox(next_attempt_at) WHERE status IN ('pending', 'sending');

-- Operational events shown on the dashboard (rate API failures, unusual activity).
CREATE TABLE system_events (
  id              BIGSERIAL PRIMARY KEY,
  kind            TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  message         TEXT NOT NULL,
  detail          JSONB,
  order_id        UUID REFERENCES orders(id),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID REFERENCES admin_users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX system_events_open_idx ON system_events(created_at DESC) WHERE acknowledged_at IS NULL;
