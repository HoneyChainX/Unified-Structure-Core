-- Adaptive RSI thresholds (Phase 2): rolling-quantile cutoffs for the BB+RSI
-- engine, plus a common `quality` score channel for cross-engine ranking.
-- Idempotent.

-- ── BB+RSI adaptive config on scalper_config ────────────────────────────────
ALTER TABLE scalper_config ADD COLUMN IF NOT EXISTS adaptive_thresholds     boolean NOT NULL DEFAULT false;
ALTER TABLE scalper_config ADD COLUMN IF NOT EXISTS adaptive_window         integer NOT NULL DEFAULT 100;
ALTER TABLE scalper_config ADD COLUMN IF NOT EXISTS adaptive_low_q          real    NOT NULL DEFAULT 0.05;
ALTER TABLE scalper_config ADD COLUMN IF NOT EXISTS adaptive_high_q         real    NOT NULL DEFAULT 0.95;
ALTER TABLE scalper_config ADD COLUMN IF NOT EXISTS adaptive_rsi_low_floor  real    NOT NULL DEFAULT 35;
ALTER TABLE scalper_config ADD COLUMN IF NOT EXISTS adaptive_rsi_high_floor real    NOT NULL DEFAULT 65;

-- ── Setup-quality score channel ─────────────────────────────────────────────
-- 0..1 score expressing how extreme this setup is relative to the symbol's
-- own recent distribution. Populated by adaptive BB+RSI; future engines will
-- write into the same column so a downstream ranker can compare apples-to-apples.
ALTER TABLE scalper_trades ADD COLUMN IF NOT EXISTS quality numeric(8,6);
ALTER TABLE signals        ADD COLUMN IF NOT EXISTS quality numeric(8,6);
