import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { getBotConfig, runBacktest } from "@workspace/api-client-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend,
} from "recharts";
import {
  FlaskConical, TrendingUp, TrendingDown, PlayCircle, ChevronDown, ChevronRight,
  Award, Target, Hash, Clock, Filter, CheckCircle, XCircle,
} from "lucide-react";

function fmtPnl(v: number | null | undefined, decimals = 3) {
  if (v == null) return "—";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(decimals)}`;
}
function pct(v: number | null | undefined) {
  if (v == null) return "—";
  return `${(v * 100).toFixed(1)}%`;
}
function timeSince(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  return `${Math.floor(diff / 60000)}m ago`;
}

const GRADE_OPTIONS = ["Setup", "Strong Setup", "A+ Setup"];
const MODE_OPTIONS = ["all", "scalp", "intraday", "swing", "position"];

type BtTrade = {
  signalId: number;
  receivedAt: string;
  symbol: string;
  dir: string;
  grade: string | null;
  mode: string | null;
  tf: string;
  confW: number | null;
  rr: number | null;
  entryPrice: number | null;
  slPrice: number | null;
  tp1Price: number | null;
  hypotheticalWin: number | null;
  hypotheticalLoss: number | null;
  actualPnl: number | null;
  hasActual: boolean;
  actualCloseReason: string | null;
};

type BtResult = {
  config: Record<string, unknown>;
  totalSignals: number;
  matchedSignals: number;
  filterRate: number;
  trades: BtTrade[];
  scenarios: {
    optimistic: { totalPnl: number; winRate: number; tradeCount: number; equityCurve: Array<{ idx: number; pnl: number }> };
    pessimistic: { totalPnl: number; winRate: number; tradeCount: number; equityCurve: Array<{ idx: number; pnl: number }> };
    actual: { totalPnl: number; winRate: number | null; tradeCount: number; equityCurve: Array<{ idx: number; pnl: number; symbol: string }> };
  };
};

function ScenarioTooltip({ active, payload }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }> }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border px-3 py-2 text-xs font-mono space-y-1 shadow-lg">
      {payload.map((p) => (
        <div key={p.name} style={{ color: p.color }}>
          {p.name}: {fmtPnl(p.value)} USDT
        </div>
      ))}
    </div>
  );
}

function buildCombinedCurve(result: BtResult) {
  const maxLen = Math.max(
    result.scenarios.optimistic.equityCurve.length,
    result.scenarios.pessimistic.equityCurve.length,
  );
  return Array.from({ length: maxLen }, (_, i) => ({
    idx: i + 1,
    optimistic: result.scenarios.optimistic.equityCurve[i]?.pnl ?? null,
    pessimistic: result.scenarios.pessimistic.equityCurve[i]?.pnl ?? null,
  }));
}

export function BacktestPage() {
  const { data: config } = useQuery({
    queryKey: ["bot-config-bt"],
    queryFn: () => getBotConfig(),
  });

  const [params, setParams] = useState<{
    minConfW: number;
    minGrade: string;
    tradingMode: string;
    longOnly: boolean;
    allowedSymbols: string;
    positionSizeUsdt: number;
  } | null>(null);

  const [result, setResult] = useState<BtResult | null>(null);
  const [showTrades, setShowTrades] = useState(false);
  const [filterDir, setFilterDir] = useState<"" | "LONG" | "SHORT">("");

  const mutation = useMutation({
    mutationFn: (p: typeof params) => runBacktest({ data: p ?? {} }),
    onSuccess: (data) => setResult(data as BtResult),
  });

  function getParams() {
    return params ?? {
      minConfW: config?.minConfW ?? 0,
      minGrade: config?.minGrade ?? "Setup",
      tradingMode: config?.tradingMode ?? "all",
      longOnly: config?.longOnly ?? false,
      allowedSymbols: config?.allowedSymbols ?? "",
      positionSizeUsdt: config?.positionSizeUsdt ?? 50,
    };
  }

  function set(key: string, val: unknown) {
    setParams((prev) => ({ ...getParams(), ...(prev ?? {}), [key]: val }));
    setResult(null);
  }

  const p = getParams();
  const curveData = result ? buildCombinedCurve(result) : [];
  const filteredTrades = result?.trades.filter((t) => !filterDir || t.dir === filterDir) ?? [];

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-center gap-3">
        <FlaskConical className="w-5 h-5 text-primary" />
        <span className="font-bold tracking-tight">BACKTEST REPLAY</span>
        <span className="text-xs text-muted-foreground">Replay your signal filter over all historical signals</span>
      </div>

      <div className="border border-border bg-secondary/20 px-4 py-3 text-xs text-muted-foreground flex items-start gap-2">
        <ChevronRight className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" />
        <div>
          Applies your filter config to every triggered signal in history.
          For signals with a real closed trade the <span className="text-foreground">actual P&L</span> is used.
          For signals without a linked trade, two scenario bounds are computed:
          <span className="text-green-400 ml-1">Optimistic</span> (all TP1 hit) and
          <span className="text-red-400 ml-1">Pessimistic</span> (all SL hit) — giving you a best/worst envelope.
        </div>
      </div>

      {/* Config panel */}
      <div className="border border-border bg-card">
        <div className="px-4 py-3 border-b border-border bg-secondary/30 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Filter className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs text-muted-foreground tracking-widest font-bold">FILTER CONFIG</span>
          </div>
          <button
            onClick={() => { setParams(null); setResult(null); }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Reset to current bot config
          </button>
        </div>
        <div className="p-4 grid grid-cols-2 md:grid-cols-3 gap-4">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground tracking-widest">MIN CONF_W (%)</label>
            <input
              type="number" min={0} max={100} value={p.minConfW}
              onChange={(e) => set("minConfW", parseFloat(e.target.value))}
              className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground tracking-widest">MIN GRADE</label>
            <select
              value={p.minGrade}
              onChange={(e) => set("minGrade", e.target.value)}
              className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
            >
              {GRADE_OPTIONS.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground tracking-widest">TRADING MODE</label>
            <select
              value={p.tradingMode}
              onChange={(e) => set("tradingMode", e.target.value)}
              className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
            >
              {MODE_OPTIONS.map(m => <option key={m} value={m}>{m.toUpperCase()}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground tracking-widest">POSITION SIZE (USDT)</label>
            <input
              type="number" min={1} value={p.positionSizeUsdt}
              onChange={(e) => set("positionSizeUsdt", parseFloat(e.target.value))}
              className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground tracking-widest">ALLOWED SYMBOLS</label>
            <input
              type="text" placeholder="empty = all" value={p.allowedSymbols}
              onChange={(e) => set("allowedSymbols", e.target.value)}
              className="w-full bg-secondary border border-border px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary placeholder:text-muted-foreground/40"
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={() => {
                setResult(null);
                mutation.mutate(params);
              }}
              disabled={mutation.isPending}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 border border-primary/60 text-primary bg-primary/10 hover:bg-primary/20 font-bold text-sm tracking-widest disabled:opacity-40 transition-all"
            >
              <PlayCircle className="w-4 h-4" />
              {mutation.isPending ? "RUNNING..." : "RUN BACKTEST"}
            </button>
          </div>
        </div>
        <div className="px-4 pb-3">
          <label className="flex items-center gap-3 cursor-pointer">
            <button
              onClick={() => set("longOnly", !p.longOnly)}
              className={`relative w-10 h-5 rounded-full border transition-colors ${p.longOnly ? "border-blue-500 bg-blue-500/20" : "border-border bg-secondary"}`}
            >
              <span className={`absolute top-0.5 w-4 h-4 rounded-full transition-all ${p.longOnly ? "left-5 bg-blue-400" : "left-0.5 bg-muted-foreground/50"}`} />
            </button>
            <span className="text-xs text-muted-foreground">Long only</span>
          </label>
        </div>
      </div>

      {/* Results */}
      {result && (
        <div className="space-y-5">
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="border border-border bg-card p-4">
              <div className="text-xs text-muted-foreground tracking-widest mb-1">SIGNALS MATCHED</div>
              <div className="text-2xl font-bold font-mono">{result.matchedSignals}</div>
              <div className="text-xs text-muted-foreground mt-0.5">of {result.totalSignals} total ({(result.filterRate * 100).toFixed(0)}%)</div>
            </div>
            <div className="border border-green-500/30 bg-green-500/5 p-4">
              <div className="text-xs text-muted-foreground tracking-widest mb-1">OPTIMISTIC (ALL TP1)</div>
              <div className={`text-2xl font-bold font-mono ${result.scenarios.optimistic.totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                {fmtPnl(result.scenarios.optimistic.totalPnl)}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">USDT</div>
            </div>
            <div className="border border-red-500/30 bg-red-500/5 p-4">
              <div className="text-xs text-muted-foreground tracking-widest mb-1">PESSIMISTIC (ALL SL)</div>
              <div className="text-2xl font-bold font-mono text-red-400">
                {fmtPnl(result.scenarios.pessimistic.totalPnl)}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">USDT</div>
            </div>
            <div className="border border-primary/30 bg-primary/5 p-4">
              <div className="text-xs text-muted-foreground tracking-widest mb-1">ACTUAL ({result.scenarios.actual.tradeCount} trades)</div>
              <div className={`text-2xl font-bold font-mono ${result.scenarios.actual.totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                {result.scenarios.actual.tradeCount > 0 ? fmtPnl(result.scenarios.actual.totalPnl) : "—"}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {result.scenarios.actual.tradeCount > 0 ? `WR ${pct(result.scenarios.actual.winRate)}` : "no real trades"}
              </div>
            </div>
          </div>

          {/* Equity curve */}
          {curveData.length > 0 && (
            <div className="border border-border bg-card">
              <div className="px-4 py-3 border-b border-border bg-secondary/30 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <TrendingUp className="w-3.5 h-3.5 text-primary" />
                  <span className="text-xs text-muted-foreground tracking-widest font-bold">SCENARIO EQUITY CURVES</span>
                </div>
                <span className="text-xs text-muted-foreground">Green=optimistic · Red=pessimistic</span>
              </div>
              <div className="p-4">
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={curveData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="idx" tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 10, fontFamily: "Space Mono" }} tickLine={false} axisLine={{ stroke: "rgba(255,255,255,0.08)" }} />
                    <YAxis tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 10, fontFamily: "Space Mono" }} tickLine={false} axisLine={{ stroke: "rgba(255,255,255,0.08)" }} tickFormatter={(v: number) => v.toFixed(1)} width={58} />
                    <Tooltip content={<ScenarioTooltip />} />
                    <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" />
                    <Line type="monotone" dataKey="optimistic" stroke="#22c55e" strokeWidth={1.5} dot={false} name="Optimistic" connectNulls />
                    <Line type="monotone" dataKey="pessimistic" stroke="#ef4444" strokeWidth={1.5} dot={false} name="Pessimistic" connectNulls />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Signal table */}
          <div className="border border-border bg-card">
            <div
              className="px-4 py-3 border-b border-border bg-secondary/30 flex items-center justify-between cursor-pointer"
              onClick={() => setShowTrades((v) => !v)}
            >
              <div className="flex items-center gap-2">
                {showTrades ? <ChevronDown className="w-3.5 h-3.5 text-primary" /> : <ChevronRight className="w-3.5 h-3.5 text-primary" />}
                <span className="text-xs text-muted-foreground tracking-widest font-bold">
                  MATCHED SIGNALS ({result.matchedSignals})
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                {(["", "LONG", "SHORT"] as const).map((d) => (
                  <button
                    key={d || "all"}
                    onClick={(e) => { e.stopPropagation(); setFilterDir(d); }}
                    className={`px-2 py-0.5 border text-xs ${filterDir === d ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground hover:text-foreground"}`}
                  >
                    {d || "ALL"}
                  </button>
                ))}
              </div>
            </div>
            {showTrades && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="border-b border-border bg-secondary/50">
                      {["TIME", "SYMBOL", "DIR", "GRADE", "MODE", "TF", "CONF_W", "RR", "HYPO WIN", "HYPO LOSS", "ACTUAL P&L"].map(h => (
                        <th key={h} className="px-3 py-2.5 text-left text-muted-foreground tracking-wider font-normal whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTrades.map((t) => (
                      <tr key={t.signalId} className="border-b border-border/40 hover:bg-secondary/30">
                        <td className="px-3 py-2 text-muted-foreground">{timeSince(t.receivedAt)}</td>
                        <td className={`px-3 py-2 font-bold ${t.dir === "LONG" ? "text-green-400" : "text-red-400"}`}>{t.symbol}</td>
                        <td className="px-3 py-2">
                          <span className={`flex items-center gap-1 ${t.dir === "LONG" ? "text-green-400" : "text-red-400"}`}>
                            {t.dir === "LONG" ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                            {t.dir}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{t.grade ?? "—"}</td>
                        <td className="px-3 py-2 text-muted-foreground">{t.mode ?? "—"}</td>
                        <td className="px-3 py-2 text-muted-foreground">{t.tf}</td>
                        <td className="px-3 py-2">{t.confW != null ? `${t.confW.toFixed(0)}%` : "—"}</td>
                        <td className="px-3 py-2">{t.rr != null ? t.rr.toFixed(2) : "—"}</td>
                        <td className="px-3 py-2 text-green-400">{fmtPnl(t.hypotheticalWin)}</td>
                        <td className="px-3 py-2 text-red-400">{fmtPnl(t.hypotheticalLoss)}</td>
                        <td className="px-3 py-2">
                          {t.hasActual ? (
                            <span className={`font-bold flex items-center gap-1 ${(t.actualPnl ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
                              {(t.actualPnl ?? 0) >= 0 ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                              {fmtPnl(t.actualPnl)}
                              {t.actualCloseReason && <span className="text-muted-foreground font-normal ml-1">{t.actualCloseReason}</span>}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">no trade</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
