import { useParams, Link } from "wouter";
import {
  useGetSignal,
  useDeleteSignal,
  useGetTradeBySignal,
  getGetSignalQueryKey,
  getGetTradeBySignalQueryKey,
} from "@workspace/api-client-react";
import {
  ArrowLeft,
  ArrowUpRight,
  ArrowDownRight,
  CheckCircle,
  XCircle,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Bot,
  Clock,
} from "lucide-react";

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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-border bg-card">
      <div className="px-4 py-2 border-b border-border bg-secondary/30">
        <span className="text-xs text-muted-foreground tracking-widest font-bold">{title}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function Row({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div className="flex justify-between items-center py-1.5 border-b border-border/40 last:border-b-0">
      <span className="text-xs text-muted-foreground tracking-wider">{label}</span>
      <span className={`text-xs font-mono font-bold ${color ?? "text-foreground"}`}>{value}</span>
    </div>
  );
}

function GatePill({ pass, label }: { pass: boolean; label: string }) {
  return (
    <div className={`flex items-center gap-2 px-4 py-3 border flex-col ${pass ? "border-green-500/40 bg-green-500/10" : "border-red-500/40 bg-red-500/10"}`}>
      {pass ? <CheckCircle className="w-5 h-5 text-green-400" /> : <XCircle className="w-5 h-5 text-red-400" />}
      <span className={`text-xs font-bold tracking-widest ${pass ? "text-green-400" : "text-red-400"}`}>{label}</span>
    </div>
  );
}

function LevelBar({ label, price, min, max, color }: { label: string; price: number | null | undefined; min: number; max: number; color: string }) {
  if (price == null || min >= max) return null;
  const pct = Math.max(0, Math.min(100, ((price - min) / (max - min)) * 100));
  return (
    <div className="flex items-center gap-3 text-xs font-mono">
      <span className={`w-16 shrink-0 text-right ${color}`}>{label}</span>
      <div className="flex-1 relative h-5 bg-secondary border border-border">
        <div className={`absolute top-0 bottom-0 w-0.5 ${color.replace("text-", "bg-")}`} style={{ left: `${pct}%` }} />
        <div className="absolute inset-y-0 left-0 right-0 flex items-center" style={{ paddingLeft: `${pct}%` }}>
          <span className={`ml-1 text-xs ${color} whitespace-nowrap`}>{fmt(price)}</span>
        </div>
      </div>
    </div>
  );
}

