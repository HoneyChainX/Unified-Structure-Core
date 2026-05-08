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

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Always restart `artifacts/api-server` after route changes (it compiles with esbuild on startup).
- Run `pnpm --filter @workspace/api-spec run codegen` after any OpenAPI spec change before editing frontend hooks.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
