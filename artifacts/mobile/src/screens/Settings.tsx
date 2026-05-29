import { useEffect, useState } from "react";
import { clearConnection, saveConnection, type Connection } from "../api";

interface SettingsProps {
  conn: Connection | null;
  onSaved: (c: Connection) => void;
  onTab: (t: "dashboard" | "positions" | "signals" | "settings") => void;
}

export function Settings({ conn, onSaved, onTab }: SettingsProps) {
  const [serverUrl, setServerUrl] = useState(conn?.serverUrl ?? "");
  const [token, setToken] = useState(conn?.token ?? "");
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const isFirstLaunch = conn == null;

  useEffect(() => {
    setServerUrl(conn?.serverUrl ?? "");
    setToken(conn?.token ?? "");
  }, [conn]);

  const save = async () => {
    setMsg(null);
    if (!serverUrl.trim() || !token.trim()) {
      setMsg("Both fields required.");
      return;
    }
    const next: Connection = { serverUrl: serverUrl.trim(), token: token.trim() };
    setTesting(true);
    try {
      const res = await fetch(`${next.serverUrl.replace(/\/$/, "")}/api/mobile/dashboard`, {
        headers: { Authorization: `Bearer ${next.token}` },
      });
      if (!res.ok) {
        setMsg(`Server returned ${res.status}. Check token / URL.`);
        return;
      }
      await saveConnection(next);
      onSaved(next);
    } catch (e) {
      setMsg(`Cannot reach server: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(false);
    }
  };

  const forget = async () => {
    if (!confirm("Forget this server and reset?")) return;
    await clearConnection();
    setServerUrl("");
    setToken("");
    setMsg("Connection cleared.");
  };

  return (
    <div style={{ padding: 16, maxWidth: 480, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ fontSize: 14, letterSpacing: 2, fontWeight: 700, color: "#a78bfa" }}>
          {isFirstLaunch ? "USC BOT — CONNECT" : "SETTINGS"}
        </div>
        {!isFirstLaunch && (
          <button onClick={() => onTab("dashboard")} style={iconBtn}>×</button>
        )}
      </div>

      {isFirstLaunch && (
        <p style={hint}>
          Point this app at your trading server. The bearer token comes from
          your server's <code style={{ color: "#a78bfa" }}>MOBILE_API_TOKEN</code> env var.
        </p>
      )}

      <Field label="SERVER URL" placeholder="https://bot.example.com">
        <input
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          placeholder="https://bot.example.com"
          autoComplete="url"
          autoCapitalize="none"
          autoCorrect="off"
          style={input}
        />
      </Field>

      <Field label="BEARER TOKEN" placeholder="MOBILE_API_TOKEN">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="—"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          style={input}
        />
      </Field>

      {msg && <div style={{ marginTop: 12, fontSize: 12, color: msg.includes("clear") ? "#34d399" : "#fca5a5" }}>{msg}</div>}

      <button onClick={save} disabled={testing} style={primaryBtn}>
        {testing ? "Testing…" : isFirstLaunch ? "Connect" : "Save & test"}
      </button>

      {!isFirstLaunch && (
        <button onClick={forget} style={{ ...primaryBtn, marginTop: 8, color: "#f87171", borderColor: "#7f1d1d" }}>
          Forget connection
        </button>
      )}

      <div style={{ marginTop: 32, fontSize: 11, color: "#444", lineHeight: 1.6 }}>
        Notifications register automatically after a successful connection on
        Android. On web (dev preview), push is skipped — UI still works.
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; placeholder?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 10, color: "#666", letterSpacing: 2, fontWeight: 700, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const input: React.CSSProperties = {
  width: "100%", padding: "10px 12px", background: "#111", border: "1px solid #1f1f1f",
  color: "#d4d4d4", borderRadius: 4, fontSize: 14, outline: "none",
};
const primaryBtn: React.CSSProperties = {
  marginTop: 16, width: "100%", padding: 12, background: "transparent",
  border: "1px solid #a78bfa", color: "#a78bfa", fontSize: 13, fontWeight: 700,
  letterSpacing: 1, borderRadius: 4, cursor: "pointer",
};
const iconBtn: React.CSSProperties = {
  background: "transparent", border: "1px solid #1f1f1f", color: "#888",
  width: 28, height: 28, borderRadius: 4, fontSize: 16, cursor: "pointer",
};
const hint: React.CSSProperties = {
  fontSize: 12, color: "#888", marginBottom: 16, lineHeight: 1.5,
};
