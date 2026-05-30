# Project Status — Unified-Structure-Core

A signal-driven Gate.io spot trading bot with a mobile companion app.
This document describes what's in the codebase as of the **Phase 2 + Mobile + Backtester** completion, who should read what, and where to start.

## At a glance

| Capability | Status | Where to look |
|---|---|---|
| Webhook bot (TradingView signals → orders) | ✅ Production | `artifacts/api-server/src/services/executor.ts` |
| Scalper bot (BB+RSI, SMC, CHT, MRX) | ✅ Production | `artifacts/api-server/src/services/scalper-*.ts` |
| Capital-safety hardening | ✅ On main | Risk guard, kill switch, atomic SL/TP, fee-aware P&L |
| Phase 2 alpha (quality channel + funding filters + Kelly) | ✅ On main, **dark-launched** | Default flags off — operator opts in per account |
| Backtester | ✅ On main | `artifacts/api-server/src/services/backtest.ts` + `/api/backtest/*` + `/backtest` page |
| Mobile companion app (Capacitor + FCM push) | ✅ Code on main | `artifacts/mobile/` — operator builds the APK locally |
| Observability (quality histogram + per-symbol Kelly stats) | ✅ Dashboard pages | `/signals` (histogram), `/symbol-stats` (Kelly diagnostics) |
| CI (typecheck + ~180 verifier assertions) | ✅ Required for every PR | `.github/workflows/ci.yml` |

## What's still operational (NOT code)

These cannot be done from this repo. Track them externally.

- [ ] Apply migrations 003–010 against the production DB. Use `./scripts/apply-migrations.sh`. See `docs/applying-migrations.md`.
- [ ] Build the Android APK in Android Studio. See `artifacts/mobile/README.md`.
- [ ] Paper-test Phase 2 features per `docs/GOING_LIVE_CHECKLIST.md`.
- [ ] Flip Phase 2 flags live, one at a time, once paper data supports it.

## Architecture map

```
artifacts/
  api-server/         Express + Drizzle. The brain.
    src/routes/       HTTP surface
      signals.ts          TradingView webhook + quality-stats endpoint
      bot.ts              Webhook-bot config + trade history + performance
      scalper.ts          Scalper config/status/trades + symbol-stats
      market.ts           Market regime (BTC dominance etc.)
      risk.ts             Kill switch + risk config
      mobile.ts           Mobile-app bearer-auth API
      devices.ts          Dashboard-side device management (no auth)
      backtest.ts         Historical replay engine API
      health.ts           Liveness + deep readiness probe
    src/services/     Domain logic
      executor.ts            Webhook-bot trade lifecycle (atomic SL/TP)
      scalper-executor.ts    Scalper trade lifecycle (Phase 2 sizing)
      scalper-loop.ts        Scan loop — emits ranked signals
      scalper-signals.ts     BB+RSI engine (adaptive thresholds)
      scalper-signals-cht.ts CHT engine (funding filter)
      scalper-signals-mrx.ts MRX engine (funding filter)
      scalper-signals-smc.ts SMC MSS+OB engine
      risk-guard.ts          Combined exposure + daily-loss breaker
      kelly-sizing.ts        Fractional-Kelly sizing helper
      fees.ts                Fee-aware P&L math
      backtest.ts            Walk-forward replay
      notify-mobile.ts       FCM dispatcher (no-op without credentials)
  dashboard/          React + Vite operator UI
    src/pages/
      dashboard.tsx          Overview
      scalper.tsx            Strategy config + Phase 2 toggles
      signals.tsx            Signal table + quality histogram
      symbol-stats.tsx       Per-symbol Kelly diagnostics
      devices.tsx            Mobile-device management
      backtest.tsx           Historical backtest UI
      bot.tsx, analytics.tsx Existing
  mobile/             Capacitor companion app (web preview at :5174)
lib/
  db/                 Drizzle schema + raw SQL migrations
    migrations/       001–010 (all idempotent, apply via runner script)
    src/schema/       Type-safe TS schema definitions
  api-zod/            Auto-generated OpenAPI client types
  api-client-react/   React Query hooks generated from OpenAPI
  api-spec/           openapi.yaml source
scripts/
  apply-migrations.sh One-command runner for lib/db/migrations/*.sql
.github/workflows/
  ci.yml              Typecheck + verifier suite on every PR
docs/
  DEPLOYMENT.md             Setup, env vars, first deploy
  GOING_LIVE_CHECKLIST.md   Paper → live transition gate
  applying-migrations.md    Migration runner usage + Supabase notes
  android-app-proposal.md   Design document for the mobile app
```

## Phase 2 feature flags (all default OFF)

All Phase 2 features are off by default. The server runs unchanged after migrations land. To activate, flip the flag per account in the dashboard's Scalper config page (`/scalper`).

