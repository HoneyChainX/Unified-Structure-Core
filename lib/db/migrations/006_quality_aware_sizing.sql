-- Quality-aware sizing: scale position size by the signal's [0,1] quality.
-- See scalper-executor.ts for the scaling formula. Disabled by default; flip
-- per-account to live-test. Idempotent.

ALTER TABLE scalper_config ADD COLUMN IF NOT EXISTS quality_aware_sizing             boolean NOT NULL DEFAULT false;
ALTER TABLE scalper_config ADD COLUMN IF NOT EXISTS quality_size_floor_pct           real    NOT NULL DEFAULT 50;
ALTER TABLE scalper_config ADD COLUMN IF NOT EXISTS quality_aware_sizing_micro_mode  boolean NOT NULL DEFAULT false;
