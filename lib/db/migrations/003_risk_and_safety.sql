-- Risk & safety infrastructure: kill-switch, daily-loss circuit breaker,
-- combined exposure cap, atomic SL/TP placement tracking.
-- Idempotent.

-- ── risk_config singleton ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS risk_config (
  id                              serial PRIMARY KEY,
  kill_switch                     boolean NOT NULL DEFAULT false,
  global_max_open_trades          integer NOT NULL DEFAULT 6,
  global_max_notional_usdt        real    NOT NULL DEFAULT 1000,
  daily_loss_limit_pct            real    NOT NULL DEFAULT 5,
  daily_loss_auto_resume_utc_hour integer NOT NULL DEFAULT 0,
  max_position_pct_of_equity      real    NOT NULL DEFAULT 50,
  kill_reason                     integer,
  updated_at                      timestamptz NOT NULL DEFAULT now()
);

-- Seed singleton row (id=1) if it does not exist yet.
INSERT INTO risk_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── protection_state column on both trade tables ────────────────────────────
-- Possible values: 'pending' | 'protected' | 'degraded' | 'emergency_closed'
ALTER TABLE trades         ADD COLUMN IF NOT EXISTS protection_state text NOT NULL DEFAULT 'pending';
ALTER TABLE scalper_trades ADD COLUMN IF NOT EXISTS protection_state text NOT NULL DEFAULT 'pending';

-- ── slippage / edge instrumentation ─────────────────────────────────────────
ALTER TABLE trades         ADD COLUMN IF NOT EXISTS slippage_bps real;
ALTER TABLE scalper_trades ADD COLUMN IF NOT EXISTS slippage_bps real;
ALTER TABLE trades         ADD COLUMN IF NOT EXISTS fees_usdt    real;
ALTER TABLE scalper_trades ADD COLUMN IF NOT EXISTS fees_usdt    real;

-- ── hot query path indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_signals_symbol_received     ON signals (symbol, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_status_created       ON trades (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scalper_trades_status_ts    ON scalper_trades (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scalper_trades_symbol_open  ON scalper_trades (gate_symbol) WHERE status IN ('open','paper');
CREATE INDEX IF NOT EXISTS idx_trades_symbol_open          ON trades (gate_symbol) WHERE status IN ('open','paper');
