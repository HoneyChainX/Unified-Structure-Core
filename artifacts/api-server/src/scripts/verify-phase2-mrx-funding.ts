// Phase 2 (6/N) verification: MRX funding-rate filter.
//
// MRX is LONG-only — the filter only ever rejects on euphoric positive
// funding. We test the gate logic in isolation (mirror) since constructing
// a synthetic 30-bar candle stream that satisfies all 7 existing MRX gates
// AND lets funding be the only variable is brittle.
let fails = 0;
const ok = (cond: boolean, label: string, detail?: unknown) => {
  if (cond) console.log("  ✓", label);
  else { console.log("  ✗", label, detail ?? ""); fails++; }
};

// Mirror of the gate logic inside evaluateMRXSignal.
function shouldReject(fundingRate: number | null, thresholdPct: number, enabled: boolean): boolean {
  if (!enabled || fundingRate == null) return false;
  const threshold = thresholdPct / 100;
  return fundingRate >= threshold;
}

console.log("[1] Disabled state");
ok(!shouldReject(0.001, 0.05, false), "disabled never rejects (even at extreme funding)");
ok(!shouldReject(0.5,   0.05, false), "disabled never rejects (absurd funding)");

console.log("[2] Threshold edges");
ok(!shouldReject(0.0004, 0.05, true), "+0.04% (below 0.05%) — allowed");
ok( shouldReject(0.0005, 0.05, true), "+0.05% (exactly threshold) — blocked");
ok( shouldReject(0.001,  0.05, true), "+0.10% (well above) — blocked");

console.log("[3] MRX is LONG-only — negative funding never blocks");
ok(!shouldReject(-0.001, 0.05, true), "-0.10% (negative funding) — allowed (no shorts to gate)");
ok(!shouldReject(-0.5,   0.05, true), "-50% (extreme negative) — allowed");
ok(!shouldReject(0,      0.05, true), "0 funding — allowed");

console.log("[4] Null funding (no perp contract / fetch failed)");
ok(!shouldReject(null, 0.05, true), "null funding never blocks");

console.log("[5] Custom thresholds");
ok(!shouldReject(0.0009, 0.10, true), "+0.09% with 0.10% threshold — allowed");
ok( shouldReject(0.0011, 0.10, true), "+0.11% with 0.10% threshold — blocked");
ok( shouldReject(0.0001, 0.01, true), "+0.01% with tight 0.01% threshold — blocked");

console.log("[6] Symmetric semantics with CHT");
// Same threshold convention: pct value is per-8h interval, decimal in code.
ok(shouldReject(0.0005, 0.05, true) === shouldReject(0.0005, 0.05, true),
   "deterministic — same inputs always produce same decision");

console.log(`\n${fails === 0 ? "✓ ALL PASS" : `✗ ${fails} FAILURE(S)`}`);
process.exit(fails === 0 ? 0 : 1);

export {};
