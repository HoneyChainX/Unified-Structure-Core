import { useState } from "react";
import { useListSignals, getListSignalsQueryKey, useDeleteSignal } from "@workspace/api-client-react";
import { Link } from "wouter";
import { ArrowUpRight, ArrowDownRight, Trash2, ChevronLeft, ChevronRight, Filter } from "lucide-react";

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
