#!/usr/bin/env node
// Onboarding stub for the iOS UI test (OnboardingUITests): genita-server's /me and prep API shapes
// (genita-server/PREP_API.md) with canned answers and short delays, so CI can walk
// I01 → I02 → I03 → I04 → V01 → V03 → V02-T → V04 → NM01 → D01 … SUM → PREP-1 → S07 without vendors.
//   node ios-app/Tools/onboarding-stub/server.mjs [--port 8790]
import { createServer } from "node:http";

const port = Number(process.argv[process.argv.indexOf("--port") + 1]) || 8790;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

const rows = [
  ["communication", "Communication style", [["Warm, direct and informal.", "explicit"]]],
  ["response", "Response preferences", [["Two or three options, one recommended.", "explicit"], ["Short first answer.", "observed"]]],
  ["help", "How Genita can help", [["Find things that fit my style and send the links.", "observed"]]],
  ["interests", "Interests", [["Visual design and building products.", "explicit"]]],
  ["likes", "Likes & dislikes", [["Clean, minimal clothes. Understated colors.", "observed"], ["Dislikes loud logos.", "explicit"]]],
  ["boundaries", "Boundaries", [["Ask before taking any action for me.", "explicit"]]],
].map(([key, title, items]) => ({ key, title, items: items.map(([text, label]) => ({ text, label })) }));
const style = (source) => ({
  status: "ready",
  profile: "How the user wants to be treated:\n- Taste: Clean, minimal clothes.\n- Talk: Warm, direct and informal.",
  style: { version: 1, source, display: rows, partial: false, toConfirm: ["Budget"], itemCount: 7, dropped: { injection: 0, sensitive: 0 } },
});

let companion = null;
let prepStartedAt = 0;
// The clock starts at PREP-1's first poll (the UI test spends longer than the prep on the screens before it):
// scene at 3 s, expressions at 12 s, mouth (ready) at 25 s — room to see Continue light up before the auto-advance.
const STEPS = [3000, 12000, 25000];
const prepView = () => {
  const t = prepStartedAt ? Date.now() - prepStartedAt : 0;
  const st = (doneAt) => (prepStartedAt && t >= doneAt ? "done" : prepStartedAt && t >= doneAt - 3000 ? "running" : "pending");
  const ready = prepStartedAt && t >= STEPS[2];
  return {
    status: ready ? "ready" : "running",
    progress: { done: STEPS.filter((d) => prepStartedAt && t >= d).length, total: 3 },
    steps: { scene: { status: prepStartedAt ? st(STEPS[0]) : "running" }, face: { status: st(STEPS[1]) }, mouth: { status: st(STEPS[2]) } },
  };
};
const companionView = () => ({ ...companion, prep: prepView(), persona: null, session: null });

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  if ((req.headers["content-type"] ?? "").startsWith("application/json")) {
    try { return JSON.parse(raw.toString("utf8") || "{}"); } catch { return {}; }
  }
  return raw;
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const send = (status, json) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
  const b = await body(req);
  log(req.method, p, Buffer.isBuffer(b) ? `${b.length} bytes` : JSON.stringify(b).slice(0, 120));
  if (p === "/healthz") return send(200, { ok: true });
  if (!req.headers.authorization?.startsWith("Bearer ")) return send(401, { error: "unauthorized" });

  if (req.method === "GET" && p === "/me")
    return send(200, { user: { id: "u1", provider: "apple", email: null, displayName: "Chelsea", aiConsentAt: "t", createdAt: "t" }, consented: true, hasCompanion: !!companion, prepStatus: companion ? prepView().status : "none", conversation: null });
  if (req.method === "PATCH" && p === "/me") return send(200, { user: { id: "u1", provider: "apple", displayName: b.displayName, createdAt: "t" }, consented: true, hasCompanion: !!companion, prepStatus: "none", conversation: null });
  if (req.method === "POST" && p === "/v1/import") { await sleep(1500); return send(200, style("import")); }
  if (req.method === "POST" && p === "/v1/import/skip") return send(200, style("skip"));
  if (req.method === "POST" && p === "/v1/companion/image") {
    await sleep(1800);
    return send(200, { imageId: "img1", passed: true, type: "human", checks: { oneFaceFrontFacing: true, sharpAndLit: true, noText: true }, reasons: [], headBox: null, ms: 1800 });
  }
  if (req.method === "POST" && p === "/v1/companion/name/suggest") { await sleep(600); return send(200, { name: "Jin", ms: 600, suggested: true }); }
  if (req.method === "GET" && p === "/v1/companion/voices") return send(200, { voices: [{ id: "v1", name: "Mira", blurb: "Warm" }], suggested: "v1", ms: 5 });
  if (req.method === "POST" && p === "/v1/companion") {
    if (companion) return send(409, { error: "companion_exists" });
    companion = { id: "c1", type: "human", name: b.name ?? "Mira", voiceId: b.voiceId, imageId: b.imageId, createdAt: "t" };
    return send(201, companionView());
  }
  if (req.method === "PATCH" && p === "/v1/companion") {
    if (!companion) return send(404, { error: "no_companion" });
    const name = String(b.name ?? "").trim();
    if (!name || name.length > 20) return send(400, { error: "bad_name" });
    companion.name = name;
    return send(200, companionView());
  }
  if (req.method === "GET" && p === "/v1/companion") return companion ? send(200, companionView()) : send(404, { error: "no_companion" });
  if (req.method === "GET" && p === "/v1/companion/prep") {
    if (!companion) return send(404, { error: "no_companion" });
    if (!prepStartedAt) prepStartedAt = Date.now();
    return send(200, prepView());
  }
  if (req.method === "POST" && p === "/v1/companion/prefs") {
    await sleep(800);
    return send(200, {
      summary: { why: "Stay focused without feeling managed", energy: "Warm, direct", initiative: "Only when asked", never: "No messages without approval" },
      persona: null, rules: [],
      session: { persona: { name: companion?.name ?? "Mira", kind: "human", traits: ["warm", "direct"], speakingStyle: "short, warm" } },
    });
  }
  send(404, { error: "not_found" });
}).listen(port, "127.0.0.1", () => log(`onboarding stub on http://127.0.0.1:${port}`));
