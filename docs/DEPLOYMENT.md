# Deployment

End-to-end guide to standing up the trading bot in production. Pair with
`docs/GOING_LIVE_CHECKLIST.md` before flipping anything to live mode.

## 1. Overview

This is a signal-driven Gate.io **spot** trading bot with three components in
a single pnpm workspace:

- **`@workspace/api-server`** — Express backend that ingests TradingView
  webhooks, runs the scalper engines (BB+RSI and SMC/MSS), places and
  reconciles orders on Gate.io, and exposes a REST API on `PORT`.
- **`@workspace/dashboard`** — Vite/React control panel that reads and
  configures everything through the api-server.
- **`artifacts/mobile`** — Capacitor-wrapped Android companion app with FCM
  push for kill-switch / emergency-close / daily-loss / high-quality-signal
  alerts. See [`artifacts/mobile/README.md`](../artifacts/mobile/README.md).

Phase 2 features (`adaptive_thresholds`, `cht_funding_filter_enabled`,
`mrx_funding_filter_enabled`, `quality_aware_sizing`, `kelly_sizing_enabled`)
are **dark-launched**: every flag defaults to `false` in
`lib/db/src/schema/scalper-config.ts`. After the migrations run, the server
behaves identically to the pre-Phase-2 code path until you flip a flag on the
dashboard. See `docs/GOING_LIVE_CHECKLIST.md` for the recommended rollout
sequence.

## 2. Prerequisites

| Requirement | Notes |
| --- | --- |
| Node.js 22+ | Matches the `@types/node` catalog version. |
| pnpm 10+ | The root `preinstall` hook rejects npm and yarn. |
| Postgres 16 | Supabase recommended (managed backups, pooled connections). Self-hosted Postgres 16 works equally well. |
| Gate.io API key | Spot **read + spot trade** permissions. No futures/withdrawal needed. Whitelist your server IP on the key. |
| Firebase project (optional) | Only needed if you want mobile push notifications. Same project you point the Android app at — see the mobile README. |
| Android Studio (optional) | Only for building the companion app APK. Not needed for the backend or dashboard. |

## 3. Environment variables

Every variable below is read directly by `artifacts/api-server/src/`. Anything
not in this table is not consumed.

### Required

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. Read by `lib/db/src/index.ts` on import — the process exits immediately if missing. |
| `PORT` | TCP port the api-server binds. `artifacts/api-server/src/index.ts` throws if unset or non-numeric. |
| `WEBHOOK_SECRET` | Required for `POST /api/signals/webhook` outside `NODE_ENV=development`. When unset in production the webhook returns HTTP 500 and refuses all signals. |
| `GATEIO_API_KEY` | Used by `services/gateio.ts` to sign requests. Empty string disables live trading paths (status endpoints expose `apiConfigured: false`). |
| `GATEIO_API_SECRET` | Companion to the API key. Same fallback behaviour. |

### Optional — features

| Variable | Default | Purpose |
| --- | --- | --- |
| `MOBILE_API_TOKEN` | (unset) | Bearer token gating the entire `/api/mobile/*` namespace. Unset → every mobile request returns 503. |
| `FCM_SERVICE_ACCOUNT_JSON` | (unset) | Inline Firebase service-account JSON. If set, takes precedence over `_PATH`. Without either, push notifications no-op (the rest of the server is unaffected). |
| `FCM_SERVICE_ACCOUNT_PATH` | (unset) | Filesystem path to the same service-account JSON. Pick whichever fits your secret-management setup. |
| `GATEIO_TAKER_FEE_RATE` | `0.0009` | Override the spot taker fee used in P&L calculations (`services/fees.ts`, `services/scalper-executor.ts`, `routes/dev.ts`). |
| `GATEIO_MAKER_FEE_RATE` | `0.0009` | Override the spot maker fee. Same use sites. |
| `TELEGRAM_BOT_TOKEN` | (unset) | If both Telegram vars are set, `services/notify.ts` emits alerts there in addition to (or instead of) FCM. |
| `TELEGRAM_CHAT_ID` | (unset) | Chat ID the bot posts into. |
| `LOG_LEVEL` | `info` | Pino log level. Set `debug` for more verbose output during bring-up. |

