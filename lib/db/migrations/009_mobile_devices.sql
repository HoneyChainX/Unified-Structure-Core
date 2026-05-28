-- Mobile push-notification device registry. Idempotent.
--
-- One row per device that has registered for push. Used by the FCM dispatcher
-- in artifacts/api-server/src/services/notify-mobile.ts to fan-out alerts.

CREATE TABLE IF NOT EXISTS mobile_devices (
  id                          serial PRIMARY KEY,
  token                       text NOT NULL UNIQUE,
  label                       text,
  platform                    text NOT NULL DEFAULT 'android',
  enabled                     boolean NOT NULL DEFAULT true,
  notify_kill_switch          boolean NOT NULL DEFAULT true,
  notify_emergency_close      boolean NOT NULL DEFAULT true,
  notify_daily_loss           boolean NOT NULL DEFAULT true,
  notify_high_quality_signal  boolean NOT NULL DEFAULT false,
  signal_quality_threshold    text    NOT NULL DEFAULT '0.8',
  registered_at               timestamptz NOT NULL DEFAULT now(),
  last_seen_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mobile_devices_enabled ON mobile_devices (enabled) WHERE enabled = true;
