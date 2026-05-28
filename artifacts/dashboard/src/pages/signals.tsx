import { useEffect, useState } from "react";
import { useListSignals, getListSignalsQueryKey, useDeleteSignal } from "@workspace/api-client-react";
import { Link } from "wouter";
import { ArrowUpRight, ArrowDownRight, Trash2, ChevronLeft, ChevronRight, Filter, Sparkles } from "lucide-react";

interface QualityHistogramBucket {
  bucket: number;
  bucketLabel: string;
  count: number;
  triggered: number;
}
interface QualityStats {
  windowHours: number;
  since: string;
  total: number;
  triggered: number;
  avgQuality: number | null;
  avgQualityTriggered: number | null;
  histogram: QualityHistogramBucket[];
}

function QualityPanel() {
  const [stats, setStats] = useState<QualityStats | null>(null);
  const [hours, setHours] = useState(168);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/signals/quality-stats?hours=${hours}`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d) => { if (!cancelled) { setStats(d); setErr(null); } })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [hours]);

  if (err) return <div className="p-3 border border-red-900 bg-red-950/30 text-red-300 text-xs">{err}</div>;
  if (!stats) return <div className="p-3 border border-border text-xs text-muted-foreground">Loading quality stats…</div>;
  if (stats.total === 0) {
    return (
      <div className="p-3 border border-border bg-secondary/10 text-xs text-muted-foreground">
        <span className="text-cyan-300/80 font-bold">◆ QUALITY:</span> No quality-scored signals in the last {hours}h.
        Enable adaptive thresholds, CHT, MRX, or SMC (each populates the score) to see distribution data here.
      </div>
    );
  }

  const maxBucket = Math.max(...stats.histogram.map((b) => b.count), 1);

  return (
    <div className="border border-border bg-secondary/10 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-bold tracking-widest">
          <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
          <span className="text-cyan-300">SIGNAL QUALITY · LAST {stats.windowHours}H</span>
        </div>
        <div className="flex gap-1">
          {[24, 72, 168, 720].map((h) => (
            <button
              key={h}
              onClick={() => setHours(h)}
              className={`px-2 py-0.5 text-[10px] font-bold border ${hours === h ? "border-cyan-500 text-cyan-300 bg-cyan-500/10" : "border-border text-muted-foreground hover:text-foreground"}`}
            >
              {h < 168 ? `${h}H` : h === 168 ? "7D" : "30D"}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <Stat label="SIGNALS SCORED" value={stats.total} />
        <Stat label="TRIGGERED" value={`${stats.triggered} / ${stats.total}`} />
        <Stat label="AVG QUALITY" value={stats.avgQuality?.toFixed(3) ?? "—"} color="text-cyan-300" />
        <Stat label="AVG (TRIGGERED)" value={stats.avgQualityTriggered?.toFixed(3) ?? "—"} color="text-green-400" />
      </div>

      <div className="space-y-1">
        <div className="text-[10px] text-muted-foreground tracking-widest font-bold">DISTRIBUTION</div>
        <div className="flex items-end gap-1 h-20">
          {stats.histogram.map((b) => {
            const totalH = (b.count / maxBucket) * 100;
            const trigH = (b.triggered / maxBucket) * 100;
            return (
              <div key={b.bucket} className="flex-1 flex flex-col justify-end items-center gap-1" title={`${b.bucketLabel}: ${b.count} signals (${b.triggered} triggered)`}>
                <div className="w-full flex flex-col justify-end" style={{ height: "60px" }}>
                  <div className="bg-cyan-500/30 w-full" style={{ height: `${totalH * 0.6}%` }} />
                  <div className="bg-green-500/60 w-full -mt-px" style={{ height: `${trigH * 0.6}%`, marginTop: `-${trigH * 0.6}%` }} />
                </div>
                <div className="text-[8px] text-muted-foreground font-mono">{b.bucket.toFixed(1)}</div>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-4 text-[10px] text-muted-foreground pt-1">
          <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 bg-cyan-500/30" /> all signals</span>
          <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 bg-green-500/60" /> triggered</span>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div>
      <div className="text-[10px] text-muted-foreground tracking-widest font-bold">{label}</div>
      <div className={`text-lg font-mono ${color ?? "text-foreground"}`}>{value}</div>
    </div>
  );
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

function RotBadge({ state }: { state: string | null | undefined }) {
  if (!state) return <span className="text-muted-foreground">—</span>;
  const colors: Record<string, string> = {
    "RISK_OFF": "text-red-400 border-red-500/40",
    "ETH->ALTS": "text-emerald-400 border-emerald-500/40",
    "BTC->ETH": "text-blue-400 border-blue-500/40",
    "BTC->ALTS": "text-violet-400 border-violet-500/40",
    "NEUTRAL": "text-muted-foreground border-border",
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 border text-xs font-bold ${colors[state] ?? colors["NEUTRAL"]}`}>
      {state}
    </span>
  );
}

