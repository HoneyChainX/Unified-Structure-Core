-- MRX funding-rate filter (LONG-only). Mirrors the CHT filter but enabled
-- per-engine since their signal profiles differ. Idempotent.

ALTER TABLE scalper_config ADD COLUMN IF NOT EXISTS mrx_funding_filter_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE scalper_config ADD COLUMN IF NOT EXISTS mrx_funding_threshold_pct  real    NOT NULL DEFAULT 0.05;
