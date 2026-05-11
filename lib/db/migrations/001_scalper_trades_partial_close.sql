-- A1: per-fill CHT P&L tracking columns (idempotent)
ALTER TABLE scalper_trades ADD COLUMN IF NOT EXISTS closed_qty    NUMERIC;
ALTER TABLE scalper_trades ADD COLUMN IF NOT EXISTS remaining_qty NUMERIC;
ALTER TABLE scalper_trades ADD COLUMN IF NOT EXISTS realized_pnl  NUMERIC;
