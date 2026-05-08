import { useGetLatestSignal, useGetSignalStats, useListSignals, getGetLatestSignalQueryKey, getGetSignalStatsQueryKey, getListSignalsQueryKey } from "@workspace/api-client-react";
import { Link } from "wouter";
import { ArrowUpRight, ArrowDownRight, TrendingUp, TrendingDown, Activity, AlertTriangle, CheckCircle, XCircle, Clock, BarChart2 } from "lucide-react";

function fmt(val: number | null | undefined, decimals = 4) {
  if (val == null) return "—";
  return val.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
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

function GateBadge({ pass, label }: { pass: boolean; label: string }) {
  return (
    <div className={`flex items-center gap-1.5 px-3 py-1.5 border text-xs font-bold tracking-widest ${pass ? "border-green-500/40 text-green-400 bg-green-500/10" : "border-red-500/40 text-red-400 bg-red-500/10"}`}>
      {pass ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
      {label}
    </div>
  );
}

function RotBadge({ state }: { state: string | null | undefined }) {
  if (!state) return <span className="text-muted-foreground">—</span>;
  const colors: Record<string, string> = {
    "RISK_OFF": "text-red-400 border-red-500/40 bg-red-500/10",
    "ETH->ALTS": "text-emerald-400 border-emerald-500/40 bg-emerald-500/10",
    "BTC->ETH": "text-blue-400 border-blue-500/40 bg-blue-500/10",
    "BTC->ALTS": "text-violet-400 border-violet-500/40 bg-violet-500/10",
    "NEUTRAL": "text-muted-foreground border-border bg-secondary",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 border text-xs font-bold tracking-wider ${colors[state] ?? colors["NEUTRAL"]}`}>
      {state}
    </span>
  );
}

function ConfBar({ confW, conf }: { confW: number | null | undefined; conf: number | null | undefined }) {
  const w = confW ?? 0;
  const color = w >= 75 ? "bg-green-500" : w >= 55 ? "bg-yellow-400" : "bg-red-500";
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>CONF {conf ?? "?"}/7</span>
        <span>{w.toFixed(1)}%</span>
      </div>
      <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
        <div className={`h-full transition-all ${color}`} style={{ width: `${Math.min(w, 100)}%` }} />
      </div>
    </div>
  );
}

export function Dashboard() {
  const { data: latest, isLoading: latestLoading } = useGetLatestSignal({
    query: { queryKey: getGetLatestSignalQueryKey(), refetchInterval: 15000 }
  });
  const { data: stats } = useGetSignalStats({
    query: { queryKey: getGetSignalStatsQueryKey(), refetchInterval: 15000 }
  });
  const { data: recentData } = useListSignals({ limit: 10 }, {
    query: { queryKey: getListSignalsQueryKey({ limit: 10 }), refetchInterval: 15000 }
  });

  const isLong = latest?.dir === "LONG";
  const isTriggered = latest?.triggered;
  const accentColor = isLong ? "text-green-400" : "text-red-400";
  const accentBg = isLong ? "bg-green-500/5 border-green-500/20" : "bg-red-500/5 border-red-500/20";
  const dirBg = isLong ? "bg-green-500/10 border-green-500/30 text-green-300" : "bg-red-500/10 border-red-500/30 text-red-300";

  const blockKeys = ["GATE_BIAS", "GATE_CTX", "GATE_ZONE"];
  const gateBias = !latest?.blockReason?.includes("B_FAIL");
  const gateCtx = gateBias && !latest?.blockReason?.includes("C_FAIL");
  const gateZone = gateCtx && !latest?.blockReason?.includes("Z_FAIL");

  return (
    <div className="space-y-5">
      {/* Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "TOTAL SIGNALS", value: stats?.total ?? "—", icon: Activity },
          { label: "TRIGGERED", value: stats?.triggered ?? "—", icon: CheckCircle, color: "text-green-400" },
          { label: "AVG CONF", value: stats?.avgConfW != null ? `${Number(stats.avgConfW).toFixed(1)}%` : "—", icon: BarChart2, color: "text-primary" },
          { label: "LONGS / SHORTS", value: `${stats?.longs ?? "—"} / ${stats?.shorts ?? "—"}`, icon: TrendingUp },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="border border-border bg-card p-4 flex flex-col gap-1">
            <div className="flex items-center gap-2 text-xs text-muted-foreground tracking-widest">
              <Icon className="w-3 h-3" />
              {label}
            </div>
            <div className={`text-xl font-bold font-mono ${color ?? ""}`}>{String(value)}</div>
          </div>
        ))}
      </div>

      {/* Latest Signal Panel */}
      <div className={`border ${latest ? accentBg : "border-border bg-card"} p-5`}>
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground tracking-widest">LATEST SIGNAL</span>
            {latest?.receivedAt && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {timeSince(latest.receivedAt)}
              </span>
            )}
          </div>
          {latest && (
            <Link href={`/signal/${latest.id}`} className="text-xs text-primary hover:underline flex items-center gap-1">
              Full Detail <ArrowUpRight className="w-3 h-3" />
            </Link>
          )}
        </div>

        {latestLoading && (
          <div className="flex items-center gap-3 text-muted-foreground text-sm py-8 justify-center">
            <Activity className="w-4 h-4 animate-pulse" />
            Waiting for signals...
          </div>
        )}

        {!latestLoading && !latest && (
          <div className="py-8 text-center text-muted-foreground text-sm">
            No signals yet. Configure your TradingView alert to POST to <code className="text-primary font-mono text-xs bg-secondary px-1 py-0.5">/api/signals/webhook</code>
          </div>
        )}

        {latest && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {/* Direction + Grade */}
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className={`flex items-center gap-2 px-4 py-2 border text-lg font-bold tracking-widest ${dirBg}`}>
                  {isLong ? <ArrowUpRight className="w-5 h-5" /> : <ArrowDownRight className="w-5 h-5" />}
                  {latest.dir}
                </div>
                <div className={`px-3 py-2 border text-xs font-bold tracking-widest ${isTriggered ? "border-green-500/40 text-green-400 bg-green-500/10" : "border-yellow-500/40 text-yellow-400 bg-yellow-500/10"}`}>
                  {isTriggered ? "TRIGGER" : "BLOCKED"}
                </div>
              </div>

              <div className="text-sm space-y-1">
                <div className="flex gap-2 text-xs text-muted-foreground tracking-widest">SYMBOL</div>
                <div className={`text-2xl font-bold font-mono ${accentColor}`}>{latest.symbol}</div>
                <div className="text-xs text-muted-foreground font-mono">{latest.tf} | TF2: {latest.tf2 ?? "—"} | TF3: {latest.tf3 ?? "—"}</div>
              </div>

              <div className="space-y-1.5">
                <div className="text-xs text-muted-foreground tracking-widest">GRADE</div>
                <div className={`text-sm font-bold ${latest.grade?.includes("A+") ? "text-yellow-400" : latest.grade?.includes("Strong") ? "text-blue-400" : "text-muted-foreground"}`}>
                  {latest.grade ?? "—"}
                </div>
              </div>

              <ConfBar confW={latest.confW} conf={latest.conf} />

              {!isTriggered && latest.blockReason && (
                <div className="flex items-center gap-2 text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/30 px-3 py-2">
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  {latest.blockReason}
                </div>
              )}
            </div>

            {/* Entry Plan */}
            <div className="space-y-3">
              <div className="text-xs text-muted-foreground tracking-widest mb-2">ENTRY PLAN</div>
              {[
                { label: "ENTRY ZONE", value: latest.zoneLow != null && latest.zoneHigh != null ? `${fmt(latest.zoneLow)} – ${fmt(latest.zoneHigh)}` : "—", highlight: true },
                { label: "ENTRY REF", value: fmt(latest.entryRef) },
                { label: "STOP LOSS", value: fmt(latest.sl), color: "text-red-400" },
                { label: "RR1", value: latest.rr1 != null ? `${latest.rr1.toFixed(2)}R` : "—", color: "text-primary" },
                { label: "TP1", value: fmt(latest.tp1), color: "text-green-400" },
                { label: "TP2", value: fmt(latest.tp2), color: "text-green-300" },
                { label: "TP3", value: fmt(latest.tp3), color: "text-green-200" },
              ].map(({ label, value, highlight, color }) => (
                <div key={label} className={`flex justify-between items-center py-1 border-b border-border/50 ${highlight ? "border-b-0 border border-border bg-secondary/50 px-2 py-1.5" : ""}`}>
                  <span className="text-xs text-muted-foreground tracking-wider">{label}</span>
                  <span className={`text-xs font-mono font-bold ${color ?? "text-foreground"}`}>{value}</span>
                </div>
              ))}
            </div>

            {/* Context + Gates + Rotation */}
            <div className="space-y-3">
              <div className="text-xs text-muted-foreground tracking-widest mb-2">CONTEXT &amp; GATES</div>

              <div className="grid grid-cols-3 gap-2">
                <GateBadge pass={gateBias} label="BIAS" />
                <GateBadge pass={gateCtx} label="CTX" />
                <GateBadge pass={gateZone} label="ZONE" />
              </div>

              <div className="grid grid-cols-2 gap-2 pt-1">
                {[
                  { label: "RISK TIER", value: latest.riskTier ?? "—", color: latest.riskTier === "HIGH_CONF" ? "text-green-400" : latest.riskTier === "MID_CONF" ? "text-yellow-400" : "text-red-400" },
                  { label: "MODE", value: latest.mode ?? "—" },
                  { label: "MACRO TF", value: latest.macroTf ?? "—" },
                  { label: "AUTH", value: latest.auth ?? "—", color: accentColor },
                ].map(({ label, value, color }) => (
                  <div key={label} className="bg-secondary border border-border p-2">
                    <div className="text-xs text-muted-foreground tracking-wider mb-0.5">{label}</div>
                    <div className={`text-xs font-bold font-mono truncate ${color ?? "text-foreground"}`}>{value}</div>
                  </div>
                ))}
              </div>

              <div className="pt-1">
                <div className="text-xs text-muted-foreground tracking-widest mb-2">ROTATION</div>
                <div className="flex items-center gap-3">
                  <RotBadge state={latest.rot} />
                  {latest.rotScore != null && (
                    <span className={`text-xs font-mono font-bold ${latest.rotScore > 0 ? "text-green-400" : "text-red-400"}`}>
                      {latest.rotScore > 0 ? "+" : ""}{latest.rotScore.toFixed(2)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Recent Signals Table */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-muted-foreground tracking-widest">RECENT SIGNALS</span>
          <Link href="/signals" className="text-xs text-primary hover:underline">View all</Link>
        </div>
        <div className="border border-border overflow-hidden">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-border bg-secondary/50">
                {["TIME", "SYMBOL", "TF", "DIR", "GRADE", "CONF", "ROT", "STATUS"].map(h => (
                  <th key={h} className="px-3 py-2 text-left text-muted-foreground tracking-widest font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {!recentData?.signals?.length && (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">No signals yet</td>
                </tr>
              )}
              {recentData?.signals?.map(s => (
                <tr
                  key={s.id}
                  className="border-b border-border/40 hover:bg-secondary/40 transition-colors cursor-pointer"
                  onClick={() => window.location.href = `/signal/${s.id}`}
                >
                  <td className="px-3 py-2 text-muted-foreground">{timeSince(s.receivedAt)}</td>
                  <td className={`px-3 py-2 font-bold ${s.dir === "LONG" ? "text-green-400" : "text-red-400"}`}>{s.symbol}</td>
                  <td className="px-3 py-2 text-muted-foreground">{s.tf}</td>
                  <td className={`px-3 py-2 font-bold tracking-wider ${s.dir === "LONG" ? "text-green-400" : "text-red-400"}`}>{s.dir}</td>
                  <td className={`px-3 py-2 ${s.grade?.includes("A+") ? "text-yellow-400" : s.grade?.includes("Strong") ? "text-blue-400" : "text-muted-foreground"}`}>{s.grade ?? "—"}</td>
                  <td className="px-3 py-2 text-foreground">{s.confW != null ? `${s.confW.toFixed(0)}%` : "—"}</td>
                  <td className="px-3 py-2"><RotBadge state={s.rot} /></td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 border text-xs font-bold ${s.triggered ? "border-green-500/40 text-green-400" : "border-yellow-500/40 text-yellow-400"}`}>
                      {s.triggered ? "OK" : "BLOCK"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
