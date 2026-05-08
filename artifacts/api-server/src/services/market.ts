import { db, signalsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { logger } from "../lib/logger";

export type MarketRegime = "RISK_OFF" | "BTC_DOMINANT" | "ETH_SEASON" | "ALT_SEASON" | "NEUTRAL";

export interface MarketSpreads {
  btcDivStable: number;       // BTC.D / (USDT.D+USDC.D)
  stableDivBtc: number;       // (USDT.D+USDC.D) / BTC.D
  btcMinusStable: number;     // BTC.D - Stable.D  (BTC.D-STABLE.C.D)
  largecapDivOthers: number;  // (BTC.D+ETH.D) / OTHERS.D
  totalDivStable: number;     // (BTC.D+ETH.D+OTHERS.D) / Stable.D  ≈ TOTALES.D/Stable.D
  usdtDivUsdc: number;        // USDT.D / USDC.D
}

export interface MarketStatus {
  btcDominance: number;
  ethDominance: number;
  stableDominance: number;    // USDT.D + USDC.D
  othersDominance: number;    // everything else
  totalMarketCapUsd: number | null;
  marketCapChange24h: number | null;
  spreads: MarketSpreads;
  regime: MarketRegime;
  regimeScore: number;
  latestRotation: string | null;
  latestRotScore: number | null;
  lastUpdated: string;
}

let cache: { data: MarketStatus; ts: number } | null = null;
const CACHE_TTL_MS = 60_000; // 1 minute

interface CoinGeckoGlobal {
  data: {
    market_cap_percentage: Record<string, number>;
    total_market_cap: Record<string, number>;
    market_cap_change_percentage_24h_usd: number;
  };
}

function classifyRegime(
  btcD: number,
  ethD: number,
  stableD: number,
  othersD: number,
): { regime: MarketRegime; score: number } {
  // RISK_OFF: high stable dominance or low btc-stable spread
  if (stableD > 14 || btcD - stableD < 38) {
    return { regime: "RISK_OFF", score: -(stableD / 10) };
  }
  // BTC_DOMINANT: btc clearly ahead, alts lagging
  if (btcD > 54 && othersD < 28) {
    return { regime: "BTC_DOMINANT", score: btcD / 10 };
  }
  // ETH_SEASON: eth gaining vs btc
  if (ethD > 16 && ethD / btcD > 0.28) {
    return { regime: "ETH_SEASON", score: (ethD / btcD) * 10 };
  }
  // ALT_SEASON: alts leading, btc dom falling
  if (othersD > 32 && btcD < 50) {
    return { regime: "ALT_SEASON", score: othersD / 10 };
  }
  return { regime: "NEUTRAL", score: 0 };
}

export async function getMarketStatus(): Promise<MarketStatus> {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return cache.data;
  }

  let btcD = 52;
  let ethD = 14;
  let usdtD = 4.5;
  let usdcD = 1.5;
  let totalMarketCapUsd: number | null = null;
  let marketCapChange24h: number | null = null;

  try {
    const resp = await fetch("https://api.coingecko.com/api/v3/global", {
      signal: AbortSignal.timeout(8000),
    });
    if (resp.ok) {
      const json = (await resp.json()) as CoinGeckoGlobal;
      const pct = json.data.market_cap_percentage;
      btcD = pct["btc"] ?? btcD;
      ethD = pct["eth"] ?? ethD;
      usdtD = pct["usdt"] ?? usdtD;
      usdcD = pct["usdc"] ?? usdcD;
      totalMarketCapUsd = json.data.total_market_cap?.["usd"] ?? null;
      marketCapChange24h = json.data.market_cap_change_percentage_24h_usd ?? null;
    }
  } catch (err) {
    logger.warn({ err }, "Market: CoinGecko fetch failed, using stale/default values");
  }

  const stableD = usdtD + usdcD;
  const largecapD = btcD + ethD;
  const othersD = Math.max(0, 100 - btcD - ethD - stableD);

  const spreads: MarketSpreads = {
    btcDivStable: stableD > 0 ? parseFloat((btcD / stableD).toFixed(3)) : 0,
    stableDivBtc: btcD > 0 ? parseFloat((stableD / btcD).toFixed(4)) : 0,
    btcMinusStable: parseFloat((btcD - stableD).toFixed(2)),
    largecapDivOthers: othersD > 0 ? parseFloat((largecapD / othersD).toFixed(3)) : 0,
    totalDivStable: stableD > 0 ? parseFloat(((largecapD + othersD) / stableD).toFixed(3)) : 0,
    usdtDivUsdc: usdcD > 0 ? parseFloat((usdtD / usdcD).toFixed(3)) : 0,
  };

  const { regime, score: regimeScore } = classifyRegime(btcD, ethD, stableD, othersD);

  // Fetch latest signal rotation
  let latestRotation: string | null = null;
  let latestRotScore: number | null = null;
  try {
    const [latest] = await db
      .select({ rot: signalsTable.rot, rotScore: signalsTable.rotScore })
      .from(signalsTable)
      .orderBy(desc(signalsTable.receivedAt))
      .limit(1);
    latestRotation = latest?.rot ?? null;
    latestRotScore = latest?.rotScore ?? null;
  } catch { /* non-critical */ }

  const status: MarketStatus = {
    btcDominance: parseFloat(btcD.toFixed(2)),
    ethDominance: parseFloat(ethD.toFixed(2)),
    stableDominance: parseFloat(stableD.toFixed(2)),
    othersDominance: parseFloat(othersD.toFixed(2)),
    totalMarketCapUsd,
    marketCapChange24h: marketCapChange24h != null ? parseFloat(marketCapChange24h.toFixed(2)) : null,
    spreads,
    regime,
    regimeScore: parseFloat(regimeScore.toFixed(3)),
    latestRotation,
    latestRotScore,
    lastUpdated: new Date().toISOString(),
  };

  cache = { data: status, ts: Date.now() };
  return status;
}
