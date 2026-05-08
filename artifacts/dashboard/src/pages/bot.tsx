import { useState } from "react";
import {
  useGetBotConfig,
  useUpdateBotConfig,
  useGetBotStatus,
  useListTrades,
  useCancelTrade,
  getGetBotConfigQueryKey,
  getGetBotStatusQueryKey,
  getListTradesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
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
} from "lucide-react";
import { Link } from "wouter";

function fmt(v: number | null | undefined, d = 4) {
  if (v == null) return "—";
  return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
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
  const updateMutation = useUpdateBotConfig();
  const cancelMutation = useCancelTrade();

  const [form, setForm] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

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
  }

  if (configLoading) {
    return <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">Loading...</div>;
  }

  const apiOk = status?.apiConfigured;
  const isEnabled = config?.enabled;
  const isPaper = config?.paperMode;

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
          <div className="md:col-span-2 flex items-center justify-between p-4 border border-border bg-secondary/30">
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

      {/* Trade History */}
      <div>
        <div className="text-xs text-muted-foreground tracking-widest mb-3">TRADE HISTORY</div>
        <div className="border border-border overflow-hidden">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-border bg-secondary/50">
                {["TIME", "SYMBOL", "SIDE", "ENTRY", "SL", "TP1", "SIZE", "STATUS", ""].map(h => (
                  <th key={h} className="px-3 py-2.5 text-left text-muted-foreground tracking-widest font-normal whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {!tradesData?.trades?.length && (
                <tr>
                  <td colSpan={9} className="px-3 py-10 text-center text-muted-foreground">
                    No trades yet. Enable the bot to start executing signals.
                  </td>
                </tr>
              )}
              {tradesData?.trades?.map(t => (
                <tr key={t.id} className="border-b border-border/40 hover:bg-secondary/40 transition-colors group">
                  <td className="px-3 py-2 text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {timeSince(t.createdAt)}
                    </div>
                  </td>
                  <td className={`px-3 py-2 font-bold ${t.side === "buy" ? "text-green-400" : "text-red-400"}`}>{t.symbol}</td>
                  <td className="px-3 py-2">
                    <span className={`flex items-center gap-1 font-bold ${t.side === "buy" ? "text-green-400" : "text-red-400"}`}>
                      {t.side === "buy" ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      {t.side.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-foreground">{fmt(t.entryPrice)}</td>
                  <td className="px-3 py-2 text-red-400">{fmt(t.slPrice)}</td>
                  <td className="px-3 py-2 text-green-400">{fmt(t.tp1Price)}</td>
                  <td className="px-3 py-2 text-muted-foreground">{t.positionSizeUsdt != null ? `${t.positionSizeUsdt}` : "—"} USDT</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={t.status} />
                      {t.paperMode && <span className="text-violet-400 text-xs">paper</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {(t.status === "open" || t.status === "paper") && (
                      <button
                        onClick={() => handleCancel(t.id)}
                        className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-400 text-muted-foreground transition-all"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
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
