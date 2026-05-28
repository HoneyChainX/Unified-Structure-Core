// Verifier: /api/scalper/symbol-stats per-symbol Kelly diagnostics math.
// Seeds synthetic closed trades, mirrors the bucketing logic, asserts output.
import { db, scalperTradesTable } from "@workspace/db";
import { desc, eq, inArray } from "drizzle-orm";

let fails = 0;
const ok = (cond: boolean, label: string, detail?: unknown) => {
  if (cond) console.log("  ✓", label);
  else { console.log("  ✗", label, detail ?? ""); fails++; }
};
const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps;

// Reference implementation — must match the production route handler.
function computeStats(closed: { gateSymbol: string; symbol: string; pnl: number; strategy: string | null; closedAt: Date }[], lookback: number, minTrades: number) {
  const bySymbol = new Map<string, typeof closed>();
  for (const t of closed) {
    const arr = bySymbol.get(t.gateSymbol) ?? [];
    if (arr.length < lookback) {
      arr.push(t);
      bySymbol.set(t.gateSymbol, arr);
    }
  }
  return [...bySymbol.entries()].map(([gateSymbol, trades]) => {
    const pnls = trades.map((t) => t.pnl);
    const wins = pnls.filter((p) => p > 0);
    const losses = pnls.filter((p) => p < 0).map(Math.abs);
    const winRate = trades.length > 0 ? wins.length / trades.length : null;
    const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : null;
    const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : null;
    const netPnl = pnls.reduce((a, b) => a + b, 0);
    const payoffRatio = avgWin != null && avgLoss != null && avgLoss > 0 ? avgWin / avgLoss : null;
    const kellyFraction = winRate != null && payoffRatio != null
      ? winRate - (1 - winRate) / payoffRatio : null;
    return {
      gateSymbol, symbol: trades[0]?.symbol ?? gateSymbol,
      trades: trades.length, wins: wins.length, losses: losses.length,
      winRate, avgWin, avgLoss, netPnl, payoffRatio, kellyFraction,
      reliable: trades.length >= minTrades,
    };
  });
}

