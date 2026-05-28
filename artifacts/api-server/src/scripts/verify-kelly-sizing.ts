// Verifier: fractional-Kelly sizing math + edge cases.
import { computeKellyMultiplier } from "../services/kelly-sizing";

let fails = 0;
const ok = (cond: boolean, label: string, detail?: unknown) => {
  if (cond) console.log("  ✓", label);
  else { console.log("  ✗", label, detail ?? ""); fails++; }
};
const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;

const defaults = {
  enabled: true,
  lookbackTrades: 30,
  minTrades: 10,
  safetyFraction: 0.5,
  floorPct: 10,
  maxPct: 100,
};

console.log("[1] Disabled");
{
  const r = computeKellyMultiplier([1, -1, 2, -1, 3], { ...defaults, enabled: false });
  ok(r.multiplier === 1.0, "disabled → multiplier 1.0");
  ok(r.reason === "disabled", "reason=disabled");
}

console.log("[2] Insufficient samples");
{
  const r = computeKellyMultiplier([1, -1, 2, -1, 3], defaults);
  ok(r.multiplier === 1.0, "5 samples < minTrades=10 → multiplier 1.0");
  ok(r.reason === "no_samples", "reason=no_samples");
}

console.log("[3] Positive edge — classic case");
{
  // 12 trades: 8 wins of avg $3, 4 losses of avg $2. p=0.667, R=1.5
  // f_kelly = 0.667 − 0.333/1.5 = 0.667 − 0.222 = 0.444
  // scale = 0.444 × 0.5 = 0.222 (clamped to [0.10, 1.0])
  const pnls = [...Array(8).fill(3), ...Array(4).fill(-2)];
  const r = computeKellyMultiplier(pnls, defaults);
  ok(r.reason === "ok", `reason=${r.reason}`);
  ok(near(r.winRate!, 2 / 3, 1e-3), `winRate ≈ 2/3 (got ${r.winRate})`);
  ok(near(r.avgWin!, 3), "avgWin = 3");
  ok(near(r.avgLoss!, 2), "avgLoss = 2");
  ok(near(r.kellyFraction!, 0.4444, 1e-3), `f_kelly ≈ 0.444 (got ${r.kellyFraction})`);
  ok(near(r.multiplier, 0.2222, 1e-3), `multiplier ≈ 0.222 (got ${r.multiplier})`);
}

console.log("[4] Negative edge — floor protects from zero-trade lockout");
{
  // 10 trades: 3 wins of $1, 7 losses of $2. p=0.3, R=0.5
  // f_kelly = 0.3 − 0.7/0.5 = 0.3 − 1.4 = -1.1 → clamps to floor (0.10)
  const pnls = [...Array(3).fill(1), ...Array(7).fill(-2)];
  const r = computeKellyMultiplier(pnls, defaults);
  ok(r.reason === "negative_edge", `reason=${r.reason}`);
  ok(near(r.multiplier, 0.10), `multiplier = floor 0.10 (got ${r.multiplier})`);
  ok((r.kellyFraction ?? 0) < 0, "kellyFraction < 0");
}

console.log("[5] All wins (lucky streak) — capped at maxPct");
{
  const r = computeKellyMultiplier(Array(15).fill(2), defaults);
  ok(r.reason === "all_wins", "reason=all_wins");
  ok(r.multiplier === 1.0, "multiplier = max 1.0 when no losses sampled");
}

console.log("[6] Safety fraction halves the bet");
{
  // Same edge as case 3, but safety=0.25 → multiplier should halve again
  const pnls = [...Array(8).fill(3), ...Array(4).fill(-2)];
  const r = computeKellyMultiplier(pnls, { ...defaults, safetyFraction: 0.25 });
  ok(near(r.multiplier, 0.1111, 1e-3), `safety 0.25 → ~0.111 (got ${r.multiplier})`);
}

console.log("[7] Max cap kicks in");
{
  // Strong edge with safety=1, capped at maxPct=50
  // 18 wins of $5, 2 losses of $1. p=0.9, R=5. f=0.9 − 0.1/5 = 0.88. scale=0.88 → cap 0.5
  const pnls = [...Array(18).fill(5), ...Array(2).fill(-1)];
  const r = computeKellyMultiplier(pnls, { ...defaults, safetyFraction: 1, maxPct: 50 });
  ok(near(r.multiplier, 0.5), `maxPct=50 caps multiplier at 0.5 (got ${r.multiplier})`);
}

console.log("[8] Floor cap when result below floor");
{
  // Tiny positive edge — scale below floor of 0.30
  // 11 wins of $1, 9 losses of $1. p=0.55, R=1. f=0.55 − 0.45/1 = 0.10
  // scale = 0.10 * 0.5 = 0.05 → clamps up to floor 0.30
  const pnls = [...Array(11).fill(1), ...Array(9).fill(-1)];
  const r = computeKellyMultiplier(pnls, { ...defaults, floorPct: 30 });
  ok(near(r.multiplier, 0.30), `floor 0.30 raises sub-floor multiplier (got ${r.multiplier})`);
}

console.log("[9] Input clamping");
{
  // safetyFraction = 2 (out of range) should clamp to 1
  const pnls = [...Array(11).fill(1), ...Array(9).fill(-1)];
  const r1 = computeKellyMultiplier(pnls, { ...defaults, safetyFraction: 2 });
  const r2 = computeKellyMultiplier(pnls, { ...defaults, safetyFraction: 1 });
  ok(near(r1.multiplier, r2.multiplier), "safetyFraction>1 clamps to 1");

  // floorPct = -50 → clamps to 0
  const r3 = computeKellyMultiplier(pnls, { ...defaults, floorPct: -50 });
  ok(r3.multiplier >= 0, `floorPct<0 doesn't break (got ${r3.multiplier})`);
}

console.log(`\n${fails === 0 ? "✓ ALL PASS" : `✗ ${fails} FAILURE(S)`}`);
process.exit(fails === 0 ? 0 : 1);

export {};
