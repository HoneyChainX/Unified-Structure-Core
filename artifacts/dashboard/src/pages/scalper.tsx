import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  Zap, Play, Square, RefreshCw, TrendingUp, TrendingDown, DollarSign,
  AlertTriangle, CheckCircle2, Clock, BarChart3, ArrowUpRight, ArrowDownRight,
  ChevronDown, ChevronUp, Shield,
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

interface ScalperConfig {
  id: number;
  enabled: boolean;
  paperMode: boolean;
  positionSizeUsdt: number;
  targetProfitUsdt: number;
  slPct: number;
  maxOpenTrades: number;
  cooldownMinutes: number;
  bbPeriod: number;
  bbStdDev: number;
  rsiPeriod: number;
  rsiOversold: number;
  rsiOverbought: number;
  volumeSpikeMultiplier: number;
  compoundingEnabled: boolean;
  compoundBalance: number | null;
  longOnly: boolean;
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
  error?: string;
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

  const { data: config, refetch: refetchConfig } = useFetch<ScalperConfig>("/api/scalper/config");
  const { data: status, refetch: refetchStatus } = useFetch<ScalperStatus>("/api/scalper/status");
  const { data: trades, refetch: refetchTrades } = useFetch<ScalperTrade[]>("/api/scalper/trades");
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
    refetchTrades();
  }

  async function triggerScan() {
    setScanning(true);
    try {
      const result = await api<{ symbols: ScanRow[]; scannedAt: string }>("/api/scalper/scan");
      setScanData(result.symbols);
      setShowScan(true);
      await api("/api/scalper/scan/trigger", { method: "POST" });
      setTimeout(() => { refetchTrades(); refetchStatus(); }, 3000);
    } catch (e) {
      alert(String(e));
    } finally {
      setScanning(false);
    }
  }

  const hasDraft = Object.keys(draft).length > 0;
  const openTrades = trades?.filter((t) => ["open", "paper"].includes(t.status)) ?? [];
  const closedTrades = trades?.filter((t) => t.status === "closed") ?? [];

  // Equity curve from closed trades
  const equityCurve = closedTrades
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
              { label: "BEST TRADE", value: perf.bestPnl != null ? `+${perf.bestPnl.toFixed(4)}` : "—", sub: "USDT", pnl: perf.bestPnl },
              { label: "WORST TRADE", value: perf.worstPnl != null ? perf.worstPnl.toFixed(4) : "—", sub: "USDT", pnl: perf.worstPnl },
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
                  {["SYMBOL", "PRICE", "BB LOWER", "BB UPPER", "RSI", "VOL RATIO", "SIGNAL"].map((h) => (
                    <th key={h} className="text-left px-3 py-2">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {scanData.map((row) => (
                  <tr key={row.gateSymbol} className="border-b border-border/50 hover:bg-secondary/20">
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
                      {row.nearLower ? (
                        <span className="text-green-400 flex items-center gap-1"><ArrowUpRight className="w-3 h-3" />LONG SETUP</span>
                      ) : row.nearUpper ? (
                        <span className="text-red-400 flex items-center gap-1"><ArrowDownRight className="w-3 h-3" />SHORT SETUP</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
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
                      <button
                        onClick={() => cancelTrade(t.id)}
                        className="text-red-400 hover:text-red-300 text-xs border border-red-500/30 px-2 py-0.5 hover:border-red-400/50 transition-colors"
                      >
                        Cancel
                      </button>
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
            <span className="text-xs font-bold tracking-widest">TRADE HISTORY ({closedTrades.length})</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  {["SYMBOL", "SIDE", "ENTRY", "EXIT", "TP", "P&L", "CLOSE REASON", "TIME"].map((h) => (
                    <th key={h} className="text-left px-3 py-2">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {closedTrades.slice(0, 50).map((t) => (
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
                    <td className="px-3 py-2 text-muted-foreground">
                      {t.closedAt ? new Date(t.closedAt).toLocaleTimeString() : "—"}
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
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground tracking-widest flex items-center gap-2">
              <DollarSign className="w-3 h-3" />TARGET PROFIT PER TRADE (USDT)
            </label>
            <input
              type="number" min={0.1} step={0.5}
              value={field("targetProfitUsdt", 2) as number}
              onChange={(e) => set("targetProfitUsdt", parseFloat(e.target.value))}
              className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
            />
            <p className="text-xs text-muted-foreground">TP is auto-set to achieve this $ profit on the full position</p>
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
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground tracking-widest">POSITION SIZE (USDT)</label>
            <input
              type="number" min={1}
              value={field("positionSizeUsdt", 50) as number}
              onChange={(e) => set("positionSizeUsdt", parseFloat(e.target.value))}
              className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
            />
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
        </div>

        {/* Advanced / Signal params */}
        <div className="border-t border-border">
          <button
            onClick={() => setShowAdvanced((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-3 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/20 transition-colors"
          >
            <span className="tracking-widest font-bold">SIGNAL PARAMETERS (BB / RSI / VOLUME)</span>
            {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>

          {showAdvanced && (
            <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-4 bg-secondary/10">
              {[
                { key: "bbPeriod", label: "BB PERIOD", min: 5, max: 50, step: 1, fallback: 20 },
                { key: "bbStdDev", label: "BB STD DEV (σ)", min: 1, max: 4, step: 0.1, fallback: 2.0 },
                { key: "rsiPeriod", label: "RSI PERIOD", min: 5, max: 30, step: 1, fallback: 14 },
                { key: "rsiOversold", label: "RSI OVERSOLD", min: 10, max: 45, step: 1, fallback: 35 },
                { key: "rsiOverbought", label: "RSI OVERBOUGHT", min: 55, max: 90, step: 1, fallback: 65 },
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
              <div className="md:col-span-3 text-xs text-muted-foreground bg-secondary/30 border border-border p-3 space-y-1">
                <div>Entry conditions (all three must be met simultaneously):</div>
                <div className="text-green-400">LONG: price ≤ BB lower  AND  RSI ≤ oversold  AND  volume ≥ {fmt(field("volumeSpikeMultiplier", 1.5), 1)}× 20-period avg</div>
                <div className="text-red-400">SHORT: price ≥ BB upper  AND  RSI ≥ overbought  AND  volume ≥ {fmt(field("volumeSpikeMultiplier", 1.5), 1)}× 20-period avg</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* How it works */}
      <div className="border border-border/50 bg-secondary/10 p-4 text-xs text-muted-foreground space-y-1.5">
        <div className="flex items-center gap-2 text-foreground font-bold mb-2">
          <CheckCircle2 className="w-4 h-4 text-primary" />HOW THIS BOT WORKS
        </div>
        <div>Every 5 minutes, scans the top 5 USDT pairs by 24h volume on Gate.io.</div>
        <div>For each symbol, fetches 60 × 5m candles and checks: <span className="text-yellow-400">BB touch + RSI extreme + volume spike</span> — all three must fire together.</div>
        <div>Target profit is <span className="text-green-400">${fmt(field("targetProfitUsdt", 2), 2)} USDT</span> per trade — TP is auto-calculated based on position size and exact fill price.</div>
        <div>Compounding reinvests each closed P&L into the running balance for exponential growth.</div>
        <div className="flex items-center gap-1.5 text-orange-400"><AlertTriangle className="w-3.5 h-3.5" />Start in Paper Mode. Only switch to Live after you observe consistent profitable patterns in simulated trades.</div>
      </div>
    </div>
  );
}
