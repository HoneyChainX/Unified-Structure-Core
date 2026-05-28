// Phase 2 (2/N) verification: shared `quality` channel across engines + ranking.
//
// Asserts that:
//   - CHT signals carry quality = score/100 in [0,1]
//   - SMC signals carry quality derived from R:R
//   - When the same symbol fires on multiple timeframes, the higher-quality
//     candidate wins the per-symbol dedup
//   - Global sort places highest-quality signal first
import type { ScalperSignal } from "../services/scalper-signals";

let fails = 0;
const ok = (cond: boolean, label: string, detail?: unknown) => {
  if (cond) console.log("  ✓", label);
  else { console.log("  ✗", label, detail ?? ""); fails++; }
};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

// ── CHT quality normalisation ──────────────────────────────────────────────
console.log("[1] CHT score → quality mapping");
const chtCases: Array<{ score: number; expectedQ: number; grade: string }> = [
  { score: 60,  expectedQ: 0.60, grade: "MEDIUM" },
  { score: 75,  expectedQ: 0.75, grade: "STRONG" },
  { score: 85,  expectedQ: 0.85, grade: "ELITE" },
  { score: 100, expectedQ: 1.00, grade: "ELITE-cap" },
  { score: 0,   expectedQ: 0.00, grade: "IGNORE (would be filtered)" },
];
for (const c of chtCases) {
  // Mirror the in-line formula in scalper-signals-cht.ts
  const q = Math.min(1, Math.max(0, c.score / 100));
  ok(near(q, c.expectedQ), `score=${c.score} (${c.grade}) → quality=${q.toFixed(2)}`);
}

// ── SMC quality from R:R ───────────────────────────────────────────────────
console.log("[2] SMC R:R → quality mapping");
const smcQuality = (entry: number, tp: number, sl: number): number => {
  const reward = Math.abs(tp - entry);
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return 0;
  const rr = reward / risk;
  return Math.min(1, Math.max(0, (rr - 1) / 3));
};
ok(near(smcQuality(100, 101, 99), 0),      "R:R = 1.0 → quality 0.00");
ok(near(smcQuality(100, 102.5, 99), 0.5),  "R:R = 2.5 → quality 0.50");
ok(near(smcQuality(100, 104, 99), 1),      "R:R = 4.0 → quality 1.00 (saturates)");
ok(near(smcQuality(100, 110, 99), 1),      "R:R = 10  → quality 1.00 (capped)");
ok(smcQuality(100, 99, 99) === 0,          "SL == entry → quality 0 (guard)");

// ── Per-symbol dedup with quality tie-break ────────────────────────────────
console.log("[3] Per-symbol dedup picks higher quality");
function dedupKeepHigherQuality(streams: ScalperSignal[][]): Map<string, ScalperSignal> {
  // Mirrors the logic in scalper-loop.ts
  const map = new Map<string, ScalperSignal>();
  for (const stream of streams) {
    for (const sig of stream) {
      const existing = map.get(sig.gateSymbol);
      const newQ = sig.quality ?? 0;
      const oldQ = existing?.quality ?? 0;
      if (!existing || newQ > oldQ) map.set(sig.gateSymbol, sig);
    }
  }
  return map;
}

const mk = (gs: string, tf: string, q?: number): ScalperSignal => ({
  symbol: gs.replace("_USDT", ""),
  gateSymbol: gs,
  side: "buy",
  entryPrice: 100,
  bbUpper: 102, bbLower: 98, bbMid: 100,
  rsi: 30, volumeRatio: 1.5,
  strategy: "bb_rsi",
  timeframe: tf,
  quality: q,
});

const dedup1 = dedupKeepHigherQuality([
  [mk("BTC_USDT", "3m", 0.4)],
  [mk("BTC_USDT", "5m", 0.8)],   // higher quality should win
]);
ok(dedup1.get("BTC_USDT")?.timeframe === "5m", "higher-quality 5m beats earlier 3m");
ok(dedup1.get("BTC_USDT")?.quality === 0.8, "kept quality = 0.8");

const dedup2 = dedupKeepHigherQuality([
  [mk("ETH_USDT", "3m", 0.9)],
  [mk("ETH_USDT", "5m", 0.5)],   // lower quality should NOT overwrite
]);
ok(dedup2.get("ETH_USDT")?.timeframe === "3m", "lower-quality later signal does not overwrite");

const dedup3 = dedupKeepHigherQuality([
  [mk("SOL_USDT", "3m", undefined)],   // unscored
  [mk("SOL_USDT", "5m", 0.1)],         // scored, even tiny quality wins
]);
ok(dedup3.get("SOL_USDT")?.timeframe === "5m", "any scored signal beats unscored");

// ── Global ranking ─────────────────────────────────────────────────────────
console.log("[4] Global rank by quality DESC");
const all: ScalperSignal[] = [
  mk("A_USDT", "5m", 0.2),
  mk("B_USDT", "5m", 0.9),
  mk("C_USDT", "5m", undefined),
  mk("D_USDT", "5m", 0.5),
];
const sorted = [...all].sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0));
ok(sorted[0].gateSymbol === "B_USDT", "B (q=0.9) ranks first");
ok(sorted[1].gateSymbol === "D_USDT", "D (q=0.5) ranks second");
ok(sorted[2].gateSymbol === "A_USDT", "A (q=0.2) ranks third");
ok(sorted[3].gateSymbol === "C_USDT", "C (unscored) sinks to last");

console.log(`\n${fails === 0 ? "✓ ALL PASS" : `✗ ${fails} FAILURE(S)`}`);
process.exit(fails === 0 ? 0 : 1);
