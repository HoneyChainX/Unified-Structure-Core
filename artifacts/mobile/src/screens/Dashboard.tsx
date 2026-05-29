import { useEffect, useState } from "react";
import { apiGet, apiPost, type Connection, type DashboardPayload } from "../api";

export function Dashboard({ conn }: { conn: Connection }) {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [halting, setHalting] = useState(false);

  const refresh = () => {
    setErr(null);
    apiGet<DashboardPayload>(conn, "/api/mobile/dashboard").then(setData).catch((e) => setErr(String(e)));
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const halt = async () => {
    if (!confirm("Engage kill switch — pause ALL trading?")) return;
    setHalting(true);
    try {
      await apiPost(conn, "/api/risk/halt", { reason: "Mobile" });
      refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setHalting(false);
    }
  };

  if (err) return <ErrorBlock msg={err} onRetry={refresh} />;
  if (!data) return <div style={loading}>Loading…</div>;

  const pnlColor = data.dailyRealisedPnl > 0 ? "#34d399" : data.dailyRealisedPnl < 0 ? "#f87171" : "#666";

  return (
    <div style={{ padding: 16 }}>
      <Tile label="EQUITY (USDT)" value={data.equityUsdt != null ? data.equityUsdt.toFixed(2) : "—"} />
      <Tile label="TODAY'S P&L" value={`${data.dailyRealisedPnl >= 0 ? "+" : ""}${data.dailyRealisedPnl.toFixed(2)}`} color={pnlColor} />
      <Tile label="OPEN TRADES" value={String(data.totalOpen)} />

      <div style={{ marginTop: 12, fontSize: 11, color: "#666", letterSpacing: 2, fontWeight: 700 }}>BY PROTECTION STATE</div>
      <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {Object.entries(data.openTradesByProtection).map(([state, count]) => (
          <div key={state} style={{ ...miniTile, borderColor: stateColor(state) }}>
            <div style={{ fontSize: 11, color: "#888" }}>{state.toUpperCase()}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: stateColor(state) }}>{count}</div>
          </div>
        ))}
        {data.totalOpen === 0 && <div style={{ ...miniTile, gridColumn: "1 / -1", color: "#666" }}>No open positions.</div>}
      </div>

      <button onClick={halt} disabled={halting} style={haltBtn}>
        {halting ? "Halting…" : "🛑 HALT ALL TRADING"}
      </button>

      <div style={{ marginTop: 16, fontSize: 11, color: "#444", textAlign: "center" }}>
        Updated {new Date(data.asOf).toLocaleTimeString()}
      </div>
    </div>
  );
}

function Tile({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={tile}>
      <div style={{ fontSize: 10, color: "#666", letterSpacing: 2, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: color ?? "#d4d4d4", fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

function ErrorBlock({ msg, onRetry }: { msg: string; onRetry: () => void }) {
  return (
    <div style={{ padding: 16 }}>
      <div style={{ ...tile, borderColor: "#7f1d1d" }}>
        <div style={{ fontSize: 11, color: "#f87171", letterSpacing: 2, fontWeight: 700 }}>ERROR</div>
        <div style={{ fontSize: 13, marginTop: 6, color: "#fca5a5", wordBreak: "break-word" }}>{msg}</div>
        <button onClick={onRetry} style={{ ...miniBtn, marginTop: 12 }}>Retry</button>
      </div>
    </div>
  );
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

const tile: React.CSSProperties = {
  padding: 12, marginBottom: 8, border: "1px solid #1f1f1f", borderRadius: 4, background: "#111",
};
const miniTile: React.CSSProperties = {
  padding: 10, border: "1px solid #1f1f1f", borderRadius: 4, background: "#111",
};
const miniBtn: React.CSSProperties = {
  background: "transparent", border: "1px solid #1f1f1f", color: "#a78bfa",
  padding: "6px 12px", fontSize: 12, fontWeight: 700, borderRadius: 4, cursor: "pointer",
};
const haltBtn: React.CSSProperties = {
  marginTop: 20, width: "100%", padding: 16, background: "transparent",
  border: "1px solid #7f1d1d", color: "#f87171", fontSize: 14, fontWeight: 700,
  letterSpacing: 1, borderRadius: 4, cursor: "pointer",
};
const loading: React.CSSProperties = { padding: 24, color: "#666", textAlign: "center" };
