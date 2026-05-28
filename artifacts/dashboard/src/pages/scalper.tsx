import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  Zap, Play, Square, RefreshCw, TrendingUp, TrendingDown, DollarSign,
  AlertTriangle, CheckCircle2, Clock, BarChart3, ArrowUpRight, ArrowDownRight,
  ChevronDown, ChevronUp, Shield, Search, LogIn, Link2, Copy, Eye, EyeOff, RotateCcw,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json() as Promise<T>;
}

interface GateKeyStatus {
  pairs: string[];
  unrestricted: boolean;
}

function GateKeyRestrictionPanel({ onSync }: { onSync: (pairs: string[]) => void }) {
  const [status, setStatus] = useState<GateKeyStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetch() {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ pairs: string[]; unrestricted: boolean; error?: string }>("/api/scalper/gateio-allowlist");
      if (data.error) throw new Error(data.error);
      setStatus(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to read key");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs text-muted-foreground tracking-widest flex items-center gap-2">
          <span className="text-yellow-400">▣</span> GATE.IO API KEY RESTRICTION
        </label>
        <button
          onClick={fetch}
          disabled={loading}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono border border-yellow-500/50 bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
          CHECK KEY
        </button>
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 p-2">{error}</div>
      )}

      {status && (
        status.unrestricted ? (
          <div className="flex items-start gap-2 bg-green-500/10 border border-green-500/30 p-3 text-xs">
            <span className="text-green-400 text-base leading-none mt-0.5">✓</span>
            <div className="space-y-0.5">
              <div className="text-green-400 font-bold">Key is unrestricted — all USDT pairs allowed</div>
              <div className="text-muted-foreground">Your API key can place orders on any pair. Clear the bot filter below to trade the full scan pool.</div>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 p-3 text-xs">
              <span className="text-red-400 text-base leading-none mt-0.5">⚠</span>
              <div className="space-y-1">
                <div className="text-red-400 font-bold">Key is restricted to {status.pairs.length} pair{status.pairs.length !== 1 ? "s" : ""}</div>
                <div className="text-muted-foreground">
                  Gate.io will <span className="text-red-300 font-bold">reject any order</span> outside this list — even if the bot's filter is cleared. This is set on Gate.io's website, not here.
                </div>
                <div className="font-mono text-foreground/70 mt-1 break-all">{status.pairs.join(", ")}</div>
              </div>
            </div>
            <div className="bg-yellow-500/10 border border-yellow-500/30 p-3 text-xs space-y-1.5">
              <div className="text-yellow-400 font-bold">To trade more pairs:</div>
              <ol className="text-muted-foreground space-y-1 list-decimal list-inside">
                <li>Go to <span className="font-mono text-foreground">gate.io → Account → API Management</span></li>
                <li>Click <span className="font-mono text-foreground">Edit</span> on your API key</li>
                <li>Under <span className="font-mono text-foreground">Trading Pairs</span>, clear all entries (leave empty = no restriction)</li>
                <li>Save and re-enter your API secret if prompted</li>
                <li>Click <span className="font-mono text-foreground">CHECK KEY</span> above to confirm</li>
              </ol>
            </div>
            <button
              onClick={() => onSync(status.pairs)}
              className="text-xs font-mono text-yellow-400/70 hover:text-yellow-400 underline underline-offset-2"
            >
              Copy these pairs into the bot filter below →
            </button>
          </div>
        )
      )}

      {!status && !loading && !error && (
        <div className="text-xs text-muted-foreground bg-secondary/30 border border-border p-2">
          Click CHECK KEY to read your API key's pair restrictions directly from Gate.io.
        </div>
      )}
    </div>
  );
}

interface ScalperConfig {
  id: number;
  enabled: boolean;
  paperMode: boolean;
  positionSizeUsdt: number;
  positionSizePct: number | null;
  targetProfitUsdt: number;
  targetProfitPct: number | null;
  slPct: number;
  maxOpenTrades: number;
  cooldownMinutes: number;
  bbPeriod: number;
  bbStdDev: number;
  rsiPeriod: number;
  rsiOversold: number;
  rsiOverbought: number;
  volumeSpikeMultiplier: number;
  emaFilterEnabled: boolean;
  emaPeriod: number;
  compoundingEnabled: boolean;
  compoundBalance: number | null;
  longOnly: boolean;
  dynamicTp: boolean;
  tpMode: string;
  webhookSecret: string | null;
  symbolAllowlist: string | null;
  scanPoolSize: number;
  strategy: string;
  // Phase 2: adaptive RSI thresholds (BB+RSI engine)
  adaptiveThresholds: boolean;
  adaptiveWindow: number;
  adaptiveLowQ: number;
  adaptiveHighQ: number;
  adaptiveRsiLowFloor: number;
  adaptiveRsiHighFloor: number;
  // Phase 2: quality-aware sizing
  qualityAwareSizing: boolean;
  qualitySizeFloorPct: number;
  qualityAwareSizingMicroMode: boolean;
  // Phase 2: funding-rate filters
  chtFundingFilterEnabled: boolean;
  chtFundingThresholdPct: number;
  mrxFundingFilterEnabled: boolean;
  mrxFundingThresholdPct: number;
  updatedAt: string;
}

interface ScalperStatus {
  enabled: boolean;
  paperMode: boolean;
  usdtBalance: number | null;
  openTrades: number;
  totalTrades: number;
  apiConfigured: boolean;
  lastSyncAt: string | null;
  lastScanAt: string | null;
  lastSignalCount: number;
}

interface ScalperTrade {
  id: number;
  symbol: string;
  gateSymbol: string;
  side: string;
  status: string;
  positionSizeUsdt: number | null;
  quantity: number | null;
  entryPrice: number | null;
  livePrice: number | null;
  tpPrice: number | null;
  slPrice: number | null;
  tpOrderId: string | null;
  slOrderId: string | null;
  closePrice: number | null;
  closeReason: string | null;
  pnl: number | null;
  paperMode: boolean;
  errorMessage: string | null;
  rsi: number | null;
  volumeRatio: number | null;
  createdAt: string;
  closedAt: string | null;
}

interface StrategyStats {
  strategy: string;
  count: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalPnl: number;
  avgPnl: number | null;
}

interface BestModeNow {
  strategy: string;
  score: number;
  winRate: number | null;
  tradeCount: number;
  liveSignals: number;
  totalScanned: number;
  marketFit: number;
}

interface MarketCondition {
  regime: "TRENDING_BULL" | "TRENDING_BEAR" | "RANGING" | "VOLATILE" | "NEUTRAL";
  adx: number;
  atrPct: number;
  btcTrend: "BULLISH" | "BEARISH" | "NEUTRAL";
  label: string;
  description: string;
  favoredStrategy: "bb_rsi" | "smc_mss" | "cht" | "mrx-hybrid";
  favoredReason: string;
}

interface ScalperPerformance {
  totalClosed: number;
  withPnl: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalPnl: number;
  avgPnl: number | null;
  bestPnl: number | null;
  worstPnl: number | null;
  strategyStats: StrategyStats[];
  bestModeNow: BestModeNow | null;
  marketCondition: MarketCondition | null;
}

interface LiveScanEntry {
  gateSymbol: string;
  lastClose: number;
  inAllowlist: boolean;
  bbRsi: {
    detected: boolean;
    side: "buy" | "sell" | null;
    /** Timeframe on which the signal was detected (e.g. "5m", "1h"). */
    timeframe: string | null;
    rsi: number | null;
    volumeRatio: number | null;
    tp: number | null;
    sl: number | null;
  };
  smc: {
    detected: boolean;
    side: "buy" | "sell" | null;
    timeframe: string | null;
    tp: number | null;
    sl: number | null;
    obHigh: number | null;
    obLow: number | null;
    mssLevel: number | null;
  };
  cht: {
    detected: boolean;
    side: "buy" | "sell" | null;
    timeframe: string | null;
    score: number | null;
    grade: string | null;
    setupType: string | null;
    taoVotes: number | null;
    tp1: number | null;
    tp2: number | null;
    tp3: number | null;
    sl: number | null;
    rr: number | null;
  };
  mrx?: {
    detected: boolean;
    timeframe: string | null;
    rsi: number | null;
    atrPct: number | null;
    inOB: boolean;
    tp: number | null;
    sl: number | null;
    gatesHit: number | null;
  };
}

interface ScanRow {
  gateSymbol: string;
  lastClose?: number;
  bbUpper?: number;
  bbLower?: number;
  bbMid?: number;
  rsi?: number;
  volumeRatio?: number;
  nearLower?: boolean;
  nearUpper?: boolean;
  signalDetected?: boolean;
  signalSide?: "buy" | "sell" | null;
  error?: string;
}

interface ManualSignal {
  side: "buy" | "sell";
  entryPrice: number;
  tpPrice: number | null;
  slPrice: number | null;
  strategy: string;
}

interface ManualScanResult {
  gateSymbol: string;
  strategy: string;
  lastClose: number;
  bbUpper: number;
  bbLower: number;
  bbMid: number;
  rsi: number;
  volumeRatio: number;
  ema: number;
  emaPeriod: number;
  emaFilterEnabled: boolean;
  trendAllowsLong: boolean;
  trendAllowsShort: boolean;
  nearLower: boolean;
  nearUpper: boolean;
  longSignal: boolean;
  shortSignal: boolean;
  hasVolumeSpike: boolean;
  signal: ManualSignal | null;
  smcDetails: { obHigh: number; obLow: number; mssLevel: number } | null;
  scannedAt: string;
}

function useFetch<T>(url: string, intervalMs = 15000) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = () => {
    setLoading(true);
    api<T>(url)
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useState(() => {
    refetch();
    const t = setInterval(refetch, intervalMs);
    return () => clearInterval(t);
  });

  return { data, loading, error, refetch };
}

interface MrxStatusData {
  autoPaused: boolean;
  pauseReason: string | null;
  recentWinRate: number | null;
  recentTradeCount: number;
  blacklistCount: number;
}

interface MrxTfEntry {
  label: string;
  count: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalPnl: number;
  avgPnl: number | null;
  bestPnl: number | null;
  worstPnl: number | null;
}

