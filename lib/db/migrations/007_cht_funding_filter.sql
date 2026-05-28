-- CHT funding-rate filter. Rejects entries where perp funding indicates the
-- crowd is already heavily positioned in the same direction as the proposed
-- trade. Idempotent.

ALTER TABLE scalper_config ADD COLUMN IF NOT EXISTS cht_funding_filter_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE scalper_config ADD COLUMN IF NOT EXISTS cht_funding_threshold_pct  real    NOT NULL DEFAULT 0.05;
