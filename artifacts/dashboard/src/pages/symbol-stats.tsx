import { useEffect, useState } from "react";
import { Activity, RotateCcw, AlertTriangle } from "lucide-react";

interface Row {
  gateSymbol: string;
  symbol: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  netPnl: number;
  payoffRatio: number | null;
  kellyFraction: number | null;
  reliable: boolean;
  lastClosedAt: string | null;
  lastStrategy: string | null;
}
interface Payload {
  lookback: number;
  minTrades: number;
  totalSymbols: number;
  reliableCount: number;
  rows: Row[];
}

export function SymbolStatsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lookback, setLookback] = useState(30);

  const refresh = async () => {
    setErr(null);
    try {
      const res = await fetch(`/api/scalper/symbol-stats?lookback=${lookback}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookback]);

  return (
    <div className="space-y-4 max-w-6xl">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Activity className="w-5 h-5 text-cyan-400" /> SCALPER · PER-SYMBOL STATS
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Last {lookback} closed trades per symbol with Kelly diagnostics. Sorted by Kelly fraction (best edge first).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {[10, 30, 100, 500].map((n) => (
              <button
                key={n}
                onClick={() => setLookback(n)}
                className={`px-2 py-1 text-[10px] font-bold border ${lookback === n ? "border-cyan-500 text-cyan-300 bg-cyan-500/10" : "border-border text-muted-foreground hover:text-foreground"}`}
              >
                LAST {n}
              </button>
            ))}
          </div>
          <button onClick={refresh} className="flex items-center gap-2 px-3 py-1.5 border border-border text-xs hover:bg-secondary/30">
            <RotateCcw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>
      </header>

      {err && <div className="p-3 border border-red-900 bg-red-950/30 text-red-300 text-xs font-mono">{err}</div>}
      {!data && !err && <div className="text-muted-foreground text-sm">Loading…</div>}

      {data && data.totalSymbols === 0 && (
        <div className="border border-border p-8 text-center text-muted-foreground text-sm">
          No closed scalper trades yet. Once trades close, per-symbol Kelly diagnostics will appear here.
        </div>
      )}

      {data && data.totalSymbols > 0 && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <Stat label="SYMBOLS" value={data.totalSymbols} />
            <Stat label="RELIABLE (≥{data.minTrades})" value={`${data.reliableCount}/${data.totalSymbols}`} />
            <Stat label="POSITIVE EDGE" value={data.rows.filter((r) => (r.kellyFraction ?? 0) > 0).length} color="text-green-400" />
            <Stat label="NEGATIVE EDGE" value={data.rows.filter((r) => (r.kellyFraction ?? 0) <= 0 && r.kellyFraction != null).length} color="text-red-400" />
          </div>

          <div className="border border-border overflow-hidden">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-border bg-secondary/50">
                  {["SYMBOL", "N", "WIN%", "AVG WIN", "AVG LOSS", "R", "NET P&L", "f*", "STRAT", "LAST"].map((h) => (
                    <th key={h} className="px-3 py-2.5 text-left text-muted-foreground tracking-widest font-normal whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.gateSymbol} className={`border-b border-border/40 hover:bg-secondary/40 transition-colors ${!r.reliable ? "opacity-70" : ""}`}>
                    <td className="px-3 py-2 font-bold flex items-center gap-1.5">
                      {!r.reliable && <AlertTriangle className="w-3 h-3 text-yellow-400" />}
                      {r.symbol}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{r.trades}</td>
                    <td className={`px-3 py-2 ${(r.winRate ?? 0) >= 0.55 ? "text-green-400" : (r.winRate ?? 0) >= 0.4 ? "text-yellow-400" : "text-red-400"}`}>
                      {r.winRate != null ? `${(r.winRate * 100).toFixed(0)}%` : "—"}
                    </td>
                    <td className="px-3 py-2 text-green-400">{r.avgWin != null ? `+${r.avgWin.toFixed(2)}` : "—"}</td>
                    <td className="px-3 py-2 text-red-400">{r.avgLoss != null ? `-${r.avgLoss.toFixed(2)}` : "—"}</td>
                    <td className="px-3 py-2">{r.payoffRatio != null ? `${r.payoffRatio.toFixed(2)}` : "—"}</td>
                    <td className={`px-3 py-2 font-bold ${r.netPnl > 0 ? "text-green-400" : r.netPnl < 0 ? "text-red-400" : "text-muted-foreground"}`}>
                      {r.netPnl >= 0 ? "+" : ""}{r.netPnl.toFixed(2)}
                    </td>
                    <td className={`px-3 py-2 ${(r.kellyFraction ?? 0) > 0.25 ? "text-green-400" : (r.kellyFraction ?? 0) > 0 ? "text-yellow-400" : "text-red-400"}`}>
                      {r.kellyFraction != null ? r.kellyFraction.toFixed(3) : "—"}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{r.lastStrategy ?? "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {r.lastClosedAt ? timeSince(r.lastClosedAt) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="p-3 border border-border bg-secondary/10 text-xs text-muted-foreground space-y-1">
            <div className="text-foreground font-bold mb-2">Reading the columns</div>
            <div><span className="font-mono text-green-400">R</span> = avg win / avg loss (payoff ratio). &gt; 1 means winners are bigger than losers.</div>
            <div><span className="font-mono text-cyan-400">f*</span> = Kelly fraction = p − (1−p)/R. Positive = edge; negative = stop (or floor-size).</div>
            <div>Half-Kelly multiplier = f* × 0.5, then clamped to [floor%, max%] from your Kelly config.</div>
            <div className="flex items-center gap-2 text-yellow-400/80"><AlertTriangle className="w-3.5 h-3.5" /> rows with the warning icon have fewer than {data.minTrades} samples — diagnostics are noisy.</div>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="border border-border p-3 bg-secondary/20">
      <div className="text-[10px] text-muted-foreground tracking-widest font-bold">{label}</div>
      <div className={`text-xl font-mono ${color ?? "text-foreground"}`}>{value}</div>
    </div>
  );
}

function timeSince(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export default SymbolStatsPage;