### Behavioural

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | (unset) | When set to `development`, the webhook route allows requests with a missing `WEBHOOK_SECRET` and the logger swaps to pretty output. **Never set this to `development` in production.** Set it to `production`. |

## 4. First-time deploy

### a. Provision Postgres

Create a Postgres 16 database. On Supabase: create a new project, then copy
the **connection string** from Project Settings → Database → Connection string
(prefer the *Session pooler* URL — Drizzle's `pg.Pool` works with it
cleanly). Self-hosting? Make sure `pg_stat_statements` is allowed and the role
you use can create extensions, tables, and indexes.

### b. Set environment variables

Copy `.env.example` from the repo root, fill in the required values, and load
it into your process supervisor (systemd `EnvironmentFile=`, Docker
`--env-file`, Render/Railway secrets, etc.). Make sure secrets are not
world-readable on disk.

### c. Install dependencies

```bash
pnpm install
```

The root `preinstall` script refuses any non-pnpm user agent — don't
substitute `npm install`.

### d. Apply migrations

The migration runner is `scripts/apply-migrations.sh`; the full procedure
(idempotency guarantees, rollback strategy, what each migration does) lives
in [`docs/applying-migrations.md`](./applying-migrations.md). Follow that
doc — do not run raw SQL by hand.

### e. Build

```bash
pnpm run build
```

This runs `tsc --build` across libraries, then per-artifact builds. The
api-server emits a single bundled `dist/index.mjs` via esbuild; the dashboard
emits a static Vite bundle under `artifacts/dashboard/dist/`.

### f. Run

Backend:

```bash
NODE_ENV=production pnpm --filter @workspace/api-server run start
```

Dashboard (for the operator browser — typically behind your reverse proxy or
served as static files):

```bash
pnpm --filter @workspace/dashboard run dev   # hot-reload, local
# or, for the static prod bundle:
pnpm --filter @workspace/dashboard run build
pnpm --filter @workspace/dashboard run serve
```

### g. (Optional) Mobile app

For the Android companion app see
[`artifacts/mobile/README.md`](../artifacts/mobile/README.md). Set
`MOBILE_API_TOKEN` (and optionally `FCM_SERVICE_ACCOUNT_JSON` /
`FCM_SERVICE_ACCOUNT_PATH`) on the server first.

## 5. Configuring the TradingView webhook

The webhook ingest endpoint is `POST /api/signals/webhook`. The secret must
travel in the `X-Webhook-Secret` HTTP header — legacy `?secret=…` query
strings still work but the server logs a warning every hit (proxies log query
strings).

TradingView setup:

1. Open your strategy/indicator alert → **Webhook URL**:
   `https://<your-host>/api/signals/webhook`
2. TradingView's alert UI does not let you set HTTP headers natively. Use one
   of:
   - A small forwarder (e.g. a Cloudflare Worker, AWS Lambda, or your own
     `nginx` location) that injects `X-Webhook-Secret` and proxies the body
     through.
   - A purpose-built relay like `tvwh`.
   - As a stopgap, append `?secret=<value>` to the URL — accepted but logged
     as a warning on every request.
