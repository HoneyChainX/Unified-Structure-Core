import { useEffect, useState } from "react";
import { Smartphone, Trash2, BellOff, Bell, RotateCcw } from "lucide-react";

interface Device {
  id: number;
  token: string;
  label: string | null;
  platform: string;
  enabled: boolean;
  notifyKillSwitch: boolean;
  notifyEmergencyClose: boolean;
  notifyDailyLoss: boolean;
  notifyHighQualitySignal: boolean;
  signalQualityThreshold: string;
  registeredAt: string;
  lastSeenAt: string;
}

export function DevicesPage() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    setErr(null);
    try {
      const res = await fetch("/api/devices");
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      setDevices(data.devices);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const update = async (id: number, patch: Partial<Device>) => {
    try {
      const res = await fetch(`/api/devices/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: number) => {
    if (!confirm("Unregister this device? It will stop receiving notifications until it re-registers.")) return;
    try {
      const res = await fetch(`/api/devices/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="max-w-4xl">
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Smartphone className="w-5 h-5 text-primary" /> MOBILE DEVICES
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Devices registered for push notifications. Toggle per-device alert preferences here.
          </p>
        </div>
        <button onClick={refresh} className="flex items-center gap-2 px-3 py-1.5 border border-border text-xs hover:bg-secondary/30">
          <RotateCcw className="w-3.5 h-3.5" /> Refresh
        </button>
      </header>

      {err && (
        <div className="mb-4 p-3 border border-red-900 bg-red-950/30 text-red-300 text-sm font-mono">
          {err}
        </div>
      )}

      {devices == null && !err && (
        <div className="text-muted-foreground text-sm">Loading…</div>
      )}

      {devices?.length === 0 && (
        <div className="border border-border p-8 text-center text-muted-foreground">
          <BellOff className="w-8 h-8 mx-auto mb-3 opacity-40" />
          <div className="text-sm">No devices registered yet.</div>
          <div className="text-xs mt-2">Install the mobile app and connect with <code className="text-primary">MOBILE_API_TOKEN</code>.</div>
        </div>
      )}

      <div className="space-y-3">
        {devices?.map((d) => (
          <div key={d.id} className={`border ${d.enabled ? "border-border" : "border-border/40"} bg-secondary/20 p-4`}>
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-bold">
                  {d.enabled ? <Bell className="w-4 h-4 text-primary" /> : <BellOff className="w-4 h-4 text-muted-foreground" />}
                  {d.label ?? <span className="text-muted-foreground italic">(no label)</span>}
                  <span className="text-[10px] text-muted-foreground px-1.5 py-0.5 border border-border rounded-sm tracking-widest font-bold">
                    {d.platform.toUpperCase()}
                  </span>
                </div>
                <div className="text-[11px] text-muted-foreground mt-1 font-mono">
                  {d.token.slice(0, 12)}…{d.token.slice(-6)}
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  registered {new Date(d.registeredAt).toLocaleString()} · last seen {new Date(d.lastSeenAt).toLocaleString()}
                </div>
              </div>
              <button onClick={() => remove(d.id)} className="text-muted-foreground hover:text-red-400 p-2" title="Unregister">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
              <Toggle
                label="Master enable"
                checked={d.enabled}
                onChange={(v) => update(d.id, { enabled: v })}
                color="primary"
              />
              <Toggle
                label="🛑 Kill switch alerts"
                checked={d.notifyKillSwitch}
                onChange={(v) => update(d.id, { notifyKillSwitch: v })}
                disabled={!d.enabled}
              />
              <Toggle
                label="⚠ Emergency close"
                checked={d.notifyEmergencyClose}
                onChange={(v) => update(d.id, { notifyEmergencyClose: v })}
                disabled={!d.enabled}
              />
              <Toggle
                label="🚨 Daily-loss breaker"
                checked={d.notifyDailyLoss}
                onChange={(v) => update(d.id, { notifyDailyLoss: v })}
                disabled={!d.enabled}
              />
              <Toggle
                label="💎 High-quality signals"
                checked={d.notifyHighQualitySignal}
                onChange={(v) => update(d.id, { notifyHighQualitySignal: v })}
                disabled={!d.enabled}
              />
              {d.notifyHighQualitySignal && (
                <div className="flex items-center justify-between p-2 bg-secondary/30 border border-border">
                  <div>
                    <div className="text-[11px] font-bold">Min quality</div>
                    <div className="text-[10px] text-muted-foreground">0..1 — alerts fire above this score</div>
                  </div>
                  <input
                    type="number" min={0} max={1} step={0.05}
                    value={parseFloat(d.signalQualityThreshold)}
                    onChange={(e) => update(d.id, { signalQualityThreshold: e.target.value })}
                    className="w-16 bg-secondary border border-border px-2 py-1 text-xs font-mono focus:outline-none focus:border-primary"
                  />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 p-3 border border-border bg-secondary/10 text-xs text-muted-foreground space-y-1">
        <div className="text-foreground font-bold mb-2">How registration works</div>
        <div>1. Install the Android app and enter the server URL + <code className="text-primary">MOBILE_API_TOKEN</code>.</div>
        <div>2. Granting notification permission triggers FCM token registration with the server.</div>
        <div>3. The device appears here. Toggle per-alert preferences. Master disable mutes everything without unregistering.</div>
        <div>4. Uninstalling the app does not auto-remove the row — use the trash icon to clean up.</div>
      </div>
    </div>
  );
}

function Toggle({
  label, checked, onChange, disabled, color,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  color?: "primary";
}) {
  const accent = color === "primary" ? "border-primary bg-primary/20" : "border-cyan-500 bg-cyan-500/20";
  const dot = color === "primary" ? "bg-primary" : "bg-cyan-400";
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`flex items-center justify-between p-2 border border-border bg-secondary/30 ${disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-secondary/60"} transition-colors`}
    >
      <span className="text-xs">{label}</span>
      <span className={`relative w-10 h-5 flex-shrink-0 rounded-full border transition-colors ${checked ? accent : "border-border bg-secondary"}`}>
        <span className={`absolute top-0.5 w-4 h-4 rounded-full transition-all ${checked ? `left-[1.125rem] ${dot}` : "left-0.5 bg-muted-foreground/50"}`} />
      </span>
    </button>
  );
}

export default DevicesPage;
