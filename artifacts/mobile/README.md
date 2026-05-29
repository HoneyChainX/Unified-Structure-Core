# USC Bot — Android companion app

Capacitor-wrapped mobile companion for the trading bot. Mobile-tuned 3-screen UI (dashboard / positions / signals) plus FCM push notifications when configured.

## Prerequisites (your machine, not this repo)

- Node 22 + pnpm (already in your dev environment)
- **Android Studio** with Android SDK 34 — needed for the actual APK build
- A **Firebase project** with an Android app configured. Download `google-services.json` from the Firebase console; you'll put it in `android/app/` after `cap add android`.
- A `MOBILE_API_TOKEN` set in your server environment (any random opaque string — you'll paste it into the app on first launch)

## Server-side setup (one-time)

Before the app can do anything, the server needs:

1. **`MOBILE_API_TOKEN`** env var set to a random secret. Without it, every `/api/mobile/*` request returns 503.
2. **Migration 009** applied (creates `mobile_devices` table).
3. *(For push)* either `FCM_SERVICE_ACCOUNT_JSON` or `FCM_SERVICE_ACCOUNT_PATH` env var pointing at your Firebase service-account credentials. Without these, the server runs unchanged but never sends notifications.

The mobile backend itself was added in the PR that introduced this app. See `artifacts/api-server/src/routes/mobile.ts`.

## Build & run

```bash
# From the repo root
cd artifacts/mobile

# First time only — generate the android/ project (writes android/ in this dir)
pnpm install
pnpm run android:add

# Place your Firebase google-services.json here:
#   android/app/google-services.json
# (See Firebase console → Project settings → Your apps → Android → Config file)

# Build the web bundle and sync into the Android project
pnpm run android:sync

# Open in Android Studio. Run on a connected device or emulator.
pnpm run android:open
```

## Web preview (no Android needed)

```bash
cd artifacts/mobile
pnpm run dev
```

Opens at <http://localhost:5174>. Push notifications won't work (Capacitor PushNotifications is a no-op on web) but the UI / API integration is fully exercisable.

## First-launch flow

1. App opens to a connect screen
2. Enter your server URL (e.g. `https://bot.example.com`) and the `MOBILE_API_TOKEN`
3. App makes a test request to `/api/mobile/dashboard`. If it returns 200, credentials are saved and the dashboard loads.
4. On Android, the app silently registers an FCM device token with the server. From then on, kill-switch / emergency-close / daily-loss alerts are pushed to the device.

## Screens

- **Dashboard** — equity, today's realised P&L, open trades grouped by `protection_state`. Big red "HALT ALL TRADING" button calls `/api/risk/halt`.
- **Positions** — open positions across both engines, with quality score where available. Tap-target sized rows.
- **Signals** — last 24h of signals, sorted by quality DESC. Quality bar + grade badge.
- **Settings** — server URL + bearer token. "Forget connection" wipes both.

## Per-device notification preferences

After first registration, the device appears in `GET /api/mobile/devices` on the server. You can `PUT /api/mobile/devices/:id` to flip:

- `enabled` — master mute
- `notify_kill_switch` / `notify_emergency_close` / `notify_daily_loss` / `notify_high_quality_signal`
- `signal_quality_threshold` — only signals at or above this 0..1 score push (default 0.8)

A future dashboard PR can surface these toggles in a web UI.

## Distribution

Out of scope for this PR — we build a debug APK locally via Android Studio. To distribute via the Play Store, you'll need a developer account and to sign a release build (`./gradlew :app:bundleRelease` from `android/`).

## Troubleshooting

- **"Cannot reach server" on connect** — confirm `MOBILE_API_TOKEN` is set on the server. Check from a desktop browser:
  ```
  curl -H "Authorization: Bearer YOUR_TOKEN" https://your-server/api/mobile/dashboard
  ```
- **Push notifications never arrive** — the server-side FCM credentials are likely missing or invalid. Check the server logs for `FCM: init failed`. On the device, check the registered token exists by hitting `/api/mobile/devices` from desktop.
- **App can't find `@capacitor/android`** — run `pnpm install` from `artifacts/mobile/` (the root install doesn't reach into mobile because Capacitor needs its own node_modules layout).
