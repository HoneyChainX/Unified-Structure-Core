-- Numeric precision migration: prices, qty, and P&L move from real (float4)
-- to numeric(24,12). float4 has ~7 significant digits — not enough for tokens
-- priced like SHIB (1e-5 USDT) or BTC notional (>1e5 USDT). Drizzle still maps
-- numeric to plain JS numbers on read for backwards compat with the dashboard;
-- new code should parse with decimal.js-light when sub-cent precision matters.
--
-- This migration is idempotent: the type-change is wrapped in a DO block that
-- only fires if the column is still `real`.

DO $$
DECLARE
  t   text;
  c   text;
  tab text[] := ARRAY['trades', 'scalper_trades'];
  col text[] := ARRAY[
    'position_size_usdt', 'quantity', 'entry_price', 'live_price',
    'sl_price', 'tp_price', 'tp1_price', 'tp2_price', 'tp3_price',
    'close_price', 'pnl', 'fees_usdt', 'bb_upper', 'bb_lower', 'bb_mid',
    'rsi', 'volume_ratio', 'slippage_bps'
  ];
BEGIN
  FOREACH t IN ARRAY tab LOOP
    FOREACH c IN ARRAY col LOOP
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = t AND column_name = c AND data_type = 'real'
      ) THEN
        EXECUTE format(
          'ALTER TABLE %I ALTER COLUMN %I TYPE numeric(24,12) USING %I::numeric(24,12)',
          t, c, c
        );
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- Signals: only convert price-like fields, leave conf/conf_w/rot_score alone
-- (those are bounded integers and percentages).
DO $$
DECLARE
  c   text;
  col text[] := ARRAY['pa_mss', 'ob_low', 'ob_high', 'zone_low', 'zone_high',
                      'entry_ref', 'sl', 'tp1', 'tp2', 'tp3', 'rr1'];
BEGIN
  FOREACH c IN ARRAY col LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_name = 'signals' AND column_name = c AND data_type = 'real'
    ) THEN
      EXECUTE format(
        'ALTER TABLE signals ALTER COLUMN %I TYPE numeric(24,12) USING %I::numeric(24,12)',
        c, c
      );
    END IF;
  END LOOP;
END $$;