export function Signals() {
  const [page, setPage] = useState(0);
  const [dirFilter, setDirFilter] = useState<"LONG" | "SHORT" | undefined>(undefined);
  const [triggeredFilter, setTriggeredFilter] = useState<boolean | undefined>(undefined);
  const limit = 25;

  const params = {
    limit,
    offset: page * limit,
    ...(dirFilter ? { dir: dirFilter } : {}),
    ...(triggeredFilter !== undefined ? { triggered: triggeredFilter } : {}),
  };

  const { data, refetch } = useListSignals(params, {
    query: { queryKey: getListSignalsQueryKey(params), refetchInterval: 15000 }
  });

  const deleteMutation = useDeleteSignal();

  const totalPages = Math.ceil((data?.total ?? 0) / limit);

  async function handleDelete(id: number, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm("Delete this signal?")) return;
    await deleteMutation.mutateAsync({ id });
    refetch();
  }

  return (
    <div className="space-y-4">
      {/* Phase 2: signal quality observability */}
      <QualityPanel />

      {/* Filters */}
      <div className="flex items-center gap-3">
        <Filter className="w-4 h-4 text-muted-foreground" />
        <span className="text-xs text-muted-foreground tracking-widest">FILTER</span>

        <div className="flex gap-2">
          {[undefined, "LONG" as const, "SHORT" as const].map(d => (
            <button
              key={d ?? "ALL"}
              onClick={() => { setDirFilter(d); setPage(0); }}
              className={`px-3 py-1 text-xs font-bold border transition-colors ${
                dirFilter === d
                  ? d === "LONG" ? "border-green-500 text-green-400 bg-green-500/10"
                  : d === "SHORT" ? "border-red-500 text-red-400 bg-red-500/10"
                  : "border-primary text-primary bg-primary/10"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {d ?? "ALL"}
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          {[undefined, true, false].map(t => (
            <button
              key={String(t)}
              onClick={() => { setTriggeredFilter(t); setPage(0); }}
              className={`px-3 py-1 text-xs font-bold border transition-colors ${
                triggeredFilter === t
                  ? t === true ? "border-green-500 text-green-400 bg-green-500/10"
                  : t === false ? "border-yellow-500 text-yellow-400 bg-yellow-500/10"
                  : "border-primary text-primary bg-primary/10"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {t === undefined ? "ALL STATUS" : t ? "TRIGGERED" : "BLOCKED"}
            </button>
          ))}
        </div>

        <div className="ml-auto text-xs text-muted-foreground">
          {data?.total ?? 0} signals
        </div>
      </div>

      {/* Table */}
      <div className="border border-border overflow-hidden">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="border-b border-border bg-secondary/50">
              {["TIME", "SYMBOL", "TF", "MODE", "DIR", "GRADE", "CONF W", "RISK", "ROT", "RR1", "STATUS", ""].map(h => (
                <th key={h} className="px-3 py-2.5 text-left text-muted-foreground tracking-widest font-normal whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!data?.signals?.length && (
              <tr>
                <td colSpan={12} className="px-3 py-10 text-center text-muted-foreground">No signals match the current filter</td>
              </tr>
            )}
            {data?.signals?.map(s => (
              <tr
                key={s.id}
                className="border-b border-border/40 hover:bg-secondary/40 transition-colors cursor-pointer group"
              >
                <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                  <Link href={`/signal/${s.id}`} className="hover:text-foreground">
                    {timeSince(s.receivedAt)}
                  </Link>
                </td>
                <td className={`px-3 py-2 font-bold ${s.dir === "LONG" ? "text-green-400" : "text-red-400"}`}>
                  <Link href={`/signal/${s.id}`}>{s.symbol}</Link>
                </td>
                <td className="px-3 py-2 text-muted-foreground">{s.tf}</td>
                <td className="px-3 py-2 text-muted-foreground">{s.mode ?? "—"}</td>
                <td className="px-3 py-2">
                  <span className={`flex items-center gap-1 font-bold ${s.dir === "LONG" ? "text-green-400" : "text-red-400"}`}>
                    {s.dir === "LONG" ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                    {s.dir}
                  </span>
                </td>
                <td className={`px-3 py-2 ${s.grade?.includes("A+") ? "text-yellow-400" : s.grade?.includes("Strong") ? "text-blue-400" : "text-muted-foreground"}`}>
                  {s.grade ?? "—"}
                </td>
                <td className="px-3 py-2">
                  {s.confW != null ? (
                    <span className={s.confW >= 75 ? "text-green-400" : s.confW >= 55 ? "text-yellow-400" : "text-red-400"}>
                      {s.confW.toFixed(1)}%
                    </span>
                  ) : "—"}
                </td>
                <td className={`px-3 py-2 ${s.riskTier === "HIGH_CONF" ? "text-green-400" : s.riskTier === "MID_CONF" ? "text-yellow-400" : "text-red-400"}`}>
                  {s.riskTier ?? "—"}
                </td>
                <td className="px-3 py-2"><RotBadge state={s.rot} /></td>
                <td className={`px-3 py-2 font-bold ${s.rr1 != null && s.rr1 >= 2 ? "text-green-400" : "text-foreground"}`}>
                  {s.rr1 != null ? `${s.rr1.toFixed(2)}R` : "—"}
                </td>
                <td className="px-3 py-2">
                  <span className={`px-2 py-0.5 border text-xs font-bold ${s.triggered ? "border-green-500/40 text-green-400" : "border-yellow-500/40 text-yellow-400"}`}>
                    {s.triggered ? "TRIGGER" : "BLOCKED"}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <button
                    onClick={(e) => handleDelete(s.id, e)}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-400 text-muted-foreground transition-all"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            Page {page + 1} of {totalPages}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="p-1.5 border border-border text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="p-1.5 border border-border text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
