// Phase 1 verification harness — runs the actual risk-guard against the verify DB
// with synthetic state and asserts each guard fires correctly.
import { db, riskConfigTable, scalperTradesTable, tradesTable } from "@workspace/db";
import { checkRiskGuard } from "../services/risk-guard";

let failures = 0;
function assert(cond: boolean, label: string, detail?: unknown) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`, detail ?? "");
    failures++;
  }
}

async function resetState() {
  await db.delete(scalperTradesTable);
  await db.delete(tradesTable);
  await db.update(riskConfigTable).set({
    killSwitch: false,
    killReason: null,
    globalMaxOpenTrades: 6,
    globalMaxNotionalUsdt: 1000,
    dailyLossLimitPct: 5,
    maxPositionPctOfEquity: 50,
  });
}

async function main() {
  // 1. Baseline green-light
  console.log("[1] Baseline: empty DB, neutral config");
  await resetState();
  let r = await checkRiskGuard({ positionSizeUsdt: 50, equityUsdt: 1000, source: "scalper" });
  assert(r.allowed === true, "allows a clean 50 USDT entry on 1000 USDT equity", r);

  // 2. Kill switch
  console.log("[2] Kill switch engaged");
  await db.update(riskConfigTable).set({ killSwitch: true });
  r = await checkRiskGuard({ positionSizeUsdt: 50, equityUsdt: 1000, source: "scalper" });
  assert(r.allowed === false && r.reasonCode === "kill_switch", "blocks all entries with reasonCode=kill_switch", r);

  // 3. Position-size sanity
  console.log("[3] Invalid position size");
  await resetState();
  r = await checkRiskGuard({ positionSizeUsdt: 0, equityUsdt: 1000, source: "scalper" });
  assert(r.allowed === false && r.reasonCode === "position_too_large", "rejects positionSize=0", r);
  r = await checkRiskGuard({ positionSizeUsdt: NaN, equityUsdt: 1000, source: "scalper" });
  assert(r.allowed === false && r.reasonCode === "position_too_large", "rejects positionSize=NaN", r);

  // 4. Position > maxPositionPctOfEquity (50%)
  console.log("[4] Position-size cap (50% of equity)");
  r = await checkRiskGuard({ positionSizeUsdt: 600, equityUsdt: 1000, source: "scalper" });
  assert(r.allowed === false && r.reasonCode === "position_too_large", "rejects 600 USDT (>50% of 1000)", r);

  // 5. Combined open-trade count cap (BUG-13 — across both tables)
  console.log("[5] Combined open-trade cap across both systems");
  await resetState();
  // 4 webhook + 3 scalper = 7, cap=6
  for (let i = 0; i < 4; i++) {
    await db.insert(tradesTable).values({
      signalId: null, symbol: `SYM${i}`, gateSymbol: `SYM${i}_USDT`, side: "buy",
      positionSizeUsdt: "10", entryPrice: "1", livePrice: "1", quantity: "10",
      status: "open", strategy: "test",
    } as any);
  }
  for (let i = 0; i < 3; i++) {
    await db.insert(scalperTradesTable).values({
      symbol: `S${i}`, gateSymbol: `S${i}_USDT`, side: "buy", strategy: "micro_2usd",
      positionSizeUsdt: "10", entryPrice: "1", livePrice: "1", quantity: "10",
      status: "open",
    } as any);
  }
  r = await checkRiskGuard({ positionSizeUsdt: 50, equityUsdt: 1000, source: "scalper" });
  assert(r.allowed === false && r.reasonCode === "max_open_trades", "rejects when combined open count = 7 ≥ cap 6", r);

  // 6. Combined notional cap
  console.log("[6] Combined notional cap");
  await resetState();
  // 500 webhook + 400 scalper = 900, new = 200 → 1100 > 1000
  await db.insert(tradesTable).values({
    signalId: null, symbol: "X", gateSymbol: "X_USDT", side: "buy",
    positionSizeUsdt: "500", entryPrice: "1", livePrice: "1", quantity: "500",
    status: "open", strategy: "test",
  } as any);
  await db.insert(scalperTradesTable).values({
    symbol: "Y", gateSymbol: "Y_USDT", side: "buy", strategy: "micro_2usd",
    positionSizeUsdt: "400", entryPrice: "1", livePrice: "1", quantity: "400",
    status: "open",
  } as any);
  r = await checkRiskGuard({ positionSizeUsdt: 200, equityUsdt: 5000, source: "scalper" });
  assert(r.allowed === false && r.reasonCode === "max_notional", "rejects when projected notional 1100 > cap 1000", r);

  // 7. Daily-loss circuit breaker auto-trips kill switch
  console.log("[7] Daily-loss circuit breaker");
  await resetState();
  // -60 USDT realised today on equity 1000 = 6% > 5% limit
  await db.insert(scalperTradesTable).values({
    symbol: "L", gateSymbol: "L_USDT", side: "buy", strategy: "micro_2usd",
    positionSizeUsdt: "100", entryPrice: "1", livePrice: "1", quantity: "100",
    status: "closed", pnl: "-60", closedAt: new Date(),
  } as any);
  r = await checkRiskGuard({ positionSizeUsdt: 50, equityUsdt: 1000, source: "scalper" });
  assert(r.allowed === false && r.reasonCode === "daily_loss_breached", "rejects with daily_loss_breached", r);
  const [cfgAfter] = await db.select().from(riskConfigTable).limit(1);
  assert(cfgAfter!.killSwitch === true && cfgAfter!.killReason === 1, "auto-trips kill switch (killReason=1)", cfgAfter);

  // 8. Daily loss below limit doesn't trip
  console.log("[8] Daily loss below limit — pass-through");
  await resetState();
  await db.insert(scalperTradesTable).values({
    symbol: "L2", gateSymbol: "L2_USDT", side: "buy", strategy: "micro_2usd",
    positionSizeUsdt: "100", entryPrice: "1", livePrice: "1", quantity: "100",
    status: "closed", pnl: "-30", closedAt: new Date(),
  } as any);
  r = await checkRiskGuard({ positionSizeUsdt: 50, equityUsdt: 1000, source: "scalper" });
  assert(r.allowed === true, "allows entries at 3% daily loss (limit 5%)", r);

  // 9. Stale loss from "yesterday" is ignored
  console.log("[9] Yesterday's loss does NOT count");
  await resetState();
  const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000); // 36h ago
  await db.insert(scalperTradesTable).values({
    symbol: "Y", gateSymbol: "Y_USDT", side: "buy", strategy: "micro_2usd",
    positionSizeUsdt: "100", entryPrice: "1", livePrice: "1", quantity: "100",
    status: "closed", pnl: "-500", closedAt: yesterday,
  } as any);
  r = await checkRiskGuard({ positionSizeUsdt: 50, equityUsdt: 1000, source: "scalper" });
  assert(r.allowed === true, "ignores 36h-old loss when computing daily window", r);

  console.log(`\n${failures === 0 ? "✓ ALL PASS" : `✗ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
