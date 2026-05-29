import { useEffect, useState } from "react";
import { apiGet, type Connection, type SignalRow } from "../api";

export function Signals({ conn }: { conn: Connection }) {
  const [rows, setRows] = useState<SignalRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = () => {
    setErr(null);
    apiGet<{ signals: SignalRow[] }>(conn, "/api/mobile/signals")
      .then((r) => {
        // Sort by quality DESC, then recency
        const sorted = [...r.signals].sort((a, b) => {
          const qa = a.quality != null ? parseFloat(a.quality) : -1;
          const qb = b.quality != null ? parseFloat(b.quality) : -1;
          if (qa !== qb) return qb - qa;
          return +new Date(b.receivedAt) - +new Date(a.receivedAt);
        });
        setRows(sorted);
      })
      .catch((e) => setErr(String(e)));
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (err) return <div style={{ padding: 16, color: "#fca5a5" }}>{err}</div>;
  if (rows == null) return <div style={{ padding: 24, color: "#666", textAlign: "center" }}>Loading…</div>;
  if (rows.length === 0) return <div style={{ padding: 24, color: "#666", textAlign: "center" }}>No signals in the last 24h.</div>;

  return (
    <div style={{ padding: 12 }}>
      <div style={{ fontSize: 10, color: "#666", letterSpacing: 2, fontWeight: 700, marginBottom: 8 }}>
        SORTED BY QUALITY · LAST 24H
      </div>
      {rows.map((s) => {
        const q = s.quality != null ? parseFloat(s.quality) : null;
        return (
          <div key={s.id} style={row}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#d4d4d4" }}>{s.symbol}</div>
              <div style={{ fontSize: 11, color: s.dir === "LONG" ? "#34d399" : "#f87171", fontWeight: 700, letterSpacing: 1 }}>
                {s.dir}
              </div>
            </div>

            <div style={{ marginTop: 6, display: "flex", gap: 8, fontSize: 11, alignItems: "center" }}>
              {q != null && (
                <QualityBar q={q} />
              )}
              {s.grade && <span style={{ color: "#a78bfa", fontWeight: 700 }}>{s.grade}</span>}
              <span style={{ color: "#666" }}>· {s.tf}</span>
              {s.triggered && <span style={{ color: "#34d399", fontWeight: 700, letterSpacing: 1, fontSize: 10 }}>TRIGGERED</span>}
            </div>

            <div style={{ marginTop: 4, fontSize: 10, color: "#444" }}>
              {new Date(s.receivedAt).toLocaleTimeString()}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function QualityBar({ q }: { q: number }) {
  const pct = Math.max(0, Math.min(1, q)) * 100;
  const color = q >= 0.75 ? "#34d399" : q >= 0.5 ? "#fbbf24" : "#666";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <div style={{ width: 40, height: 4, background: "#1f1f1f", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color }} />
      </div>
      <span style={{ color, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{q.toFixed(2)}</span>
    </div>
  );
}

const row: React.CSSProperties = {
  padding: 12, marginBottom: 8, border: "1px solid #1f1f1f", borderRadius: 4, background: "#111",
};