3. The alert message body must be JSON matching the `ReceiveWebhookBody`
   schema in `@workspace/api-zod` (the strategy's stock template emits this).

A signal where `block_reason === "OK"`, `grade` includes `"TRIGGER"`, or
`block_reason` is null with a non-`"None"` grade is recorded as
`triggered=true` and will fan out to the executor.

## 6. First verification

After `pnpm --filter @workspace/api-server run start`, you should see:

- `Server listening on :<PORT>` (pino structured log line).
- No `DATABASE_URL must be set` exit.
- `GET /healthz` returns `{"status":"ok"}`.
- `GET /api/bot/status` returns `apiConfigured: true` once both
  `GATEIO_API_KEY` and `GATEIO_API_SECRET` are set.
- `GET /api/scalper/status` likewise reports `apiConfigured: true`.
- `GET /api/risk` returns the seeded `risk_config` row (kill switch off,
  defaults from `lib/db/src/schema/risk-config.ts`).
- Open the dashboard, navigate to *Signals* — an empty list is correct
  pre-traffic.

Trigger a test webhook from your shell:

```bash
curl -X POST https://<your-host>/api/signals/webhook \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $WEBHOOK_SECRET" \
  -d '{"symbol":"BTC_USDT","tf":"1m","dir":"long","grade":"TRIGGER"}'
```

Expect HTTP 200 and a new row visible in the dashboard *Signals* page.

## 7. Production hardening

- **TLS / reverse proxy** — terminate HTTPS at nginx / Caddy / Cloudflare in
  front of the api-server. The Express app does not bind TLS directly.
- **Process supervisor** — run the api-server under systemd, pm2, or your
  platform's equivalent. Honour SIGTERM; the server's graceful shutdown stops
  the scalper loops first, then drains HTTP, then closes the PG pool
  (`artifacts/api-server/src/index.ts`).
- **Log rotation** — Pino writes JSON to stdout. Pipe to `journalctl`,
  CloudWatch, Loki, or `pino-pretty` for dev; rotate at the supervisor /
  collector layer.
- **Backups** — your Postgres provider's PITR is the primary defence. Before
  any migration, dump at minimum the `risk_config`, `scalper_config`,
  `signals`, `trades`, and `scalper_trades` tables. The procedure is in
  [`docs/applying-migrations.md`](./applying-migrations.md).
- **Key hygiene** — Gate.io API keys are IP-whitelisted; rotate on
  compromise. Webhook secret rotates by updating `WEBHOOK_SECRET` env var and
  the TradingView header in lock-step.
- **Kill switch reachability** — `POST /api/risk/kill` must be reachable from
  the operator's phone / laptop even if the dashboard is down. Test it before
  going live.

## 8. Updates

```bash
git pull
pnpm install
# Apply any new migrations (idempotent — see docs/applying-migrations.md):
bash scripts/apply-migrations.sh
pnpm run build
# Restart the api-server via your supervisor (systemd: `systemctl restart`).
```

Migrations are designed to be safe to re-run; running them with no new
migration files is a no-op.

## 9. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Process exits at startup with `DATABASE_URL must be set` | `DATABASE_URL` env var not loaded into the process environment. |
| Process exits with `PORT environment variable is required` | Same, for `PORT`. |
| Every webhook returns HTTP 500 `Server misconfigured: WEBHOOK_SECRET not set` | Set `WEBHOOK_SECRET` and restart. The server intentionally refuses to accept signals without it in non-development mode. |
| Every webhook returns HTTP 401 `Unauthorized` | TradingView (or your relay) is not sending the `X-Webhook-Secret` header or it doesn't match. Check for trailing whitespace. |
| `GET /api/bot/status` returns `apiConfigured: false` | `GATEIO_API_KEY` and/or `GATEIO_API_SECRET` not set. The server runs and accepts signals, but cannot place orders. |
| Gate.io requests return HTTP 401 | Wrong key/secret, IP not whitelisted, or insufficient permissions on the key. Spot trade permission is required. |
| Push notifications never arrive | Likely `FCM: init failed` in the logs — service-account JSON not set or malformed. The server otherwise runs normally; push is best-effort. See `artifacts/mobile/README.md` troubleshooting. |
| Every `/api/mobile/*` request returns HTTP 503 | `MOBILE_API_TOKEN` is unset. Set it and restart. |
| Open trades show `protection_state = degraded` or `emergency_closed` | The executor could not place or reconcile the protective SL/TP. Inspect the executor logs around the trade ID; see `services/scalper-executor.ts`. |
| Webhook log warns "secret in query string" | TradingView is sending `?secret=…`. Move the secret into the `X-Webhook-Secret` header via a relay — query strings get logged by proxies. |
