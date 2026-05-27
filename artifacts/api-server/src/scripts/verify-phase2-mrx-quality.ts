// Phase 2 (3/N) verification: MRX quality scoring math.
//
// Mirrors the formula in scalper-signals-mrx.ts and asserts each axis
// produces the expected score for representative inputs. The intent is
// catch-the-bug, not duplicate the formula — the verifier defines a
// reference implementation and the production code must match.
let fails = 0;
const ok = (cond: boolean, label: string, detail?: unknown) => {
  if (cond) console.log("  ✓", label);
  else { console.log("  ✗", label, detail ?? ""); fails++; }
};
const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

// Reference quality formula — exactly mirrors evaluateMRXSignal's tail block.
function mrxQuality(p: {
  rsi: number;
  effectiveRsiCap: number;
  lastClose: number;
  bbLower: number;
  volumeRatio: number;
  htfEma20: number;
  htfEma50: number;
  pumpChange5m: number;
  inOB: boolean;
}): number {
  const rsiScore  = clamp01((p.effectiveRsiCap - p.rsi) / Math.max(1, p.effectiveRsiCap));
  const bbScore   = clamp01(((p.bbLower - p.lastClose) / Math.max(1e-12, p.bbLower)) * 100);
  const volScore  = clamp01((p.volumeRatio - 1.2) / 1.8);
  const htfScore  = p.htfEma20 > p.htfEma50 ? 1 : 0.5;
  const pumpScore = clamp01((p.pumpChange5m + 1.5) / 3);
  let q = 0.30 * rsiScore + 0.20 * bbScore + 0.20 * volScore +
          0.15 * htfScore + 0.15 * pumpScore;
  if (p.inOB) q += 0.10;
  return clamp01(q);
}

// ── Individual axis behaviour ──────────────────────────────────────────────
console.log("[1] Per-axis sanity (other axes pinned to mid-band)");
const base = {
  rsi: 25, effectiveRsiCap: 25,    // rsiScore = 0
  lastClose: 100, bbLower: 100,    // bbScore = 0
  volumeRatio: 1.2,                // volScore = 0
  htfEma20: 100, htfEma50: 100,    // htfScore = 0.5
  pumpChange5m: -1.5,              // pumpScore = 0
  inOB: false,
};
ok(near(mrxQuality(base), 0.5 * 0.15), "all axes at floor → quality = 0.075 (HTF tie gets 0.5)");

ok(near(mrxQuality({ ...base, rsi: 0 }), 0.30 + 0.5 * 0.15), "RSI=0 max → +0.30");
ok(near(mrxQuality({ ...base, lastClose: 99 }), 0.20 + 0.5 * 0.15), "1% below BB lower → bbScore=1 → +0.20");
ok(near(mrxQuality({ ...base, volumeRatio: 3.0 }), 0.20 + 0.5 * 0.15), "volR=3.0 → volScore=1 → +0.20");
ok(near(mrxQuality({ ...base, htfEma20: 101, htfEma50: 100 }), 0.15), "bullish HTF stack → htfScore=1 → +0.075 (vs 0.075 baseline)");
ok(near(mrxQuality({ ...base, pumpChange5m: 1.5 }), 0.15 + 0.5 * 0.15), "pump +1.5% → pumpScore=1 → +0.15");
ok(near(mrxQuality({ ...base, inOB: true }), 0.5 * 0.15 + 0.10), "OB confluence → +0.10 bonus");

// ── Clamping ───────────────────────────────────────────────────────────────
console.log("[2] Clamping");
const huge = mrxQuality({ ...base, rsi: 0, lastClose: 50, volumeRatio: 10, htfEma20: 200, htfEma50: 100, pumpChange5m: 100, inOB: true });
ok(huge === 1, `extreme inputs clamp to 1.0 (got ${huge})`);

const negRsi = mrxQuality({ ...base, rsi: 100 }); // rsi > cap → score 0
ok(negRsi === 0.5 * 0.15, `RSI above cap clamps to 0 (got ${negRsi.toFixed(4)})`);

// ── End-to-end "elite" setup ───────────────────────────────────────────────
console.log("[3] Elite-shaped setup produces high quality");
const elite = mrxQuality({
  rsi: 15, effectiveRsiCap: 28,  // RSI deep below the OB-relaxed cap
  lastClose: 99.5, bbLower: 100,  // 0.5% below BB lower
  volumeRatio: 2.5,               // volScore = (2.5-1.2)/1.8 ≈ 0.722
  htfEma20: 102, htfEma50: 100,   // bullish HTF
  pumpChange5m: 0.5,              // quiet base
  inOB: true,                     // +0.10
});
console.log(`    elite quality = ${elite.toFixed(3)}`);
ok(elite > 0.7, "elite-shaped setup scores > 0.7");

// ── Marginal setup should land mid-range ──────────────────────────────────
console.log("[4] Marginal setup lands mid-range");
const marginal = mrxQuality({
  rsi: 24, effectiveRsiCap: 25,   // barely under cap
  lastClose: 100, bbLower: 100,    // exactly at lower
  volumeRatio: 1.3,                // just above hard floor
  htfEma20: 100, htfEma50: 100,    // neutral HTF
  pumpChange5m: -1.4,              // near pump floor
  inOB: false,
});
console.log(`    marginal quality = ${marginal.toFixed(3)}`);
ok(marginal < 0.25, "marginal setup scores < 0.25 (just-passing gates ≠ high quality)");
ok(marginal > 0, "marginal setup scores > 0 (not zero — it did pass)");

console.log(`\n${fails === 0 ? "✓ ALL PASS" : `✗ ${fails} FAILURE(S)`}`);
process.exit(fails === 0 ? 0 : 1);
