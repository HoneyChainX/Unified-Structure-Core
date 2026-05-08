import { useState } from "react";
import {
  useGetBotConfig,
  useUpdateBotConfig,
  useGetBotStatus,
  useListTrades,
  useCancelTrade,
  useGetBotPerformance,
  useSendTestSignal,
  useGetEquityCurve,
  useGetMarketStatus,
  getGetBotConfigQueryKey,
  getGetBotStatusQueryKey,
  getListTradesQueryKey,
  getGetBotPerformanceQueryKey,
  getGetEquityCurveQueryKey,
  getGetMarketStatusQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import {
  Bot,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Zap,
  FlaskConical,
  DollarSign,
  ShieldAlert,
  Target,
  TrendingUp,
  TrendingDown,
  Clock,
  Trash2,
  BarChart2,
  RefreshCw,
  PlayCircle,
  Timer,
  Layers,
  ArrowUpRight,
  Repeat2,
  Globe,
  Activity,
  ChevronRight,
  RotateCcw,
} from "lucide-react";
import { Link } from "wouter";

function fmt(v: number | null | undefined, d = 4) {
  if (v == null) return "—";
  return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtPnl(v: number | null | undefined) {
  if (v == null) return null;
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(4)}`;
}
function fmtPct(v: number | null | undefined, suffix = "%") {
  if (v == null) return "—";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}${suffix}`;
}
function fmtB(v: number | null | undefined) {
  if (v == null) return "—";
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  return `$${v.toFixed(0)}`;
}
function timeSince(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    open: "border-blue-500/40 text-blue-400",
    paper: "border-violet-500/40 text-violet-400",
    closed: "border-green-500/40 text-green-400",
    cancelled: "border-muted-foreground/40 text-muted-foreground",
    error: "border-red-500/40 text-red-400",
    pending: "border-yellow-500/40 text-yellow-400",
  };
  return (
    <span className={`px-2 py-0.5 border text-xs font-bold ${colors[status] ?? "border-border text-muted-foreground"}`}>
      {status.toUpperCase()}
    </span>
  );
}

const TEST_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "DOGEUSDT"];

function computeReturnPct(trade: { pnl?: number | null; entryPrice?: number | null; quantity?: number | null; positionSizeUsdt?: number | null }) {
  if (trade.pnl == null) return null;
  const cost =
    trade.entryPrice != null && trade.quantity != null
      ? trade.entryPrice * trade.quantity
      : trade.positionSizeUsdt;
  if (!cost || cost <= 0) return null;
  return (trade.pnl / cost) * 100;
}

function EquityTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: { symbol: string; pnl: number; cumulative: number; closeReason: string | null; returnPct: number | null } }> }) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-card border border-border px-3 py-2 text-xs font-mono space-y-1 shadow-lg">
      <div className="font-bold text-foreground">{d.symbol}</div>
      <div className={d.pnl >= 0 ? "text-green-400" : "text-red-400"}>
        Trade: {d.pnl >= 0 ? "+" : ""}{d.pnl.toFixed(4)} USDT
        {d.returnPct != null ? ` (${fmtPct(d.returnPct)})` : ""}
      </div>
      <div className={d.cumulative >= 0 ? "text-green-400" : "text-red-400"}>
        Cumulative: {d.cumulative >= 0 ? "+" : ""}{d.cumulative.toFixed(4)} USDT
      </div>
      {d.closeReason && <div className="text-muted-foreground">via {d.closeReason.toUpperCase()}</div>}
    </div>
  );
}

// ─── Trading mode config ────────────────────────────────────────────────────
const TRADING_MODES = [
  {
    id: "all",
    label: "ALL",
    sublabel: "All signals",
    description: "No mode filter",
    tps: "TP1–TP3",
    multiplier: "1×",
    color: "border-border text-foreground",
    active: "border-primary text-primary bg-primary/10",
    dotColor: "bg-muted-foreground",
  },
  {
    id: "scalp",
    label: "SCALP",
    sublabel: "Fast signals",
    description: "mode=scalp",
    tps: "TP1 only",
    multiplier: "0.5×",
    color: "border-border text-foreground",
    active: "border-orange-400 text-orange-400 bg-orange-400/10",
    dotColor: "bg-orange-400",
  },
  {
    id: "intraday",
    label: "INTRADAY",
    sublabel: "4H/Daily",
    description: "mode=Intraday",
    tps: "TP1+TP2",
    multiplier: "1×",
    color: "border-border text-foreground",
    active: "border-blue-400 text-blue-400 bg-blue-400/10",
    dotColor: "bg-blue-400",
  },
  {
    id: "swing",
    label: "SWING",
    sublabel: "Multi-day",
    description: "mode=swing",
    tps: "TP1–TP3",
    multiplier: "1.5×",
    color: "border-border text-foreground",
    active: "border-violet-400 text-violet-400 bg-violet-400/10",
    dotColor: "bg-violet-400",
  },
  {
    id: "position",
    label: "POSITION",
    sublabel: "High conviction",
    description: "All signals",
    tps: "TP1–TP3",
    multiplier: "2×",
    color: "border-border text-foreground",
    active: "border-green-400 text-green-400 bg-green-400/10",
    dotColor: "bg-green-400",
  },
] as const;

