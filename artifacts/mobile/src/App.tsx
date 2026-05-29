import { useEffect, useState } from "react";
import { Dashboard } from "./screens/Dashboard";
import { Positions } from "./screens/Positions";
import { Signals } from "./screens/Signals";
import { Settings } from "./screens/Settings";
import { loadConnection, type Connection } from "./api";
import { registerForPushNotifications } from "./push";

type Tab = "dashboard" | "positions" | "signals" | "settings";

export function App() {
  const [conn, setConn] = useState<Connection | null>(null);
  const [tab, setTab] = useState<Tab>("dashboard");
  const [bootstrapped, setBootstrapped] = useState(false);

  useEffect(() => {
    loadConnection().then((c) => {
      setConn(c);
      setBootstrapped(true);
      if (c) {
        // Best-effort: register FCM token so push works. Failures are logged
        // and ignored — the app is still usable without push.
        registerForPushNotifications(c).catch((err) => {
          console.warn("Push registration failed:", err);
        });
      }
    });
  }, []);

  if (!bootstrapped) {
    return <div style={{ display: "grid", placeItems: "center", height: "100%", color: "#666" }}>Loading…</div>;
  }

  if (!conn || tab === "settings") {
    return <Settings conn={conn} onSaved={(c) => { setConn(c); setTab("dashboard"); }} onTab={setTab} />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <header style={{ padding: "12px 16px", borderBottom: "1px solid #1f1f1f", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 13, letterSpacing: 2, fontWeight: 700, color: "#a78bfa" }}>USC BOT</div>
        <button onClick={() => setTab("settings")} style={iconBtn}>⚙</button>
      </header>

      <main style={{ flex: 1, overflowY: "auto" }}>
        {tab === "dashboard" && <Dashboard conn={conn} />}
        {tab === "positions" && <Positions conn={conn} />}
        {tab === "signals" && <Signals conn={conn} />}
      </main>

      <nav style={tabBar}>
        <TabBtn active={tab === "dashboard"} label="Dashboard" onClick={() => setTab("dashboard")} />
        <TabBtn active={tab === "positions"} label="Positions" onClick={() => setTab("positions")} />
        <TabBtn active={tab === "signals"} label="Signals" onClick={() => setTab("signals")} />
      </nav>
    </div>
  );
}

function TabBtn({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, padding: "14px 0", background: "transparent", border: "none",
        color: active ? "#a78bfa" : "#666", fontSize: 12, fontWeight: 700,
        letterSpacing: 1, borderTop: active ? "2px solid #a78bfa" : "2px solid transparent",
      }}
    >
      {label.toUpperCase()}
    </button>
  );
}

const iconBtn: React.CSSProperties = {
  background: "transparent", border: "1px solid #1f1f1f", color: "#a78bfa",
  width: 32, height: 32, borderRadius: 4, fontSize: 16, cursor: "pointer",
};

const tabBar: React.CSSProperties = {
  display: "flex", borderTop: "1px solid #1f1f1f", background: "#0a0a0a",
  paddingBottom: "env(safe-area-inset-bottom, 0px)",
};
