// Verifier: Phase 2 historical-replay backtester.
// Constructs synthetic candle series to drive the engine deterministically —
// no Gate.io calls, no DB reads. Asserts evaluator dispatch, exit detection,
// fee math, sizing composition, Sharpe + drawdown formulas, range pre-checks.
import {
  runBacktest,
  simulateExit,
  summarize,
  tradeSharpe,
  maxDrawdown,
  computeSizeUsdt,
  fetchHistoricalCandles,
  intervalToSeconds,
  MAX_CANDLES,
  type BacktestSizing,
  type BacktestTrade,
} from "../services/backtest";
import type { Candle } from "../services/scalper-signals";

let fails = 0;
const ok = (cond: boolean, label: string, detail?: unknown) => {
  if (cond) console.log("  ✓", label);
  else { console.log("  ✗", label, detail ?? ""); fails++; }
};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

function mkCandle(time: number, open: number, high: number, low: number, close: number, volume = 1): Candle {
  return { time, open, high, low, close, volume };
}

function defaultSizing(): BacktestSizing {
  return {
    baseUsdt: 100,
    qualityAwareSizing: false,
    qualitySizeFloorPct: 50,
    kelly: { enabled: false, lookbackTrades: 30, minTrades: 10, safetyFraction: 0.5, floorPct: 10, maxPct: 100 },
  };
}