// ─── Market regime colors ────────────────────────────────────────────────────
const REGIME_STYLES: Record<string, { badge: string; label: string; icon: string }> = {
  BTC_DOMINANT: { badge: "border-orange-500/50 text-orange-400 bg-orange-500/10", label: "BTC DOMINANT", icon: "₿" },
  ETH_SEASON:   { badge: "border-blue-500/50 text-blue-400 bg-blue-500/10",       label: "ETH SEASON",   icon: "Ξ" },
  ALT_SEASON:   { badge: "border-violet-500/50 text-violet-400 bg-violet-500/10", label: "ALT SEASON",   icon: "⬆" },
  RISK_OFF:     { badge: "border-red-500/50 text-red-400 bg-red-500/10",           label: "RISK OFF",     icon: "⚠" },
  NEUTRAL:      { badge: "border-border text-muted-foreground",                    label: "NEUTRAL",      icon: "—" },
};

const ROT_COLORS: Record<string, string> = {
  "RISK_OFF":   "text-red-400",
  "BTC->ETH":   "text-blue-400",
  "BTC->ALTS":  "text-violet-400",
  "ETH->ALTS":  "text-emerald-400",
};

// ─── DominanceBar sub-component ──────────────────────────────────────────────
function DominanceBar({ label, value, total = 100, color }: { label: string; value: number; total?: number; color: string }) {
  const pct = Math.min((value / total) * 100, 100);
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground tracking-wider">{label}</span>
        <span className={`font-mono font-bold ${color}`}>{value.toFixed(2)}%</span>
      </div>
      <div className="h-1.5 bg-secondary border border-border overflow-hidden">
        <div className={`h-full ${color.replace("text-", "bg-")}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ─── SpreadRow sub-component ─────────────────────────────────────────────────
function SpreadRow({ label, value, desc, positive }: { label: string; value: number | string; desc?: string; positive?: boolean }) {
  const color = positive == null ? "text-foreground" : positive ? "text-green-400" : "text-muted-foreground";
  return (
    <div className="flex items-center justify-between py-1 border-b border-border/30 last:border-0">
      <div>
        <span className="text-xs font-mono text-muted-foreground">{label}</span>
        {desc && <span className="ml-2 text-xs text-muted-foreground/50">{desc}</span>}
      </div>
      <span className={`text-xs font-mono font-bold ${color}`}>{value}</span>
    </div>
  );
}

// ─── MarketStatusPanel ────────────────────────────────────────────────────────
function MarketStatusPanel() {
  const { data: market, isLoading, refetch } = useGetMarketStatus({
    query: {
      queryKey: getGetMarketStatusQueryKey(),
      refetchInterval: 60_000,
      staleTime: 55_000,
    }
  });

  const regime = market?.regime ?? "NEUTRAL";
  const rs = REGIME_STYLES[regime] ?? REGIME_STYLES.NEUTRAL;

  return (
    <div className="border border-border bg-card">
      <div className="px-4 py-3 border-b border-border bg-secondary/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Globe className="w-3.5 h-3.5 text-primary" />
          <span className="text-xs text-muted-foreground tracking-widest font-bold">MARKET STATUS</span>
          {market && (
            <span className={`px-2.5 py-0.5 border text-xs font-bold tracking-widest ml-1 ${rs.badge}`}>
              {rs.icon} {rs.label}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {market && (
            <span className="text-xs text-muted-foreground">
              {fmtB(market.totalMarketCapUsd ?? null)}
              {market.marketCapChange24h != null && (
                <span className={market.marketCapChange24h >= 0 ? "text-green-400 ml-1" : "text-red-400 ml-1"}>
                  {market.marketCapChange24h >= 0 ? "+" : ""}{market.marketCapChange24h.toFixed(2)}%
                </span>
              )}
            </span>
          )}
          <button onClick={() => refetch()} className="text-muted-foreground hover:text-foreground">
            <RefreshCw className="w-3 h-3" />
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="px-4 py-6 text-xs text-muted-foreground text-center">Fetching market data...</div>
      ) : !market ? (
        <div className="px-4 py-4 text-xs text-muted-foreground">Market data unavailable</div>
      ) : (
        <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Dominance bars */}
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground tracking-widest mb-2">DOMINANCE</div>
            <DominanceBar label="BTC.D" value={market.btcDominance} color="text-orange-400" />
            <DominanceBar label="ETH.D" value={market.ethDominance} color="text-blue-400" />
            <DominanceBar label="STABLE.D (USDT+USDC)" value={market.stableDominance} color="text-green-400" />
            <DominanceBar label="OTHERS.D (Alts)" value={market.othersDominance} color="text-violet-400" />
          </div>

          {/* Spread table */}
          <div>
            <div className="text-xs text-muted-foreground tracking-widest mb-2">SPREADS</div>
            <SpreadRow
              label="BTC.D/(USDT.D+USDC.D)"
              value={market.spreads.btcDivStable.toFixed(3)}
              desc="BTC vs Stable"
              positive={market.spreads.btcDivStable > 5}
            />
            <SpreadRow
              label="(USDT.D+USDC.D)/BTC.D"
              value={market.spreads.stableDivBtc.toFixed(4)}
              desc="Stable vs BTC"
            />
            <SpreadRow
              label="BTC.D − STABLE.C.D"
              value={market.spreads.btcMinusStable.toFixed(2)}
              desc="Risk appetite"
              positive={market.spreads.btcMinusStable > 40}
            />
            <SpreadRow
              label="(BTC.D+ETH.D)/OTHERS.D"
              value={market.spreads.largecapDivOthers.toFixed(3)}
              desc="Large-cap vs Alt"
              positive={market.spreads.largecapDivOthers < 5}
            />
            <SpreadRow
              label="TOTALES.D/(USDT.D+USDC.D)"
              value={market.spreads.totalDivStable.toFixed(3)}
              desc="Risk-on ratio"
              positive={market.spreads.totalDivStable > 7}
            />
            <SpreadRow
              label="USDT.D/USDC.D"
              value={market.spreads.usdtDivUsdc.toFixed(3)}
              desc="Stable mix"
            />
          </div>

          {/* Rotation from latest signal */}
          {(market.latestRotation || market.latestRotScore != null) && (
            <div className="md:col-span-2 flex items-center gap-4 pt-2 border-t border-border/40">
              <div>
                <div className="text-xs text-muted-foreground tracking-widest mb-1">SCRIPT ROTATION</div>
                <span className={`text-sm font-bold font-mono ${ROT_COLORS[market.latestRotation ?? ""] ?? "text-foreground"}`}>
                  {market.latestRotation ?? "—"}
                </span>
              </div>
              {market.latestRotScore != null && (
                <div>
                  <div className="text-xs text-muted-foreground tracking-widest mb-1">ROT SCORE</div>
                  <span className={`text-sm font-bold font-mono ${market.latestRotScore >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {market.latestRotScore >= 0 ? "+" : ""}{market.latestRotScore.toFixed(3)}
                  </span>
                </div>
              )}
              <div className="ml-auto text-xs text-muted-foreground">
                from latest signal · refreshes every 60s
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export function BotPage() {
  const queryClient = useQueryClient();
  const { data: config, isLoading: configLoading } = useGetBotConfig({
    query: { queryKey: getGetBotConfigQueryKey(), refetchInterval: 30000 }
  });
  const { data: status } = useGetBotStatus({
    query: { queryKey: getGetBotStatusQueryKey(), refetchInterval: 15000 }
  });
  const { data: tradesData, refetch: refetchTrades } = useListTrades({}, {
    query: { queryKey: getListTradesQueryKey({}), refetchInterval: 15000 }
  });
  const { data: perf, refetch: refetchPerf } = useGetBotPerformance({
    query: { queryKey: getGetBotPerformanceQueryKey(), refetchInterval: 30000 }
  });
  const { data: equityCurve, refetch: refetchEquity } = useGetEquityCurve({
    query: { queryKey: getGetEquityCurveQueryKey(), refetchInterval: 30000 }
  });

  const updateMutation = useUpdateBotConfig();
  const cancelMutation = useCancelTrade();
  const testSignalMutation = useSendTestSignal();

  const [form, setForm] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testSymbol, setTestSymbol] = useState("BTCUSDT");
  const [testDir, setTestDir] = useState<"LONG" | "SHORT">("LONG");
  const [testing, setTesting] = useState(false);

  const current = form ?? config ?? {};

  function field<T>(key: string, fallback: T): T {
    return (current as Record<string, unknown>)[key] !== undefined
      ? ((current as Record<string, unknown>)[key] as T)
      : fallback;
  }

  function set(key: string, value: unknown) {
    setForm((prev) => ({ ...(prev ?? config ?? {}), [key]: value }));
    setSaved(false);
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      await updateMutation.mutateAsync({ data: form });
      queryClient.invalidateQueries({ queryKey: getGetBotConfigQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
      setForm(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled() {
    await updateMutation.mutateAsync({ data: { enabled: !config?.enabled } });
    queryClient.invalidateQueries({ queryKey: getGetBotConfigQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
  }

  async function handleCancel(id: number) {
    if (!confirm("Cancel this trade and its SL/TP orders?")) return;
    await cancelMutation.mutateAsync({ id });
    refetchTrades();
    refetchPerf();
    refetchEquity();
  }

  async function fireTestSignal() {
    setTesting(true);
    try {
      await testSignalMutation.mutateAsync({ data: { symbol: testSymbol, dir: testDir, tf: "4H", grade: "A+ Setup", confW: 75 } });
      setTimeout(() => {
        refetchTrades();
        refetchPerf();
        refetchEquity();
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
      }, 1500);
    } finally {
      setTesting(false);
    }
  }

  async function resetCompoundBalance() {
    if (!confirm("Reset compound balance back to base position size?")) return;
    await updateMutation.mutateAsync({ data: { compoundBalance: config?.positionSizeUsdt ?? 50 } });
    queryClient.invalidateQueries({ queryKey: getGetBotConfigQueryKey() });
  }

  if (configLoading) {
    return <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">Loading...</div>;
  }

  const apiOk = status?.apiConfigured;
  const isEnabled = config?.enabled;
  const isPaper = config?.paperMode;
  const currentMode = field("tradingMode", "all") as string;
  const compoundingOn = field("compoundingEnabled", false) as boolean;
  const compoundBalance = field("compoundBalance", null) as number | null;
  const baseSize = field("positionSizeUsdt", 50) as number;

  const activeModeStyle = TRADING_MODES.find((m) => m.id === currentMode);
  const effectiveSize = compoundingOn && compoundBalance != null
    ? compoundBalance
    : baseSize;
  const modeMultiplier: Record<string, number> = { all: 1, scalp: 0.5, intraday: 1, swing: 1.5, position: 2 };
  const nextPositionSize = (effectiveSize * (modeMultiplier[currentMode] ?? 1)).toFixed(2);

  const equityPoints = equityCurve?.points ?? [];

  return (
    <div className="space-y-5 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Bot className="w-5 h-5 text-primary" />
          <span className="font-bold tracking-tight">BOT CONTROL</span>
          {isPaper && (
            <span className="flex items-center gap-1.5 px-2 py-1 border border-violet-500/40 text-violet-400 bg-violet-500/10 text-xs font-bold">
              <FlaskConical className="w-3 h-3" />PAPER MODE
            </span>
          )}
          {isEnabled && !isPaper && (
            <span className="flex items-center gap-1.5 px-2 py-1 border border-green-500/40 text-green-400 bg-green-500/10 text-xs font-bold animate-pulse">
              <Zap className="w-3 h-3" />LIVE TRADING
            </span>
          )}
          {config?.longOnly && (
            <span className="flex items-center gap-1.5 px-2 py-1 border border-blue-500/40 text-blue-400 bg-blue-500/10 text-xs font-bold">
              <ArrowUpRight className="w-3 h-3" />LONG ONLY
            </span>
          )}
          {activeModeStyle && currentMode !== "all" && (
            <span className={`flex items-center gap-1 px-2 py-1 border text-xs font-bold ${activeModeStyle.active}`}>
              <Activity className="w-3 h-3" />{activeModeStyle.label}
            </span>
          )}
          {compoundingOn && (
            <span className="flex items-center gap-1.5 px-2 py-1 border border-yellow-500/40 text-yellow-400 bg-yellow-500/10 text-xs font-bold">
              <Repeat2 className="w-3 h-3" />COMPOUNDING
            </span>
          )}
        </div>

        <button
          onClick={toggleEnabled}
          disabled={!apiOk && !isPaper}
          className={`flex items-center gap-2 px-5 py-2.5 border font-bold text-sm tracking-widest transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
            isEnabled
              ? "border-red-500/50 text-red-400 bg-red-500/10 hover:bg-red-500/20"
              : "border-green-500/50 text-green-400 bg-green-500/10 hover:bg-green-500/20"
          }`}
        >
          {isEnabled ? <><XCircle className="w-4 h-4" />DISABLE BOT</> : <><CheckCircle className="w-4 h-4" />ENABLE BOT</>}
        </button>
      </div>

      {/* API key warning */}
      {!apiOk && (
        <div className="flex items-start gap-3 border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-300">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <div className="font-bold mb-1">Gate.io API key not configured</div>
            <div className="text-xs text-yellow-400/80">
              Add <code className="bg-black/30 px-1">GATEIO_API_KEY</code> and <code className="bg-black/30 px-1">GATEIO_API_SECRET</code> in Secrets. Until then, only Paper Mode trades will execute.
            </div>
          </div>
        </div>
      )}

      {/* Market Status */}
      <MarketStatusPanel />

      {/* Status strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "USDT BALANCE", value: status?.usdtBalance != null ? `${status.usdtBalance.toFixed(2)} USDT` : isPaper ? "Paper" : "—", icon: DollarSign, color: "text-primary" },
          { label: "OPEN TRADES", value: status?.openTrades ?? 0, icon: TrendingUp },
          { label: "TOTAL TRADES", value: status?.totalTrades ?? 0, icon: Target },
          { label: "NEXT SIZE", value: `${nextPositionSize} USDT`, icon: Activity, color: compoundingOn ? "text-yellow-400" : undefined },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="border border-border bg-card p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground tracking-widest mb-1">
              <Icon className="w-3 h-3" />{label}
            </div>
            <div className={`text-lg font-bold font-mono ${color ?? ""}`}>{String(value)}</div>
          </div>
        ))}
      </div>

      {status?.lastSyncAt && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <RefreshCw className="w-3 h-3" />
          Keep-alive sync active — last checked {timeSince(status.lastSyncAt)}
        </div>
      )}

      {/* Performance */}
      {perf && perf.totalTrades > 0 && (
        <div className="border border-border bg-card">
          <div className="px-4 py-3 border-b border-border bg-secondary/30 flex items-center gap-2">
            <BarChart2 className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs text-muted-foreground tracking-widest font-bold">PERFORMANCE</span>
          </div>
          <div className="p-4 grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <div className="text-xs text-muted-foreground tracking-widest mb-1">WIN RATE</div>
              <div className={`text-xl font-bold font-mono ${perf.winRate != null ? (perf.winRate >= 0.5 ? "text-green-400" : "text-red-400") : ""}`}>
                {perf.winRate != null ? `${(perf.winRate * 100).toFixed(1)}%` : "—"}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">{perf.closedTrades} closed</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground tracking-widest mb-1">TOTAL P&L</div>
              <div className={`text-xl font-bold font-mono ${perf.totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                {perf.totalPnl >= 0 ? "+" : ""}{perf.totalPnl.toFixed(4)}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                USDT
                {equityCurve?.totalReturnPct != null && (
                  <span className={`ml-2 font-bold ${equityCurve.totalReturnPct >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {fmtPct(equityCurve.totalReturnPct)}
                  </span>
                )}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground tracking-widest mb-1">BEST TRADE</div>
              <div className="text-xl font-bold font-mono text-green-400">
                {perf.bestTrade != null ? `+${perf.bestTrade.toFixed(4)}` : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground tracking-widest mb-1">WORST TRADE</div>
              <div className="text-xl font-bold font-mono text-red-400">
                {perf.worstTrade != null ? perf.worstTrade.toFixed(4) : "—"}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Equity Curve */}
      {equityPoints.length >= 1 && (
        <div className="border border-border bg-card">
          <div className="px-4 py-3 border-b border-border bg-secondary/30 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs text-muted-foreground tracking-widest font-bold">EQUITY CURVE</span>
            </div>
            <div className="text-xs text-muted-foreground font-mono">
              {equityPoints.length} trade{equityPoints.length !== 1 ? "s" : ""}
              {equityCurve?.totalPnl != null && (
                <span className={`ml-3 font-bold ${equityCurve.totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {equityCurve.totalPnl >= 0 ? "+" : ""}{equityCurve.totalPnl.toFixed(4)} USDT
                </span>
              )}
            </div>
          </div>
          <div className="p-4">
            <ResponsiveContainer width="100%" height={200}>
              <LineChart
                data={equityPoints.map((p, i) => ({ ...p, idx: i + 1 }))}
                margin={{ top: 4, right: 8, left: 0, bottom: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="idx" tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 10, fontFamily: "Space Mono, monospace" }} tickLine={false} axisLine={{ stroke: "rgba(255,255,255,0.08)" }} />
                <YAxis tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 10, fontFamily: "Space Mono, monospace" }} tickLine={false} axisLine={{ stroke: "rgba(255,255,255,0.08)" }} tickFormatter={(v: number) => v.toFixed(2)} width={60} />
                <Tooltip content={<EquityTooltip />} />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
                <Line
                  type="monotone"
                  dataKey="cumulative"
                  stroke="#22c55e"
                  strokeWidth={2}
                  dot={(props) => {
                    const { cx, cy, payload } = props;
                    return <circle key={`dot-${payload.idx}`} cx={cx} cy={cy} r={3.5} fill={payload.pnl >= 0 ? "#22c55e" : "#ef4444"} stroke="rgba(0,0,0,0.5)" strokeWidth={1} />;
                  }}
                  activeDot={{ r: 5, stroke: "#22c55e", fill: "#111" }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ─── TRADING MODE SELECTION ──────────────────────────────────────────── */}
      <div className="border border-border bg-card">
        <div className="px-4 py-3 border-b border-border bg-secondary/30 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs text-muted-foreground tracking-widest font-bold">TRADING MODE</span>
          </div>
          {form && (
            <button
              onClick={save}
              disabled={saving}
              className="px-3 py-1 border border-primary/50 text-primary bg-primary/10 hover:bg-primary/20 text-xs font-bold tracking-widest disabled:opacity-40"
            >
              {saving ? "Saving..." : "SAVE"}
            </button>
          )}
        </div>
        <div className="p-4 space-y-4">
          {/* Mode cards */}
          <div className="grid grid-cols-5 gap-2">
            {TRADING_MODES.map((mode) => {
              const isActive = currentMode === mode.id;
              return (
                <button
                  key={mode.id}
                  onClick={() => set("tradingMode", mode.id)}
                  className={`relative flex flex-col items-center gap-1 p-3 border transition-all ${
                    isActive ? mode.active : "border-border bg-secondary/30 hover:border-border/80 hover:bg-secondary/50 text-muted-foreground"
                  }`}
                >
                  {isActive && (
                    <span className={`absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full ${mode.dotColor}`} />
                  )}
                  <span className="text-xs font-bold tracking-wider">{mode.label}</span>
                  <span className="text-xs opacity-60">{mode.sublabel}</span>
                  <div className="mt-1 space-y-0.5 text-center">
                    <div className="text-xs opacity-50">{mode.tps}</div>
                    <div className={`text-xs font-bold ${isActive ? "" : "text-muted-foreground"}`}>{mode.multiplier} size</div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Mode description */}
          <div className="flex items-center gap-3 px-3 py-2 bg-secondary/20 border border-border/40 text-xs text-muted-foreground">
            <ChevronRight className="w-3 h-3 text-primary shrink-0" />
            <div>
              {currentMode === "all" && "All signals are accepted regardless of their Pine Script mode. Position size is used as-is."}
              {currentMode === "scalp" && "Only signals with mode='scalp' will be executed. Position size is halved — ideal for high-frequency, tight setups."}
              {currentMode === "intraday" && "Only signals with mode='Intraday' will be executed. Perfect for 4H/Daily chart signals from the Unified v1 indicator."}
              {currentMode === "swing" && "Only signals with mode='swing' will be executed. Position size is 1.5× — suited for multi-day holds using wider stops."}
              {currentMode === "position" && "All triggered signals are accepted regardless of mode. Size is 2× — reserve for highest-conviction setups."}
            </div>
          </div>

          {/* ─── COMPOUNDING ────────────────────────────────────────────────── */}
          <div className="border border-border/60 bg-secondary/10">
            <div className="px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Repeat2 className={`w-4 h-4 ${compoundingOn ? "text-yellow-400" : "text-muted-foreground"}`} />
                <div>
                  <div className="text-sm font-bold flex items-center gap-2">
                    Compounding Mode
                    {compoundingOn && <span className="text-xs font-normal text-yellow-400 border border-yellow-500/30 px-1.5 py-0.5">ACTIVE</span>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Reinvest profits — each trade uses the running compound balance as its base size
                  </div>
                </div>
              </div>
              <button
                onClick={() => set("compoundingEnabled", !compoundingOn)}
                className={`relative w-12 h-6 rounded-full border transition-colors ${compoundingOn ? "border-yellow-500 bg-yellow-500/20" : "border-border bg-secondary"}`}
              >
                <span className={`absolute top-0.5 w-5 h-5 rounded-full transition-all ${compoundingOn ? "left-6 bg-yellow-400" : "left-0.5 bg-muted-foreground/50"}`} />
              </button>
            </div>
            {compoundingOn && (
              <div className="px-4 pb-4 pt-0 border-t border-border/40 mt-0">
                <div className="grid grid-cols-3 gap-4 mt-3">
                  <div>
                    <div className="text-xs text-muted-foreground tracking-widest mb-1">COMPOUND BALANCE</div>
                    <div className={`text-xl font-bold font-mono ${
                      compoundBalance != null && compoundBalance > baseSize ? "text-green-400" :
                      compoundBalance != null && compoundBalance < baseSize ? "text-red-400" : "text-foreground"
                    }`}>
                      {compoundBalance != null ? `${compoundBalance.toFixed(4)} USDT` : "—"}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {compoundBalance != null && baseSize > 0
                        ? `${((compoundBalance - baseSize) / baseSize * 100 >= 0 ? "+" : "")}${((compoundBalance - baseSize) / baseSize * 100).toFixed(2)}% vs base`
                        : "base = positionSizeUsdt"}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground tracking-widest mb-1">NEXT POSITION SIZE</div>
                    <div className="text-xl font-bold font-mono text-yellow-400">
                      {nextPositionSize} USDT
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {compoundBalance?.toFixed(2)} × {modeMultiplier[currentMode] ?? 1}× ({currentMode})
                    </div>
                  </div>
                  <div className="flex flex-col justify-between">
                    <div className="text-xs text-muted-foreground tracking-widest mb-1">ACTIONS</div>
                    <button
                      onClick={resetCompoundBalance}
                      className="flex items-center gap-2 px-3 py-2 border border-border text-xs text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-all"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Reset to {baseSize} USDT
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ─── CONFIGURATION ─────────────────────────────────────────────────── */}
      <div className="border border-border bg-card">
        <div className="px-4 py-3 border-b border-border bg-secondary/30 flex items-center justify-between">
          <span className="text-xs text-muted-foreground tracking-widest font-bold">CONFIGURATION</span>
          <div className="flex items-center gap-3">
            {saved && <span className="text-xs text-green-400">Saved</span>}
            <button
              onClick={save}
              disabled={!form || saving}
              className="px-4 py-1.5 border border-primary/50 text-primary bg-primary/10 hover:bg-primary/20 text-xs font-bold tracking-widest disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              {saving ? "Saving..." : "SAVE CHANGES"}
            </button>
          </div>
        </div>
        <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-5">

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

          {/* Regime Gating — spans full width */}
          <div className={`md:col-span-2 border transition-colors ${field("regimeGatingEnabled", false) ? "border-orange-500/40 bg-orange-500/5" : "border-border bg-secondary/30"}`}>
            <div className="flex items-center justify-between p-4">
              <div className="flex items-center gap-3">
                <Globe className={`w-4 h-4 ${field("regimeGatingEnabled", false) ? "text-orange-400" : "text-muted-foreground"}`} />
                <div>
                  <div className="text-sm font-bold flex items-center gap-2">
                    Regime Gating
                    {field("regimeGatingEnabled", false) && (
                      <span className="text-xs font-normal text-orange-400 border border-orange-500/30 px-1.5 py-0.5">ACTIVE</span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Skip signals when market regime is unfavorable — uses live CoinGecko data (cached 60s)
                  </div>
                </div>
              </div>
              <button
                onClick={() => set("regimeGatingEnabled", !field("regimeGatingEnabled", false))}
                className={`relative w-12 h-6 rounded-full border transition-colors ${field("regimeGatingEnabled", false) ? "border-orange-500 bg-orange-500/20" : "border-border bg-secondary"}`}
              >
                <span className={`absolute top-0.5 w-5 h-5 rounded-full transition-all ${field("regimeGatingEnabled", false) ? "left-6 bg-orange-400" : "left-0.5 bg-muted-foreground/50"}`} />
              </button>
            </div>
            {field("regimeGatingEnabled", false) && (
              <div className="px-4 pb-4 pt-0 border-t border-orange-500/20">
                <div className="flex items-center justify-between mt-3">
                  <div>
                    <div className="text-sm font-bold mb-0.5 flex items-center gap-2">
                      <ShieldAlert className="w-3.5 h-3.5 text-red-400" />Block on RISK_OFF regime
                    </div>
                    <div className="text-xs text-muted-foreground">
                      When BTC.D−Stable.D &lt; 38 or Stable.D &gt; 14% — refuse all signals (stablecoin flight = market fear)
                    </div>
                  </div>
                  <button
                    onClick={() => set("blockOnRiskOff", !field("blockOnRiskOff", true))}
                    className={`relative w-12 h-6 rounded-full border transition-colors ${field("blockOnRiskOff", true) ? "border-red-500 bg-red-500/20" : "border-border bg-secondary"}`}
                  >
                    <span className={`absolute top-0.5 w-5 h-5 rounded-full transition-all ${field("blockOnRiskOff", true) ? "left-6 bg-red-400" : "left-0.5 bg-muted-foreground/50"}`} />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Position Size */}
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground tracking-widest flex items-center gap-2">
              <DollarSign className="w-3 h-3" />BASE POSITION SIZE (USDT)
            </label>
            <input
              type="number"
              min={1}
              value={field("positionSizeUsdt", 50) as number}
              onChange={(e) => set("positionSizeUsdt", parseFloat(e.target.value))}
              className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
            />
            <p className="text-xs text-muted-foreground">Base USDT per trade (mode multiplier applied on top)</p>
          </div>

          {/* Min Confidence */}
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground tracking-widest">MIN CONF_W (%)</label>
            <input
              type="number"
              min={0}
              max={100}
              value={field("minConfW", 60) as number}
              onChange={(e) => set("minConfW", parseFloat(e.target.value))}
              className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
            />
            <p className="text-xs text-muted-foreground">Skip signals below this weighted confidence</p>
          </div>

          {/* Min Grade */}
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground tracking-widest">MINIMUM GRADE</label>
            <select
              value={field("minGrade", "Strong Setup") as string}
              onChange={(e) => set("minGrade", e.target.value)}
              className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
            >
              <option value="Setup">Setup (all)</option>
              <option value="Strong Setup">Strong Setup</option>
              <option value="A+ Setup">A+ Setup only</option>
            </select>
          </div>

          {/* Allowed Symbols */}
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground tracking-widest">ALLOWED SYMBOLS</label>
            <input
              type="text"
              placeholder="BTCUSDT, ETHUSDT (empty = all)"
              value={field("allowedSymbols", "") as string}
              onChange={(e) => set("allowedSymbols", e.target.value)}
              className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary placeholder:text-muted-foreground/40"
            />
          </div>

          {/* Max Open Trades */}
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground tracking-widest flex items-center gap-2">
              <Layers className="w-3 h-3" />MAX OPEN TRADES
            </label>
            <input
              type="number"
              min={1}
              max={20}
              value={field("maxOpenTrades", 3) as number}
              onChange={(e) => set("maxOpenTrades", parseInt(e.target.value))}
              className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
            />
          </div>

          {/* Cooldown */}
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground tracking-widest flex items-center gap-2">
              <Timer className="w-3 h-3" />COOLDOWN (MINUTES)
            </label>
            <input
              type="number"
              min={0}
              value={field("cooldownMinutes", 0) as number}
              onChange={(e) => set("cooldownMinutes", parseInt(e.target.value))}
              className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
            />
            <p className="text-xs text-muted-foreground">0 = disabled</p>
          </div>

          {/* SL/TP toggles */}
          <div className="md:col-span-2 space-y-3">
            <div className="text-xs text-muted-foreground tracking-widest flex items-center gap-2">
              <ShieldAlert className="w-3 h-3" />STOP LOSS &amp; TAKE PROFIT ORDERS
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { key: "slEnabled", label: "STOP LOSS", color: "red" },
                { key: "tp1Enabled", label: "TP1", color: "green" },
                { key: "tp2Enabled", label: "TP2", color: "green" },
                { key: "tp3Enabled", label: "TP3", color: "green" },
              ].map(({ key, label, color }) => (
                <button
                  key={key}
                  onClick={() => set(key, !field(key, true))}
                  className={`flex items-center justify-between px-3 py-2.5 border transition-colors ${
                    field(key, true)
                      ? color === "red" ? "border-red-500/50 bg-red-500/10 text-red-400" : "border-green-500/50 bg-green-500/10 text-green-400"
                      : "border-border bg-secondary text-muted-foreground"
                  }`}
                >
                  <span className="text-xs font-bold tracking-wider">{label}</span>
                  {field(key, true) ? <CheckCircle className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                </button>
              ))}
            </div>
          </div>

          {/* TP allocation */}
          <div className="md:col-span-2 space-y-3">
            <div className="text-xs text-muted-foreground tracking-widest">TP POSITION ALLOCATION (%)</div>
            <div className="grid grid-cols-3 gap-3">
              {[{ key: "tp1Pct", label: "TP1 %" }, { key: "tp2Pct", label: "TP2 %" }, { key: "tp3Pct", label: "TP3 %" }].map(({ key, label }) => (
                <div key={key} className="space-y-1">
                  <label className="text-xs text-muted-foreground">{label}</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={field(key, 33) as number}
                    onChange={(e) => set(key, parseFloat(e.target.value))}
                    className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
                  />
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Total: {((field("tp1Pct", 50) as number) + (field("tp2Pct", 30) as number) + (field("tp3Pct", 20) as number)).toFixed(0)}% — should sum to 100%
            </p>
          </div>
        </div>
      </div>

      {/* Telegram hint */}
      <div className="flex items-start gap-3 border border-border bg-secondary/20 px-4 py-3 text-xs text-muted-foreground">
        <span className="text-lg leading-none">💬</span>
        <div>
          <span className="text-foreground font-bold">Telegram notifications</span> — set <code className="bg-black/30 px-1 text-primary">TELEGRAM_BOT_TOKEN</code> and <code className="bg-black/30 px-1 text-primary">TELEGRAM_CHAT_ID</code> in Secrets to receive trade alerts on your phone.
        </div>
      </div>

      {/* Test Signal */}
      <div className="border border-border bg-card">
        <div className="px-4 py-3 border-b border-border bg-secondary/30 flex items-center gap-2">
          <PlayCircle className="w-3.5 h-3.5 text-primary" />
          <span className="text-xs text-muted-foreground tracking-widest font-bold">TEST SIGNAL</span>
        </div>
        <div className="p-4 flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground tracking-widest">SYMBOL</label>
            <select value={testSymbol} onChange={(e) => setTestSymbol(e.target.value)} className="bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary">
              {TEST_SYMBOLS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground tracking-widest">DIRECTION</label>
            <select value={testDir} onChange={(e) => setTestDir(e.target.value as "LONG" | "SHORT")} className="bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary">
              <option value="LONG">LONG</option>
              <option value="SHORT">SHORT {config?.longOnly ? "(blocked)" : ""}</option>
            </select>
          </div>
          <button
            onClick={fireTestSignal}
            disabled={testing || !isEnabled}
            className="flex items-center gap-2 px-4 py-2 border border-primary/50 text-primary bg-primary/10 hover:bg-primary/20 text-sm font-bold tracking-widest disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            <PlayCircle className="w-4 h-4" />
            {testing ? "FIRING..." : "FIRE TEST"}
          </button>
          {!isEnabled && <span className="text-xs text-muted-foreground">Enable the bot first</span>}
        </div>
      </div>

      {/* Trade History */}
      <div>
        <div className="text-xs text-muted-foreground tracking-widest mb-3">TRADE HISTORY</div>
        <div className="border border-border overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-border bg-secondary/50">
                {["TIME", "SYMBOL", "SIDE", "ENTRY", "LIVE", "SL", "TP1", "P&L", "RETURN", "STATUS", ""].map(h => (
                  <th key={h} className="px-3 py-2.5 text-left text-muted-foreground tracking-widest font-normal whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {!tradesData?.trades?.length && (
                <tr>
                  <td colSpan={11} className="px-3 py-10 text-center text-muted-foreground">
                    No trades yet. Enable the bot to start executing signals.
                  </td>
                </tr>
              )}
              {tradesData?.trades?.map(t => {
                const pnlColor = t.pnl == null ? "" : t.pnl >= 0 ? "text-green-400" : "text-red-400";
                const isOpen = t.status === "open" || t.status === "paper";
                const retPct = computeReturnPct(t);
                return (
                  <tr key={t.id} className="border-b border-border/40 hover:bg-secondary/40 transition-colors group">
                    <td className="px-3 py-2 text-muted-foreground">
                      <div className="flex items-center gap-1"><Clock className="w-3 h-3" />{timeSince(t.createdAt)}</div>
                    </td>
                    <td className="px-3 py-2 font-bold">
                      <Link href={`/signal/${t.signalId}`} className={`hover:underline ${t.side === "buy" ? "text-green-400" : "text-red-400"}`}>
                        {t.symbol}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`flex items-center gap-1 font-bold ${t.side === "buy" ? "text-green-400" : "text-red-400"}`}>
                        {t.side === "buy" ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                        {t.side.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-3 py-2">{fmt(t.entryPrice)}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {isOpen && t.livePrice != null ? (
                        <span className={t.side === "buy" ? (t.livePrice > (t.entryPrice ?? 0) ? "text-green-400" : "text-red-400") : (t.livePrice < (t.entryPrice ?? 0) ? "text-green-400" : "text-red-400")}>
                          {fmt(t.livePrice)}
                        </span>
                      ) : t.closePrice != null ? fmt(t.closePrice) : "—"}
                    </td>
                    <td className="px-3 py-2 text-red-400">{fmt(t.slPrice)}</td>
                    <td className="px-3 py-2 text-green-400">{fmt(t.tp1Price)}</td>
                    <td className={`px-3 py-2 font-bold ${pnlColor}`}>
                      {t.pnl != null ? (
                        <span>
                          {fmtPnl(t.pnl)} USDT
                          {t.closeReason && t.closeReason !== "manual" && (
                            <span className="ml-1 text-muted-foreground font-normal">via {t.closeReason.toUpperCase()}</span>
                          )}
                        </span>
                      ) : "—"}
                    </td>
                    <td className={`px-3 py-2 font-bold ${pnlColor}`}>
                      {retPct != null ? fmtPct(retPct) : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <StatusBadge status={t.status} />
                        {t.paperMode && t.status !== "paper" && <span className="text-violet-400 text-xs">paper</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {isOpen && (
                        <button onClick={() => handleCancel(t.id)} className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-400 text-muted-foreground transition-all">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="text-xs text-muted-foreground">
        Trades are linked to signals — view them in{" "}
        <Link href="/signals" className="text-primary hover:underline">Signal History</Link>.
      </div>
    </div>
  );
}
