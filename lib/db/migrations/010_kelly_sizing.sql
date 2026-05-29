-- Fractional-Kelly position sizing. Idempotent.
--
-- When enabled, the scalper executor multiplies the base position size by a
-- Kelly fraction derived from each symbol's recent closed-trade history.
-- Composes with quality-aware sizing (each multiplier is independent).
--
--   f_kelly = max(0, p − (1−p) / R)        — binary-outcome Kelly
--   scale   = clamp(f_kelly × safety, floor, max)
--
-- where p = win rate, R = avg_win_usdt / avg_loss_usdt. Below
-- kelly_min_trades closed trades, the multiplier is 1.0 (no effect).

ALTER TABLE scalper_config ADD COLUMN IF NOT EXISTS kelly_sizing_enabled    boolean NOT NULL DEFAULT false;
ALTER TABLE scalper_config ADD COLUMN IF NOT EXISTS kelly_lookback_trades   integer NOT NULL DEFAULT 30;
ALTER TABLE scalper_config ADD COLUMN IF NOT EXISTS kelly_min_trades        integer NOT NULL DEFAULT 10;
ALTER TABLE scalper_config ADD COLUMN IF NOT EXISTS kelly_safety_fraction   real    NOT NULL DEFAULT 0.5;
ALTER TABLE scalper_config ADD COLUMN IF NOT EXISTS kelly_floor_pct         real    NOT NULL DEFAULT 10;
ALTER TABLE scalper_config ADD COLUMN IF NOT EXISTS kelly_max_pct           real    NOT NULL DEFAULT 100;
