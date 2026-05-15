-- Add DB-configurable MRX volatility filter thresholds to scalper_config.
-- 1m defaults are deliberately looser than 3m: 1m candles on top-10 USDT pairs
-- have naturally smaller ATR/BBW ranges than 3m candles.
-- All columns are NOT NULL with sensible defaults so existing rows are unaffected.

ALTER TABLE scalper_config
  ADD COLUMN IF NOT EXISTS mrx_atr_pct_min_1m  real NOT NULL DEFAULT 0.05,
  ADD COLUMN IF NOT EXISTS mrx_atr_pct_max_1m  real NOT NULL DEFAULT 2.0,
  ADD COLUMN IF NOT EXISTS mrx_bb_width_min_1m real NOT NULL DEFAULT 0.15,
  ADD COLUMN IF NOT EXISTS mrx_bb_width_max_1m real NOT NULL DEFAULT 3.0,
  ADD COLUMN IF NOT EXISTS mrx_atr_pct_min_3m  real NOT NULL DEFAULT 0.3,
  ADD COLUMN IF NOT EXISTS mrx_atr_pct_max_3m  real NOT NULL DEFAULT 3.0,
  ADD COLUMN IF NOT EXISTS mrx_bb_width_min_3m real NOT NULL DEFAULT 0.6,
  ADD COLUMN IF NOT EXISTS mrx_bb_width_max_3m real NOT NULL DEFAULT 5.0;