async function main() {
  // ── [1] Interval parsing + range cap ─────────────────────────────────────
  console.log("[1] intervalToSeconds + MAX_CANDLES guard");
  ok(intervalToSeconds("1m")  === 60,     "1m → 60s");
  ok(intervalToSeconds("5m")  === 300,    "5m → 300s");
  ok(intervalToSeconds("1h")  === 3600,   "1h → 3600s");
  ok(intervalToSeconds("4h")  === 14400,  "4h → 14400s");
  ok(intervalToSeconds("1d")  === 86400,  "1d → 86400s");
  try { intervalToSeconds("7x"); ok(false, "rejects garbage interval"); }
  catch { ok(true, "rejects garbage interval"); }

  let threw = false;
  try {
    // 1m × (MAX_CANDLES + 1000) bars → should throw before hitting the wire
    await fetchHistoricalCandles("BTC_USDT", "1m", 0, (MAX_CANDLES + 1000) * 60_000, async () => {
      throw new Error("should not be called");
    });
  } catch (err) {
    threw = err instanceof Error && /too large/i.test(err.message);
  }
  ok(threw, "range > MAX_CANDLES throws before fetch");

  // ── [2] Empty range → 0 trades ───────────────────────────────────────────
  console.log("[2] Empty candle input → 0 trades");
  {
    const r = await runBacktest({
      gateSymbol: "TEST_USDT",
      startTime: "2026-01-01T00:00:00Z",
      endTime:   "2026-01-01T01:00:00Z",
      timeframe: "5m",
      strategy:  "bb_rsi",
      config: {},
      sizing: defaultSizing(),
      candles: [],
    });
    ok(r.trades.length === 0, "no candles → no trades");
    ok(r.summary.totalTrades === 0, "summary.totalTrades = 0");
    ok(r.summary.netPnl === 0, "summary.netPnl = 0");
    ok(r.summary.sharpe === 0, "summary.sharpe = 0 with no trades");
  }

  // ── [3] simulateExit: TP hit before SL ──────────────────────────────────
  console.log("[3] simulateExit — TP / SL / both / EOD branches");
  {
    // BUY @ 100, TP=110, SL=90. Next bar high=115 (TP), low=98.
    const bars = [mkCandle(0, 100, 115, 98, 112)];
    const ex = simulateExit("buy", 100, 110, 90, 5, 5, bars, 5);
    ok(ex.reason === "tp" && ex.exitPrice === 110, "BUY TP hit first");
  }
  {
    // BUY @ 100, TP=110, SL=90. Next bar high=108, low=88 (SL hit, TP not).
    const bars = [mkCandle(0, 100, 108, 88, 92)];
    const ex = simulateExit("buy", 100, 110, 90, 5, 5, bars, 5);
    ok(ex.reason === "sl" && ex.exitPrice === 90, "BUY SL hit first");
  }
  {
    // Both TP and SL inside one bar — pessimistic = SL wins.
    const bars = [mkCandle(0, 100, 115, 85, 100)];
    const ex = simulateExit("buy", 100, 110, 90, 5, 5, bars, 5);
    ok(ex.reason === "sl", "ambiguous bar → SL (pessimistic)");
  }
  {
    // No hit anywhere → EOD close.
    const bars = [
      mkCandle(0, 100, 102, 99, 101),
      mkCandle(60, 101, 103, 100, 102),
    ];
    const ex = simulateExit("buy", 100, 110, 90, 5, 5, bars, 5);
    ok(ex.reason === "eod" && ex.exitPrice === 102, "EOD close at last bar");
  }
  {
    // SELL @ 100, TP=90, SL=110. Bar low=88 (TP), high=105.
    const bars = [mkCandle(0, 100, 105, 88, 92)];
    const ex = simulateExit("sell", 100, 90, 110, 5, 5, bars, 5);
    ok(ex.reason === "tp" && ex.exitPrice === 90, "SELL TP hit first");
  }

  // ── [4] Sharpe + drawdown math ──────────────────────────────────────────
  console.log("[4] Sharpe + drawdown formulas");
  {
    // Returns [1,1,1,1] — zero variance → 0
    ok(tradeSharpe([1, 1, 1, 1]) === 0, "constant returns → Sharpe 0");
    // [-1, 1] mean 0 → Sharpe 0
    ok(tradeSharpe([-1, 1]) === 0, "zero-mean → Sharpe 0");
    // [1, 3]: mean=2, sample-stddev=sqrt(((1-2)^2+(3-2)^2)/1)=sqrt(2). sharpe = (2/√2)*√2 = 2
    ok(near(tradeSharpe([1, 3]), 2, 1e-6), `[1,3] → Sharpe 2 (got ${tradeSharpe([1, 3])})`);
    ok(tradeSharpe([1]) === 0, "single sample → Sharpe 0");
  }
  {
    ok(maxDrawdown([1, 2, 3, 4]) === 0, "monotonic → DD 0");
    ok(maxDrawdown([10, 7, 12, 5, 8]) === 7, "peak 12 → trough 5 = DD 7");
    ok(maxDrawdown([]) === 0, "empty curve → DD 0");
  }

  // ── [5] Fee math: gross > net for winners ───────────────────────────────
  console.log("[5] Fee deduction shrinks net relative to gross");
  {
    // Hand-build a winning trade and verify summarize() reports gross > net.
    const trades: BacktestTrade[] = [{
      entryTime: 0, entryPrice: 100, exitTime: 60, exitPrice: 105,
      side: "buy", quantity: 1, notionalUsdt: 100,
      gross: 5, fees: 0.18, net: 4.82,
      quality: 0.7, reason: "tp", tpPrice: 105, slPrice: 95,
      kellyMultiplier: 1, qualityMultiplier: 1,
    }];
    const s = summarize(trades);
    ok(s.grossPnl > s.netPnl, `gross ${s.grossPnl} > net ${s.netPnl}`);
    ok(s.feesPaid > 0, "fees recorded");
    ok(s.wins === 1 && s.losses === 0, "1 win classified");
    ok(s.winRate === 1, "winRate = 1.0");
  }

  // ── [6] computeSizeUsdt: quality-aware + Kelly composition ──────────────
  console.log("[6] computeSizeUsdt — quality + Kelly composition");
  {
    // No sizing toggles → base preserved
    const r = computeSizeUsdt(100, 0.5, [], defaultSizing());
    ok(r.usdt === 100, "base preserved when both off");
    ok(r.qualityMult === 1 && r.kellyMult === 1, "multipliers = 1");
  }
  {
    // Quality-aware with floor=50, quality=0 → 0.5×; quality=1 → 1×
    const s = { ...defaultSizing(), qualityAwareSizing: true, qualitySizeFloorPct: 50 };
    const lo = computeSizeUsdt(100, 0, [], s);
    const hi = computeSizeUsdt(100, 1, [], s);
    ok(near(lo.usdt, 50, 1e-9),  `quality=0 → 50 USDT (got ${lo.usdt})`);
    ok(near(hi.usdt, 100, 1e-9), `quality=1 → 100 USDT (got ${hi.usdt})`);
    const mid = computeSizeUsdt(100, 0.5, [], s);
    ok(near(mid.usdt, 75, 1e-9), `quality=0.5 → 75 USDT (got ${mid.usdt})`);
  }
  {
    // Kelly enabled, classic case (mirrors verify-kelly-sizing case [3]):
    // 8 wins of 3, 4 losses of -2 → multiplier ≈ 0.2222
    const pnls = [...Array(8).fill(3), ...Array(4).fill(-2)];
    const s = {
      ...defaultSizing(),
      kelly: { enabled: true, lookbackTrades: 30, minTrades: 10, safetyFraction: 0.5, floorPct: 10, maxPct: 100 },
    };
    const r = computeSizeUsdt(100, 0.5, pnls, s);
    ok(near(r.kellyMult, 0.2222, 1e-3), `kelly mult ≈ 0.222 (got ${r.kellyMult})`);
    ok(near(r.usdt, 100 * r.kellyMult, 1e-9), "size = base × kelly when quality off");
  }
  {
    // Composition: quality (0.75) × kelly (0.2222) on base 100 → ~16.67
    const pnls = [...Array(8).fill(3), ...Array(4).fill(-2)];
    const s: BacktestSizing = {
      baseUsdt: 100,
      qualityAwareSizing: true,
      qualitySizeFloorPct: 50,
      kelly: { enabled: true, lookbackTrades: 30, minTrades: 10, safetyFraction: 0.5, floorPct: 10, maxPct: 100 },
    };
    const r = computeSizeUsdt(100, 0.5, pnls, s);
    const expected = 100 * 0.75 * 0.2222222222;
    ok(near(r.usdt, expected, 1e-3), `compose q×k×base ≈ ${expected.toFixed(3)} (got ${r.usdt})`);
  }

  // ── [7] End-to-end: oversold bounce → exactly 1 BB+RSI trade ───────────
  console.log("[7] Synthetic oversold-bounce → exactly 1 BB+RSI trade");
  {
    // Build a series with one clean drop → bounce sequence. With BB+RSI longOnly,
    // the signal first fires at i=25 (first bar past minBars where close < bbLower
    // AND RSI < 35). Entry is at i+1 open; we craft i+1 onwards to bounce
    // immediately so SL never triggers and the engine sees exactly one TP exit.
    const candles: Candle[] = [];
    let price = 100;
    // 25 bars of flat baseline at ~100 (BB mid sits near 100)
    for (let i = 0; i < 25; i++) {
      candles.push(mkCandle(i * 300, price, price + 0.05, price - 0.05, price, 100));
      price += 0.01;
    }
    // ONE deep waterfall bar — close below BB lower, RSI crushed.
    const dropOpen = price;
    price -= 8.0;
    candles.push(mkCandle(25 * 300, dropOpen, dropOpen + 0.05, price - 0.05, price, 200));
    // The engine evaluates at i=25 (signal fires) and enters at i+1's OPEN.
    // i+1 = bounce bar. Open here = entry.
    const entryBarOpen = price + 0.5; // gap-up open
    const tpTarget = entryBarOpen * 1.005;
    // Bounce bar: high reaches TP, low never threatens default SL (entry × 0.995).
    candles.push(mkCandle(26 * 300, entryBarOpen, tpTarget + 0.1, entryBarOpen - 0.05, tpTarget + 0.02, 200));
    // Padding so the engine has room to walk; price stays above the TP so no
    // re-entry signal fires (RSI recovers fast on the bounce).
    for (let i = 0; i < 10; i++) {
      const p = tpTarget + 0.2;
      candles.push(mkCandle((27 + i) * 300, p, p + 0.05, p - 0.05, p, 100));
    }

    const r = await runBacktest({
      gateSymbol: "TEST_USDT",
      startTime: new Date(0).toISOString(),
      endTime: new Date(candles.length * 300_000).toISOString(),
      timeframe: "5m",
      strategy: "bb_rsi",
      config: {
        longOnly: true,
        signalParams: {
          bbPeriod: 20, bbStdDev: 2.0,
          rsiPeriod: 14, rsiOversold: 35, rsiOverbought: 70,
          volumeSpikeMultiplier: 1.5,
          longOnly: true,
          emaFilterEnabled: false, emaPeriod: 10,
        },
      },
      sizing: defaultSizing(),
      candles,
    });
    ok(r.trades.length === 1, `exactly 1 trade fired (got ${r.trades.length})`);
    if (r.trades.length === 1) {
      const t = r.trades[0];
      ok(t.side === "buy", `side=buy (got ${t.side})`);
      ok(t.reason === "tp", `reason=tp (got ${t.reason})`);
      ok(near(t.exitPrice, entryBarOpen * 1.005, 1e-6),
         `exit ≈ entry × 1.005 (got entry=${t.entryPrice} exit=${t.exitPrice})`);
      ok(t.gross > t.net, `winner: gross ${t.gross.toFixed(4)} > net ${t.net.toFixed(4)} (fees ${t.fees.toFixed(5)})`);
    }
  }

  console.log(`\n${fails === 0 ? "✓ ALL PASS" : `✗ ${fails} FAILURE(S)`}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-backtest crashed:", err);
  process.exit(1);
});

export {};
