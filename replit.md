# Unified Signal Dashboard

A real-time trading signal dashboard for the "Unified v1" TradingView Pine Script indicator. Receives JSON webhook alerts from TradingView and displays all signal components: direction, gates, confidence, entry zones, TPs/SL, rotation state, and full signal history.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/dashboard run dev` — run the frontend (port 23183)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Webhook Integration

Configure your TradingView alert to send a webhook POST to:
```
https://<your-domain>/api/signals/webhook
```

The alert message must be the JSON output from the Pine Script's alert block (already built into the script).

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite, Wouter routing, TanStack Query, Tailwind CSS v4
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — API contract (source of truth)
- `lib/db/src/schema/signals.ts` — Signals table schema
- `artifacts/api-server/src/routes/signals.ts` — Webhook + signal API routes
- `artifacts/dashboard/src/pages/dashboard.tsx` — Main dashboard page
- `artifacts/dashboard/src/pages/signals.tsx` — Signal history page
- `artifacts/dashboard/src/pages/signal-detail.tsx` — Single signal detail page
- `artifacts/dashboard/src/components/layout.tsx` — Sidebar layout

## Architecture decisions

- Webhook endpoint accepts the exact JSON structure that the Pine Script fires as alerts, mapping snake_case fields to camelCase DB columns.
- `triggered` boolean is derived from `block_reason === "OK"` on ingest — no separate field needed in the alert payload.
- Frontend auto-refreshes every 15 seconds via TanStack Query `refetchInterval` — no WebSocket needed for this use case.
- All CSS variables use forced dark-only theme (`:root, .dark` merged) — no light mode toggle.
- Space Mono monospace font chosen for the Bloomberg terminal aesthetic.

## Product

- **Main dashboard** (`/`): Latest signal with full entry plan, gate status, confidence bar, context/rotation, and a recent signals table.
- **Signal history** (`/signals`): Filterable/sortable table of all signals with pagination.
- **Signal detail** (`/signal/:id`): Full expanded view of any signal with a visual level map and raw webhook payload.
- **Bot control** (`/bot`): Gate.io spot trading bot — configure position size, confidence thresholds, symbol allowlist, SL/TP rules, paper vs live mode. Trade history with cancel support.

## Trading Bot

The bot fires automatically after each webhook signal is stored. Execution logic:
1. Check bot is enabled and signal is `triggered`
2. Check `conf_w` >= `min_conf_w` threshold
3. Check `grade` >= `min_grade` threshold
4. Check symbol is in allowlist (if set)
5. In paper mode: record simulated trade
6. In live mode: market buy/sell via Gate.io Spot API, then place SL stop-limit and TP price-triggered orders

Required secrets for live trading: `GATEIO_API_KEY`, `GATEIO_API_SECRET`

## Where things live (extended)

- `lib/db/src/schema/bot-config.ts` — Bot configuration table
- `lib/db/src/schema/trades.ts` — Trade history table
- `artifacts/api-server/src/services/gateio.ts` — Gate.io API client (HMAC-SHA512 auth)
- `artifacts/api-server/src/services/executor.ts` — Signal-to-trade execution logic
- `artifacts/api-server/src/routes/bot.ts` — Bot config + trade history API routes
- `artifacts/dashboard/src/pages/bot.tsx` — Bot control page

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Always restart `artifacts/api-server` after route changes (it compiles with esbuild on startup).
- Run `pnpm --filter @workspace/api-spec run codegen` after any OpenAPI spec change before editing frontend hooks.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