async function main() {
  // ── Synthetic data ────────────────────────────────────────────────────────
  console.log("[1] Seed + compute per-symbol stats");
  await db.delete(scalperTradesTable);
  const baseDate = new Date("2026-01-01T00:00:00Z");

  // BTC: 8 wins of $5, 4 losses of $2 → p=0.667, R=2.5, f*=0.667 - 0.333/2.5 = 0.534
  // ETH: 3 wins of $1, 7 losses of $3 → p=0.3, R=0.333, f*=0.3 - 0.7/0.333 = -1.8 (negative edge)
  // SOL: 2 wins (not enough) → reliable=false
  const trades: { gateSymbol: string; symbol: string; pnl: string; strategy: string; status: string; closedAt: Date; side: string; quantity: number; positionSizeUsdt: number }[] = [];
  // BTC
  for (let i = 0; i < 8; i++) trades.push({ gateSymbol: "BTC_USDT", symbol: "BTC", pnl: "5", strategy: "cht", status: "closed", closedAt: new Date(baseDate.getTime() + i * 1000), side: "buy", quantity: 0.01, positionSizeUsdt: 100 });
  for (let i = 0; i < 4; i++) trades.push({ gateSymbol: "BTC_USDT", symbol: "BTC", pnl: "-2", strategy: "cht", status: "closed", closedAt: new Date(baseDate.getTime() + (8 + i) * 1000), side: "buy", quantity: 0.01, positionSizeUsdt: 100 });
  // ETH
  for (let i = 0; i < 3; i++) trades.push({ gateSymbol: "ETH_USDT", symbol: "ETH", pnl: "1", strategy: "bb_rsi", status: "closed", closedAt: new Date(baseDate.getTime() + i * 1000), side: "buy", quantity: 0.1, positionSizeUsdt: 100 });
  for (let i = 0; i < 7; i++) trades.push({ gateSymbol: "ETH_USDT", symbol: "ETH", pnl: "-3", strategy: "bb_rsi", status: "closed", closedAt: new Date(baseDate.getTime() + (3 + i) * 1000), side: "buy", quantity: 0.1, positionSizeUsdt: 100 });
  // SOL — only 2 trades
  trades.push({ gateSymbol: "SOL_USDT", symbol: "SOL", pnl: "10", strategy: "mrx-hybrid", status: "closed", closedAt: baseDate, side: "buy", quantity: 1, positionSizeUsdt: 100 });
  trades.push({ gateSymbol: "SOL_USDT", symbol: "SOL", pnl: "-5", strategy: "mrx-hybrid", status: "closed", closedAt: new Date(baseDate.getTime() + 1000), side: "buy", quantity: 1, positionSizeUsdt: 100 });

  await db.insert(scalperTradesTable).values(trades as never);

  // Query in the same order the production code would (DESC by closedAt)
  const rows = await db
    .select({
      gateSymbol: scalperTradesTable.gateSymbol,
      symbol: scalperTradesTable.symbol,
      pnl: scalperTradesTable.pnl,
      strategy: scalperTradesTable.strategy,
      closedAt: scalperTradesTable.closedAt,
    })
    .from(scalperTradesTable)
    .where(inArray(scalperTradesTable.status, ["closed"]))
    .orderBy(desc(scalperTradesTable.closedAt));

  const normalised = rows
    .filter((r) => r.pnl != null && r.closedAt != null)
    .map((r) => ({ ...r, pnl: parseFloat(r.pnl!), closedAt: r.closedAt! }));

  const stats = computeStats(normalised, 30, 5);
  const btc = stats.find((s) => s.gateSymbol === "BTC_USDT")!;
  const eth = stats.find((s) => s.gateSymbol === "ETH_USDT")!;
  const sol = stats.find((s) => s.gateSymbol === "SOL_USDT")!;

  // BTC: positive edge
  ok(btc.trades === 12, `BTC trade count = 12 (got ${btc.trades})`);
  ok(near(btc.winRate!, 2 / 3, 1e-3), `BTC win rate ≈ 0.667 (got ${btc.winRate?.toFixed(3)})`);
  ok(btc.avgWin === 5, "BTC avg win = 5");
  ok(btc.avgLoss === 2, "BTC avg loss = 2");
  ok(btc.payoffRatio === 2.5, "BTC R = 2.5");
  ok(near(btc.kellyFraction!, 0.5333, 1e-3), `BTC f* ≈ 0.533 (got ${btc.kellyFraction?.toFixed(3)})`);
  ok(btc.netPnl === 8 * 5 - 4 * 2, `BTC net = $${btc.netPnl} (expected 32)`);
  ok(btc.reliable === true, "BTC reliable (≥5 trades)");

  // ETH: negative edge
  ok(eth.trades === 10, `ETH trade count = 10 (got ${eth.trades})`);
  ok(near(eth.winRate!, 0.3), "ETH win rate = 0.3");
  ok(eth.avgWin === 1, "ETH avg win = 1");
  ok(eth.avgLoss === 3, "ETH avg loss = 3");
  ok(near(eth.payoffRatio!, 1 / 3), "ETH R = 1/3");
  ok((eth.kellyFraction ?? 0) < 0, `ETH f* < 0 (got ${eth.kellyFraction?.toFixed(3)})`);
  ok(eth.netPnl === 3 * 1 - 7 * 3, `ETH net = $${eth.netPnl} (expected -18)`);

  // SOL: unreliable
  ok(sol.trades === 2, "SOL trade count = 2");
  ok(sol.reliable === false, "SOL marked unreliable (<5 trades)");

  // ── Sort order ────────────────────────────────────────────────────────────
  const sorted = [...stats].sort((a, b) => {
    const ka = a.kellyFraction ?? -Infinity;
    const kb = b.kellyFraction ?? -Infinity;
    if (ka !== kb) return kb - ka;
    return b.trades - a.trades;
  });
  ok(sorted[0].gateSymbol === "BTC_USDT", "sort: BTC first (highest f*)");
  ok(sorted[sorted.length - 1].gateSymbol === "ETH_USDT", "sort: ETH last (negative f*)");

  // ── Lookback truncation ───────────────────────────────────────────────────
  console.log("[2] Lookback truncates to N most-recent");
  const stats5 = computeStats(normalised, 5, 5);
  const btc5 = stats5.find((s) => s.gateSymbol === "BTC_USDT")!;
  ok(btc5.trades === 5, `lookback=5 → BTC limited to 5 trades (got ${btc5.trades})`);

  await db.delete(scalperTradesTable);

  console.log(`\n${fails === 0 ? "✓ ALL PASS" : `✗ ${fails} FAILURE(S)`}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
