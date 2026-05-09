import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  Zap, Play, Square, RefreshCw, TrendingUp, TrendingDown, DollarSign,
  AlertTriangle, CheckCircle2, Clock, BarChart3, ArrowUpRight, ArrowDownRight,
  ChevronDown, ChevronUp, Shield, Search, LogIn,
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

function SyncAllowlistButton({ onSync }: { onSync: (pairs: string[]) => void }) {
  const [state, setState] = useState<"idle" | "loading" | "ok" | "err">("idle");
  const [msg, setMsg] = useState("");

  async function sync() {
    setState("loading");
    setMsg("");
    try {
      const data = await api<{ pairs: string[]; unrestricted: boolean; error?: string }>("/api/scalper/gateio-allowlist");
      if (data.error) throw new Error(data.error);
      onSync(data.pairs);
      setMsg(data.unrestricted ? "No restrictions — all pairs allowed" : `${data.pairs.length} pairs synced`);
      setState("ok");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
      setState("err");
    }
    setTimeout(() => setState("idle"), 4000);
  }

  return (
    <div className="flex items-center gap-2">
      {msg && (
        <span className={`text-xs font-mono ${state === "ok" ? "text-green-400" : "text-red-400"}`}>{msg}</span>
      )}
      <button
        onClick={sync}
        disabled={state === "loading"}
        className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono border border-orange-500/50 bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 transition-colors disabled:opacity-50"
      >
        <RefreshCw className={`w-3 h-3 ${state === "loading" ? "animate-spin" : ""}`} />
        SYNC FROM GATE.IO
      </button>
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
  symbolAllowlist: string | null;
  strategy: string;
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
  closePrice: number | null;
  closeReason: string | null;
  pnl: number | null;
  paperMode: boolean;
  rsi: number | null;
  volumeRatio: number | null;
  createdAt: string;
  closedAt: string | null;
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
  // Open positions: poll every 15s for live P&L
  const { data: openTrades_, refetch: refetchOpen } = useFetch<ScalperTrade[]>("/api/scalper/trades?status=open,paper&limit=100");
  // Closed history: poll every 60s (static data — only grows)
  const { data: closedTrades_, refetch: refetchClosed } = useFetch<ScalperTrade[]>("/api/scalper/trades?status=closed,cancelled&limit=200", 60000);
  const { data: perf, refetch: refetchPerf } = useFetch<ScalperPerformance>("/api/scalper/performance");

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
  const openTrades = openTrades_ ?? [];
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
                {openTrades.map((t) => (
                  <tr key={t.id} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="px-3 py-2 font-bold">{t.symbol}</td>
                    <td className={`px-3 py-2 font-bold ${t.side === "buy" ? "text-green-400" : "text-red-400"}`}>
                      {t.side === "buy" ? "LONG" : "SHORT"}
                    </td>
                    <td className="px-3 py-2">{fmt(t.entryPrice, 6)}</td>
                    <td className="px-3 py-2">{fmt(t.livePrice, 6)}</td>
                    <td className="px-3 py-2 text-green-400">{fmt(t.tpPrice, 6)}</td>
                    <td className="px-3 py-2 text-red-400">{fmt(t.slPrice, 6)}</td>
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
                ))}
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
          <div className="grid grid-cols-2 gap-3">
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
          </div>
        </div>

        <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Paper Mode */}
          <div className="flex items-center justify-between p-4 border border-border bg-secondary/30">
            <div>
              <div className="text-sm font-bold mb-0.5">Paper Mode</div>
              <div className="text-xs text-muted-foreground">Simulate trades without placing real orders</div>
            </div>
            <button
              onClick={() => set("paperMode", !field("paperMode", true))}
              className={`relative w-12 h-6 rounded-full border transition-colors ${field("paperMode", true) ? "border-violet-500 bg-violet-500/20" : "border-green-500 bg-green-500/20"}`}
            >
              <span className={`absolute top-0.5 w-5 h-5 rounded-full transition-all ${field("paperMode", true) ? "left-0.5 bg-violet-400" : "left-6 bg-green-400"}`} />
            </button>
          </div>

          {/* Long Only */}
          <div className="flex items-center justify-between p-4 border border-border bg-secondary/30">
            <div>
              <div className="text-sm font-bold mb-0.5 flex items-center gap-2">
                <ArrowUpRight className="w-3.5 h-3.5 text-blue-400" />Long Only
              </div>
              <div className="text-xs text-muted-foreground">Skip SHORT signals — safer for spot</div>
            </div>
            <button
              onClick={() => set("longOnly", !field("longOnly", false))}
              className={`relative w-12 h-6 rounded-full border transition-colors ${field("longOnly", false) ? "border-blue-500 bg-blue-500/20" : "border-border bg-secondary"}`}
            >
              <span className={`absolute top-0.5 w-5 h-5 rounded-full transition-all ${field("longOnly", false) ? "left-6 bg-blue-400" : "left-0.5 bg-muted-foreground/50"}`} />
            </button>
          </div>

          {/* Target Profit */}
          <div className="space-y-3">
            <label className="text-xs text-muted-foreground tracking-widest flex items-center gap-2">
              <DollarSign className="w-3 h-3" />TARGET PROFIT PER TRADE
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => set("targetProfitPct", null)}
                className={`flex-1 py-1.5 text-xs font-mono border transition-colors ${field("targetProfitPct", null) == null ? "border-primary bg-primary/10 text-primary" : "border-border bg-secondary text-muted-foreground"}`}
              >FIXED USDT</button>
              <button
                onClick={() => { if (field("targetProfitPct", null) == null) set("targetProfitPct", 1); }}
                className={`flex-1 py-1.5 text-xs font-mono border transition-colors ${field("targetProfitPct", null) != null ? "border-emerald-500 bg-emerald-500/10 text-emerald-400" : "border-border bg-secondary text-muted-foreground"}`}
              >% OF ENTRY</button>
            </div>
            {field("targetProfitPct", null) == null ? (
              <>
                <input
                  type="number" min={0.1} step={0.5}
                  value={field("targetProfitUsdt", 2) as number}
                  onChange={(e) => set("targetProfitUsdt", parseFloat(e.target.value))}
                  className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
                />
                <p className="text-xs text-muted-foreground">TP placed to achieve this fixed $ profit on the full position</p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min={0.1} max={20} step={0.1}
                    value={field("targetProfitPct", 1) as number}
                    onChange={(e) => set("targetProfitPct", parseFloat(e.target.value))}
                    className="flex-1 bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-emerald-500"
                  />
                  <span className="text-emerald-400 font-mono font-bold text-lg">%</span>
                </div>
                <p className="text-xs text-muted-foreground">TP placed this % above entry (long) or below (short) — adapts to any position size</p>
              </>
            )}
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
          <div className="flex items-center justify-between p-4 border border-border bg-secondary/30">
            <div>
              <div className="text-sm font-bold mb-0.5">Compounding</div>
              <div className="text-xs text-muted-foreground">Reinvest profits — each trade uses the running balance</div>
            </div>
            <button
              onClick={() => set("compoundingEnabled", !field("compoundingEnabled", false))}
              className={`relative w-12 h-6 rounded-full border transition-colors ${field("compoundingEnabled", false) ? "border-yellow-500 bg-yellow-500/20" : "border-border bg-secondary"}`}
            >
              <span className={`absolute top-0.5 w-5 h-5 rounded-full transition-all ${field("compoundingEnabled", false) ? "left-6 bg-yellow-400" : "left-0.5 bg-muted-foreground/50"}`} />
            </button>
          </div>

          {/* Trading Allowlist */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs text-muted-foreground tracking-widest flex items-center gap-2">
                <span className="text-orange-400">▣</span> API TRADING ALLOWLIST
              </label>
              <SyncAllowlistButton onSync={(pairs) => set("symbolAllowlist", pairs.length > 0 ? pairs.join(", ") : null)} />
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
                <span className="text-green-400 font-mono">SCAN</span> — always free. Candle data is a public endpoint, your API key is never involved. The bot scans any pair.
              </p>
              <p className="text-xs text-muted-foreground">
                <span className="text-orange-400 font-mono">TRADE</span> — restricted by your Gate.io API key. List only the pairs your key is allowed to trade. Signals on unlisted pairs are detected but skipped at order time. Manual entry always overrides this.
              </p>
            </div>
          </div>
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

            return (
              <div className="border border-border bg-secondary/20">
                {/* ── Symbol header ────────────────────────────────────────── */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                  <div className="flex items-center gap-3">
                    <div className="font-bold font-mono text-sm">{manualResult.gateSymbol}</div>
                    <span className="text-[10px] tracking-widest px-1.5 py-0.5 border border-border text-muted-foreground">
                      {isSMC ? "SMC MSS+OB" : "BB+RSI"}
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
                    <span className="text-xs text-muted-foreground tracking-widest">NO SIGNAL — conditions not met for {isSMC ? "SMC MSS+OB+Fib" : "BB+RSI"} strategy</span>
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
            <div>Every 5 minutes, scans your allowlisted pairs (or top-5 USDT by volume) on Gate.io.</div>
            <div>For each symbol, fetches 60 × 5m candles and checks: <span className="text-yellow-400">BB touch + RSI extreme + volume spike</span> — all three must fire together.</div>
            <div>With EMA filter on: only longs above {field("emaPeriod", 50)}-EMA, only shorts below it — no trading against the trend.</div>
            <div>Target profit is <span className="text-green-400">${fmt(field("targetProfitUsdt", 2), 2)} USDT</span> per trade — TP is auto-calculated based on position size and exact fill price.</div>
          </>
        ) : (
          <>
            <div>Every 5 minutes, scans your allowlisted pairs (or top-5 USDT by volume) on Gate.io.</div>
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
