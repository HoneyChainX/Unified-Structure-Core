import { useQuery } from "@tanstack/react-query";
import { getBotAnalytics, type AnalyticsDimEntry } from "@workspace/api-client-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine,
} from "recharts";
import { BarChart2, TrendingUp, TrendingDown, Target, Award, Hash, ArrowUpRight } from "lucide-react";

function pct(v: number | null | undefined) {
  if (v == null) return "—";
  return `${(v * 100).toFixed(1)}%`;
}
function usd(v: number | null | undefined) {
  if (v == null) return "—";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(3)}`;
}

type DimEntry = AnalyticsDimEntry;

function DimTable({ title, data, icon: Icon }: { title: string; data: DimEntry[]; icon: React.ComponentType<{ className?: string }> }) {
  if (!data.length) return (
    <div className="border border-border bg-card">
      <div className="px-4 py-3 border-b border-border bg-secondary/30 flex items-center gap-2">
        <Icon className="w-3.5 h-3.5 text-primary" />
        <span className="text-xs text-muted-foreground tracking-widest font-bold">{title}</span>
      </div>
      <div className="px-4 py-8 text-center text-xs text-muted-foreground">No closed trades yet</div>
    </div>
  );

  return (
    <div className="border border-border bg-card">
      <div className="px-4 py-3 border-b border-border bg-secondary/30 flex items-center gap-2">
        <Icon className="w-3.5 h-3.5 text-primary" />
        <span className="text-xs text-muted-foreground tracking-widest font-bold">{title}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="border-b border-border bg-secondary/50">
              {["LABEL", "TRADES", "WIN RATE", "TOTAL P&L", "AVG P&L", "BEST", "WORST"].map(h => (
                <th key={h} className="px-3 py-2.5 text-left text-muted-foreground tracking-wider font-normal whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.label} className="border-b border-border/40 hover:bg-secondary/30">
                <td className="px-3 py-2 font-bold text-foreground">{row.label}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  <span className="text-green-400">{row.wins}W</span>
                  <span className="text-muted-foreground mx-1">/</span>
                  <span className="text-red-400">{row.losses}L</span>
                  <span className="text-muted-foreground ml-1">({row.count})</span>
                </td>
                <td className={`px-3 py-2 font-bold ${row.winRate != null ? row.winRate >= 0.5 ? "text-green-400" : "text-red-400" : "text-muted-foreground"}`}>
                  {pct(row.winRate)}
                </td>
                <td className={`px-3 py-2 font-bold ${row.totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>{usd(row.totalPnl)}</td>
                <td className={`px-3 py-2 ${(row.avgPnl ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>{usd(row.avgPnl)}</td>
                <td className="px-3 py-2 text-green-400">{usd(row.bestPnl)}</td>
                <td className="px-3 py-2 text-red-400">{usd(row.worstPnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PnlBar({ data, labelKey }: { data: DimEntry[]; labelKey: string }) {
  if (!data.length) return null;
  const sorted = [...data].sort((a, b) => b.totalPnl - a.totalPnl);
  return (
    <ResponsiveContainer width="100%" height={Math.max(120, sorted.length * 32)}>
      <BarChart data={sorted} layout="vertical" margin={{ left: 80, right: 20, top: 4, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
        <XAxis type="number" tick={{ fill: "rgba(255,255,255,0.3)", fontSize: 10, fontFamily: "Space Mono" }} tickLine={false} axisLine={{ stroke: "rgba(255,255,255,0.08)" }} tickFormatter={(v: number) => v.toFixed(2)} />
        <YAxis type="category" dataKey="label" tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 10, fontFamily: "Space Mono" }} tickLine={false} axisLine={false} width={76} />
        <Tooltip
          content={({ active, payload }) => {
            if (!active || !payload?.[0]) return null;
            const d = payload[0].payload as DimEntry;
            return (
              <div className="bg-card border border-border px-3 py-2 text-xs font-mono space-y-1 shadow-lg">
                <div className="font-bold">{d.label}</div>
                <div className={d.totalPnl >= 0 ? "text-green-400" : "text-red-400"}>P&L: {usd(d.totalPnl)} USDT</div>
                <div>Win rate: {pct(d.winRate)} ({d.wins}W / {d.losses}L)</div>
                <div>Avg: {usd(d.avgPnl)}</div>
              </div>
            );
          }}
        />
        <ReferenceLine x={0} stroke="rgba(255,255,255,0.15)" />
        <Bar dataKey="totalPnl" radius={2}>
          {sorted.map((entry) => (
            <Cell key={entry.label} fill={entry.totalPnl >= 0 ? "#22c55e" : "#ef4444"} fillOpacity={0.75} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function AnalyticsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["bot-analytics"],
    queryFn: () => getBotAnalytics(),
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">Loading analytics...</div>;
  }

  if (!data || data.totalClosed === 0) {
    return (
      <div className="space-y-5 max-w-4xl">
        <div className="flex items-center gap-3">
          <BarChart2 className="w-5 h-5 text-primary" />
          <span className="font-bold tracking-tight">SIGNAL ANALYTICS</span>
        </div>
        <div className="border border-border bg-card px-6 py-12 text-center space-y-2">
          <BarChart2 className="w-8 h-8 text-muted-foreground mx-auto mb-4" />
          <div className="text-foreground font-bold">No closed trades yet</div>
          <div className="text-xs text-muted-foreground max-w-sm mx-auto">
            Analytics appear once trades close via SL, TP, or manually. Run the bot in paper mode to start collecting data.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-3">
        <BarChart2 className="w-5 h-5 text-primary" />
        <span className="font-bold tracking-tight">SIGNAL ANALYTICS</span>
        <span className="text-xs text-muted-foreground border border-border px-2 py-0.5">{data.totalClosed} closed trades</span>
      </div>

      {/* LONG vs SHORT summary chart */}
      {data.byDir.length > 0 && (
        <div className="grid grid-cols-2 gap-4">
          {data.byDir.map((d) => (
            <div key={d.label} className="border border-border bg-card p-4">
              <div className="flex items-center gap-2 mb-3">
                {d.label === "LONG" ? <TrendingUp className="w-4 h-4 text-green-400" /> : <TrendingDown className="w-4 h-4 text-red-400" />}
                <span className="font-bold text-sm">{d.label}</span>
                <span className="text-muted-foreground text-xs ml-auto">{d.count} trades</span>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <div className="text-xs text-muted-foreground tracking-widest mb-1">WIN RATE</div>
                  <div className={`text-lg font-bold font-mono ${d.winRate != null ? d.winRate >= 0.5 ? "text-green-400" : "text-red-400" : ""}`}>{pct(d.winRate)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground tracking-widest mb-1">TOTAL P&L</div>
                  <div className={`text-lg font-bold font-mono ${d.totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>{usd(d.totalPnl)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground tracking-widest mb-1">AVG P&L</div>
                  <div className={`text-lg font-bold font-mono ${(d.avgPnl ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>{usd(d.avgPnl)}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* By Grade */}
      {data.byGrade.length > 0 && (
        <div className="border border-border bg-card">
          <div className="px-4 py-3 border-b border-border bg-secondary/30 flex items-center gap-2">
            <Award className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs text-muted-foreground tracking-widest font-bold">P&L BY GRADE</span>
          </div>
          <div className="p-4">
            <PnlBar data={data.byGrade} labelKey="grade" />
          </div>
        </div>
      )}
      <DimTable title="BREAKDOWN BY GRADE" data={data.byGrade} icon={Award} />

      {/* By Mode */}
      {data.byMode.length > 0 && (
        <div className="border border-border bg-card">
          <div className="px-4 py-3 border-b border-border bg-secondary/30 flex items-center gap-2">
            <Target className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs text-muted-foreground tracking-widest font-bold">P&L BY SIGNAL MODE</span>
          </div>
          <div className="p-4">
            <PnlBar data={data.byMode} labelKey="mode" />
          </div>
        </div>
      )}
      <DimTable title="BREAKDOWN BY SIGNAL MODE" data={data.byMode} icon={Target} />

      {/* By Timeframe */}
      {data.byTf.length > 0 && (
        <div className="border border-border bg-card">
          <div className="px-4 py-3 border-b border-border bg-secondary/30 flex items-center gap-2">
            <Hash className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs text-muted-foreground tracking-widest font-bold">P&L BY TIMEFRAME</span>
          </div>
          <div className="p-4">
            <PnlBar data={data.byTf} labelKey="tf" />
          </div>
        </div>
      )}
      <DimTable title="BREAKDOWN BY TIMEFRAME" data={data.byTf} icon={Hash} />

      {/* By Symbol */}
      {data.bySymbol.length > 0 && (
        <div className="border border-border bg-card">
          <div className="px-4 py-3 border-b border-border bg-secondary/30 flex items-center gap-2">
            <ArrowUpRight className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs text-muted-foreground tracking-widest font-bold">P&L BY SYMBOL</span>
          </div>
          <div className="p-4">
            <PnlBar data={data.bySymbol} labelKey="symbol" />
          </div>
        </div>
      )}
      <DimTable title="BREAKDOWN BY SYMBOL" data={data.bySymbol} icon={ArrowUpRight} />

      {/* Close reason */}
      <DimTable title="BREAKDOWN BY CLOSE REASON" data={data.byCloseReason} icon={BarChart2} />

      {/* MRX per-timeframe */}
      {data.byMrxTf.length > 0 && (
        <div className="space-y-3">
          <div className="border border-border bg-card">
            <div className="px-4 py-3 border-b border-border bg-secondary/30 flex items-center gap-2">
              <Hash className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs text-muted-foreground tracking-widest font-bold">MRX WIN RATE BY TIMEFRAME</span>
              <span className="text-xs text-muted-foreground border border-border px-2 py-0.5 ml-auto">
                {data.byMrxTf.reduce((s, r) => s + r.count, 0)} closed trades
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="border-b border-border bg-secondary/50">
                    {["TIMEFRAME", "TRADES", "WIN RATE", "TOTAL P&L", "AVG P&L", "BEST", "WORST"].map(h => (
                      <th key={h} className="px-3 py-2.5 text-left text-muted-foreground tracking-wider font-normal whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.byMrxTf.map((row) => (
                    <tr key={row.label} className="border-b border-border/40 hover:bg-secondary/30">
                      <td className="px-3 py-2 font-bold text-foreground uppercase">{row.label}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        <span className="text-green-400">{row.wins}W</span>
                        <span className="text-muted-foreground mx-1">/</span>
                        <span className="text-red-400">{row.losses}L</span>
                        <span className="text-muted-foreground ml-1">({row.count})</span>
                      </td>
                      <td className={`px-3 py-2 font-bold ${row.winRate != null ? row.winRate >= 0.5 ? "text-green-400" : "text-red-400" : "text-muted-foreground"}`}>
                        {pct(row.winRate)}
                      </td>
                      <td className={`px-3 py-2 font-bold ${row.totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}>{usd(row.totalPnl)}</td>
                      <td className={`px-3 py-2 ${(row.avgPnl ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>{usd(row.avgPnl)}</td>
                      <td className="px-3 py-2 text-green-400">{usd(row.bestPnl)}</td>
                      <td className="px-3 py-2 text-red-400">{usd(row.worstPnl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
