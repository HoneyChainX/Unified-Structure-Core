// Verifier: /api/risk/kill and /api/risk/halt must produce identical state.
//
// History: the mobile app's "HALT ALL TRADING" button calls /api/risk/halt,
// but the server only had /api/risk/kill — that button 404'd on a real
// device. Fix added /halt as a parallel registration of the same handler.
// This verifier locks that contract in: both routes must exist and produce
// identical state changes, so the mobile-app button and any docs that say
// /halt continue to work.
import express from "express";
import { db, riskConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import riskRouter from "../routes/risk";

let fails = 0;
const ok = (cond: boolean, label: string, detail?: unknown) => {
  if (cond) console.log("  ✓", label);
  else { console.log("  ✗", label, detail ?? ""); fails++; }
};

const app = express();
app.use(express.json());
app.use("/api/risk", riskRouter);

async function jsonReq(path: string, method: "GET" | "POST" | "PUT", body?: unknown) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") { server.close(); reject(new Error("no addr")); return; }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      })
        .then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }))
        .then((result) => { server.close(); resolve(result); })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

async function reset() {
  await db.delete(riskConfigTable);
  await db.insert(riskConfigTable).values({});
}

async function readKillState() {
  const [row] = await db.select().from(riskConfigTable).limit(1);
  return { killSwitch: row?.killSwitch ?? false, killReason: row?.killReason ?? null };
}

async function main() {
  // ── 1. Both routes exist and respond 200 ────────────────────────────────────
  console.log("[1] Both /kill and /halt respond 200");
  await reset();
  const kill = await jsonReq("/api/risk/kill", "POST", { reason: 42 });
  ok(kill.status === 200, `POST /kill → 200 (got ${kill.status})`);
  ok(kill.body.ok === true, "kill body has ok: true");

  await reset();
  const halt = await jsonReq("/api/risk/halt", "POST", { reason: 42 });
  ok(halt.status === 200, `POST /halt → 200 (got ${halt.status})`);
  ok(halt.body.ok === true, "halt body has ok: true");

  // ── 2. Identical state changes ──────────────────────────────────────────────
  console.log("[2] Both routes produce identical state");
  await reset();
  await jsonReq("/api/risk/kill", "POST", { reason: 7 });
  const afterKill = await readKillState();

  await reset();
  await jsonReq("/api/risk/halt", "POST", { reason: 7 });
  const afterHalt = await readKillState();

  ok(afterKill.killSwitch === true, "/kill engages the kill switch");
  ok(afterHalt.killSwitch === true, "/halt engages the kill switch");
  ok(afterKill.killReason === afterHalt.killReason,
     `kill_reason matches across both routes (kill=${afterKill.killReason}, halt=${afterHalt.killReason})`);
  ok(afterKill.killReason === 7, "kill_reason picked up from body");

  // ── 3. Non-numeric `reason` defaults to 0 (mobile sends a string) ───────────
  console.log("[3] Non-numeric `reason` defaults to 0");
  await reset();
  await jsonReq("/api/risk/halt", "POST", { reason: "Mobile" });
  const afterMobile = await readKillState();
  ok(afterMobile.killSwitch === true, "mobile-style string reason still engages kill switch");
  ok(afterMobile.killReason === 0, `string reason → killReason defaults to 0 (got ${afterMobile.killReason})`);

  // ── 4. /resume clears regardless of which route engaged it ──────────────────
  console.log("[4] /resume clears state set by either /kill or /halt");
  await reset();
  await jsonReq("/api/risk/halt", "POST", { reason: 99 });
  const beforeResume = await readKillState();
  ok(beforeResume.killSwitch === true, "halt engaged");
  await jsonReq("/api/risk/resume", "POST");
  const afterResume = await readKillState();
  ok(afterResume.killSwitch === false, "/resume cleared kill switch");
  ok(afterResume.killReason === null, "/resume cleared kill_reason");

  // ── 5. Route alias regression guard: handler is the same function ──────────
  console.log("[5] Regression guard: route table includes both paths");
  // Pull the stack from the router and verify both paths exist mounted to POST
  // (defensive against someone removing /halt later).
  const layers = (riskRouter as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] }).stack;
  const postRoutes = layers
    .filter((l) => l.route?.methods.post)
    .map((l) => l.route!.path);
  ok(postRoutes.includes("/kill"), `route table includes POST /kill (got: ${postRoutes.join(", ")})`);
  ok(postRoutes.includes("/halt"), `route table includes POST /halt (got: ${postRoutes.join(", ")})`);

  await reset();
  console.log(`\n${fails === 0 ? "✓ ALL PASS" : `✗ ${fails} FAILURE(S)`}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(2); });
