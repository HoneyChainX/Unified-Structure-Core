// Phase 2 (4/N) verification: quality-aware sizing math.
//
// Mirrors the formula in scalper-executor.ts and asserts that:
//   - scale = floor + (1 - floor) * quality across the full quality range
//   - floor is honoured even at quality=0
//   - max-quality always returns the unscaled size
//   - disabled mode is a no-op
//   - micro mode is opt-out by default
let fails = 0;
const ok = (cond: boolean, label: string, detail?: unknown) => {
  if (cond) console.log("  ✓", label);
  else { console.log("  ✗", label, detail ?? ""); fails++; }
};
const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;

// Reference impl — must match scalper-executor.ts
function sizeWithQuality(
  baseSize: number,
  quality: number | undefined,
  cfg: {
    qualityAwareSizing?: boolean;
    qualitySizeFloorPct?: number;
    qualityAwareSizingMicroMode?: boolean;
  },
  isMicro: boolean,
): number {
  const apply = cfg.qualityAwareSizing === true
    && (!isMicro || cfg.qualityAwareSizingMicroMode === true);
  if (!apply) return baseSize;
  const q = Math.min(1, Math.max(0, quality ?? 0));
  const floor = Math.min(1, Math.max(0, (cfg.qualitySizeFloorPct ?? 50) / 100));
  const scale = floor + (1 - floor) * q;
  return baseSize * scale;
}

// ── 1. Disabled by default ─────────────────────────────────────────────────
console.log("[1] Disabled by default (existing behaviour preserved)");
ok(sizeWithQuality(100, 0.5, {}, false) === 100, "no flags → no scaling");
ok(sizeWithQuality(100, 0.0, { qualityAwareSizing: false }, false) === 100, "explicitly disabled → no scaling");

// ── 2. Enabled, default floor 50% ──────────────────────────────────────────
console.log("[2] Enabled with default floor (50%)");
const enabled = { qualityAwareSizing: true, qualitySizeFloorPct: 50 };
ok(sizeWithQuality(100, 0.0, enabled, false) === 50,  "q=0   → 50% of base");
ok(near(sizeWithQuality(100, 0.5, enabled, false), 75),  "q=0.5 → 75% of base");
ok(sizeWithQuality(100, 1.0, enabled, false) === 100, "q=1   → 100% of base");

// ── 3. Custom floor ────────────────────────────────────────────────────────
console.log("[3] Custom floor (25%)");
const lowFloor = { qualityAwareSizing: true, qualitySizeFloorPct: 25 };
ok(sizeWithQuality(100, 0.0, lowFloor, false) === 25,  "q=0   → 25% (matches floor)");
ok(near(sizeWithQuality(100, 0.5, lowFloor, false), 62.5), "q=0.5 → 62.5%");
ok(sizeWithQuality(100, 1.0, lowFloor, false) === 100, "q=1   → 100% (always)");

const fullFloor = { qualityAwareSizing: true, qualitySizeFloorPct: 100 };
ok(sizeWithQuality(100, 0.0, fullFloor, false) === 100, "floor=100% → quality has no effect");

// ── 4. Asymmetry: quality never exceeds base ───────────────────────────────
console.log("[4] Asymmetry guarantee");
for (let q = 0; q <= 1.01; q += 0.1) {
  const sized = sizeWithQuality(100, q, enabled, false);
  if (!(sized >= 50 - 1e-9 && sized <= 100 + 1e-9)) {
    ok(false, `q=${q.toFixed(2)} produced ${sized.toFixed(2)} — outside [50, 100]`);
  }
}
ok(true, "all quality values produce sized ∈ [floor, base]");

// ── 5. Clamping ────────────────────────────────────────────────────────────
console.log("[5] Quality and floor clamping");
ok(sizeWithQuality(100, undefined, enabled, false) === 50, "undefined quality → floor (50%)");
ok(sizeWithQuality(100, -0.5, enabled, false) === 50, "negative quality clamps to 0");
ok(sizeWithQuality(100, 2.0, enabled, false) === 100, "quality > 1 clamps to 1");
ok(sizeWithQuality(100, 0.5, { qualityAwareSizing: true, qualitySizeFloorPct: 150 }, false) === 100, "floor > 100% clamps to 1");
ok(sizeWithQuality(100, 0.5, { qualityAwareSizing: true, qualitySizeFloorPct: -10 }, false) === 50, "floor < 0 clamps to 0 → 50% via 0.5*1");

// ── 6. Micro mode opt-out ──────────────────────────────────────────────────
console.log("[6] Micro mode is opt-out by default");
ok(sizeWithQuality(100, 0.0, enabled, true) === 100, "isMicro=true + opt-out=false → no scaling");
ok(sizeWithQuality(100, 0.0, { ...enabled, qualityAwareSizingMicroMode: true }, true) === 50, "isMicro=true + opt-in → scales");

console.log(`\n${fails === 0 ? "✓ ALL PASS" : `✗ ${fails} FAILURE(S)`}`);
process.exit(fails === 0 ? 0 : 1);

export {};
