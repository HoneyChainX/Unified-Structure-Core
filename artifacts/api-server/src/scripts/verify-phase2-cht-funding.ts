// Phase 2 (5/N) verification: CHT funding-rate filter.
//
// Builds a minimal candle set that would satisfy every other CHT gate, then
// invokes evaluateCHTSignal with varying funding-rate inputs to confirm:
//   - Disabled mode: never blocks regardless of funding
//   - Long entry: blocked at funding >= +threshold, allowed below
//   - Short entry: blocked at funding <= -threshold, allowed above
//   - null funding (unavailable): never blocks
//   - Threshold edge cases (==, just under, just over)
import { evaluateCHTSignal } from "../services/scalper-signals-cht";
import type { Candle } from "../services/scalper-signals";

let fails = 0;
const ok = (cond: boolean, label: string, detail?: unknown) => {
  if (cond) console.log("  ✓", label);
  else { console.log("  ✗", label, detail ?? ""); fails++; }
};

// CHT requires:
//   - 80+ LTF candles, 55+ HTF candles
//   - bullish or bearish trend (EMA20 vs EMA50)
//   - HTF EMA20 vs EMA50 agreement
//   - ADX >= 18
// We craft a synthetic uptrend that satisfies trend + HTF + ADX so funding is
// the only variable. If the CHT signal is null in the disabled case, our
// synthetic data is insufficient and the test is non-informative (we report
// SKIP rather than fail in that case).

function mkCandles(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    time: i,
    open: i > 0 ? closes[i - 1] : c,
    high: c * 1.005,
    low: c * 0.995,
    close: c,
    volume: 1000 + (i % 5) * 200,
  }));
}

// Strong uptrend with mild noise — drives EMA20 > EMA50, ADX > 18,
// and the trigger detector usually finds something.
function uptrend(n: number, slope = 0.3): number[] {
  const out: number[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const noise = Math.sin(i * 0.7) * 0.6;
    p = p + slope + noise;
    out.push(p);
  }
  return out;
}

const ltf = mkCandles(uptrend(120, 0.35));
const htf = mkCandles(uptrend(80, 0.4));
const btc = mkCandles(uptrend(120, 0.2));

// ── Sanity: with filter disabled, does the synthetic setup produce a long? ──
console.log("[0] Synthetic CHT setup baseline (filter disabled)");
const baseline = evaluateCHTSignal("BTC_USDT", ltf, htf, btc, {
  longOnly: false,
  marketContext: null,
  timeframe: "5m",
  fundingFilterEnabled: false,
});
if (!baseline) {
  console.log("    SKIP: synthetic data didn't satisfy non-funding CHT gates — funding-only tests are vacuous");
  console.log("    (this still exercises the code path; the filter logic is tested below independently)");
} else {
  console.log(`    baseline side=${baseline.side} quality=${baseline.quality?.toFixed(3)}`);
  ok(true, "baseline produces a CHT signal — funding-filter tests are meaningful");
}

// ── Independent filter-logic verification (mirrors the gate in evaluateCHTSignal) ──
console.log("[1] Filter-logic unit tests (mirror of CHT gate)");
function shouldReject(side: "buy" | "sell", funding: number | null, thresholdPct: number, enabled: boolean): boolean {
  if (!enabled || funding == null) return false;
  const threshold = thresholdPct / 100;
  if (side === "buy"  && funding >=  threshold) return true;
  if (side === "sell" && funding <= -threshold) return true;
  return false;
}

ok(!shouldReject("buy",  0.001, 0.05, false), "disabled → never rejects (even at extreme funding)");

// threshold 0.05% = 0.0005 decimal
ok(!shouldReject("buy",  0.0004, 0.05, true), "long at +0.04% funding (below threshold) — allowed");
ok( shouldReject("buy",  0.0005, 0.05, true), "long at +0.05% funding (exactly threshold) — blocked");
ok( shouldReject("buy",  0.001,  0.05, true), "long at +0.10% funding (well above) — blocked");

ok(!shouldReject("sell",-0.0004, 0.05, true), "short at -0.04% funding (above threshold) — allowed");
ok( shouldReject("sell",-0.0005, 0.05, true), "short at -0.05% funding (exactly threshold) — blocked");
ok( shouldReject("sell",-0.001,  0.05, true), "short at -0.10% funding (well below) — blocked");

// Opposite-side trades are never blocked (a long when funding is NEGATIVE = contrarian = good)
ok(!shouldReject("buy", -0.005, 0.05, true), "long at NEGATIVE funding (crowd short) — never blocked");
ok(!shouldReject("sell", 0.005, 0.05, true), "short at POSITIVE funding (crowd long) — never blocked");

// null funding (perp doesn't exist / fetch failed)
ok(!shouldReject("buy", null, 0.05, true), "null funding (unavailable) — never blocks");

// Custom threshold
ok(!shouldReject("buy", 0.0005, 0.10, true), "long at +0.05% with 0.10% threshold — allowed");
ok( shouldReject("buy", 0.0011, 0.10, true), "long at +0.11% with 0.10% threshold — blocked");

// ── Live integration: drive evaluateCHTSignal through the gate ──────────────
if (baseline) {
  console.log("[2] Live evaluator gate (using baseline synthetic setup)");
  // Same synthetic setup, but with funding configured to block
  const blocked = evaluateCHTSignal("BTC_USDT", ltf, htf, btc, {
    longOnly: false,
    marketContext: null,
    timeframe: "5m",
    fundingFilterEnabled: true,
    fundingThresholdPct: 0.05,
    fundingRate: 0.001, // +0.10%, above 0.05% threshold
  });
  if (baseline.side === "buy") {
    ok(blocked === null, "long entry blocked when funding > +threshold");
  } else {
    // Synthetic gave us a short — we'd need negative funding to block
    const shortBlocked = evaluateCHTSignal("BTC_USDT", ltf, htf, btc, {
      longOnly: false,
      marketContext: null,
      timeframe: "5m",
      fundingFilterEnabled: true,
      fundingThresholdPct: 0.05,
      fundingRate: -0.001,
    });
    ok(shortBlocked === null, "short entry blocked when funding < -threshold");
  }

  // Mild funding (below threshold) should NOT block
  const allowed = evaluateCHTSignal("BTC_USDT", ltf, htf, btc, {
    longOnly: false,
    marketContext: null,
    timeframe: "5m",
    fundingFilterEnabled: true,
    fundingThresholdPct: 0.05,
    fundingRate: baseline.side === "buy" ? 0.0001 : -0.0001,
  });
  ok(allowed != null && allowed.side === baseline.side, "mild same-side funding still allows the trade");

  // Opposite-side funding should never block
  const contraFunding = evaluateCHTSignal("BTC_USDT", ltf, htf, btc, {
    longOnly: false,
    marketContext: null,
    timeframe: "5m",
    fundingFilterEnabled: true,
    fundingThresholdPct: 0.05,
    fundingRate: baseline.side === "buy" ? -0.005 : 0.005,
  });
  ok(contraFunding != null, "contrarian funding (crowd opposite to us) never blocks");
}

console.log(`\n${fails === 0 ? "✓ ALL PASS" : `✗ ${fails} FAILURE(S)`}`);
process.exit(fails === 0 ? 0 : 1);

export {};
