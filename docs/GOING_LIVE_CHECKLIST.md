# Going-Live Checklist

Copy this into your issue tracker / notes app and tick through it before
flipping `paper_mode` off in `scalper_config`. Order matters — each section
gates the next.

Default state of the system is safe: `scalper_config.paper_mode = true` and
every Phase 2 flag (`adaptive_thresholds`, `quality_aware_sizing`,
`kelly_sizing_enabled`, `cht_funding_filter_enabled`,
`mrx_funding_filter_enabled`) is `false`. Going live is a deliberate sequence
of flag flips, not a single switch.

## 1. Before flipping anything on

- [ ] Server is up, healthy, and reachable from the operator's phone (not just
      LAN). `GET /healthz` returns 200 over the production URL.
- [ ] Kill switch reachable end-to-end:
      `curl -X POST https://<host>/api/risk/kill -d '{"reason":1}' -H "Content-Type: application/json"`
      returns `ok: true` and `GET /api/risk` shows `killSwitch: true`.
      Then `POST /api/risk/resume` clears it.
- [ ] `risk_config` configured to your account size, not defaults. Specifically:
  - [ ] `global_max_open_trades` set (default 6 — drop to 1 or 2 for the first week).
  - [ ] `global_max_notional_usdt` set conservatively (default 1000).
  - [ ] `daily_loss_limit_pct` set (default 5 — keep or tighten).
  - [ ] `max_position_pct_of_equity` set (default 50 — drop substantially for first week).
- [ ] `scalper_config` reviewed:
  - [ ] `position_size_usdt` is the **paper** test size you want; you'll cut it further before going live.
  - [ ] `symbol_allowlist` populated with the symbols you actually want traded (leaving it null scans top-N by volume, which is fine for paper but not for first live trades).
  - [ ] `max_open_trades` set conservatively.