function TradeCard({ signalId }: { signalId: number }) {
  const { data: trade, isLoading, isError } = useGetTradeBySignal(signalId, {
    query: {
      queryKey: getGetTradeBySignalQueryKey(signalId),
      retry: false,
      refetchInterval: 15000,
    }
  });

  if (isLoading) {
    return (
      <div className="border border-border bg-card px-4 py-3 text-xs text-muted-foreground flex items-center gap-2">
        <Bot className="w-3.5 h-3.5" />
        Checking for linked trade...
      </div>
    );
  }

  if (isError || !trade) return null;

  const isOpen = trade.status === "open" || trade.status === "paper";
  const pnlColor = trade.pnl == null ? "" : trade.pnl >= 0 ? "text-green-400" : "text-red-400";
  const statusColors: Record<string, string> = {
    open: "border-blue-500/40 text-blue-400 bg-blue-500/10",
    paper: "border-violet-500/40 text-violet-400 bg-violet-500/10",
    closed: "border-green-500/40 text-green-400 bg-green-500/10",
    cancelled: "border-border text-muted-foreground",
    error: "border-red-500/40 text-red-400 bg-red-500/10",
  };

  const costBasis =
    trade.entryPrice != null && trade.quantity != null
      ? trade.entryPrice * trade.quantity
      : trade.positionSizeUsdt;
  const retPct = trade.pnl != null && costBasis && costBasis > 0
    ? (trade.pnl / costBasis) * 100
    : null;

  return (
    <div className="border border-border bg-card">
      <div className="px-4 py-3 border-b border-border bg-secondary/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bot className="w-3.5 h-3.5 text-primary" />
          <span className="text-xs text-muted-foreground tracking-widest font-bold">LINKED TRADE</span>
          {trade.paperMode && (
            <span className="text-xs text-violet-400 border border-violet-500/30 px-1.5 py-0.5">PAPER</span>
          )}
        </div>
        <Link href="/bot" className="text-xs text-primary hover:underline">View all trades →</Link>
      </div>
      <div className="p-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
          <div>
            <div className="text-xs text-muted-foreground tracking-widest mb-1">SIDE</div>
            <div className={`flex items-center gap-1.5 font-bold font-mono text-sm ${trade.side === "buy" ? "text-green-400" : "text-red-400"}`}>
              {trade.side === "buy" ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
              {trade.side.toUpperCase()}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground tracking-widest mb-1">STATUS</div>
            <span className={`px-2 py-0.5 border text-xs font-bold ${statusColors[trade.status] ?? "border-border text-muted-foreground"}`}>
              {trade.status.toUpperCase()}
            </span>
          </div>
          <div>
            <div className="text-xs text-muted-foreground tracking-widest mb-1">ENTRY</div>
            <div className="font-mono font-bold text-sm">{fmt(trade.entryPrice)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground tracking-widest mb-1">
              {isOpen ? "LIVE PRICE" : "CLOSE PRICE"}
            </div>
            <div className={`font-mono font-bold text-sm ${
              isOpen && trade.livePrice != null && trade.entryPrice != null
                ? (trade.side === "buy"
                  ? (trade.livePrice > trade.entryPrice ? "text-green-400" : "text-red-400")
                  : (trade.livePrice < trade.entryPrice ? "text-green-400" : "text-red-400"))
                : ""
            }`}>
              {isOpen ? fmt(trade.livePrice) : fmt(trade.closePrice)}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <div className="text-xs text-muted-foreground tracking-widest mb-1">SIZE</div>
            <div className="font-mono text-sm">{trade.positionSizeUsdt != null ? `${trade.positionSizeUsdt.toFixed(2)} USDT` : "—"}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground tracking-widest mb-1">STOP LOSS</div>
            <div className="font-mono text-sm text-red-400">{fmt(trade.slPrice)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground tracking-widest mb-1">TP1</div>
            <div className="font-mono text-sm text-green-400">{fmt(trade.tp1Price)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground tracking-widest mb-1">P&amp;L</div>
            <div className={`font-mono font-bold text-sm ${pnlColor}`}>
              {trade.pnl != null ? (
                <>
                  {trade.pnl >= 0 ? "+" : ""}{trade.pnl.toFixed(4)} USDT
                  {retPct != null && (
                    <span className="ml-1.5 text-xs">({retPct >= 0 ? "+" : ""}{retPct.toFixed(2)}%)</span>
                  )}
                  {trade.closeReason && trade.closeReason !== "manual" && (
                    <span className="ml-1.5 text-muted-foreground font-normal text-xs">via {trade.closeReason.toUpperCase()}</span>
                  )}
                </>
              ) : "—"}
            </div>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Clock className="w-3 h-3" />
          Opened {timeSince(trade.createdAt)}
          {trade.closedAt && <> · Closed {timeSince(trade.closedAt)}</>}
          <span className="ml-auto text-xs">Trade #{trade.id}</span>
        </div>
      </div>
    </div>
  );
}

export function SignalDetail() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { data: signal, isLoading } = useGetSignal(id, {
    query: { enabled: !!id, queryKey: getGetSignalQueryKey(id) }
  });
  const deleteMutation = useDeleteSignal();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
        Loading...
      </div>
    );
  }

  if (!signal) {
    return (
      <div className="text-center py-16">
        <p className="text-muted-foreground mb-4">Signal not found.</p>
        <Link href="/signals" className="text-primary hover:underline text-sm">Back to signals</Link>
      </div>
    );
  }

  const isLong = signal.dir === "LONG";
  const isTriggered = signal.triggered;
  const accentColor = isLong ? "text-green-400" : "text-red-400";
  const accentBorder = isLong ? "border-green-500/30" : "border-red-500/30";
  const accentBg = isLong ? "bg-green-500/5" : "bg-red-500/5";

  const gateBias = !signal.blockReason?.includes("B_FAIL");
  const gateCtx = gateBias && !signal.blockReason?.includes("C_FAIL");
  const gateZone = gateCtx && !signal.blockReason?.includes("Z_FAIL");

  const allLevels = [signal.sl, signal.zoneLow, signal.zoneHigh, signal.tp1, signal.tp2, signal.tp3].filter((v): v is number => v != null);
  const minLevel = allLevels.length ? Math.min(...allLevels) * 0.998 : 0;
  const maxLevel = allLevels.length ? Math.max(...allLevels) * 1.002 : 1;

  async function handleDelete() {
    if (!confirm("Delete this signal?")) return;
    await deleteMutation.mutateAsync({ id });
    window.location.href = "/signals";
  }

  return (
    <div className="space-y-5 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <Link href="/signals" className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-4 h-4" />
          Back to Signals
        </Link>
        <button onClick={handleDelete} className="text-xs text-red-400 hover:text-red-300 border border-red-500/30 px-3 py-1.5 transition-colors">
          Delete Signal
        </button>
      </div>

      {/* Title band */}
      <div className={`border ${accentBorder} ${accentBg} px-5 py-4 flex items-center justify-between`}>
        <div className="flex items-center gap-4">
          <span className={`flex items-center gap-2 text-2xl font-bold ${accentColor}`}>
            {isLong ? <ArrowUpRight className="w-6 h-6" /> : <ArrowDownRight className="w-6 h-6" />}
            {signal.dir}
          </span>
          <span className={`text-xl font-bold font-mono ${accentColor}`}>{signal.symbol}</span>
          <span className="text-xs text-muted-foreground border border-border px-2 py-1">{signal.tf}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className={`px-4 py-2 border text-sm font-bold tracking-widest ${isTriggered ? "border-green-500/50 text-green-400 bg-green-500/10" : "border-yellow-500/50 text-yellow-400 bg-yellow-500/10"}`}>
            {isTriggered ? "TRIGGERED" : "BLOCKED"}
          </span>
          {signal.grade && (
            <span className={`px-3 py-2 border text-xs font-bold ${signal.grade.includes("A+") ? "border-yellow-500/40 text-yellow-400" : signal.grade.includes("Strong") ? "border-blue-400/40 text-blue-400" : "border-border text-muted-foreground"}`}>
              {signal.grade}
            </span>
          )}
        </div>
      </div>

      {/* Linked trade — only shown if signal was triggered and bot may have traded it */}
      {isTriggered && <TradeCard signalId={id} />}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Confidence */}
        <Section title="CONFIDENCE">
          <div className="space-y-3">
            <div className="flex items-center gap-4">
              <div className="text-3xl font-bold font-mono text-foreground">{signal.conf ?? "?"}<span className="text-muted-foreground text-base">/7</span></div>
              <div className="flex-1">
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-muted-foreground">CONF_W</span>
                  <span className={`font-bold ${(signal.confW ?? 0) >= 75 ? "text-green-400" : (signal.confW ?? 0) >= 55 ? "text-yellow-400" : "text-red-400"}`}>
                    {signal.confW?.toFixed(1) ?? "—"}%
                  </span>
                </div>
                <div className="h-2 bg-secondary border border-border overflow-hidden">
                  <div
                    className={`h-full transition-all ${(signal.confW ?? 0) >= 75 ? "bg-green-500" : (signal.confW ?? 0) >= 55 ? "bg-yellow-400" : "bg-red-500"}`}
                    style={{ width: `${Math.min(signal.confW ?? 0, 100)}%` }}
                  />
                </div>
              </div>
            </div>
            <Row label="RISK TIER" value={signal.riskTier ?? "—"} color={signal.riskTier === "HIGH_CONF" ? "text-green-400" : signal.riskTier === "MID_CONF" ? "text-yellow-400" : "text-red-400"} />
          </div>
        </Section>

        {/* Gates */}
        <Section title="GATE STATUS">
          <div className="grid grid-cols-3 gap-3 mb-3">
            <GatePill pass={gateBias} label="B BIAS" />
            <GatePill pass={gateCtx} label="C CTX" />
            <GatePill pass={gateZone} label="Z ZONE" />
          </div>
          {signal.blockReason && signal.blockReason !== "OK" && (
            <div className="flex items-center gap-2 text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/30 px-3 py-2">
              <AlertTriangle className="w-3 h-3 shrink-0" />
              BLOCK REASON: {signal.blockReason}
            </div>
          )}
        </Section>

        {/* Entry Plan */}
        <Section title="ENTRY PLAN">
          <Row label="ENTRY ZONE" value={signal.zoneLow != null && signal.zoneHigh != null ? `${fmt(signal.zoneLow)} – ${fmt(signal.zoneHigh)}` : "—"} color="text-primary" />
          <Row label="ENTRY REF" value={fmt(signal.entryRef)} />
          <Row label="STOP LOSS" value={fmt(signal.sl)} color="text-red-400" />
          <Row label="RR1" value={signal.rr1 != null ? `${signal.rr1.toFixed(2)}R` : "—"} color={signal.rr1 != null && signal.rr1 >= 2 ? "text-green-400" : "text-foreground"} />
          <Row label="TP1" value={fmt(signal.tp1)} color="text-green-400" />
          <Row label="TP2" value={fmt(signal.tp2)} color="text-green-300" />
          <Row label="TP3" value={fmt(signal.tp3)} color="text-green-200" />
        </Section>

        {/* Structure */}
        <Section title="STRUCTURE &amp; CONTEXT">
          <Row label="AUTHORITY" value={signal.auth ?? "—"} color={accentColor} />
          <Row label="PA MSS" value={fmt(signal.paMss)} />
          <Row label="OB RANGE" value={signal.obLow != null ? `${fmt(signal.obLow)} – ${fmt(signal.obHigh)}` : "—"} />
          <Row label="MODE" value={signal.mode ?? "—"} />
          <Row label="MACRO TF" value={signal.macroTf ?? "—"} />
          <Row label="TF2 / TF3" value={`${signal.tf2 ?? "—"} / ${signal.tf3 ?? "—"}`} />
        </Section>

        {/* Level Map */}
        {allLevels.length > 0 && (
          <Section title="LEVEL MAP">
            <div className="space-y-2">
              <LevelBar label="TP3" price={signal.tp3} min={minLevel} max={maxLevel} color={isLong ? "text-green-200" : "text-red-200"} />
              <LevelBar label="TP2" price={signal.tp2} min={minLevel} max={maxLevel} color={isLong ? "text-green-300" : "text-red-300"} />
              <LevelBar label="TP1" price={signal.tp1} min={minLevel} max={maxLevel} color={isLong ? "text-green-400" : "text-red-400"} />
              <LevelBar label="ZONE HI" price={signal.zoneHigh} min={minLevel} max={maxLevel} color="text-primary" />
              <LevelBar label="ZONE LO" price={signal.zoneLow} min={minLevel} max={maxLevel} color="text-primary" />
              <LevelBar label="SL" price={signal.sl} min={minLevel} max={maxLevel} color="text-red-500" />
            </div>
          </Section>
        )}

        {/* Rotation */}
        <Section title="ROTATION">
          <Row label="STATE" value={signal.rot ?? "—"} color={
            signal.rot === "RISK_OFF" ? "text-red-400" :
            signal.rot === "ETH->ALTS" ? "text-emerald-400" :
            signal.rot === "BTC->ETH" ? "text-blue-400" :
            signal.rot === "BTC->ALTS" ? "text-violet-400" :
            "text-muted-foreground"
          } />
          <Row label="ROT SCORE" value={signal.rotScore != null ? `${signal.rotScore > 0 ? "+" : ""}${signal.rotScore.toFixed(3)}` : "—"} color={signal.rotScore != null ? (signal.rotScore > 0 ? "text-green-400" : "text-red-400") : undefined} />
        </Section>
      </div>

      {/* Webhook */}
      <Section title="WEBHOOK PAYLOAD">
        <pre className="text-xs font-mono text-muted-foreground overflow-auto max-h-64 whitespace-pre-wrap break-all">
          {JSON.stringify(signal.rawPayload ?? {}, null, 2)}
        </pre>
      </Section>
    </div>
  );
}
