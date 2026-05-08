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
  getGetBotConfigQueryKey,
  getGetBotStatusQueryKey,
  getListTradesQueryKey,
  getGetBotPerformanceQueryKey,
  getGetEquityCurveQueryKey,
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
  TrendingDown as TrendingDownIcon,
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

// Custom tooltip for equity curve
function EquityTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: { symbol: string; pnl: number; cumulative: number; closeReason: string | null; returnPct: number | null } }> }) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  const pnlColor = d.pnl >= 0 ? "text-green-400" : "text-red-400";
  const cumColor = d.cumulative >= 0 ? "text-green-400" : "text-red-400";
  return (
    <div className="bg-card border border-border px-3 py-2 text-xs font-mono space-y-1 shadow-lg">
      <div className="font-bold text-foreground">{d.symbol}</div>
      <div className={pnlColor}>Trade: {d.pnl >= 0 ? "+" : ""}{d.pnl.toFixed(4)} USDT{d.returnPct != null ? ` (${fmtPct(d.returnPct)})` : ""}</div>
      <div className={cumColor}>Cumulative: {d.cumulative >= 0 ? "+" : ""}{d.cumulative.toFixed(4)} USDT</div>
      {d.closeReason && <div className="text-muted-foreground">via {d.closeReason.toUpperCase()}</div>}
    </div>
  );
}

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

  if (configLoading) {
    return <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">Loading...</div>;
  }

  const apiOk = status?.apiConfigured;
  const isEnabled = config?.enabled;
  const isPaper = config?.paperMode;
  const isLongOnly = field("longOnly", false) as boolean;

  const equityPoints = equityCurve?.points ?? [];
  const hasEquityData = equityPoints.length >= 1;

  return (
    <div className="space-y-5 max-w-4xl">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Bot className="w-5 h-5 text-primary" />
          <span className="font-bold tracking-tight">BOT CONTROL</span>
          {isPaper && (
            <span className="flex items-center gap-1.5 px-2 py-1 border border-violet-500/40 text-violet-400 bg-violet-500/10 text-xs font-bold">
              <FlaskConical className="w-3 h-3" />
              PAPER MODE
            </span>
          )}
          {isEnabled && !isPaper && (
            <span className="flex items-center gap-1.5 px-2 py-1 border border-green-500/40 text-green-400 bg-green-500/10 text-xs font-bold animate-pulse">
              <Zap className="w-3 h-3" />
              LIVE TRADING
            </span>
          )}
          {config?.longOnly && (
            <span className="flex items-center gap-1.5 px-2 py-1 border border-blue-500/40 text-blue-400 bg-blue-500/10 text-xs font-bold">
              <ArrowUpRight className="w-3 h-3" />
              LONG ONLY
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
          {isEnabled ? <><XCircle className="w-4 h-4" /> DISABLE BOT</> : <><CheckCircle className="w-4 h-4" /> ENABLE BOT</>}
        </button>
      </div>

      {/* API key warning */}
      {!apiOk && (
        <div className="flex items-start gap-3 border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-300">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <div className="font-bold mb-1">Gate.io API key not configured</div>
            <div className="text-xs text-yellow-400/80">
              Add <code className="bg-black/30 px-1">GATEIO_API_KEY</code> and <code className="bg-black/30 px-1">GATEIO_API_SECRET</code> in your Secrets panel. Until then, only Paper Mode trades will be simulated.
            </div>
          </div>
        </div>
      )}

      {/* Status strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "USDT BALANCE", value: status?.usdtBalance != null ? `${status.usdtBalance.toFixed(2)} USDT` : isPaper ? "Paper" : "—", icon: DollarSign, color: "text-primary" },
          { label: "OPEN TRADES", value: status?.openTrades ?? 0, icon: TrendingUp },
          { label: "TOTAL TRADES", value: status?.totalTrades ?? 0, icon: Target },
          { label: "API STATUS", value: apiOk ? "Connected" : "Missing Keys", icon: apiOk ? CheckCircle : AlertTriangle, color: apiOk ? "text-green-400" : "text-yellow-400" },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="border border-border bg-card p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground tracking-widest mb-1">
              <Icon className="w-3 h-3" />
              {label}
            </div>
            <div className={`text-lg font-bold font-mono ${color ?? ""}`}>{String(value)}</div>
          </div>
        ))}
      </div>

      {/* Last sync indicator */}
      {status?.lastSyncAt && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <RefreshCw className="w-3 h-3" />
          Keep-alive sync active — last checked {timeSince(status.lastSyncAt)}
        </div>
      )}

      {/* Performance Stats */}
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
      {hasEquityData && (
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
                <XAxis
                  dataKey="idx"
                  tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 10, fontFamily: "Space Mono, monospace" }}
                  tickLine={false}
                  axisLine={{ stroke: "rgba(255,255,255,0.08)" }}
                  label={{ value: "Trade #", position: "insideBottomRight", offset: -4, fill: "rgba(255,255,255,0.2)", fontSize: 9 }}
                />
                <YAxis
                  tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 10, fontFamily: "Space Mono, monospace" }}
                  tickLine={false}
                  axisLine={{ stroke: "rgba(255,255,255,0.08)" }}
                  tickFormatter={(v: number) => v.toFixed(2)}
                  width={60}
                />
                <Tooltip content={<EquityTooltip />} />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
                <Line
                  type="monotone"
                  dataKey="cumulative"
                  stroke="#22c55e"
                  strokeWidth={2}
                  dot={(props) => {
                    const { cx, cy, payload } = props;
                    const color = payload.pnl >= 0 ? "#22c55e" : "#ef4444";
                    return <circle key={`dot-${payload.idx}`} cx={cx} cy={cy} r={3.5} fill={color} stroke="rgba(0,0,0,0.5)" strokeWidth={1} />;
                  }}
                  activeDot={{ r: 5, stroke: "#22c55e", fill: "#111" }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Config Form */}
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

          {/* Paper Mode Toggle */}
          <div className="flex items-center justify-between p-4 border border-border bg-secondary/30">
            <div>
              <div className="text-sm font-bold mb-0.5">Paper Mode</div>
              <div className="text-xs text-muted-foreground">Simulate trades without placing real orders on Gate.io</div>
            </div>
            <button
              onClick={() => set("paperMode", !field("paperMode", true))}
              className={`relative w-12 h-6 rounded-full border transition-colors ${field("paperMode", true) ? "border-violet-500 bg-violet-500/20" : "border-green-500 bg-green-500/20"}`}
            >
              <span className={`absolute top-0.5 w-5 h-5 rounded-full transition-all ${field("paperMode", true) ? "left-0.5 bg-violet-400" : "left-6 bg-green-400"}`} />
            </button>
          </div>

          {/* Long Only Toggle */}
          <div className="flex items-center justify-between p-4 border border-border bg-secondary/30">
            <div>
              <div className="text-sm font-bold mb-0.5 flex items-center gap-2">
                <ArrowUpRight className="w-3.5 h-3.5 text-blue-400" />
                Long Only
              </div>
              <div className="text-xs text-muted-foreground">Skip SHORT signals — safer for spot trading</div>
            </div>
            <button
              onClick={() => set("longOnly", !field("longOnly", false))}
              className={`relative w-12 h-6 rounded-full border transition-colors ${isLongOnly ? "border-blue-500 bg-blue-500/20" : "border-border bg-secondary"}`}
            >
              <span className={`absolute top-0.5 w-5 h-5 rounded-full transition-all ${isLongOnly ? "left-6 bg-blue-400" : "left-0.5 bg-muted-foreground/50"}`} />
            </button>
          </div>

          {/* Position Size */}
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground tracking-widest flex items-center gap-2">
              <DollarSign className="w-3 h-3" />
              POSITION SIZE (USDT)
            </label>
            <input
              type="number"
              min={1}
              value={field("positionSizeUsdt", 50) as number}
              onChange={(e) => set("positionSizeUsdt", parseFloat(e.target.value))}
              className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
            />
            <p className="text-xs text-muted-foreground">Amount of USDT to use per trade</p>
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
            <p className="text-xs text-muted-foreground">Comma-separated. Leave empty to allow all symbols</p>
          </div>

          {/* Max Open Trades */}
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground tracking-widest flex items-center gap-2">
              <Layers className="w-3 h-3" />
              MAX OPEN TRADES
            </label>
            <input
              type="number"
              min={1}
              max={20}
              value={field("maxOpenTrades", 3) as number}
              onChange={(e) => set("maxOpenTrades", parseInt(e.target.value))}
              className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
            />
            <p className="text-xs text-muted-foreground">Stop opening new positions beyond this limit</p>
          </div>

          {/* Cooldown */}
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground tracking-widest flex items-center gap-2">
              <Timer className="w-3 h-3" />
              COOLDOWN (MINUTES)
            </label>
            <input
              type="number"
              min={0}
              value={field("cooldownMinutes", 0) as number}
              onChange={(e) => set("cooldownMinutes", parseInt(e.target.value))}
              className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
            />
            <p className="text-xs text-muted-foreground">Min minutes between trades on the same symbol. 0 = disabled</p>
          </div>

          {/* SL/TP toggles */}
          <div className="md:col-span-2 space-y-3">
            <div className="text-xs text-muted-foreground tracking-widest mb-2 flex items-center gap-2">
              <ShieldAlert className="w-3 h-3" />
              STOP LOSS &amp; TAKE PROFIT ORDERS
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
              {[
                { key: "tp1Pct", label: "TP1 %" },
                { key: "tp2Pct", label: "TP2 %" },
                { key: "tp3Pct", label: "TP3 %" },
              ].map(({ key, label }) => (
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
              Total: {(
                (field("tp1Pct", 50) as number) +
                (field("tp2Pct", 30) as number) +
                (field("tp3Pct", 20) as number)
              ).toFixed(0)}% — should ideally sum to 100%
            </p>
          </div>
        </div>
      </div>

      {/* Telegram notification hint */}
      <div className="flex items-start gap-3 border border-border bg-secondary/20 px-4 py-3 text-xs text-muted-foreground">
        <span className="text-lg leading-none">💬</span>
        <div>
          <span className="text-foreground font-bold">Telegram notifications</span> — set <code className="bg-black/30 px-1 text-primary">TELEGRAM_BOT_TOKEN</code> and <code className="bg-black/30 px-1 text-primary">TELEGRAM_CHAT_ID</code> in your Secrets panel to receive trade open/close alerts on your phone.
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
            <select
              value={testSymbol}
              onChange={(e) => setTestSymbol(e.target.value)}
              className="bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
            >
              {TEST_SYMBOLS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground tracking-widest">DIRECTION</label>
            <select
              value={testDir}
              onChange={(e) => setTestDir(e.target.value as "LONG" | "SHORT")}
              className="bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
            >
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
          {!isEnabled && (
            <span className="text-xs text-muted-foreground">Enable the bot first to fire test signals</span>
          )}
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
                const pnlVal = t.pnl;
                const pnlColor = pnlVal == null ? "" : pnlVal >= 0 ? "text-green-400" : "text-red-400";
                const isOpen = t.status === "open" || t.status === "paper";
                const retPct = computeReturnPct(t);
                return (
                  <tr key={t.id} className="border-b border-border/40 hover:bg-secondary/40 transition-colors group">
                    <td className="px-3 py-2 text-muted-foreground">
                      <div className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {timeSince(t.createdAt)}
                      </div>
                    </td>
                    <td className={`px-3 py-2 font-bold`}>
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
                    <td className="px-3 py-2 text-foreground">{fmt(t.entryPrice)}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {isOpen && t.livePrice != null ? (
                        <span className={
                          t.livePrice !== t.entryPrice
                            ? (t.side === "buy"
                              ? (t.livePrice > (t.entryPrice ?? 0) ? "text-green-400" : "text-red-400")
                              : (t.livePrice < (t.entryPrice ?? 0) ? "text-green-400" : "text-red-400"))
                            : ""
                        }>
                          {fmt(t.livePrice)}
                        </span>
                      ) : t.closePrice != null ? fmt(t.closePrice) : "—"}
                    </td>
                    <td className="px-3 py-2 text-red-400">{fmt(t.slPrice)}</td>
                    <td className="px-3 py-2 text-green-400">{fmt(t.tp1Price)}</td>
                    <td className={`px-3 py-2 font-bold ${pnlColor}`}>
                      {pnlVal != null ? (
                        <span>
                          {fmtPnl(pnlVal)} USDT
                          {t.closeReason && t.closeReason !== "manual" && (
                            <span className="ml-1 text-muted-foreground font-normal text-xs">via {t.closeReason.toUpperCase()}</span>
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
                        <button
                          onClick={() => handleCancel(t.id)}
                          className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-400 text-muted-foreground transition-all"
                        >
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

      {/* Signal link */}
      <div className="text-xs text-muted-foreground">
        Trades are linked to signals. View them in{" "}
        <Link href="/signals" className="text-primary hover:underline">Signal History</Link>.
      </div>
    </div>
  );
}
