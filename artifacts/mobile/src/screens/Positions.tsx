import { useEffect, useState } from "react";
import { apiGet, type Connection, type Position } from "../api";

export function Positions({ conn }: { conn: Connection }) {
  const [rows, setRows] = useState<Position[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = () => {
    setErr(null);
    apiGet<{ positions: Position[] }>(conn, "/api/mobile/positions")
      .then((r) => setRows(r.positions))
      .catch((e) => setErr(String(e)));
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (err) return <div style={{ padding: 16, color: "#fca5a5" }}>{err}</div>;
  if (rows == null) return <div style={{ padding: 24, color: "#666", textAlign: "center" }}>Loading…</div>;
  if (rows.length === 0) return <div style={{ padding: 24, color: "#666", textAlign: "center" }}>No open positions.</div>;

  return (
    <div style={{ padding: 12 }}>
      {rows.map((p) => (
        <div key={`${p.engine}-${p.id}`} style={row}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#d4d4d4" }}>{p.symbol}</div>
            <div style={{ fontSize: 11, color: p.side === "buy" ? "#34d399" : "#f87171", fontWeight: 700, letterSpacing: 1 }}>
              {p.side.toUpperCase()}
            </div>
          </div>

          <div style={{ marginTop: 6, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 12 }}>
            <KV k="ENTRY" v={fmtPx(p.entryPrice)} />
            <KV k="LIVE" v={fmtPx(p.livePrice)} />
            <KV k="P&L" v={fmtPnl(p.pnl)} color={pnlColor(p.pnl)} />
            <KV k="QTY" v={fmtNum(p.quantity, 4)} />
          </div>

          <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap", fontSize: 10 }}>
            <Badge color={stateColor(p.protectionState)} label={p.protectionState} />
            {p.strategy && <Badge color="#888" label={p.strategy} />}
            {p.quality != null && <Badge color="#a78bfa" label={`q=${parseFloat(p.quality).toFixed(2)}`} />}
            <Badge color="#888" label={p.engine} />
          </div>
        </div>
      ))}
    </div>
  );
}

function KV({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: "#666", letterSpacing: 1, fontWeight: 700 }}>{k}</div>
      <div style={{ color: color ?? "#d4d4d4", fontVariantNumeric: "tabular-nums" }}>{v}</div>
    </div>
  );
}

function Badge({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ padding: "2px 6px", border: `1px solid ${color}`, color, borderRadius: 3, fontWeight: 700, letterSpacing: 1 }}>
      {label.toUpperCase()}
    </span>
  );
}

function fmtPx(v: string | number | null): string {
  if (v == null) return "—";
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (!Number.isFinite(n)) return "—";
  return n.toPrecision(6);
}
function fmtPnl(v: string | number | null): string {
  if (v == null) return "—";
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (!Number.isFinite(n)) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(2);
}
function fmtNum(v: string | number | null, digits: number): string {
  if (v == null) return "—";
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}
function pnlColor(v: string | number | null): string {
  if (v == null) return "#666";
  const n = typeof v === "string" ? parseFloat(v) : v;
  return n > 0 ? "#34d399" : n < 0 ? "#f87171" : "#666";
}
function stateColor(state: string): string {
  switch (state) {
    case "protected": return "#34d399";
    case "degraded": return "#fbbf24";
    case "emergency_closed": return "#f87171";
    case "pending": return "#94a3b8";
    default: return "#888";
  }
}

const row: React.CSSProperties = {
  padding: 12, marginBottom: 8, border: "1px solid #1f1f1f", borderRadius: 4, background: "#111",
};