| Flag | What it does | Risk if wrong |
|---|---|---|
| `adaptive_thresholds` | Rolling-quantile RSI cutoffs vs. fixed 30/70 | Different signals, same trading logic. Low risk. |
| `quality_aware_sizing` | Scale position size by [0,1] setup quality | Reduces sizes only — defensive. Low risk. |
| `kelly_sizing_enabled` | Multiply size by historical Kelly fraction | Drops below-floor symbols' sizes. Medium risk. |
| `cht_funding_filter_enabled` | Skip CHT longs into euphoric funding (perp) | Filter; reduces trade count. Low risk. |
| `mrx_funding_filter_enabled` | Skip MRX longs into euphoric funding | Filter; reduces trade count. Low risk. |

Default thresholds match the live executor defaults in `lib/db/src/schema/scalper-config.ts`. Operator can override per account via the dashboard.

## Capital-safety guarantees (always-on)

These do NOT have flags — they're always on. Disabling them would break the safety model.

- **Atomic SL/TP placement.** If the SL order fails after entry, the executor immediately market-closes the position and writes `protection_state='emergency_closed'`. The trade is never left naked.
- **Kill switch.** `POST /api/risk/halt` engages, `POST /api/risk/resume` clears. Persisted in `risk_config.kill_switch`. Survives restart. Blocks all new entries (both engines).
- **Daily-loss circuit breaker.** Once 24-hour realised P&L breaches `daily_loss_limit_pct` of equity, kill switch auto-trips with `kill_reason=1`. Resets at UTC midnight.
- **Combined exposure cap.** `global_max_open_trades` and `global_max_notional_usdt` apply across BOTH engines (webhook bot + scalper).
- **Fee-aware P&L.** Every accounting path uses `pnlFromFills()` which subtracts taker fees on both legs. Compound balance updates atomically via SQL increment.

## Observability

- **`/signals`** — paginated signal table with a quality-score histogram and triggered ratio per quality bin. Lets the operator see whether their score is informative.
- **`/symbol-stats`** — per-symbol breakdown of closed trades with the same Kelly fraction the live sizer would compute. Tells the operator which symbols are profitable vs which are getting floor-sized.
- **`/devices`** — registered mobile devices, per-device alert preferences, quality threshold for signal alerts.
- **`/backtest`** — replay any date range, any strategy, with current Phase 2 config. Returns trades, P&L, Sharpe, max drawdown.
- **Logs** — every Phase 2 sizing decision is logged with full diagnostics (quality score, Kelly fraction, multipliers, before/after size). Search for `"Scalper: Kelly sizing applied"` or `"Scalper: quality-aware sizing applied"` in production logs.

## CI invariants

Every PR runs through `.github/workflows/ci.yml`:

1. **Typecheck** all 5 workspace packages (api-server, dashboard, mobile, mockup-sandbox, scripts).
2. **Verifier suite** — every `artifacts/api-server/src/scripts/verify-*.ts` is executed against an ephemeral Postgres with migrations applied. ~180 assertions cover risk guards, Kelly math, sizing composition, quality scoring, funding filters, the backtester walk-forward engine, mobile push dispatch, and more.

CI is not just for code review — it's the first place to look when a change misbehaves. Failing assertions point at the exact behavioral contract that broke.

## Where to start as a new operator

1. Read `docs/DEPLOYMENT.md` end-to-end.
2. Bring up a Postgres (Supabase recommended).
3. Run `./scripts/apply-migrations.sh` against it.
4. Start the api-server in paper mode (`scalper_config.paper_mode = true`, which is the default).
5. Watch `/dashboard` and `/signals` for a day. Do trades fire? Does the executor write rows correctly?
6. Read `docs/GOING_LIVE_CHECKLIST.md` and tick through the paper-validation requirements before flipping Phase 2 flags or going live.

## Where to start as a new contributor

1. Read this file.
2. Read `CLAUDE.md` if present (project conventions).
3. Look at an existing PR for the project's style — see `git log --oneline` for recent merges.
4. Each verifier in `artifacts/api-server/src/scripts/verify-*.ts` mirrors a piece of production logic and is the cleanest entry point for understanding what that piece is supposed to do. Read the verifier first, then the implementation.
5. CI must stay green. Add a new verifier for any new behavioral contract.

## Not in scope

Everything below was deliberately left out and would be reasonable future work, but is NOT part of "the project as currently scoped":

- Walk-forward optimisation / parameter sweeps on the backtester
- Monte-Carlo on the closed-trade distribution
- Persistent backtest history in the DB
- Multi-position / portfolio backtests
- Logistic-regression meta-label across engines (was discussed in the Android proposal as Phase 3+)
- iOS app (Capacitor leaves the door open via `pnpm run dev` in mobile Safari, but no native iOS target)
- Strategy auto-selection across all engines simultaneously
- Filter-rejection telemetry (counting how many signals each filter rejected) — useful but not built
