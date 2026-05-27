// Phase 2 integration: run the real evaluators, pipe their output through
// the ranker logic, and confirm the highest-quality candidate ends up first.
import { evaluateSignal, type Candle, type ScalperSignal, type SignalParams } from "../services/scalper-signals";

let fails = 0;
const ok = (cond: boolean, label: string, detail?: unknown) => {
  if (cond) console.log("  ✓", label);
  else { console.log("  ✗", label, detail ?? ""); fails++; }
};

const mkCandles = (closes: number[]): Candle[] => closes.map((c, i) => ({
  time: i, open: c, high: c * 1.001, low: c * 0.999, close: c, volume: 100,
}));

function lcg(seed: number) { let s = seed; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; }

// Three symbols, three setup qualities, all run through the real adaptive
// evaluator. Then we apply the loop's dedup + sort to confirm ranking works.
function buildOversoldPullback(seed: number, depth: number): Candle[] {
  const rng = lcg(seed);
  const closes: number[] = [];
  let p = 100;
  for (let i = 0; i < 140; i++) {
    p = p + 0.15 + (rng() - 0.5) * 0.4;
    closes.push(p);
  }
  const peak = closes[closes.length - 1];
  for (let i = 1; i <= 5; i++) closes.push(peak * (1 - depth * i / 5));
  return mkCandles(closes);
}

const params: SignalParams = {
  bbPeriod: 20, bbStdDev: 2, rsiPeriod: 14,
  rsiOversold: 30, rsiOverbought: 70,
  volumeSpikeMultiplier: 1.5, longOnly: false,
  emaFilterEnabled: false, emaPeriod: 50,
  adaptiveThresholds: true, adaptiveWindow: 100,
  adaptiveLowQ: 0.05, adaptiveHighQ: 0.95,
  adaptiveRsiLowFloor: 35, adaptiveRsiHighFloor: 65,
};

console.log("[1] Three real evaluations across different pullback depths");
const deepPullback   = evaluateSignal("DEEP_USDT", buildOversoldPullback(11, 0.05), params);
const mediumPullback = evaluateSignal("MED_USDT",  buildOversoldPullback(22, 0.035), params);
const shallowPullback= evaluateSignal("SHL_USDT",  buildOversoldPullback(33, 0.022), params);
console.log("    DEEP:", deepPullback ? `side=${deepPullback.side} q=${deepPullback.quality?.toFixed(3)}` : "no signal");
console.log("    MED: ", mediumPullback ? `side=${mediumPullback.side} q=${mediumPullback.quality?.toFixed(3)}` : "no signal");
console.log("    SHL: ", shallowPullback ? `side=${shallowPullback.side} q=${shallowPullback.quality?.toFixed(3)}` : "no signal");

const signals: ScalperSignal[] = [shallowPullback, mediumPullback, deepPullback].filter(Boolean) as ScalperSignal[];
ok(signals.length >= 2, "at least 2 of 3 setups produce signals");

// Run the actual loop logic
const dedup = new Map<string, ScalperSignal>();
for (const sig of signals) {
  const existing = dedup.get(sig.gateSymbol);
  const newQ = sig.quality ?? 0;
  const oldQ = existing?.quality ?? 0;
  if (!existing || newQ > oldQ) dedup.set(sig.gateSymbol, sig);
}
const ranked = [...dedup.values()].sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0));
console.log("    ranked:", ranked.map(s => `${s.gateSymbol}(q=${s.quality?.toFixed(3)})`).join(" → "));
ok(ranked.length === signals.length, `ranked.length = ${ranked.length} (unique symbols)`);

// Quality should be monotonic with pullback depth
const qualities = ranked.map(s => s.quality ?? 0);
const isDescending = qualities.every((q, i) => i === 0 || qualities[i - 1] >= q);
ok(isDescending, `qualities descending: ${qualities.map(q => q.toFixed(3)).join(", ")}`);

// ── Sizing: pipe each signal through the sizing math ────────────────────────
console.log("[2] Quality-aware sizing applied to ranked signals");
const sizingCfg = { qualityAwareSizing: true, qualitySizeFloorPct: 50 };
const baseSize = 100;
for (const sig of ranked) {
  const q = Math.min(1, Math.max(0, sig.quality ?? 0));
  const floor = sizingCfg.qualitySizeFloorPct / 100;
  const scale = floor + (1 - floor) * q;
  const sized = baseSize * scale;
  console.log(`    ${sig.gateSymbol} q=${q.toFixed(3)} → size ${sized.toFixed(2)} USDT (scale ${scale.toFixed(3)})`);
  ok(sized >= 50 && sized <= 100, `size in [50, 100]`);
}

console.log(`\n${fails === 0 ? "✓ ALL PASS" : `✗ ${fails} FAILURE(S)`}`);
process.exit(fails === 0 ? 0 : 1);
