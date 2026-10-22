-- Initial corridor configuration.
-- rate_max_age_seconds = 26h because the default free reference feed (open.er-api.com)
-- publishes once a day. Lower it when you switch to an intraday provider. Payment instructions are deliberately NOT seeded:
-- the corridor refuses new orders until an operator enters approved instructions.

INSERT INTO corridors (from_currency, to_currency, enabled, min_send_amount, max_send_amount,
                       quote_ttl_seconds, payment_window_minutes, payout_sla_hours, rate_max_age_seconds, payout_terms)
VALUES
  ('RUB', 'GHS', TRUE, 1000.00, 300000.00, 600, 120, 24, 93600,
   'Payout is made within 24 hours after your payment has been independently verified, during operating hours.'),
  -- Reverse direction stays disabled until there is a valid rate and an approved way to fulfil it.
  ('GHS', 'RUB', FALSE, 100.00, 30000.00, 600, 120, 24, 93600, '');

INSERT INTO fee_schedules (corridor_id, version, fee_rate, note)
SELECT id, 1, 0.007, 'Initial 0.7% service fee, deducted from the gross converted amount'
FROM corridors;

INSERT INTO settings (key, value) VALUES
  ('business_name',              '"NorbsCoin"'),
  ('support_email',              '""'),
  ('support_phone',              '""'),
  ('support_whatsapp',           '""'),
  ('operating_hours',            '"Mon–Sat 09:00–20:00 (Moscow time)"'),
  ('admin_notification_emails',  '[]'),
  ('terms_version',              '"2026-10-v1"'),
  ('terms_text',                 '"The service fee is deducted from the gross converted amount. The exchange rate and payout shown are fixed once you confirm. Payment proof is reviewed manually and is not treated as confirmation that funds arrived. Payout is made only after your payment is independently verified."'),
  ('unusual_amount_threshold',   '{"RUB": 150000}'),
  ('max_orders_per_phone_24h',   '3'),
  ('payout_warning_hours',       '4'),
  ('retention_days',             '730');
