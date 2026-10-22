-- RUB → NGN (Nigerian naira) and RUB → XAF (Central African CFA franc).
-- Created DISABLED: enable each one in Settings only once you have a valid rate, approved
-- payment instructions and a working way to pay out in that currency.
INSERT INTO corridors (from_currency, to_currency, enabled, min_send_amount, max_send_amount,
                       quote_ttl_seconds, payment_window_minutes, payout_sla_hours, rate_max_age_seconds, payout_terms)
VALUES
  ('RUB', 'NGN', FALSE, 1000.00, 300000.00, 600, 120, 24, 93600,
   'Payout is made within 24 hours after your payment has been independently verified, during operating hours.'),
  ('RUB', 'XAF', FALSE, 1000.00, 300000.00, 600, 120, 24, 93600,
   'Payout is made within 24 hours after your payment has been independently verified, during operating hours.')
ON CONFLICT (from_currency, to_currency) DO NOTHING;

INSERT INTO fee_schedules (corridor_id, version, fee_rate, note)
SELECT c.id, 1, 0.007, 'Initial 0.7% service fee, deducted from the gross converted amount'
FROM corridors c
WHERE (c.from_currency, c.to_currency) IN (('RUB', 'NGN'), ('RUB', 'XAF'))
  AND NOT EXISTS (SELECT 1 FROM fee_schedules f WHERE f.corridor_id = c.id);
