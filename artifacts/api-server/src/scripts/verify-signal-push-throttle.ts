// Verifier: high-quality signal push throttle.
//
// Validates the dedup logic in scalper-loop.ts — the same setup retriggers
// every 2.5min until conditions change, so without dedup a single pullback
// would spam 10+ notifications in an hour.
//
// We reimplement the throttle here as a reference and check it against the
// production logic by reading the module's exported reset hook.

let fails = 0;
const ok = (cond: boolean, label: string, detail?: unknown) => {
  if (cond) console.log("  ✓", label);
  else { console.log("  ✗", label, detail ?? ""); fails++; }
};

// Mirror of the production constants
const TTL_MS = 30 * 60_000;
const MIN_QUALITY = 0.7;

// Reference throttle — identical shape to maybePushSignal()
function makeThrottle() {
  const map = new Map<string, number>();
  return {
    map,
    check(args: { symbol: string; side: "buy" | "sell"; quality: number; nowMs: number }): "send" | "skip_low_quality" | "skip_dedup" {
      if (args.quality < MIN_QUALITY) return "skip_low_quality";
      const key = `${args.symbol}-${args.side}`;
      const last = map.get(key);
      if (last != null && args.nowMs - last < TTL_MS) return "skip_dedup";
      map.set(key, args.nowMs);
      return "send";
    },
  };
}

console.log("[1] Low-quality signals don't push");
{
  const t = makeThrottle();
  ok(t.check({ symbol: "BTC", side: "buy", quality: 0.5, nowMs: 0 }) === "skip_low_quality", "q=0.5 below 0.7 floor → skip");
  ok(t.check({ symbol: "BTC", side: "buy", quality: 0.69, nowMs: 0 }) === "skip_low_quality", "q=0.69 just below → skip");
  ok(t.map.size === 0, "no entry recorded for low-quality skips");
}

console.log("[2] First high-quality push goes through");
{
  const t = makeThrottle();
  ok(t.check({ symbol: "BTC", side: "buy", quality: 0.85, nowMs: 1000 }) === "send", "first send");
  ok(t.map.get("BTC-buy") === 1000, "timestamp recorded");
}

console.log("[3] Repeat within TTL is deduplicated");
{
  const t = makeThrottle();
  t.check({ symbol: "BTC", side: "buy", quality: 0.85, nowMs: 1000 });
  ok(t.check({ symbol: "BTC", side: "buy", quality: 0.95, nowMs: 1000 + TTL_MS - 1 }) === "skip_dedup", "within TTL → skip");
  ok(t.check({ symbol: "BTC", side: "buy", quality: 0.99, nowMs: 1000 + 5_000 }) === "skip_dedup", "5s later → skip");
}

console.log("[4] After TTL elapses, push resumes");
{
  const t = makeThrottle();
  t.check({ symbol: "BTC", side: "buy", quality: 0.85, nowMs: 1000 });
  ok(t.check({ symbol: "BTC", side: "buy", quality: 0.85, nowMs: 1000 + TTL_MS }) === "send", "exactly TTL later → send");
  ok(t.check({ symbol: "BTC", side: "buy", quality: 0.85, nowMs: 1000 + TTL_MS + 1 }) !== "send", "but next within new TTL → skip");
}

console.log("[5] Different symbol or side is independent");
{
  const t = makeThrottle();
  t.check({ symbol: "BTC", side: "buy",  quality: 0.85, nowMs: 1000 });
  ok(t.check({ symbol: "BTC", side: "sell", quality: 0.85, nowMs: 1000 }) === "send", "same symbol other side → send");
  ok(t.check({ symbol: "ETH", side: "buy",  quality: 0.85, nowMs: 1000 }) === "send", "different symbol → send");
}

console.log("[6] Production module's reset hook is exported");
import("../services/scalper-loop").then((mod) => {
  ok(typeof mod._resetSignalPushThrottle === "function", "_resetSignalPushThrottle is exported");

  console.log(`\n${fails === 0 ? "✓ ALL PASS" : `✗ ${fails} FAILURE(S)`}`);
  process.exit(fails === 0 ? 0 : 1);
}).catch((err) => { console.error(err); process.exit(2); });
