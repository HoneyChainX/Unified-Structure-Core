# Android Companion App — Design Proposal

**Status:** Proposal. No code shipped until product decisions are confirmed.
**Audience:** Project owner. Read top-to-bottom; the trade-offs at the end matter most.

## Why an Android app

The existing dashboard (`artifacts/dashboard`, React/Vite) covers configuration and analytics. An Android app would primarily serve **real-time operator awareness** while away from a desktop:

1. **Push alerts** — kill-switch trips, daily-loss breaker hits, emergency-close events, unprotected positions
2. **At-a-glance positions** — open trades, today's P&L, current protection state
3. **One-tap intervention** — halt trading, resume, close a specific position, flip a feature flag
4. **Signal ticker** — recent high-quality signals (the new `quality` field gives a sortable column)

Anything that requires deep analysis (backtests, threshold tuning, multi-pair charts) stays on the desktop dashboard. The mobile app is for *response*, not *analysis*.

## Framework recommendation

I recommend **Capacitor wrapping the existing React dashboard** with native push notifications, as the first version. Trade-off summary:

| Option | Pros | Cons | Effort to MVP |
|---|---|---|---|
| **Capacitor + existing React** | Reuses dashboard codebase 1:1. Single team, single language (TS). Native push & background tasks via plugins. Updates ship as web deploys for most screens. | Heavier app bundle than native. Some platform-specific UX feels "webby". No iOS bonus for free if you ever want it (but small lift). | **~3–5 days** |
| **React Native** | Native UX feel. Shared component library possible with web. iOS path basically free. | New build pipeline, RN-specific dependencies, separate code from web dashboard, native debugging skills needed. | **~10–14 days** |
| **Kotlin native** | Best performance + UX. Real Android idioms. Full control. | Entirely separate codebase. No web reuse. Slowest to ship. iOS would need Swift separately. | **~3–4 weeks** |
| **Flutter** | Single Dart codebase, good UX. | Yet another language/runtime. No reuse with web. | **~2–3 weeks** |

**Why Capacitor for v1:** the dashboard is already a complete React app with all the state management, API client, and screens you need. Wrapping it means the mobile "app" is a known-good codebase plus push notifications. If push is the killer feature (which I think it is for an operator-awareness app), the wrapper approach gets it shipped 5-10× faster than starting fresh.

**When to upgrade to native:** if the app proves valuable and you want true offline mode, deep gestures, or iOS, migrate screen-by-screen to React Native (sharing the API client and types). Don't over-invest until the product proves out.

## MVP scope (3 screens, 1 background service)

**Screen 1 — Dashboard.** Current account equity, today's realised P&L, count of open trades by protection state (protected/degraded/emergency_closed), kill-switch status. Top of screen has a giant red "HALT ALL TRADING" button (calls existing `/api/risk/halt`).

**Screen 2 — Open positions.** List of open trades across both engines (webhook bot + scalper). Each row shows: symbol, side, entry, current price, unrealised P&L, time held, protection_state badge, quality score. Tap a row → details + "Close now" button (already-supported via existing API).

**Screen 3 — Recent signals.** Last 20 signals across all engines, sorted by `quality` DESC. Each row shows: symbol, strategy, side, quality score, whether it was traded. Tap → full signal details. Useful for "is the bot seeing what I'd see?"

**Background — Push notifications.** Triggered server-side by:
- Kill switch engaged (any reason)
- Daily-loss breaker tripped
- Emergency-close event (`protection_state = emergency_closed`)
- Any trade closed with `closeReason = sl` and absolute loss > N% of equity
- Optional: every high-quality signal fired (configurable threshold)

## API contract sketch

These endpoints either exist already (Phase 1+2 added several `/api/risk/*` routes) or need adding. The mobile app should NOT introduce a new auth surface — reuse whatever the dashboard uses today (likely session cookie or bearer token from `botConfig.webhookSecret` for read-only).

```
GET  /api/mobile/dashboard          — equity, daily P&L, open count by protection_state
GET  /api/mobile/positions          — open trades from both tables (already partial via /api/scalper/trades and /api/bot/trades)
GET  /api/mobile/signals?since=ISO  — recent signals with quality, joined to whether-traded
POST /api/risk/halt                 — already exists (Phase 1)
POST /api/risk/resume               — already exists (Phase 1)
POST /api/positions/:id/close       — closes a specific open position at market
POST /api/mobile/register-device    — register FCM token for push
```

Auth: use an existing `webhookSecret`-style bearer token issued from the dashboard's settings page. Don't build a username/password system for one user.

Push: Firebase Cloud Messaging (FCM) is the standard for Android. Requires:
1. A Firebase project (~10 min one-time setup)
2. Server-side FCM admin SDK to send (1 npm dep, ~50 lines)
3. Device token registration endpoint
4. Hooks in the existing alert paths (kill-switch trip, emergency-close) that POST to FCM

## Product decisions you have to make first

I can't pick these for you:

1. **Auth model.** Single-operator (you) only, or multiple users with permissions later? If single, a static bearer token in the app is fine. If multi, need actual auth.
2. **Distribution.** Sideload-only (APK from a release page) vs Play Store. Play Store adds policy review and a developer-account fee but enables auto-updates and broader installs.
3. **Where push hooks live.** Add them to the existing notify.ts / alerts pipeline, or build a new mobile-specific notification service?
4. **iOS later?** If yes, that argues for React Native over Capacitor in the medium term.

## Effort estimate (Capacitor path)

| Phase | Work | Days |
|---|---|---|
| 1. Capacitor wrapper | Install, wrap existing dashboard, configure manifest, app icons | 1 |
| 2. Mobile-API endpoints | Add /api/mobile/* routes, response shapes optimised for small screens | 1 |
| 3. Push notifications | FCM setup, token registration, server-side trigger hooks in 4–5 alert paths | 1–2 |
| 4. Mobile-specific UI tweaks | Bigger touch targets, simplified positions screen, halt button | 1 |
| 5. Testing + Play Store submission (optional) | APK signing, store listing, screenshots, policy review | 1–3 |

**Total: 3–5 days of focused work for sideload-installable MVP. Add 1–3 days for Play Store distribution.**

## What I will NOT do without your direction

- Pick a framework
- Decide on Play Store vs sideload
- Build an auth system
- Wire push triggers into the existing alert paths
- Set up Firebase

## Next step

Read this, push back on the framework recommendation or MVP scope, then I'll write the actual `mobile/` package (or `artifacts/mobile/`) once decisions are made.