- [ ] Mobile alerts wired (only if you're relying on them):
  - [ ] `MOBILE_API_TOKEN` set on server.
  - [ ] Android app connected and visible in `GET /api/mobile/devices`.
  - [ ] FCM credentials present (`FCM_SERVICE_ACCOUNT_JSON` or `_PATH`).
  - [ ] Push test: engage and disengage the kill switch — a notification arrives on the device.
- [ ] Backups taken **of the current config rows** so a bad edit can be reverted:
      `pg_dump -t risk_config -t scalper_config -t mobile_devices --data-only $DATABASE_URL > config-backup-$(date +%F).sql`
- [ ] Full DB backup taken (your provider's snapshot is fine).
- [ ] You can see api-server logs in real time (`journalctl -fu …` or
      equivalent) — you'll need this for the first live trade.

## 2. Paper mode validation

Run with `scalper_config.paper_mode = true` and `enabled = true`. Phase 2
flags stay off. Watch the dashboard.

- [ ] Minimum **7 calendar days** of continuous paper-mode operation with no
      restarts caused by crashes.
- [ ] At least **30 closed paper trades per strategy** you intend to enable
      (`bb_rsi` and/or `smc_mss`). Fewer than that and Kelly later won't have
      a stable history.
- [ ] Dashboard `Symbol Stats` (`GET /api/scalper/symbol-stats`) shows
      per-symbol win rate, avg R, and trade count that look believable — no
      symbol with 100% win rate over 3 trades that you'd then over-size.
- [ ] Dashboard `Signals` quality histogram (`GET /api/signals/quality-stats`)
      shows a realistic distribution — not all 0.0 (signals never qualify)
      and not all 1.0 (every signal is a TRIGGER, which usually means the
      gating is too loose).
- [ ] No `protection_state = emergency_closed` rows in `scalper_trades` over
      the validation window (`degraded` is acceptable during paper mode but
      investigate the cause).
- [ ] Daily P&L per the dashboard equity curve has the shape you expected
      for the regime you ran — not "flat then one huge spike."

## 3. Flipping Phase 2 features safely

Each flag is one PUT to `/api/scalper/config`. Flip **one at a time**, in
this order, and watch each for the indicated dwell time before moving on.
Stay in paper mode for at least the first two flips.

- [ ] **Adaptive RSI thresholds** — `adaptive_thresholds: true`. Safest first
      step: only changes which signals fire (not size). Watch 24–48h. Confirm
      the signal rate didn't collapse to zero or explode.
- [ ] **Quality-aware sizing** — `quality_aware_sizing: true`. Asymmetric and
      defensive: it can only reduce position size below the configured base,
      never above. Watch 24–48h. Confirm sizes on weak signals are scaled
      down per `quality_size_floor_pct`.
- [ ] **Kelly sizing** — `kelly_sizing_enabled: true`. Requires per-symbol
      trade history of at least `kelly_min_trades` (default 10) — confirm
      Step 2 closed enough trades per symbol before enabling. Watch 24–48h
      with `kelly_safety_fraction = 0.5` (half-Kelly) and the default floor
      / cap.
- [ ] **Funding filters** — `cht_funding_filter_enabled: true` and/or
      `mrx_funding_filter_enabled: true`. These hit the Gate.io perp funding
      endpoint; if you've seen flakiness from that endpoint in the logs,
      defer this flip and run without funding filters. Watch 24h.

After all four are stable in paper, you're ready for Step 4.

## 4. First live trade

- [ ] `scalper_config.position_size_usdt` set to **the smallest size you can
      stomach losing entirely** (target ≤ $10 — Gate.io's spot minimum
      notional is the real floor).
- [ ] `scalper_config.symbol_allowlist` reduced to a **single** liquid pair
      you understand (BTC_USDT or ETH_USDT is the boring-correct answer).
- [ ] `scalper_config.max_open_trades = 1`.
- [ ] `risk_config.global_max_open_trades = 1`.
- [ ] `risk_config.global_max_notional_usdt` set to ~3× `position_size_usdt`.
- [ ] Set `scalper_config.paper_mode = false`. Save.
- [ ] Tail the api-server logs. Wait for the next signal that triggers.
      Confirm in the logs the **full lifecycle**:
      `entry placed` → `entry filled` → `SL placed` → `TP placed` →
      `TP filled` (or `SL filled`) → `trade closed`.
- [ ] In the database, the closed `scalper_trades` row shows
      `protection_state = protected` — not `degraded`, not `emergency_closed`.
- [ ] Realised P&L on the dashboard matches your manual calculation (entry,
      exit, qty, minus 2× `GATEIO_TAKER_FEE_RATE` × notional).
- [ ] Gate.io account balance moved by the expected amount.

If any of the above is wrong, flip `paper_mode` back to `true` and
investigate before the next live cycle.

## 5. Scaling up

Only after **20+ successful live round-trips** at the small size:

- [ ] Raise `position_size_usdt` (or set `position_size_pct` to size off live
      balance), one step at a time. Don't double — go +50% at most.
- [ ] Expand `symbol_allowlist` one symbol at a time. Watch the new symbol's
      first few trades closely.
- [ ] Raise `max_open_trades` and `global_max_open_trades` in lockstep.
- [ ] If Kelly is enabled: in `GET /api/scalper/symbol-stats`, watch the
      effective Kelly fraction per symbol. Symbols whose closed-trade
      history goes negative will be floored at `kelly_floor_pct` (default
      10%) — that's working as designed, but you should manually remove
      them from the allowlist or accept the small forced size.

## 6. Always-on monitoring

After live, watch these every day for the first month, then weekly:

- [ ] Daily P&L per dashboard equity curve.
- [ ] Count of `scalper_trades` with `protection_state = emergency_closed` —
      target zero. Any non-zero gets investigated same day.
- [ ] `GET /api/risk` — `killSwitch` should be `false` unless you tripped it.
      `kill_reason` tells you why if it engaged automatically (daily-loss
      limit, etc.).
- [ ] Mobile alert delivery — if a kill-switch fired and no push arrived,
      FCM is broken. Fix before anything else.
- [ ] Gate.io API rate-limit headroom — watch for `429` responses in the
      api-server logs. If you see them, drop `scan_pool_size` first, then
      lengthen the scalper loop interval.
- [ ] Server uptime and `DATABASE_URL` connection pool health (Postgres
      provider dashboard).