function MrxPerformancePanel({ data }: { data: MrxTfEntry[] }) {
  if (!data.length) {
    return (
      <div className="px-4 pb-4">
        <div className="border border-orange-500/20 bg-orange-500/5 px-4 py-3 text-xs font-mono text-muted-foreground">
          <span className="text-orange-400/70 font-bold tracking-widest">MRX PERFORMANCE</span>
          <span className="ml-3 opacity-60">No closed MRX trades yet</span>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 pb-4 space-y-2">
      <div className="text-[10px] text-muted-foreground tracking-widest font-bold text-orange-400/80">
        MRX PERFORMANCE BY TIMEFRAME
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {data.map((row) => {
          const wr = row.winRate != null ? row.winRate * 100 : null;
          const wrGood = wr != null && wr >= 50;
          const avgGood = (row.avgPnl ?? 0) >= 0;
          return (
            <div key={row.label} className="border border-orange-500/20 bg-orange-500/5 px-3 py-2.5 font-mono">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-orange-300 uppercase tracking-widest">{row.label}</span>
                <span className="text-[10px] text-muted-foreground">
                  <span className="text-green-400">{row.wins}W</span>
                  <span className="mx-1">/</span>
                  <span className="text-red-400">{row.losses}L</span>
                  <span className="ml-1 opacity-60">({row.count})</span>
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-[11px]">
                <div>
                  <div className="text-[9px] text-muted-foreground tracking-widest mb-0.5">WIN RATE</div>
                  <div className={`font-bold ${wr != null ? wrGood ? "text-green-400" : "text-red-400" : "text-muted-foreground"}`}>
                    {wr != null ? `${wr.toFixed(0)}%` : "—"}
                  </div>
                </div>
                <div>
                  <div className="text-[9px] text-muted-foreground tracking-widest mb-0.5">AVG P&L</div>
                  <div className={`font-bold ${avgGood ? "text-green-400" : "text-red-400"}`}>
                    {row.avgPnl != null ? `${row.avgPnl >= 0 ? "+" : ""}${row.avgPnl.toFixed(3)}` : "—"}
                  </div>
                </div>
                <div>
                  <div className="text-[9px] text-muted-foreground tracking-widest mb-0.5">TOTAL P&L</div>
                  <div className={`font-bold ${row.totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {row.totalPnl >= 0 ? "+" : ""}{row.totalPnl.toFixed(3)}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MrxStatusPanel() {
  const [status, setStatus] = useState<MrxStatusData | null>(null);
  const [resuming, setResuming] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useState(() => {
    const load = () =>
      api<{ mrxStatus: MrxStatusData }>("/api/scalper/performance")
        .then((d) => setStatus(d.mrxStatus ?? null))
        .catch(() => null);
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  });

  async function resume() {
    setResuming(true);
    setMsg(null);
    try {
      await api("/api/scalper/mrx/resume", { method: "POST" });
      setMsg("MRX scanner resumed.");
      setStatus((s) => s ? { ...s, autoPaused: false, pauseReason: null } : s);
    } catch {
      setMsg("Failed to resume — check server logs.");
    } finally {
      setResuming(false);
    }
  }

  return (
    <div className="p-4 border-b border-border space-y-3">
      <div className="flex items-center justify-between">
        <label className="text-xs text-muted-foreground tracking-widest flex items-center gap-2">
          <span className="text-orange-400">◈</span> MRX — MEAN REVERSION XPRESS
        </label>
        <span className="text-[10px] font-mono text-orange-400/70 border border-orange-500/20 bg-orange-500/5 px-2 py-0.5">
          PARALLEL SCANNER · ALWAYS ACTIVE
        </span>
      </div>

      {/* Fixed parameters */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs font-mono">
        {[
          { label: "TIMEFRAME", value: "1m + 3m candles" },
          { label: "DIRECTION", value: "LONG ONLY" },
          { label: "TP TARGET", value: "+0.28%" },
          { label: "SL GUARD", value: "−2.5%" },
        ].map(({ label, value }) => (
          <div key={label} className="border border-orange-500/20 bg-orange-500/5 px-3 py-2">
            <div className="text-[10px] text-muted-foreground tracking-widest mb-0.5">{label}</div>
            <div className="text-orange-300 font-bold">{value}</div>
          </div>
        ))}
      </div>

      {/* 7-gate evaluator summary */}
      <div className="text-[10px] text-muted-foreground/70 font-mono leading-relaxed border border-border/30 bg-secondary/20 px-3 py-2">
        <span className="text-orange-400/80 font-bold">7 GATES: </span>
        BB Lower touch · RSI ≤ 25 · ATR% in range · BB width not too narrow · Volume spike · HTF EMA filter · Pump guard (no candle &gt;2.5%)
        <span className="ml-2 text-orange-400/60">+ Gate 8: 1h Order Block confluence (bonus)</span>
      </div>

      {/* Live status */}
      {status && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className={`flex items-center gap-2 px-3 py-1.5 border text-xs font-mono ${
            status.autoPaused
              ? "border-orange-500/60 bg-orange-500/10 text-orange-300"
              : "border-green-500/40 bg-green-500/8 text-green-300"
          }`}>
            <span className={`w-2 h-2 rounded-full ${status.autoPaused ? "bg-orange-400 animate-pulse" : "bg-green-400"}`} />
            {status.autoPaused ? "AUTO-PAUSED" : "SCANNING"}
          </div>
          {status.recentTradeCount > 0 && (
            <div className="text-xs font-mono text-muted-foreground">
              Recent WR: <span className={status.recentWinRate != null && status.recentWinRate >= 70 ? "text-green-400" : "text-red-400"}>
                {status.recentWinRate != null ? `${status.recentWinRate.toFixed(0)}%` : "—"}
              </span>
              <span className="ml-1 opacity-50">({status.recentTradeCount} trades)</span>
            </div>
          )}
          {status.blacklistCount > 0 && (
            <div className="text-xs font-mono text-muted-foreground">
              Cooldown: <span className="text-orange-400">{status.blacklistCount} symbols</span>
            </div>
          )}
          {status.autoPaused && (
            <button
              onClick={resume}
              disabled={resuming}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-bold border border-orange-500 bg-orange-500/20 text-orange-300 hover:bg-orange-500/30 transition-colors disabled:opacity-50"
            >
              <RotateCcw className={`w-3 h-3 ${resuming ? "animate-spin" : ""}`} />
              {resuming ? "RESUMING…" : "RESUME SCANNER"}
            </button>
          )}
          {status.pauseReason && (
            <div className="text-[10px] text-orange-400/70 font-mono">{status.pauseReason}</div>
          )}
        </div>
      )}
      {msg && <div className="text-xs font-mono text-orange-300">{msg}</div>}
    </div>
  );
}

function pnlClass(pnl: number | null): string {
  if (pnl == null) return "text-muted-foreground";
  if (pnl > 0) return "text-green-400";
  if (pnl < 0) return "text-red-400";
  return "text-muted-foreground";
}

function fmt(n: number | null | undefined, decimals = 4): string {
  if (n == null) return "—";
  return n.toFixed(decimals);
}

export function ScalperPage() {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanData, setScanData] = useState<ScanRow[] | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showQualityFilters, setShowQualityFilters] = useState(false);
  const [showScan, setShowScan] = useState(false);
  const [draft, setDraft] = useState<Partial<ScalperConfig>>({});

  // Manual entry state
  const [manualSymbol, setManualSymbol] = useState("");
  const [manualScanning, setManualScanning] = useState(false);
  const [manualResult, setManualResult] = useState<ManualScanResult | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);
  const [entering, setEntering] = useState<"buy" | "sell" | null>(null);

  const { data: config, refetch: refetchConfig } = useFetch<ScalperConfig>("/api/scalper/config");
  const { data: status, refetch: refetchStatus } = useFetch<ScalperStatus>("/api/scalper/status");
  // Open positions: poll every 15s for live P&L (include "error" so filled-but-unprotected trades are visible)
  const { data: openTrades_, refetch: refetchOpen } = useFetch<ScalperTrade[]>("/api/scalper/trades?status=open,paper,error&limit=100");
  // Closed history: poll every 60s (static data — only grows)
  const { data: closedTrades_, refetch: refetchClosed } = useFetch<ScalperTrade[]>("/api/scalper/trades?status=closed,cancelled&limit=200", 60000);
  const { data: perf, refetch: refetchPerf } = useFetch<ScalperPerformance>("/api/scalper/performance");
  // Bot analytics for MRX performance breakdown — poll every 60s (slow-moving data)
  const { data: botAnalytics } = useFetch<{ byMrxTf: MrxTfEntry[] }>("/api/bot/analytics", 60000);
  // Live dual-strategy scan: poll every 30s
  const { data: liveScan } = useFetch<{ results: LiveScanEntry[]; scannedAt: string | null }>("/api/scalper/scan/live", 30000);

  const cfg = { ...config, ...draft } as ScalperConfig;

  function field<K extends keyof ScalperConfig>(key: K, fallback: ScalperConfig[K]): ScalperConfig[K] {
    return (cfg[key] ?? fallback) as ScalperConfig[K];
  }

  function set<K extends keyof ScalperConfig>(key: K, val: ScalperConfig[K]) {
    setDraft((d) => ({ ...d, [key]: val }));
  }

  async function save() {
    setSaving(true);
    try {
      await api("/api/scalper/config", { method: "PUT", body: JSON.stringify(draft) });
      setDraft({});
      refetchConfig();
      refetchStatus();
    } catch (e) {
      alert(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled() {
    const newVal = !field("enabled", false);
    await api("/api/scalper/config", { method: "PUT", body: JSON.stringify({ enabled: newVal }) });
    refetchConfig();
    refetchStatus();
  }

  async function cancelTrade(id: number) {
    await api(`/api/scalper/trades/${id}/cancel`, { method: "DELETE" });
    refetchOpen();
    refetchClosed();
    refetchPerf();
  }

  const [forceClosing, setForceClosing] = useState<number | null>(null);

  const [showWebhookSecret, setShowWebhookSecret] = useState(false);
  const [webhookCopied, setWebhookCopied] = useState(false);
  const [regeneratingSecret, setRegeneratingSecret] = useState(false);

  async function regenerateWebhookSecret() {
    if (!confirm("Rotate the webhook secret? The current URL will stop working immediately.")) return;
    setRegeneratingSecret(true);
    try {
      await api("/api/scalper/webhook/regenerate", { method: "POST" });
      await refetchConfig();
      setShowWebhookSecret(true);
    } catch (e) {
      alert(`Failed: ${String(e)}`);
    } finally {
      setRegeneratingSecret(false);
    }
  }

  const [liveEntering, setLiveEntering] = useState<Record<string, "buy" | "sell" | null>>({});
  const [liveEnterMsg, setLiveEnterMsg] = useState<Record<string, { msg: string; ok: boolean }>>({});

  async function enterFromMonitor(
    gateSymbol: string,
    side: "buy" | "sell",
    opts?: { tpPrice?: number | null; slPrice?: number | null; strategy?: string },
  ) {
    setLiveEntering((p) => ({ ...p, [gateSymbol]: side }));
    setLiveEnterMsg((p) => { const n = { ...p }; delete n[gateSymbol]; return n; });
    const payload: Record<string, unknown> = { symbol: gateSymbol, side };
    if (opts?.tpPrice != null) payload["tpPrice"] = opts.tpPrice;
    if (opts?.slPrice != null) payload["slPrice"] = opts.slPrice;
    if (opts?.strategy)        payload["strategy"] = opts.strategy;
    try {
      const res = await api("/api/scalper/trade/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = res as { trade?: { id: number }; blocked?: string; error?: string };
      if (json.blocked) {
        setLiveEnterMsg((p) => ({ ...p, [gateSymbol]: { msg: json.blocked!, ok: false } }));
      } else if (json.error) {
        setLiveEnterMsg((p) => ({ ...p, [gateSymbol]: { msg: json.error!, ok: false } }));
      } else {
        setLiveEnterMsg((p) => ({ ...p, [gateSymbol]: { msg: `#${json.trade?.id ?? "?"} opened`, ok: true } }));
        setTimeout(() => { refetchOpen(); refetchPerf(); refetchStatus(); }, 800);
      }
    } catch (e) {
      setLiveEnterMsg((p) => ({ ...p, [gateSymbol]: { msg: String(e), ok: false } }));
    } finally {
      setLiveEntering((p) => ({ ...p, [gateSymbol]: null }));
    }
  }

  async function forceCloseTrade(id: number) {
    if (!confirm("Force-close this live position at market price now? This places an immediate market sell order on Gate.io.")) return;
    setForceClosing(id);
    try {
      await api(`/api/scalper/trade/${id}/close`, { method: "POST" });
      setTimeout(() => { refetchOpen(); refetchClosed(); refetchPerf(); refetchStatus(); }, 1000);
    } catch (e) {
      alert(`Force close failed: ${String(e)}`);
    } finally {
      setForceClosing(null);
    }
  }

  async function manualScan() {
    if (!manualSymbol.trim()) return;
    setManualScanning(true);
    setManualResult(null);
    setManualError(null);
    try {
      const result = await api<ManualScanResult>("/api/scalper/scan/symbol", {
        method: "POST",
        body: JSON.stringify({ symbol: manualSymbol.trim() }),
      });
      setManualResult(result);
    } catch (e) {
      setManualError(String(e));
    } finally {
      setManualScanning(false);
    }
  }

  async function manualEnter(side: "buy" | "sell") {
    if (!manualResult) return;
    setEntering(side);
    try {
      const body: Record<string, unknown> = { symbol: manualResult.gateSymbol, side };
      // If the detected signal matches the chosen direction, carry through strategy geometry (TP/SL/strategy)
      // so the executor uses e.g. SMC Fib levels instead of falling back to config-based computation
      if (manualResult.signal && manualResult.signal.side === side) {
        if (manualResult.signal.tpPrice != null) body["tpPrice"] = manualResult.signal.tpPrice;
        if (manualResult.signal.slPrice != null) body["slPrice"] = manualResult.signal.slPrice;
        body["strategy"] = manualResult.signal.strategy;
      }
      await api("/api/scalper/trade/manual", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setManualResult(null);
      setManualSymbol("");
      setTimeout(() => { refetchOpen(); refetchClosed(); refetchStatus(); }, 1500);
    } catch (e) {
      alert(String(e));
    } finally {
      setEntering(null);
    }
  }

  async function triggerScan() {
    setScanning(true);
    try {
      const result = await api<{ symbols: ScanRow[]; scannedAt: string }>("/api/scalper/scan");
      setScanData(result.symbols);
      setShowScan(true);
      await api("/api/scalper/scan/trigger", { method: "POST" });
      setTimeout(() => { refetchOpen(); refetchClosed(); refetchStatus(); }, 3000);
    } catch (e) {
      alert(String(e));
    } finally {
      setScanning(false);
    }
  }

  const hasDraft = Object.keys(draft).length > 0;
  // Only show error-status trades that have a confirmed entry fill (entryPrice != null).
  // Error trades with no entryPrice are failed entries — they never opened a real position.
  const openTrades = (openTrades_ ?? []).filter(
    (t) => t.status !== "error" || t.entryPrice != null
  );
  const closedTrades = closedTrades_ ?? [];

  // Equity curve from closed trades (sort ascending by close time)
  const equityCurve = [...closedTrades]
    .sort((a, b) => new Date(a.closedAt ?? a.createdAt).getTime() - new Date(b.closedAt ?? b.createdAt).getTime())
    .reduce<Array<{ idx: number; cumulative: number; pnl: number }>>((acc, t, i) => {
      const prev = acc[i - 1]?.cumulative ?? 0;
      return [...acc, { idx: i + 1, pnl: t.pnl ?? 0, cumulative: prev + (t.pnl ?? 0) }];
    }, []);

  const isEnabled = field("enabled", false);
  const isPaper = field("paperMode", true);

  return (
    <div className="space-y-6 max-w-6xl">
      {/* ─── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Zap className={`w-5 h-5 ${isEnabled ? "text-yellow-400" : "text-muted-foreground"}`} />
          <h1 className="text-lg font-bold tracking-wider">SCALPER BOT</h1>
          {isEnabled && (
            <span className={`text-xs font-bold border px-2 py-0.5 ${isPaper ? "border-violet-500/50 text-violet-400" : "border-green-500/50 text-green-400"}`}>
              {isPaper ? "PAPER" : "LIVE"}
            </span>
          )}
          {!isEnabled && (
            <span className="text-xs text-muted-foreground border border-border px-2 py-0.5">DISABLED</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={triggerScan}
            disabled={scanning}
            className="flex items-center gap-2 px-3 py-1.5 border border-border text-xs hover:border-primary/50 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${scanning ? "animate-spin" : ""}`} />
            {scanning ? "Scanning..." : "Manual Scan"}
          </button>
          <button
            onClick={toggleEnabled}
            className={`flex items-center gap-2 px-4 py-1.5 border text-xs font-bold transition-colors ${
              isEnabled
                ? "border-red-500/50 text-red-400 hover:bg-red-500/10"
                : "border-green-500/50 text-green-400 hover:bg-green-500/10"
            }`}
          >
            {isEnabled ? <><Square className="w-3.5 h-3.5" />STOP BOT</> : <><Play className="w-3.5 h-3.5" />START BOT</>}
          </button>
        </div>
      </div>

      {/* ─── Status row ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          {
            label: "USDT BALANCE",
            value: status?.usdtBalance != null ? `${status.usdtBalance.toFixed(2)} USDT` : "—",
            icon: DollarSign,
            color: "text-green-400",
          },
          {
            label: "OPEN TRADES",
            value: status?.openTrades ?? "—",
            icon: TrendingUp,
            color: "text-blue-400",
          },
          {
            label: "TOTAL TRADES",
            value: status?.totalTrades ?? "—",
            icon: BarChart3,
            color: "text-muted-foreground",
          },
          {
            label: "LAST SCAN",
            value: status?.lastScanAt ? new Date(status.lastScanAt).toLocaleTimeString() : "—",
            icon: Clock,
            color: "text-muted-foreground",
          },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="border border-border bg-secondary/20 p-4">
            <div className="text-xs text-muted-foreground tracking-widest mb-1 flex items-center gap-1.5">
              <Icon className="w-3 h-3" />{label}
            </div>
            <div className={`text-xl font-bold font-mono ${color}`}>{value}</div>
          </div>
        ))}
      </div>

      {/* ─── Performance ─────────────────────────────────────────────────────── */}
      {perf && perf.totalClosed > 0 && (
        <div className="border border-border bg-secondary/20 p-4 space-y-3">
          <div className="text-xs text-muted-foreground tracking-widest font-bold flex items-center gap-2">
            <BarChart3 className="w-3.5 h-3.5" />PERFORMANCE
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: "WIN RATE", value: perf.winRate != null ? `${perf.winRate.toFixed(1)}%` : "—", sub: `${perf.wins}W / ${perf.losses}L` },
              { label: "TOTAL P&L", value: `${perf.totalPnl >= 0 ? "+" : ""}${perf.totalPnl.toFixed(4)}`, sub: "USDT", pnl: perf.totalPnl },
              { label: "BEST TRADE", value: perf.bestPnl != null ? `${perf.bestPnl >= 0 ? "+" : ""}${perf.bestPnl.toFixed(4)}` : "—", sub: "USDT", pnl: perf.bestPnl },
              { label: "WORST TRADE", value: perf.worstPnl != null ? `${perf.worstPnl >= 0 ? "+" : ""}${perf.worstPnl.toFixed(4)}` : "—", sub: "USDT", pnl: perf.worstPnl },
            ].map(({ label, value, sub, pnl }) => (
              <div key={label}>
                <div className="text-xs text-muted-foreground tracking-widest mb-1">{label}</div>
                <div className={`text-lg font-bold font-mono ${pnl !== undefined ? pnlClass(pnl ?? null) : ""}`}>{value}</div>
                <div className="text-xs text-muted-foreground">{sub}</div>
              </div>
            ))}
          </div>

          {/* ── Strategy breakdown ── */}
          {perf.strategyStats && perf.strategyStats.length > 0 && (
            <div className="border-t border-border/40 pt-3 space-y-2">
              <div className="text-xs text-muted-foreground tracking-widest font-bold">BY STRATEGY</div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {(["bb_rsi", "smc_mss", "cht", "mrx-hybrid"] as const).map((strat) => {
                  const s = perf.strategyStats.find((x) => x.strategy === strat);
                  const label = strat === "bb_rsi" ? "BB+RSI" : strat === "smc_mss" ? "SMC MSS" : strat === "cht" ? "CHT ENGINE" : "MRX";
                  const color = strat === "bb_rsi" ? "text-cyan-400 border-cyan-500/30" : strat === "smc_mss" ? "text-violet-400 border-violet-500/30" : strat === "cht" ? "text-amber-400 border-amber-500/30" : "text-orange-400 border-orange-500/30";
                  const isBest = perf.bestModeNow?.strategy === strat && (s?.count ?? 0) > 0;
                  return (
                    <div key={strat} className={`border bg-secondary/20 px-3 py-2 relative ${isBest ? "border-yellow-500/50 bg-yellow-500/5" : "border-border/50"}`}>
                      {isBest && <span className="absolute top-1.5 right-2 text-yellow-400 text-xs">★</span>}
                      <div className={`text-xs font-bold tracking-wider ${color}`}>{label}</div>
                      {s ? (
                        <>
                          <div className={`text-base font-bold font-mono mt-0.5 ${s.winRate != null && s.winRate >= 50 ? "text-green-400" : s.winRate != null ? "text-red-400" : ""}`}>
                            {s.winRate != null ? `${s.winRate.toFixed(1)}%` : "—"}
                          </div>
                          <div className="text-xs text-muted-foreground">{s.wins}W / {s.losses}L · {s.count} trades</div>
                          <div className={`text-xs font-mono mt-0.5 ${s.totalPnl >= 0 ? "text-green-400/80" : "text-red-400/80"}`}>
                            {s.totalPnl >= 0 ? "+" : ""}{s.totalPnl.toFixed(4)} USDT
                          </div>
                        </>
                      ) : (
                        <div className="text-xs text-muted-foreground/50 mt-1">No closed trades yet</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Market condition + Best mode now ── */}
          {(perf.marketCondition || perf.bestModeNow) && (() => {
            const mc = perf.marketCondition;
            const b = perf.bestModeNow;

            const regimeColor = !mc ? "text-muted-foreground border-border/40 bg-secondary/20" :
              mc.regime === "TRENDING_BULL" ? "text-green-300 border-green-500/40 bg-green-500/8" :
              mc.regime === "TRENDING_BEAR" ? "text-red-300 border-red-500/40 bg-red-500/8" :
              mc.regime === "RANGING"       ? "text-blue-300 border-blue-500/40 bg-blue-500/8" :
              mc.regime === "VOLATILE"      ? "text-orange-300 border-orange-500/40 bg-orange-500/8" :
                                             "text-zinc-300 border-zinc-500/40 bg-zinc-500/8";

            const regimeDot = !mc ? "bg-muted-foreground" :
              mc.regime === "TRENDING_BULL" ? "bg-green-400" :
              mc.regime === "TRENDING_BEAR" ? "bg-red-400" :
              mc.regime === "RANGING"       ? "bg-blue-400" :
              mc.regime === "VOLATILE"      ? "bg-orange-400" :
                                             "bg-zinc-400";

            const stratLabel = (s: string) => s === "bb_rsi" ? "BB+RSI" : s === "smc_mss" ? "SMC MSS" : s === "cht" ? "CHT ENGINE" : "MRX";
            const stratColor = (s: string) => s === "bb_rsi" ? "text-cyan-300 border-cyan-500/50 bg-cyan-500/10" :
              s === "smc_mss" ? "text-violet-300 border-violet-500/50 bg-violet-500/10" :
              s === "cht" ? "text-amber-300 border-amber-500/50 bg-amber-500/10" :
              "text-orange-300 border-orange-500/50 bg-orange-500/10";

            // Per-strategy market fit scores for display
            const FIT_TABLE: Record<string, Record<string, number>> = {
              TRENDING_BULL: { bb_rsi: 20, smc_mss: 100, cht: 85, "mrx-hybrid": 30 },
              TRENDING_BEAR: { bb_rsi: 20, smc_mss: 100, cht: 75, "mrx-hybrid": 10 },
              RANGING:       { bb_rsi: 100, smc_mss: 40, cht: 30, "mrx-hybrid": 95 },
              VOLATILE:      { bb_rsi: 30, smc_mss: 55, cht: 90, "mrx-hybrid": 20 },
              NEUTRAL:       { bb_rsi: 60, smc_mss: 65, cht: 60, "mrx-hybrid": 65 },
            };
            const fitRow = mc ? FIT_TABLE[mc.regime] : null;

            return (
              <div className="border-t border-border/40 pt-3 space-y-2">

                {/* Market condition card */}
                {mc && (
                  <div>
                    <div className="text-xs text-muted-foreground tracking-widest font-bold mb-1.5">MARKET CONDITIONS</div>
                    <div className={`border px-3 py-2 ${regimeColor}`}>
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <div className="flex items-center gap-2">
                          <span className={`inline-block w-2 h-2 rounded-full ${regimeDot}`} />
                          <span className="font-bold tracking-wider text-sm">{mc.label}</span>
                        </div>
                        <div className="flex items-center gap-3 text-xs font-mono opacity-80">
                          <span>ADX {mc.adx}</span>
                          <span>ATR {mc.atrPct.toFixed(2)}%</span>
                          <span className={mc.btcTrend === "BULLISH" ? "text-green-400" : mc.btcTrend === "BEARISH" ? "text-red-400" : "text-zinc-400"}>
                            BTC {mc.btcTrend}
                          </span>
                        </div>
                      </div>
                      <div className="text-xs opacity-60 mt-1">{mc.description}</div>

                      {/* Per-strategy fit bars */}
                      {fitRow && (
                        <div className="mt-2 grid grid-cols-4 gap-1.5">
                          {(["bb_rsi", "smc_mss", "cht", "mrx-hybrid"] as const).map((s) => {
                            const fit = fitRow[s] ?? 50;
                            const isTop = s === mc.favoredStrategy;
                            const barColor = s === "bb_rsi" ? "bg-cyan-500" : s === "smc_mss" ? "bg-violet-500" : s === "cht" ? "bg-amber-500" : "bg-orange-500";
                            const labelC = s === "bb_rsi" ? "text-cyan-400" : s === "smc_mss" ? "text-violet-400" : s === "cht" ? "text-amber-400" : "text-orange-400";
                            return (
                              <div key={s} className={`rounded px-1.5 py-1 ${isTop ? "bg-white/5 border border-white/10" : "bg-black/20"}`}>
                                <div className={`text-[10px] font-bold ${labelC} mb-0.5`}>{stratLabel(s)}</div>
                                <div className="h-1 bg-white/10 rounded-full overflow-hidden">
                                  <div className={`h-full ${barColor} rounded-full`} style={{ width: `${fit}%` }} />
                                </div>
                                <div className="text-[10px] font-mono text-white/50 mt-0.5">{fit}% fit</div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Best mode now banner */}
                {b && (
                  <div>
                    <div className="text-xs text-muted-foreground tracking-widest font-bold mb-1.5">BEST MODE NOW</div>
                    <div className={`border px-3 py-2.5 ${stratColor(b.strategy)}`}>
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-yellow-400 text-sm">★</span>
                          <span className="font-bold tracking-wider text-sm">{stratLabel(b.strategy)}</span>
                          <span className="text-xs opacity-60">recommended</span>
                        </div>
                        <div className="flex items-center gap-3 text-xs font-mono">
                          {b.winRate != null && (
                            <span className={b.winRate >= 50 ? "text-green-400" : "text-red-400"}>
                              {b.winRate.toFixed(1)}% WR ({b.tradeCount})
                            </span>
                          )}
                          {b.totalScanned > 0 && (
                            <span className="text-yellow-400/80">{b.liveSignals}/{b.totalScanned} live</span>
                          )}
                          <span className="text-white/50">fit {b.marketFit}%</span>
                        </div>
                      </div>
                      {mc && mc.favoredStrategy === b.strategy && (
                        <div className="text-xs opacity-60 mt-1">{mc.favoredReason}</div>
                      )}
                      <div className="text-[10px] opacity-40 mt-1">Score = 40% win rate · 30% live signals · 30% market fit</div>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {equityCurve.length > 1 && (
            <div className="h-32 mt-2">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={equityCurve}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="idx" tick={{ fontSize: 10, fill: "#666" }} />
                  <YAxis tick={{ fontSize: 10, fill: "#666" }} />
                  <Tooltip
                    contentStyle={{ background: "#0d0d0d", border: "1px solid #333", fontSize: 12 }}
                    formatter={(val: number) => [`${val >= 0 ? "+" : ""}${val.toFixed(4)} USDT`, "Cumulative P&L"]}
                  />
                  <ReferenceLine y={0} stroke="#444" />
                  <Line type="monotone" dataKey="cumulative" stroke="#22c55e" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      {/* ─── Scan results ────────────────────────────────────────────────────── */}
      {showScan && scanData && (
        <div className="border border-border">
          <div className="flex items-center justify-between p-3 border-b border-border">
            <span className="text-xs font-bold tracking-widest flex items-center gap-2">
              <RefreshCw className="w-3.5 h-3.5 text-primary" />MARKET SCAN — TOP 5 USDT PAIRS (5m)
            </span>
            <button onClick={() => setShowScan(false)} className="text-xs text-muted-foreground hover:text-foreground">Hide</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  {["SYMBOL", "PRICE", "BB LOWER", "BB UPPER", "RSI", "VOL RATIO", "STRATEGY SIGNAL"].map((h) => (
                    <th key={h} className="text-left px-3 py-2">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {scanData.map((row) => (
                  <tr key={row.gateSymbol} className={`border-b border-border/50 hover:bg-secondary/20 ${row.signalDetected ? "bg-primary/5" : ""}`}>
                    <td className="px-3 py-2 font-bold">{row.gateSymbol}</td>
                    <td className="px-3 py-2">{fmt(row.lastClose, 6)}</td>
                    <td className={`px-3 py-2 ${row.nearLower ? "text-green-400 font-bold" : ""}`}>{fmt(row.bbLower, 6)}</td>
                    <td className={`px-3 py-2 ${row.nearUpper ? "text-red-400 font-bold" : ""}`}>{fmt(row.bbUpper, 6)}</td>
                    <td className={`px-3 py-2 ${row.rsi != null && row.rsi <= 35 ? "text-green-400" : row.rsi != null && row.rsi >= 65 ? "text-red-400" : ""}`}>
                      {fmt(row.rsi, 1)}
                    </td>
                    <td className={`px-3 py-2 ${row.volumeRatio != null && row.volumeRatio >= 1.5 ? "text-yellow-400" : ""}`}>
                      {fmt(row.volumeRatio, 2)}×
                    </td>
                    <td className="px-3 py-2">
                      {row.signalDetected && row.signalSide === "buy" ? (
                        <span className="text-green-400 flex items-center gap-1 font-bold"><ArrowUpRight className="w-3 h-3" />LONG ✓</span>
                      ) : row.signalDetected && row.signalSide === "sell" ? (
                        <span className="text-red-400 flex items-center gap-1 font-bold"><ArrowDownRight className="w-3 h-3" />SHORT ✓</span>
                      ) : (
                        <span className="text-muted-foreground">no signal</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ─── Live signal monitor ─────────────────────────────────────────────── */}
      <div className="border border-border">
        <div className="flex items-center justify-between p-3 border-b border-border">
          <span className="text-xs font-bold tracking-widest flex items-center gap-2">
            <Zap className="w-3.5 h-3.5 text-yellow-400" />LIVE SIGNAL MONITOR
            {liveScan?.scannedAt && (
              <span className="text-muted-foreground font-normal normal-case">
                — scanned {new Date(liveScan.scannedAt).toLocaleTimeString()} · refreshes every 2.5 min
              </span>
            )}
          </span>
          <div className="flex items-center gap-3">
            {liveScan?.results && liveScan.results.some((r) => r.bbRsi.detected || r.smc.detected || r.cht?.detected || r.mrx?.detected) && (
              <span className="text-xs font-mono text-yellow-400 font-bold animate-pulse">
                {liveScan.results.filter((r) => r.bbRsi.detected || r.smc.detected || r.cht?.detected || r.mrx?.detected).length} SIGNAL{liveScan.results.filter((r) => r.bbRsi.detected || r.smc.detected || r.cht?.detected || r.mrx?.detected).length !== 1 ? "S" : ""} ACTIVE
              </span>
            )}
            {!liveScan?.scannedAt && (
              <span className="text-xs text-muted-foreground">Waiting for first scan…</span>
            )}
          </div>
        </div>
        {liveScan?.results && liveScan.results.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="text-left px-3 py-2">SYMBOL</th>
                  <th className="text-left px-3 py-2">PRICE</th>
                  <th className="text-left px-3 py-2">RSI</th>
                  <th className="text-left px-3 py-2">VOL×</th>
                  <th className="text-left px-3 py-2 text-cyan-400">BB+RSI</th>
                  <th className="text-left px-3 py-2 text-violet-400">SMC MSS+OB</th>
                  <th className="text-left px-3 py-2 text-amber-400">CHT ENGINE</th>
                  <th className="text-left px-3 py-2 text-orange-400">MRX</th>
                  <th className="text-left px-3 py-2 text-yellow-400">ACTION</th>
                </tr>
              </thead>
              <tbody>
                {liveScan.results
                  .slice()
                  .sort((a, b) => {
                    const aHit = (a.bbRsi.detected ? 4 : 0) + (a.smc.detected ? 2 : 0) + (a.cht?.detected ? 3 : 0) + (a.mrx?.detected ? 3 : 0);
                    const bHit = (b.bbRsi.detected ? 4 : 0) + (b.smc.detected ? 2 : 0) + (b.cht?.detected ? 3 : 0) + (b.mrx?.detected ? 3 : 0);
                    return bHit - aHit;
                  })
                  .map((row) => {
                    const anySignal = row.bbRsi.detected || row.smc.detected || row.cht?.detected || row.mrx?.detected;
                    const multiSignal = [row.bbRsi.detected, row.smc.detected, row.cht?.detected, row.mrx?.detected].filter(Boolean).length >= 2;
                    return (
                      <tr
                        key={row.gateSymbol}
                        className={`border-b border-border/50 transition-colors ${
                          multiSignal ? "bg-yellow-500/10 hover:bg-yellow-500/15" :
                          anySignal ? "bg-primary/5 hover:bg-primary/10" :
                          "hover:bg-secondary/20"
                        }`}
                      >
                        <td className={`px-3 py-2.5 font-bold ${anySignal ? "text-foreground" : "text-muted-foreground"}`}>
                          <span className="flex items-center gap-1.5">
                            {row.gateSymbol.replace("_USDT", "")}
                            {row.inAllowlist && (
                              <span title="In your trading allowlist" className="text-orange-400 text-xs">▣</span>
                            )}
                            {multiSignal && <span className="text-yellow-400 text-xs">★</span>}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">{row.lastClose.toPrecision(6)}</td>
                        <td className={`px-3 py-2.5 ${row.bbRsi.rsi != null && row.bbRsi.rsi <= 35 ? "text-green-400 font-bold" : row.bbRsi.rsi != null && row.bbRsi.rsi >= 65 ? "text-red-400 font-bold" : ""}`}>
                          {row.bbRsi.rsi != null ? row.bbRsi.rsi.toFixed(1) : "—"}
                        </td>
                        <td className={`px-3 py-2.5 ${row.bbRsi.volumeRatio != null && row.bbRsi.volumeRatio >= 1.5 ? "text-yellow-400 font-bold" : "text-muted-foreground"}`}>
                          {row.bbRsi.volumeRatio != null ? `${row.bbRsi.volumeRatio.toFixed(2)}×` : "—"}
                        </td>
                        <td className="px-3 py-2.5">
                          {row.bbRsi.detected ? (
                            <span className={`inline-flex items-center gap-1 font-bold px-2 py-0.5 border ${row.bbRsi.side === "buy" ? "text-green-300 border-green-500/50 bg-green-500/15" : "text-red-300 border-red-500/50 bg-red-500/15"}`}>
                              {row.bbRsi.side === "buy" ? <><ArrowUpRight className="w-3 h-3" />LONG</> : <><ArrowDownRight className="w-3 h-3" />SHORT</>}
                              {row.bbRsi.timeframe && <span className="font-normal text-[10px] opacity-60 ml-0.5 border border-current/30 px-1">{row.bbRsi.timeframe}</span>}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          {row.smc.detected ? (
                            <span className={`inline-flex items-center gap-1 font-bold px-2 py-0.5 border ${row.smc.side === "buy" ? "text-green-300 border-green-500/50 bg-green-500/15" : "text-red-300 border-red-500/50 bg-red-500/15"}`}>
                              {row.smc.side === "buy" ? <><ArrowUpRight className="w-3 h-3" />LONG</> : <><ArrowDownRight className="w-3 h-3" />SHORT</>}
                              {row.smc.timeframe && <span className="font-normal text-[10px] opacity-60 ml-0.5 border border-current/30 px-1">{row.smc.timeframe}</span>}
                              {row.smc.obHigh != null && (
                                <span className="text-violet-300/70 ml-1 font-normal">OB {row.smc.obLow?.toPrecision(5)}–{row.smc.obHigh?.toPrecision(5)}</span>
                              )}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 min-w-[160px]">
                          {row.cht?.detected ? (() => {
                            const c = row.cht;
                            const gradeColor =
                              c.grade === "ELITE"  ? "text-amber-300 border-amber-500/50 bg-amber-500/15" :
                              c.grade === "STRONG" ? "text-yellow-300 border-yellow-500/50 bg-yellow-500/15" :
                              "text-orange-300 border-orange-500/50 bg-orange-500/15";
                            return (
                              <span className={`inline-flex items-center gap-1 font-bold px-2 py-0.5 border ${gradeColor}`}>
                                {c.side === "buy" ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                                {c.side === "buy" ? "LONG" : "SHORT"}
                                <span className="font-normal ml-1 text-[10px] opacity-80">{c.grade} {c.score}</span>
                                {c.setupType && <span className="font-normal text-[10px] opacity-60 ml-0.5">{c.setupType[0]}</span>}
                                {c.timeframe && <span className="font-normal text-[10px] opacity-50 border border-current/30 px-1 ml-0.5">{c.timeframe}</span>}
                              </span>
                            );
                          })() : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 min-w-[110px]">
                          {row.mrx?.detected ? (
                            <span className="inline-flex items-center gap-1 font-bold px-2 py-0.5 border text-orange-300 border-orange-500/50 bg-orange-500/15">
                              <ArrowUpRight className="w-3 h-3" />LONG
                              {row.mrx.timeframe && <span className="font-normal text-[10px] opacity-60 ml-0.5 border border-current/30 px-1">{row.mrx.timeframe}</span>}
                              {row.mrx.inOB && <span className="font-normal text-[10px] opacity-70 ml-0.5 border border-current/30 px-1">OB</span>}
                              {row.mrx.rsi != null && <span className="font-normal text-[10px] opacity-60 ml-0.5">RSI {row.mrx.rsi.toFixed(0)}</span>}
                              {row.mrx.atrPct != null && <span className="font-normal text-[10px] opacity-50">ATR {row.mrx.atrPct.toFixed(2)}%</span>}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 min-w-[130px]">
                          {(() => {
                            const msg = liveEnterMsg[row.gateSymbol];
                            const entering = liveEntering[row.gateSymbol];
                            if (msg) {
                              return (
                                <span className={`text-xs ${msg.ok ? "text-green-400" : "text-red-400"}`}>
                                  {msg.ok ? "✓ " : "✗ "}{msg.msg}
                                </span>
                              );
                            }
                            const sides: Array<"buy" | "sell"> = [];
                            // geometry map: per-side TP/SL/strategy to pass to executor
                            const geo: Partial<Record<"buy" | "sell", { tpPrice?: number; slPrice?: number; strategy?: string }>> = {};
                            if (row.bbRsi.detected && row.bbRsi.side) {
                              const s = row.bbRsi.side as "buy" | "sell";
                              sides.push(s);
                              geo[s] = { tpPrice: row.bbRsi.tp ?? undefined, slPrice: row.bbRsi.sl ?? undefined, strategy: "bb_rsi" };
                            }
                            if (row.smc.detected && row.smc.side && !sides.includes(row.smc.side as "buy" | "sell")) {
                              const s = row.smc.side as "buy" | "sell";
                              sides.push(s);
                              geo[s] = { tpPrice: row.smc.tp ?? undefined, slPrice: row.smc.sl ?? undefined, strategy: "smc_mss" };
                            }
                            if (row.cht?.detected && row.cht.side && !sides.includes(row.cht.side as "buy" | "sell")) {
                              const s = row.cht.side as "buy" | "sell";
                              sides.push(s);
                              geo[s] = { tpPrice: row.cht.tp1 ?? undefined, slPrice: row.cht.sl ?? undefined, strategy: "cht" };
                            }
                            if (row.mrx?.detected && !sides.includes("buy")) {
                              sides.push("buy");
                              geo["buy"] = { tpPrice: row.mrx.tp ?? undefined, slPrice: row.mrx.sl ?? undefined, strategy: "mrx-hybrid" };
                            }
                            if (sides.length === 0) return <span className="text-muted-foreground/30">—</span>;
                            return (
                              <div className="flex flex-col gap-1">
                                {sides.map((side) => (
                                  <button
                                    key={side}
                                    disabled={entering != null}
                                    onClick={() => enterFromMonitor(row.gateSymbol, side, geo[side])}
                                    className={`inline-flex items-center gap-1 px-2 py-0.5 border text-xs font-bold transition-opacity disabled:opacity-50 ${
                                      side === "buy"
                                        ? "border-green-500/70 bg-green-500/20 text-green-300 hover:bg-green-500/35"
                                        : "border-red-500/70 bg-red-500/20 text-red-300 hover:bg-red-500/35"
                                    }`}
                                  >
                                    {entering === side ? (
                                      <span className="animate-pulse">Entering…</span>
                                    ) : side === "buy" ? (
                                      <><ArrowUpRight className="w-3 h-3" />ENTER LONG</>
                                    ) : (
                                      <><ArrowDownRight className="w-3 h-3" />ENTER SHORT</>
                                    )}
                                  </button>
                                ))}
                              </div>
                            );
                          })()}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-6 text-center text-muted-foreground text-sm">
            {liveScan?.scannedAt ? "No symbols in scan results — check allowlist configuration" : "First scan runs 10 seconds after server start…"}
          </div>
        )}
      </div>

      {/* ─── Open trades ─────────────────────────────────────────────────────── */}
      <div className="border border-border">
        <div className="flex items-center justify-between p-3 border-b border-border">
          <span className="text-xs font-bold tracking-widest flex items-center gap-2">
            <TrendingUp className="w-3.5 h-3.5 text-blue-400" />OPEN POSITIONS ({openTrades.length})
          </span>
        </div>
        {openTrades.length === 0 ? (
          <div className="p-6 text-center text-muted-foreground text-sm">No open positions</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  {["SYMBOL", "SIDE", "ENTRY", "LIVE", "TP", "SL", "SIZE", "P&L", "RSI", "ACTION"].map((h) => (
                    <th key={h} className="text-left px-3 py-2">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {openTrades.map((t) => {
                  const unprotected = !t.paperMode && !t.tpOrderId && !t.slOrderId;
                  return (
                  <tr key={t.id} className={`border-b border-border/50 hover:bg-secondary/20 ${unprotected ? "bg-red-500/5" : ""}`}>
                    <td className="px-3 py-2 font-bold">
                      <div className="flex items-center gap-1.5">
                        {t.symbol}
                        {unprotected && (
                          <span
                            title={t.errorMessage ?? "TP/SL orders not placed on Gate.io — position is unprotected. Sync will retry."}
                            className="text-red-400 animate-pulse cursor-help"
                          >
                            ⚠
                          </span>
                        )}
                      </div>
                      {unprotected && (
                        <div className="text-red-400/70 text-xs font-normal mt-0.5 max-w-[140px] truncate" title={t.errorMessage ?? ""}>
                          {t.errorMessage ? t.errorMessage.split("|")[0]?.trim().replace(/Gate\.io \d+: /, "") : "no TP/SL on exchange"}
                        </div>
                      )}
                    </td>
                    <td className={`px-3 py-2 font-bold ${t.side === "buy" ? "text-green-400" : "text-red-400"}`}>
                      {t.side === "buy" ? "LONG" : "SHORT"}
                    </td>
                    <td className="px-3 py-2">{fmt(t.entryPrice, 6)}</td>
                    <td className="px-3 py-2">{fmt(t.livePrice, 6)}</td>
                    <td className={`px-3 py-2 ${t.tpOrderId ? "text-green-400" : "text-green-400/40"}`}>{fmt(t.tpPrice, 6)}</td>
                    <td className={`px-3 py-2 ${t.slOrderId ? "text-red-400" : "text-red-400/40"}`}>{fmt(t.slPrice, 6)}</td>
                    <td className="px-3 py-2">{fmt(t.positionSizeUsdt, 2)}</td>
                    <td className={`px-3 py-2 font-bold ${pnlClass(t.pnl)}`}>
                      {t.pnl != null ? `${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(4)}` : "—"}
                    </td>
                    <td className="px-3 py-2">{fmt(t.rsi, 1)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        {!t.paperMode && (
                          <button
                            onClick={() => forceCloseTrade(t.id)}
                            disabled={forceClosing === t.id}
                            title="Close position at market price via Gate.io immediately"
                            className="text-orange-400 hover:text-orange-300 text-xs border border-orange-500/40 px-2 py-0.5 hover:border-orange-400/60 transition-colors disabled:opacity-50"
                          >
                            {forceClosing === t.id ? "Closing…" : "Close Now"}
                          </button>
                        )}
                        <button
                          onClick={() => cancelTrade(t.id)}
                          className="text-muted-foreground hover:text-red-300 text-xs border border-border hover:border-red-500/30 px-2 py-0.5 transition-colors"
                          title="Cancel DB tracking only (does NOT close the Gate.io position)"
                        >
                          Cancel
                        </button>
                      </div>
                    </td>
                  </tr>
                );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ─── Trade history ────────────────────────────────────────────────────── */}
      {closedTrades.length > 0 && (
        <div className="border border-border">
          <div className="flex items-center justify-between p-3 border-b border-border">
            <span className="text-xs font-bold tracking-widest">
              TRADE HISTORY ({status?.totalTrades != null ? status.totalTrades - openTrades.length : closedTrades.length})
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  {["SYMBOL", "SIDE", "ENTRY", "EXIT", "TP", "P&L", "REASON", "MODE", "TIME"].map((h) => (
                    <th key={h} className="text-left px-3 py-2">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {closedTrades.map((t) => (
                  <tr key={t.id} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="px-3 py-2 font-bold">{t.symbol}</td>
                    <td className={`px-3 py-2 ${t.side === "buy" ? "text-green-400" : "text-red-400"}`}>
                      {t.side === "buy" ? "LONG" : "SHORT"}
                    </td>
                    <td className="px-3 py-2">{fmt(t.entryPrice, 6)}</td>
                    <td className="px-3 py-2">{fmt(t.closePrice, 6)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{fmt(t.tpPrice, 6)}</td>
                    <td className={`px-3 py-2 font-bold ${pnlClass(t.pnl)}`}>
                      {t.pnl != null ? `${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(4)}` : "—"}
                    </td>
                    <td className={`px-3 py-2 ${t.closeReason === "tp" ? "text-green-400" : t.closeReason === "sl" ? "text-red-400" : "text-muted-foreground"}`}>
                      {t.closeReason?.toUpperCase() ?? "—"}
                    </td>
                    <td className={`px-3 py-2 text-xs ${t.paperMode ? "text-violet-400" : "text-green-400"}`}>
                      {t.paperMode ? "PAPER" : "LIVE"}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {t.closedAt ? new Date(t.closedAt).toLocaleString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ─── Configuration ───────────────────────────────────────────────────── */}
      <div className="border border-border">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <span className="text-xs text-muted-foreground tracking-widest font-bold">CONFIGURATION</span>
          {hasDraft && (
            <button
              onClick={save}
              disabled={saving}
              className="text-xs font-bold border border-primary/50 text-primary px-4 py-1.5 hover:bg-primary/10 transition-colors disabled:opacity-50"
            >
              {saving ? "Saving..." : "SAVE CHANGES"}
            </button>
          )}
        </div>

        {/* Strategy selector */}
        <div className="p-4 border-b border-border space-y-3">
          <label className="text-xs text-muted-foreground tracking-widest">STRATEGY ENGINE</label>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <button
              onClick={() => set("strategy", "bb_rsi")}
              className={`p-3 text-left border transition-colors ${field("strategy", "bb_rsi") === "bb_rsi" ? "border-primary bg-primary/10" : "border-border bg-secondary/30 hover:border-border/80"}`}
            >
              <div className={`text-sm font-bold mb-1 font-mono ${field("strategy", "bb_rsi") === "bb_rsi" ? "text-primary" : "text-muted-foreground"}`}>BB + RSI</div>
              <div className="text-xs text-muted-foreground leading-relaxed">Mean-reversion scalper. Enters on Bollinger Band touch + RSI extreme + volume spike. Fast, frequent signals on any liquid pair.</div>
            </button>
            <button
              onClick={() => set("strategy", "smc_mss")}
              className={`p-3 text-left border transition-colors ${field("strategy", "bb_rsi") === "smc_mss" ? "border-violet-500 bg-violet-500/10" : "border-border bg-secondary/30 hover:border-border/80"}`}
            >
              <div className={`text-sm font-bold mb-1 font-mono ${field("strategy", "bb_rsi") === "smc_mss" ? "text-violet-400" : "text-muted-foreground"}`}>SMC — MSS + OB+ + Fib</div>
              <div className="text-xs text-muted-foreground leading-relaxed">Smart Money. Detects Market Structure Shifts, finds the Order Block, and enters on candle-close confirmation inside the OB. TP = Fib 4.236 extension.</div>
            </button>
            <button
              onClick={() => set("strategy", "cht")}
              className={`p-3 text-left border transition-colors ${field("strategy", "bb_rsi") === "cht" ? "border-amber-500 bg-amber-500/10" : "border-border bg-secondary/30 hover:border-border/80"}`}
            >
              <div className={`text-sm font-bold mb-1 font-mono ${field("strategy", "bb_rsi") === "cht" ? "text-amber-400" : "text-muted-foreground"}`}>CHT Engine</div>
              <div className="text-xs text-muted-foreground leading-relaxed">Crypto Hybrid Trading Intelligence. Trend + MSS + Trigger + HTF + TAO consensus (6 experts). Graded ELITE/STRONG/MEDIUM. TP = 1.5R.</div>
            </button>
            <button
              onClick={() => set("strategy", "mrx-hybrid")}
              className={`p-3 text-left border transition-colors ${field("strategy", "bb_rsi") === "mrx-hybrid" ? "border-orange-500 bg-orange-500/10" : "border-border bg-secondary/30 hover:border-border/80"}`}
            >
              <div className={`text-sm font-bold mb-1 font-mono ${field("strategy", "bb_rsi") === "mrx-hybrid" ? "text-orange-400" : "text-muted-foreground"}`}>MRX — Mean Reversion Xpress</div>
              <div className="text-xs text-muted-foreground leading-relaxed">Oversold snap on 1m + 3m candles (1m evaluated first). 7-gate evaluator (BB lower + RSI ≤ 25 + ATR + BB width + vol spike + HTF EMA + pump guard). LONG ONLY · TP +0.28% · SL −2.5%.</div>
            </button>
          </div>
        </div>

        {/* MRX Status panel — shown always so the user can see MRX params and auto-pause state */}
        <MrxStatusPanel />

        {/* MRX Performance — compact timeframe breakdown from bot analytics */}
        <MrxPerformancePanel data={botAnalytics?.byMrxTf ?? []} />

        <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Paper Mode */}
          <div className={`flex items-center justify-between p-4 border transition-colors ${field("paperMode", true) ? "border-violet-500/60 bg-violet-500/10" : "border-green-500/60 bg-green-500/10"}`}>
            <div>
              <div className={`text-sm font-bold mb-0.5 ${field("paperMode", true) ? "text-violet-300" : "text-green-300"}`}>Paper Mode</div>
              <div className="text-xs text-muted-foreground">
                {field("paperMode", true) ? "Simulating — no real orders placed" : "LIVE — real Gate.io orders firing"}
              </div>
            </div>
            <button
              onClick={() => set("paperMode", !field("paperMode", true))}
              className={`flex items-center gap-2 px-4 py-2 text-xs font-mono font-bold border transition-colors ${
                field("paperMode", true)
                  ? "border-violet-500 bg-violet-500/20 text-violet-300 hover:bg-violet-500/30"
                  : "border-green-500 bg-green-500/20 text-green-300 hover:bg-green-500/30"
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${field("paperMode", true) ? "bg-violet-400" : "bg-green-400"}`} />
              {field("paperMode", true) ? "PAPER" : "LIVE"}
            </button>
          </div>

          {/* Long Only */}
          <div className={`flex items-center justify-between p-4 border transition-colors ${field("longOnly", false) ? "border-blue-500/60 bg-blue-500/10" : "border-border bg-secondary/30"}`}>
            <div>
              <div className={`text-sm font-bold mb-0.5 flex items-center gap-2 ${field("longOnly", false) ? "text-blue-300" : "text-foreground"}`}>
                <ArrowUpRight className="w-3.5 h-3.5" />Long Only
              </div>
              <div className="text-xs text-muted-foreground">
                {field("longOnly", false) ? "LONG signals only — SHORT signals skipped" : "Both LONG and SHORT signals allowed"}
              </div>
            </div>
            <button
              onClick={() => set("longOnly", !field("longOnly", false))}
              className={`flex items-center gap-2 px-4 py-2 text-xs font-mono font-bold border transition-colors ${
                field("longOnly", false)
                  ? "border-blue-500 bg-blue-500/20 text-blue-300 hover:bg-blue-500/30"
                  : "border-border bg-secondary text-muted-foreground hover:border-blue-500/50 hover:text-blue-300"
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${field("longOnly", false) ? "bg-blue-400" : "bg-muted-foreground/40"}`} />
              {field("longOnly", false) ? "ON" : "OFF"}
            </button>
          </div>

          {/* Target Profit */}
          <div className="space-y-3">
            <label className="text-xs text-muted-foreground tracking-widest flex items-center gap-2">
              <DollarSign className="w-3 h-3" />TARGET PROFIT PER TRADE
            </label>
            {(() => {
              const rawTpMode = field("tpMode", "fixed_usdt") as string;
              const isDynamic = field("dynamicTp", false) as boolean;
              const tpPct = field("targetProfitPct", null) as number | null;
              // Normalise: legacy records may not have tpMode set yet
              const tpMode = rawTpMode === "micro_2usd" ? "micro"
                : rawTpMode === "mrx_fixed" ? "mrx"
                : isDynamic ? "auto"
                : tpPct != null ? "pct"
                : "usdt";
              return (
                <>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                    <button
                      onClick={() => { set("tpMode", "fixed_usdt"); set("dynamicTp", false); set("targetProfitPct", null); }}
                      className={`py-1.5 text-xs font-mono border transition-colors ${tpMode === "usdt" ? "border-primary bg-primary/10 text-primary" : "border-border bg-secondary text-muted-foreground"}`}
                    >FIXED USDT</button>
                    <button
                      onClick={() => { set("tpMode", "fixed_pct"); set("dynamicTp", false); if (tpPct == null) set("targetProfitPct", 1); }}
                      className={`py-1.5 text-xs font-mono border transition-colors ${tpMode === "pct" ? "border-emerald-500 bg-emerald-500/10 text-emerald-400" : "border-border bg-secondary text-muted-foreground"}`}
                    >% OF ENTRY</button>
                    <button
                      onClick={() => { set("tpMode", "dynamic_bb"); set("dynamicTp", true); set("targetProfitPct", null); }}
                      className={`py-1.5 text-xs font-mono border transition-colors ${tpMode === "auto" ? "border-violet-500 bg-violet-500/10 text-violet-300" : "border-border bg-secondary text-muted-foreground"}`}
                    >AUTO BB</button>
                    <button
                      onClick={() => { set("tpMode", "micro_2usd"); set("dynamicTp", false); set("targetProfitPct", null); set("longOnly", true); }}
                      className={`py-1.5 text-xs font-mono border transition-colors ${tpMode === "micro" ? "border-yellow-500 bg-yellow-500/10 text-yellow-300" : "border-border bg-secondary text-muted-foreground"}`}
                    >MICRO $2</button>
                    <button
                      onClick={() => { set("tpMode", "mrx_fixed"); set("dynamicTp", false); set("targetProfitPct", null); set("longOnly", true); }}
                      className={`py-1.5 text-xs font-mono border transition-colors ${tpMode === "mrx" ? "border-orange-500 bg-orange-500/10 text-orange-300" : "border-border bg-secondary text-muted-foreground"}`}
                    >MRX FIXED</button>
                  </div>
                  {tpMode === "usdt" && (
                    <>
                      <input
                        type="number" min={0.1} step={0.5}
                        value={field("targetProfitUsdt", 2) as number}
                        onChange={(e) => set("targetProfitUsdt", parseFloat(e.target.value))}
                        className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
                      />
                      <p className="text-xs text-muted-foreground">TP placed to achieve this fixed $ profit on the full position</p>
                    </>
                  )}
                  {tpMode === "pct" && (
                    <>
                      <div className="flex items-center gap-2">
                        <input
                          type="number" min={0.1} max={20} step={0.1}
                          value={tpPct ?? 1}
                          onChange={(e) => set("targetProfitPct", parseFloat(e.target.value))}
                          className="flex-1 bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-emerald-500"
                        />
                        <span className="text-emerald-400 font-mono font-bold text-lg">%</span>
                      </div>
                      <p className="text-xs text-muted-foreground">TP placed this % above entry (long) or below (short) — adapts to any position size</p>
                    </>
                  )}
                  {tpMode === "auto" && (
                    <p className="text-xs text-violet-300/80 border border-violet-500/30 bg-violet-500/10 px-3 py-2">
                      Bot targets the opposite Bollinger Band — upper band for longs, lower band for shorts. Applies to both BB+RSI and SMC strategies, overriding Fibonacci targets. TP adapts to current market volatility automatically.
                    </p>
                  )}
                  {tpMode === "micro" && (
                    <div className="space-y-2">
                      <div className="border border-yellow-500/40 bg-yellow-500/5 px-3 py-2.5 space-y-1.5">
                        <div className="text-yellow-300 text-xs font-bold tracking-wider">MICRO $2 SNIPER MODE</div>
                        <div className="text-xs text-muted-foreground leading-relaxed">
                          Position is auto-sized so that <span className="text-yellow-300">1R = target profit</span>. Two TP tiers:
                        </div>
                        <div className="grid grid-cols-2 gap-1 text-xs font-mono">
                          <div className="bg-green-500/10 border border-green-500/30 px-2 py-1">
                            <span className="text-green-400">TP1</span> · 1R · 50% exit → SL→BE
                          </div>
                          <div className="bg-green-500/10 border border-green-500/30 px-2 py-1">
                            <span className="text-green-400">TP2</span> · 2R · 50% exit → full close
                          </div>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Set the target $ below — position size adapts automatically to hit it.
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground font-mono">TARGET $</span>
                        <input
                          type="number" min={0.5} step={0.5}
                          value={field("targetProfitUsdt", 2) as number}
                          onChange={(e) => set("targetProfitUsdt", parseFloat(e.target.value))}
                          className="flex-1 bg-secondary border border-yellow-500/40 px-3 py-2 text-sm font-mono focus:outline-none focus:border-yellow-400 text-yellow-300"
                        />
                        <span className="text-yellow-400 font-mono font-bold text-lg">USDT</span>
                      </div>
                    </div>
                  )}
                  {tpMode === "mrx" && (
                    <div className="border border-orange-500/40 bg-orange-500/5 px-3 py-2.5 space-y-2">
                      <div className="text-orange-300 text-xs font-bold tracking-wider">MRX FIXED PARAMETERS</div>
                      <div className="text-xs text-muted-foreground leading-relaxed">
                        Hardcoded TP/SL tuned for the MRX oversold-snap setup on 1m + 3m candles. These values are fixed and cannot be adjusted — the engine is calibrated around them.
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                        <div className="bg-green-500/10 border border-green-500/30 px-2 py-1.5">
                          <div className="text-green-400 font-bold">TP +0.28%</div>
                          <div className="text-muted-foreground text-[10px]">entry × 1.0028</div>
                        </div>
                        <div className="bg-red-500/10 border border-red-500/30 px-2 py-1.5">
                          <div className="text-red-400 font-bold">SL −2.5%</div>
                          <div className="text-muted-foreground text-[10px]">entry × 0.975</div>
                        </div>
                      </div>
                      <div className="text-[10px] text-orange-400/70 font-mono">
                        Risk/Reward ≈ 1 : 8.9 · LONG ONLY · 100% USDT balance · Best fit: RANGING market
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
          </div>

          {/* SL % */}
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground tracking-widest flex items-center gap-2">
              <Shield className="w-3 h-3" />STOP LOSS (% FROM ENTRY)
            </label>
            <input
              type="number" min={0.1} max={5} step={0.1}
              value={field("slPct", 0.5) as number}
              onChange={(e) => set("slPct", parseFloat(e.target.value))}
              className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
            />
            <p className="text-xs text-muted-foreground">SL placed this % against entry price</p>
          </div>

          {/* Position Size */}
          <div className="space-y-3">
            <label className="text-xs text-muted-foreground tracking-widest">POSITION SIZE</label>
            {/* Mode toggle */}
            <div className="flex gap-2">
              <button
                onClick={() => { set("positionSizePct", null); }}
                className={`flex-1 py-1.5 text-xs font-mono border transition-colors ${(field("positionSizePct", null) == null) ? "border-primary bg-primary/10 text-primary" : "border-border bg-secondary text-muted-foreground"}`}
              >FIXED USDT</button>
              <button
                onClick={() => { if (field("positionSizePct", null) == null) set("positionSizePct", 30); }}
                className={`flex-1 py-1.5 text-xs font-mono border transition-colors ${(field("positionSizePct", null) != null) ? "border-cyan-500 bg-cyan-500/10 text-cyan-400" : "border-border bg-secondary text-muted-foreground"}`}
              >% OF BALANCE</button>
            </div>
            {field("positionSizePct", null) == null ? (
              <>
                <input
                  type="number" min={1}
                  value={field("positionSizeUsdt", 50) as number}
                  onChange={(e) => set("positionSizeUsdt", parseFloat(e.target.value))}
                  className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
                />
                <p className="text-xs text-muted-foreground">Fixed USDT amount per trade</p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min={1} max={100}
                    value={field("positionSizePct", 30) as number}
                    onChange={(e) => set("positionSizePct", parseFloat(e.target.value))}
                    className="flex-1 bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-cyan-500"
                  />
                  <span className="text-cyan-400 font-mono font-bold text-lg">%</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Uses this % of your live USDT balance per trade — compounds automatically as balance grows
                </p>
              </>
            )}
          </div>

          {/* Max Open Trades */}
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground tracking-widest">MAX OPEN TRADES</label>
            <input
              type="number" min={1} max={20}
              value={field("maxOpenTrades", 3) as number}
              onChange={(e) => set("maxOpenTrades", parseInt(e.target.value))}
              className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
            />
          </div>

          {/* Cooldown */}
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground tracking-widest">COOLDOWN (MINUTES)</label>
            <input
              type="number" min={0}
              value={field("cooldownMinutes", 5) as number}
              onChange={(e) => set("cooldownMinutes", parseInt(e.target.value))}
              className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
            />
            <p className="text-xs text-muted-foreground">Min wait between trades on the same symbol (0 = off)</p>
          </div>

          {/* Compounding */}
          <div className={`flex items-center justify-between p-4 border transition-colors ${field("compoundingEnabled", false) ? "border-yellow-500/60 bg-yellow-500/10" : "border-border bg-secondary/30"}`}>
            <div>
              <div className={`text-sm font-bold mb-0.5 ${field("compoundingEnabled", false) ? "text-yellow-300" : "text-foreground"}`}>Compounding</div>
              <div className="text-xs text-muted-foreground">
                {field("compoundingEnabled", false) ? "Profits reinvested — balance grows each trade" : "Fixed size — balance not reinvested"}
              </div>
            </div>
            <button
              onClick={() => set("compoundingEnabled", !field("compoundingEnabled", false))}
              className={`flex items-center gap-2 px-4 py-2 text-xs font-mono font-bold border transition-colors ${
                field("compoundingEnabled", false)
                  ? "border-yellow-500 bg-yellow-500/20 text-yellow-300 hover:bg-yellow-500/30"
                  : "border-border bg-secondary text-muted-foreground hover:border-yellow-500/50 hover:text-yellow-300"
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${field("compoundingEnabled", false) ? "bg-yellow-400" : "bg-muted-foreground/40"}`} />
              {field("compoundingEnabled", false) ? "ON" : "OFF"}
            </button>
          </div>

          {/* Gate.io key restriction checker */}
          <GateKeyRestrictionPanel onSync={(pairs) => set("symbolAllowlist", pairs.length > 0 ? pairs.join(", ") : null)} />

          {/* Bot-side Trading Allowlist */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs text-muted-foreground tracking-widest flex items-center gap-2">
                <span className="text-orange-400">▣</span> BOT FILTER (OPTIONAL)
              </label>
            </div>
            <textarea
              rows={3}
              placeholder={"BTC_USDT, ETH_USDT, SOL_USDT\n(leave blank = trade any scanned pair)"}
              value={(field("symbolAllowlist", null) as string | null) ?? ""}
              onChange={(e) => set("symbolAllowlist", e.target.value.trim() === "" ? null : e.target.value)}
              className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-orange-400 resize-none"
            />
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                <span className="text-green-400 font-mono">SCAN</span> — candle data is a public endpoint, your API key is never involved. Leave blank to trade any pair from the scan pool.
              </p>
              <p className="text-xs text-muted-foreground">
                <span className="text-orange-400 font-mono">TRADE</span> — if set, only these pairs are eligible for order placement. Signals on other pairs are detected but skipped. Manual entry always overrides this.
              </p>
            </div>
          </div>

          {/* Scan pool size */}
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground tracking-widest flex items-center gap-2">
              <span className="text-cyan-400">▣</span> SCAN POOL SIZE
            </label>
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={5}
                max={100}
                step={5}
                value={field("scanPoolSize", 20)}
                onChange={(e) => set("scanPoolSize", parseInt(e.target.value) || 20)}
                className="w-24 bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-cyan-400"
              />
              <span className="text-xs text-muted-foreground">pairs scanned per cycle when no allowlist is set</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Top-N USDT pairs by 24h volume are scanned for signals. Allowlist pairs are always included first, then volume fills the remaining slots up to this limit. Higher = more market coverage, slightly more API calls per 2.5-min cycle.
            </p>
          </div>

          {/* TradingView Webhook */}
          {(() => {
            const secret = config?.webhookSecret ?? null;
            const origin = window.location.origin;
            const webhookUrl = `${origin}/api/scalper/webhook?secret=${secret ?? ""}`;
            return (
              <div className="space-y-3 border border-violet-500/30 bg-violet-500/5 p-3">
                <label className="text-xs text-violet-400 tracking-widest flex items-center gap-2">
                  <Link2 className="w-3 h-3" />TRADINGVIEW WEBHOOK
                </label>

                {/* URL row */}
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">Alert URL (POST)</div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 bg-secondary border border-border px-2 py-1.5 text-xs font-mono truncate text-muted-foreground">
                      {origin}/api/scalper/webhook?secret=
                      <span className="text-violet-300">{showWebhookSecret ? (secret ?? "—") : "••••••••••••"}</span>
                    </code>
                    <button
                      onClick={async () => {
                        if (!secret) return;
                        await navigator.clipboard.writeText(webhookUrl);
                        setWebhookCopied(true);
                        setTimeout(() => setWebhookCopied(false), 2000);
                      }}
                      title="Copy full URL"
                      className="shrink-0 p-2 border border-border hover:border-violet-400 transition-colors"
                    >
                      {webhookCopied ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      onClick={() => setShowWebhookSecret((v) => !v)}
                      title={showWebhookSecret ? "Hide secret" : "Reveal secret"}
                      className="shrink-0 p-2 border border-border hover:border-violet-400 transition-colors"
                    >
                      {showWebhookSecret ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      onClick={regenerateWebhookSecret}
                      disabled={regeneratingSecret}
                      title="Rotate secret"
                      className="shrink-0 p-2 border border-border hover:border-red-400 hover:text-red-400 transition-colors disabled:opacity-50"
                    >
                      <RotateCcw className={`w-3.5 h-3.5 ${regeneratingSecret ? "animate-spin" : ""}`} />
                    </button>
                  </div>
                </div>

                {/* Alert message template */}
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">TradingView alert message — paste as-is:</div>
                  <pre className="bg-secondary border border-border px-3 py-2 text-xs font-mono text-violet-200 select-all">{`{"symbol":"{{ticker}}","side":"{{strategy.order.action}}"}`}</pre>
                  <div className="text-xs text-muted-foreground space-y-0.5">
                    <div>Set alert <span className="text-violet-300 font-mono">Webhook URL</span> to the URL above, method <span className="text-violet-300 font-mono">POST</span>.</div>
                    <div>Optional extra fields: <span className="text-violet-300 font-mono">"tp": 1.23, "sl": 0.98</span> (absolute prices) · <span className="text-violet-300 font-mono">"force": true</span> (skip duplicate/cooldown guards).</div>
                    <div>Accepted sides: <span className="text-green-400 font-mono">buy / long</span> · <span className="text-red-400 font-mono">sell / short</span>.</div>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>

        {/* Advanced / Signal params — only relevant for BB+RSI strategy */}
        {field("strategy", "bb_rsi") === "bb_rsi" && (
          <div className="border-t border-border">
            <button
              onClick={() => setShowAdvanced((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-3 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/20 transition-colors"
            >
              <span className="tracking-widest font-bold">SIGNAL PARAMETERS (BB / RSI / EMA / VOLUME)</span>
              {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>

            {showAdvanced && (
              <div className="p-4 space-y-4 bg-secondary/10">
                {/* EMA Trend Filter */}
                <div className="flex items-center justify-between p-3 border border-border bg-secondary/30">
                  <div>
                    <div className="text-sm font-bold mb-0.5 flex items-center gap-2">
                      <span className="text-yellow-400 font-mono text-xs">EMA</span> Trend Filter
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Only LONG when price &gt; {field("emaPeriod", 50)}-EMA (uptrend). Only SHORT when price &lt; EMA (downtrend). Blocks mean-reversion against the trend.
                    </div>
                  </div>
                  <button
                    onClick={() => set("emaFilterEnabled", !field("emaFilterEnabled", true))}
                    className={`ml-4 relative w-12 h-6 flex-shrink-0 rounded-full border transition-colors ${field("emaFilterEnabled", true) ? "border-yellow-500 bg-yellow-500/20" : "border-border bg-secondary"}`}
                  >
                    <span className={`absolute top-0.5 w-5 h-5 rounded-full transition-all ${field("emaFilterEnabled", true) ? "left-6 bg-yellow-400" : "left-0.5 bg-muted-foreground/50"}`} />
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs text-muted-foreground tracking-widest">EMA PERIOD</label>
                    <input
                      type="number" min={5} max={200} step={1}
                      value={field("emaPeriod", 50) as number}
                      onChange={(e) => set("emaPeriod", parseInt(e.target.value))}
                      className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-yellow-400"
                    />
                  </div>
                  {[
                    { key: "bbPeriod", label: "BB PERIOD", min: 5, max: 50, step: 1, fallback: 20 },
                    { key: "bbStdDev", label: "BB STD DEV (σ)", min: 1, max: 4, step: 0.1, fallback: 2.0 },
                    { key: "rsiPeriod", label: "RSI PERIOD", min: 5, max: 30, step: 1, fallback: 14 },
                    { key: "rsiOversold", label: "RSI OVERSOLD", min: 10, max: 45, step: 1, fallback: 30 },
                    { key: "rsiOverbought", label: "RSI OVERBOUGHT", min: 55, max: 90, step: 1, fallback: 70 },
                    { key: "volumeSpikeMultiplier", label: "VOLUME SPIKE (×)", min: 1, max: 5, step: 0.1, fallback: 1.5 },
                  ].map(({ key, label, min, max, step, fallback }) => (
                    <div key={key} className="space-y-1.5">
                      <label className="text-xs text-muted-foreground tracking-widest">{label}</label>
                      <input
                        type="number" min={min} max={max} step={step}
                        value={field(key as keyof ScalperConfig, fallback) as number}
                        onChange={(e) => set(key as keyof ScalperConfig, parseFloat(e.target.value) as never)}
                        className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
                      />
                    </div>
                  ))}
                </div>

                <div className="text-xs text-muted-foreground bg-secondary/30 border border-border p-3 space-y-1">
                  <div>Entry conditions (all must be met simultaneously):</div>
                  <div className="text-green-400">LONG: price ≤ BB lower  AND  RSI ≤ {field("rsiOversold", 30)}  AND  volume ≥ {fmt(field("volumeSpikeMultiplier", 1.5), 1)}×{field("emaFilterEnabled", true) ? "  AND  price > EMA" : ""}</div>
                  <div className="text-red-400">SHORT: price ≥ BB upper  AND  RSI ≥ {field("rsiOverbought", 70)}  AND  volume ≥ {fmt(field("volumeSpikeMultiplier", 1.5), 1)}×{field("emaFilterEnabled", true) ? "  AND  price < EMA" : ""}</div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* PHASE 2: QUALITY & FILTERS — adaptive thresholds, quality-aware sizing, funding-rate filters */}
        <div className="border-t border-border">
          <button
            onClick={() => setShowQualityFilters((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-3 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/20 transition-colors"
          >
            <span className="tracking-widest font-bold">
              <span className="text-cyan-400">◆</span> QUALITY &amp; FILTERS (PHASE 2)
            </span>
            {showQualityFilters ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>

          {showQualityFilters && (
            <div className="p-4 space-y-4 bg-cyan-500/5 border-l-2 border-cyan-500/30">
              {/* ── Adaptive RSI thresholds (BB+RSI only) ───────────────────── */}
              {field("strategy", "bb_rsi") === "bb_rsi" && (
                <div className="border border-border bg-secondary/30 p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-bold mb-0.5 flex items-center gap-2">
                        <span className="text-cyan-400 font-mono text-xs">RSI</span> Adaptive Thresholds
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Replace fixed RSI {field("rsiOversold", 30)}/{field("rsiOverbought", 70)} cutoffs with rolling per-symbol quantiles.
                        Quiet markets get tighter bounds; volatile markets get wider ones. Floors prevent firing at neutral RSI.
                      </div>
                    </div>
                    <button
                      onClick={() => set("adaptiveThresholds", !field("adaptiveThresholds", false))}
                      className={`ml-4 relative w-12 h-6 flex-shrink-0 rounded-full border transition-colors ${field("adaptiveThresholds", false) ? "border-cyan-500 bg-cyan-500/20" : "border-border bg-secondary"}`}
                    >
                      <span className={`absolute top-0.5 w-5 h-5 rounded-full transition-all ${field("adaptiveThresholds", false) ? "left-6 bg-cyan-400" : "left-0.5 bg-muted-foreground/50"}`} />
                    </button>
                  </div>

                  {field("adaptiveThresholds", false) && (
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 pt-2 border-t border-border/50">
                      {[
                        { key: "adaptiveWindow", label: "WINDOW (BARS)", min: 20, max: 500, step: 10, fallback: 100 },
                        { key: "adaptiveLowQ", label: "LOW QUANTILE", min: 0.01, max: 0.20, step: 0.01, fallback: 0.05 },
                        { key: "adaptiveHighQ", label: "HIGH QUANTILE", min: 0.80, max: 0.99, step: 0.01, fallback: 0.95 },
                        { key: "adaptiveRsiLowFloor", label: "OVERSOLD FLOOR", min: 20, max: 45, step: 1, fallback: 35 },
                        { key: "adaptiveRsiHighFloor", label: "OVERBOUGHT FLOOR", min: 55, max: 80, step: 1, fallback: 65 },
                      ].map(({ key, label, min, max, step, fallback }) => (
                        <div key={key} className="space-y-1">
                          <label className="text-[10px] text-muted-foreground tracking-widest">{label}</label>
                          <input
                            type="number" min={min} max={max} step={step}
                            value={field(key as keyof ScalperConfig, fallback) as number}
                            onChange={(e) => set(key as keyof ScalperConfig, parseFloat(e.target.value) as never)}
                            className="w-full bg-secondary border border-border px-2 py-1 text-xs font-mono focus:outline-none focus:border-cyan-400"
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── Quality-aware sizing (all strategies) ─────────────────── */}
              <div className="border border-border bg-secondary/30 p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-bold mb-0.5 flex items-center gap-2">
                      <span className="text-cyan-400 font-mono text-xs">SIZE</span> Quality-Aware Sizing
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Scale position size by the signal's [0,1] quality score.
                      <code className="text-cyan-300/80"> size = base × ({fmt(field("qualitySizeFloorPct", 50) / 100, 2)} + {fmt(1 - field("qualitySizeFloorPct", 50) / 100, 2)} × quality)</code>.
                      Weak signals risk {field("qualitySizeFloorPct", 50)}% of base, strong signals risk 100%. Never exceeds base.
                    </div>
                  </div>
                  <button
                    onClick={() => set("qualityAwareSizing", !field("qualityAwareSizing", false))}
                    className={`ml-4 relative w-12 h-6 flex-shrink-0 rounded-full border transition-colors ${field("qualityAwareSizing", false) ? "border-cyan-500 bg-cyan-500/20" : "border-border bg-secondary"}`}
                  >
                    <span className={`absolute top-0.5 w-5 h-5 rounded-full transition-all ${field("qualityAwareSizing", false) ? "left-6 bg-cyan-400" : "left-0.5 bg-muted-foreground/50"}`} />
                  </button>
                </div>

                {field("qualityAwareSizing", false) && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-border/50">
                    <div className="space-y-1">
                      <label className="text-[10px] text-muted-foreground tracking-widest">SIZE FLOOR (%)</label>
                      <input
                        type="number" min={0} max={100} step={5}
                        value={field("qualitySizeFloorPct", 50) as number}
                        onChange={(e) => set("qualitySizeFloorPct", parseFloat(e.target.value) as never)}
                        className="w-full bg-secondary border border-border px-2 py-1 text-xs font-mono focus:outline-none focus:border-cyan-400"
                      />
                      <div className="text-[10px] text-muted-foreground">Weakest signal (quality=0) gets this % of base size.</div>
                    </div>
                    {field("tpMode", "fixed_usdt") === "micro_2usd" && (
                      <div className="flex items-center justify-between p-2 bg-orange-500/5 border border-orange-500/20">
                        <div>
                          <div className="text-[11px] text-orange-300 font-bold">APPLY TO MICRO MODE</div>
                          <div className="text-[10px] text-muted-foreground">Off by default — Micro mode is risk-defined (1R = fixed USDT). Scaling breaks that contract.</div>
                        </div>
                        <button
                          onClick={() => set("qualityAwareSizingMicroMode", !field("qualityAwareSizingMicroMode", false))}
                          className={`ml-2 relative w-10 h-5 flex-shrink-0 rounded-full border transition-colors ${field("qualityAwareSizingMicroMode", false) ? "border-orange-500 bg-orange-500/20" : "border-border bg-secondary"}`}
                        >
                          <span className={`absolute top-0.5 w-4 h-4 rounded-full transition-all ${field("qualityAwareSizingMicroMode", false) ? "left-5 bg-orange-400" : "left-0.5 bg-muted-foreground/50"}`} />
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* ── CHT funding-rate filter (CHT only) ────────────────────── */}
              {field("strategy", "bb_rsi") === "cht" && (
                <div className="border border-border bg-secondary/30 p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-bold mb-0.5 flex items-center gap-2">
                        <span className="text-fuchsia-400 font-mono text-xs">CHT</span> Funding-Rate Filter
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Reject CHT longs when perp funding ≥ +{fmt(field("chtFundingThresholdPct", 0.05), 2)}% (crowd is crowded long → squeeze risk).
                        Symmetric for shorts at ≤ -{fmt(field("chtFundingThresholdPct", 0.05), 2)}%. Normal funding has no effect.
                      </div>
                    </div>
                    <button
                      onClick={() => set("chtFundingFilterEnabled", !field("chtFundingFilterEnabled", false))}
                      className={`ml-4 relative w-12 h-6 flex-shrink-0 rounded-full border transition-colors ${field("chtFundingFilterEnabled", false) ? "border-fuchsia-500 bg-fuchsia-500/20" : "border-border bg-secondary"}`}
                    >
                      <span className={`absolute top-0.5 w-5 h-5 rounded-full transition-all ${field("chtFundingFilterEnabled", false) ? "left-6 bg-fuchsia-400" : "left-0.5 bg-muted-foreground/50"}`} />
                    </button>
                  </div>

                  {field("chtFundingFilterEnabled", false) && (
                    <div className="pt-2 border-t border-border/50">
                      <label className="text-[10px] text-muted-foreground tracking-widest">THRESHOLD (% PER 8H)</label>
                      <input
                        type="number" min={0.01} max={0.50} step={0.01}
                        value={field("chtFundingThresholdPct", 0.05) as number}
                        onChange={(e) => set("chtFundingThresholdPct", parseFloat(e.target.value) as never)}
                        className="w-full md:w-48 bg-secondary border border-border px-2 py-1 text-xs font-mono focus:outline-none focus:border-fuchsia-400"
                      />
                      <div className="text-[10px] text-muted-foreground mt-1">
                        0.05% per 8h ≈ 55% APR. Only EXTREME positioning triggers a block.
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── MRX funding-rate filter (MRX only, LONG-only) ─────────── */}
              {field("strategy", "bb_rsi") === "mrx-hybrid" && (
                <div className="border border-border bg-secondary/30 p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-bold mb-0.5 flex items-center gap-2">
                        <span className="text-orange-400 font-mono text-xs">MRX</span> Funding-Rate Filter (LONG-only)
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Reject MRX entries when perp funding ≥ +{fmt(field("mrxFundingThresholdPct", 0.05), 2)}% (crowd already crowded long).
                        Negative funding never blocks (MRX is LONG-only). Normal funding has no effect.
                      </div>
                    </div>
                    <button
                      onClick={() => set("mrxFundingFilterEnabled", !field("mrxFundingFilterEnabled", false))}
                      className={`ml-4 relative w-12 h-6 flex-shrink-0 rounded-full border transition-colors ${field("mrxFundingFilterEnabled", false) ? "border-orange-500 bg-orange-500/20" : "border-border bg-secondary"}`}
                    >
                      <span className={`absolute top-0.5 w-5 h-5 rounded-full transition-all ${field("mrxFundingFilterEnabled", false) ? "left-6 bg-orange-400" : "left-0.5 bg-muted-foreground/50"}`} />
                    </button>
                  </div>

                  {field("mrxFundingFilterEnabled", false) && (
                    <div className="pt-2 border-t border-border/50">
                      <label className="text-[10px] text-muted-foreground tracking-widest">THRESHOLD (% PER 8H)</label>
                      <input
                        type="number" min={0.01} max={0.50} step={0.01}
                        value={field("mrxFundingThresholdPct", 0.05) as number}
                        onChange={(e) => set("mrxFundingThresholdPct", parseFloat(e.target.value) as never)}
                        className="w-full md:w-48 bg-secondary border border-border px-2 py-1 text-xs font-mono focus:outline-none focus:border-orange-400"
                      />
                      <div className="text-[10px] text-muted-foreground mt-1">
                        0.05% per 8h ≈ 55% APR. Same convention as CHT.
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="text-[11px] text-cyan-300/60 border border-cyan-500/20 bg-cyan-500/5 p-2 leading-relaxed">
                All Phase 2 filters are disabled by default. Flip them on per-account once you've verified behaviour in paper mode.
                The <code className="text-cyan-300">quality</code> column on signals/trades is populated regardless and visible in analytics.
              </div>
            </div>
          )}
        </div>

        {/* SMC strategy info panel */}
        {field("strategy", "bb_rsi") === "smc_mss" && (
          <div className="border-t border-border p-4 space-y-3 bg-violet-500/5">
            <div className="text-xs font-bold tracking-widest text-violet-400">SMC SETUP LOGIC</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-muted-foreground">
              <div className="space-y-1.5">
                <div className="text-foreground font-bold">Bullish MSS (Long)</div>
                <div>1. Swing low forms → impulse breaks a prior swing high</div>
                <div>2. Order Block = last <span className="text-red-400">bearish candle</span> before the breakout</div>
                <div>3. Entry = candle closes <span className="text-green-400">inside OB body</span> on retrace</div>
                <div>4. TP = Fib <span className="text-violet-400">4.236</span> extension (swing low → swing high)</div>
                <div>5. SL = below OB low − 0.1%</div>
              </div>
              <div className="space-y-1.5">
                <div className="text-foreground font-bold">Bearish MSS (Short)</div>
                <div>1. Swing high forms → impulse breaks a prior swing low</div>
                <div>2. Order Block = last <span className="text-green-400">bullish candle</span> before the breakdown</div>
                <div>3. Entry = candle closes <span className="text-red-400">inside OB body</span> on retrace</div>
                <div>4. TP = Fib <span className="text-violet-400">4.236</span> extension (swing high → swing low)</div>
                <div>5. SL = above OB high + 0.1%</div>
              </div>
            </div>
            <div className="text-xs text-violet-300/60 border border-violet-500/20 bg-violet-500/5 p-2">
              Swing detection uses 3-bar confirmation. Setups older than 60 candles (5 hours) are ignored. TP overrides config target — position size and SL % still apply.
            </div>
          </div>
        )}

        {/* CHT Engine info panel */}
        {field("strategy", "bb_rsi") === "cht" && (
          <div className="border-t border-border p-4 space-y-3 bg-amber-500/5">
            <div className="text-xs font-bold tracking-widest text-amber-400">CHT ENGINE — CRYPTO HYBRID TRADING INTELLIGENCE</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-muted-foreground">
              <div className="space-y-2">
                <div className="text-foreground font-bold">11-Stage Analysis Pipeline</div>
                <div className="space-y-1">
                  <div><span className="text-amber-400">1. Trend:</span> EMA20/EMA50 alignment · ADX ≥ 18 (ranging = skip)</div>
                  <div><span className="text-amber-400">2. HTF:</span> 1h EMA20/EMA50 must agree with 5m direction</div>
                  <div><span className="text-amber-400">3. Volatility:</span> ATR% 0.3–8% scalp regime required</div>
                  <div><span className="text-amber-400">4. Volume:</span> Ratio ≥ 1.0× · weak volume = skip</div>
                  <div><span className="text-amber-400">5. Trigger:</span> RETEST &gt; BREAKOUT &gt; REVERSAL (graded 25/18/15)</div>
                  <div><span className="text-amber-400">6. TAO:</span> 6 expert consensus — needs ≥ 4 votes to emit</div>
                </div>
              </div>
              <div className="space-y-2">
                <div className="text-foreground font-bold">TAO Consensus Experts</div>
                <div className="space-y-1">
                  <div><span className="text-amber-400/70">①</span> Spread Expert — alt outperforming BTC</div>
                  <div><span className="text-amber-400/70">②</span> Trend Expert — EMA20 {">"}{">"} EMA50</div>
                  <div><span className="text-amber-400/70">③</span> EMA Expert — price above EMA50</div>
                  <div><span className="text-amber-400/70">④</span> Volume Expert — ratio ≥ 1.2×</div>
                  <div><span className="text-amber-400/70">⑤</span> Divergence Expert — RSI divergence</div>
                  <div><span className="text-amber-400/70">⑥</span> Rotation Expert — RSI {">"}{">"} 50 + HTF aligned</div>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-2 text-xs">
              {[
                { grade: "ELITE",  score: "85+",  color: "text-amber-300 border-amber-500/40 bg-amber-500/10" },
                { grade: "STRONG", score: "75+",  color: "text-yellow-300 border-yellow-500/40 bg-yellow-500/10" },
                { grade: "MEDIUM", score: "60+",  color: "text-orange-300 border-orange-500/40 bg-orange-500/10" },
                { grade: "IGNORE", score: "<60", color: "text-muted-foreground border-border bg-secondary/20" },
              ].map(({ grade, score, color }) => (
                <div key={grade} className={`border px-2 py-1.5 text-center ${color}`}>
                  <div className="font-bold">{grade}</div>
                  <div className="opacity-70">{score} pts</div>
                </div>
              ))}
            </div>
            <div className="text-xs text-amber-300/60 border border-amber-500/20 bg-amber-500/5 p-2">
              TP = entry ± 1.5× SL distance (TP2 / 1.5R). SL set from trigger geometry: RETEST = recent low/high − 0.8 ATR · BREAKOUT = swing level ± 1 ATR · REVERSAL = zone edge − 0.8 ATR. Position size and risk rules from config still apply.
            </div>
          </div>
        )}
      </div>

      {/* ─── Manual Entry ────────────────────────────────────────────────────── */}
      <div className="border border-border">
        <div className="p-3 border-b border-border flex items-center gap-2">
          <LogIn className="w-3.5 h-3.5 text-yellow-400" />
          <span className="text-xs font-bold tracking-widest">MANUAL ENTRY — SCAN ANY COIN & ENTER NOW</span>
        </div>
        <div className="p-4 space-y-4">
          <p className="text-xs text-muted-foreground">
            Spotted a setup? Type any Gate.io USDT symbol, scan it to see live indicators, then force-enter Long or Short instantly — bypasses the automatic signal filter.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="e.g. BTC, ETH, XRP, PEPE…"
              value={manualSymbol}
              onChange={(e) => { setManualSymbol(e.target.value); setManualResult(null); setManualError(null); }}
              onKeyDown={(e) => e.key === "Enter" && manualScan()}
              className="flex-1 bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary uppercase placeholder:normal-case placeholder:text-muted-foreground/50"
            />
            <button
              onClick={manualScan}
              disabled={manualScanning || !manualSymbol.trim()}
              className="flex items-center gap-2 px-4 py-2 border border-border text-xs hover:border-primary/50 transition-colors disabled:opacity-50"
            >
              <Search className={`w-3.5 h-3.5 ${manualScanning ? "animate-pulse" : ""}`} />
              {manualScanning ? "Scanning…" : "Scan"}
            </button>
          </div>

          {manualError && (
            <div className="flex items-center gap-2 text-xs text-red-400 border border-red-500/30 bg-red-500/5 p-3">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />{manualError}
            </div>
          )}

          {manualResult && (() => {
            const p = manualResult.lastClose < 1 ? 6 : 4;
            const sig = manualResult.signal;
            const isSMC = manualResult.strategy === "smc_mss";
            const isCHT = manualResult.strategy === "cht";

            return (
              <div className="border border-border bg-secondary/20">
                {/* ── Symbol header ────────────────────────────────────────── */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                  <div className="flex items-center gap-3">
                    <div className="font-bold font-mono text-sm">{manualResult.gateSymbol}</div>
                    <span className={`text-[10px] tracking-widest px-1.5 py-0.5 border ${isCHT ? "border-amber-500/50 text-amber-400" : "border-border text-muted-foreground"}`}>
                      {isSMC ? "SMC MSS+OB" : isCHT ? "CHT ENGINE" : "BB+RSI"}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Scanned {new Date(manualResult.scannedAt).toLocaleTimeString()}
                  </div>
                </div>

                {/* ── SIGNAL STATUS BANNER ─────────────────────────────────── */}
                {sig ? (
                  <div className={`px-4 py-4 border-b border-border ${sig.side === "buy" ? "bg-green-500/10 border-l-2 border-l-green-500" : "bg-red-500/10 border-l-2 border-l-red-500"}`}>
                    <div className="flex items-center gap-3">
                      <CheckCircle2 className={`w-5 h-5 shrink-0 ${sig.side === "buy" ? "text-green-400" : "text-red-400"}`} />
                      <div>
                        <div className={`text-sm font-bold tracking-widest ${sig.side === "buy" ? "text-green-400" : "text-red-400"}`}>
                          SIGNAL DETECTED — {sig.side === "buy" ? "LONG" : "SHORT"}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          Entry ~{sig.entryPrice.toFixed(p)}
                          {sig.tpPrice != null && <> · TP {sig.tpPrice.toFixed(p)}</>}
                          {sig.slPrice != null && <> · SL {sig.slPrice.toFixed(p)}</>}
                        </div>
                      </div>
                    </div>
                    {/* TP/SL level display */}
                    {(sig.tpPrice != null || sig.slPrice != null) && (
                      <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-xs">
                        {sig.tpPrice != null && (
                          <div className="bg-green-500/10 border border-green-500/30 px-3 py-2">
                            <div className="text-[10px] text-muted-foreground tracking-widest">TAKE PROFIT</div>
                            <div className="text-green-400 font-bold mt-0.5">{sig.tpPrice.toFixed(p)}</div>
                            {sig.tpPrice > sig.entryPrice
                              ? <div className="text-[10px] text-green-400/70">+{((sig.tpPrice / sig.entryPrice - 1) * 100).toFixed(2)}%</div>
                              : <div className="text-[10px] text-green-400/70">{((sig.tpPrice / sig.entryPrice - 1) * 100).toFixed(2)}%</div>}
                          </div>
                        )}
                        {sig.slPrice != null && (
                          <div className="bg-red-500/10 border border-red-500/30 px-3 py-2">
                            <div className="text-[10px] text-muted-foreground tracking-widest">STOP LOSS</div>
                            <div className="text-red-400 font-bold mt-0.5">{sig.slPrice.toFixed(p)}</div>
                            {sig.slPrice < sig.entryPrice
                              ? <div className="text-[10px] text-red-400/70">{((sig.slPrice / sig.entryPrice - 1) * 100).toFixed(2)}%</div>
                              : <div className="text-[10px] text-red-400/70">+{((sig.slPrice / sig.entryPrice - 1) * 100).toFixed(2)}%</div>}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="px-4 py-3 border-b border-border bg-secondary/30 flex items-center gap-2">
                    <span className="w-4 h-4 rounded-full border border-muted-foreground/40 inline-flex items-center justify-center text-muted-foreground/40 text-[10px]">○</span>
                    <span className="text-xs text-muted-foreground tracking-widest">NO SIGNAL — conditions not met for {isSMC ? "SMC MSS+OB+Fib" : isCHT ? "CHT Engine" : "BB+RSI"} strategy</span>
                  </div>
                )}

                {/* ── Strategy-specific details ────────────────────────────── */}
                {isSMC && manualResult.smcDetails ? (
                  <div className="px-4 py-3 border-b border-border">
                    <div className="text-[10px] tracking-widest text-muted-foreground mb-2">SMC STRUCTURE</div>
                    <div className="grid grid-cols-3 gap-3 text-xs font-mono">
                      <div>
                        <div className="text-muted-foreground text-[10px]">OB HIGH</div>
                        <div className="font-bold text-yellow-400">{manualResult.smcDetails.obHigh.toFixed(p)}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground text-[10px]">OB LOW</div>
                        <div className="font-bold text-yellow-400">{manualResult.smcDetails.obLow.toFixed(p)}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground text-[10px]">MSS LEVEL</div>
                        <div className="font-bold text-blue-400">{manualResult.smcDetails.mssLevel.toFixed(p)}</div>
                      </div>
                    </div>
                  </div>
                ) : !isSMC && (
                  <div className="px-4 py-2 border-b border-border flex flex-wrap gap-4 text-xs">
                    {[
                      { label: "Near BB Lower", ok: manualResult.nearLower },
                      { label: "Near BB Upper", ok: manualResult.nearUpper },
                      { label: "RSI Oversold", ok: manualResult.rsi <= 35 },
                      { label: "RSI Overbought", ok: manualResult.rsi >= 65 },
                      { label: "Volume Spike", ok: manualResult.hasVolumeSpike },
                      { label: "Trend OK (Long)", ok: manualResult.trendAllowsLong },
                      { label: "Trend OK (Short)", ok: manualResult.trendAllowsShort },
                    ].map(({ label, ok }) => (
                      <span key={label} className={`flex items-center gap-1 ${ok ? "text-green-400" : "text-muted-foreground"}`}>
                        {ok ? <CheckCircle2 className="w-3 h-3" /> : <span className="w-3 h-3 inline-flex items-center justify-center text-muted-foreground/40">○</span>}
                        {label}
                      </span>
                    ))}
                  </div>
                )}

                {/* ── Indicators grid ──────────────────────────────────────── */}
                <div className="grid grid-cols-3 md:grid-cols-6 divide-x divide-border text-xs font-mono border-b border-border">
                  {[
                    { label: "PRICE", value: manualResult.lastClose.toFixed(p), color: "" },
                    { label: "BB LOWER", value: manualResult.bbLower.toFixed(p), color: manualResult.nearLower ? "text-green-400" : "" },
                    { label: "BB UPPER", value: manualResult.bbUpper.toFixed(p), color: manualResult.nearUpper ? "text-red-400" : "" },
                    { label: "RSI", value: manualResult.rsi.toFixed(1), color: manualResult.rsi <= 35 ? "text-green-400" : manualResult.rsi >= 65 ? "text-red-400" : "" },
                    { label: "VOL RATIO", value: `${manualResult.volumeRatio.toFixed(2)}×`, color: manualResult.hasVolumeSpike ? "text-yellow-400" : "" },
                    { label: `EMA ${manualResult.emaPeriod}`, value: manualResult.ema.toFixed(p), color: manualResult.lastClose > manualResult.ema ? "text-green-400" : "text-red-400" },
                  ].map(({ label, value, color }) => (
                    <div key={label} className="px-3 py-3 space-y-0.5">
                      <div className="text-muted-foreground tracking-widest" style={{ fontSize: "10px" }}>{label}</div>
                      <div className={`font-bold ${color}`}>{value}</div>
                    </div>
                  ))}
                </div>

                {/* ── Action buttons ────────────────────────────────────────── */}
                <div className="px-4 py-3 flex items-center gap-3">
                  <span className="text-xs text-muted-foreground flex-1">
                    {sig ? "Strategy signal detected — entering will use computed TP/SL levels." : "No signal — force-enter bypasses all strategy conditions."}
                  </span>
                  <button
                    onClick={() => manualEnter("buy")}
                    disabled={entering !== null}
                    className={`flex items-center gap-1.5 px-4 py-2 text-xs font-bold border transition-colors disabled:opacity-50 ${
                      sig?.side === "buy"
                        ? "border-green-500 text-green-400 bg-green-500/10 hover:bg-green-500/20"
                        : "border-green-500/40 text-green-400/70 hover:bg-green-500/10"
                    }`}
                  >
                    <ArrowUpRight className="w-3.5 h-3.5" />
                    {entering === "buy" ? "Entering…" : sig?.side === "buy" ? "Enter LONG ✓" : "Force LONG"}
                  </button>
                  {!field("longOnly", false) && (
                    <button
                      onClick={() => manualEnter("sell")}
                      disabled={entering !== null}
                      className={`flex items-center gap-1.5 px-4 py-2 text-xs font-bold border transition-colors disabled:opacity-50 ${
                        sig?.side === "sell"
                          ? "border-red-500 text-red-400 bg-red-500/10 hover:bg-red-500/20"
                          : "border-red-500/40 text-red-400/70 hover:bg-red-500/10"
                      }`}
                    >
                      <ArrowDownRight className="w-3.5 h-3.5" />
                      {entering === "sell" ? "Entering…" : sig?.side === "sell" ? "Enter SHORT ✓" : "Force SHORT"}
                    </button>
                  )}
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* How it works */}
      <div className="border border-border/50 bg-secondary/10 p-4 text-xs text-muted-foreground space-y-1.5">
        <div className="flex items-center gap-2 text-foreground font-bold mb-2">
          <CheckCircle2 className="w-4 h-4 text-primary" />HOW THIS BOT WORKS
        </div>
        {field("strategy", "bb_rsi") === "bb_rsi" ? (
          <>
            <div>Every 2.5 minutes, scans your allowlisted pairs (or top-{field("scanPoolSize", 20)} USDT pairs by volume) on Gate.io.</div>
            <div>For each symbol, fetches 60 × 5m candles and checks: <span className="text-yellow-400">BB touch + RSI extreme + volume spike</span> — all three must fire together.</div>
            <div>With EMA filter on: only longs above {field("emaPeriod", 50)}-EMA, only shorts below it — no trading against the trend.</div>
            <div>Target profit is <span className="text-green-400">${fmt(field("targetProfitUsdt", 2), 2)} USDT</span> per trade — TP is auto-calculated based on position size and exact fill price.</div>
          </>
        ) : (
          <>
            <div>Every 2.5 minutes, scans your allowlisted pairs (or top-{field("scanPoolSize", 20)} USDT pairs by volume) on Gate.io.</div>
            <div>For each symbol, fetches 150 × 5m candles and looks for a <span className="text-violet-400">Market Structure Shift</span> — a candle closing above/below a prior swing high/low after a swing.</div>
            <div>Identifies the <span className="text-yellow-400">Order Block</span> (last bearish candle before bullish MSS, or last bullish candle before bearish MSS) and waits for price to retrace into the OB body.</div>
            <div>Entry fires when a candle <span className="text-green-400">closes inside the OB body</span> — no wick traps. TP is the <span className="text-violet-400">Fib 4.236 extension</span> of the MSS swing. SL is below/above the OB edge.</div>
          </>
        )}
        <div>Compounding reinvests each closed P&L into the running balance for exponential growth.</div>
        <div className="flex items-center gap-1.5 text-orange-400"><AlertTriangle className="w-3.5 h-3.5" />Start in Paper Mode. Only switch to Live after you observe consistent profitable patterns in simulated trades.</div>
      </div>
    </div>
  );
}
