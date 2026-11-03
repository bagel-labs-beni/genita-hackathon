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

// V04: the server's four voices for the look, the preview clip (WAV, 4 s tone: long enough that a loaded CI simulator still sees "Playing") and the saved pick.
// POST /__voice {down:true|false} flips the voice service so the UI test can show the greyed list.
let voiceDown = false;
const VOICES = [["72", "Tara", "Warm, bright"], ["120", "Leah", "Soft, steady"], ["36", "Leo", "Calm, low"], ["24", "Dan", "Easygoing"]]
  .map(([id, name, blurb]) => ({ id, name, blurb, label: `${name} · ${blurb.split(",")[0].toLowerCase()}`, previewUrl: `/v1/companion/voices/${id}/preview` }));
function previewWav() {
  const rate = 24000, n = Math.floor(rate * 4), pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 2500), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

let companion = null;
let prepStartedAt = 0;
// POST /__prep {failAt:n}: the face step fails once n of its 13 images are settled (PREP-1e); retry clears it.
let failAt = null;
// The real Meta-only shape (genita-server runner.ts prepView): scene, then ONE face step for 3 expressions +
// 10 visemes (`settled` of 13), the old video clips and lip step `skipped`. The clock starts at PREP-1's first poll
// (the UI test spends longer than the prep on the screens before it): scene done at 3 s, then one face image a
// second (expressions done at 6 s, mouth done = ready at 16 s).
const SCENE_MS = 3000, FACE_TOTAL = 13;
let FACE_MS = 1000;
const prepView = () => {
  const t = prepStartedAt ? Date.now() - prepStartedAt : 0;
  const sceneDone = prepStartedAt && t >= SCENE_MS;
  let settled = sceneDone ? Math.min(FACE_TOTAL, Math.floor((t - SCENE_MS) / FACE_MS)) : 0;
  const failed = failAt != null && settled >= failAt;
  if (failed) settled = failAt;
  const ready = !failed && settled >= FACE_TOTAL;
  const face = !sceneDone ? null : { status: failed ? "failed" : ready ? "done" : "running", settled, total: FACE_TOTAL, ms: null };
  const skipped = { status: "skipped", ms: null };
  return {
    status: failed ? "failed" : ready ? "ready" : "running",
    progress: { done: (sceneDone ? 1 : 0) + settled, total: 1 + FACE_TOTAL },
    sceneUrl: null,
    steps: { scene: { status: sceneDone ? "done" : "running", ms: null }, videos: { neutral: skipped, happy: skipped, warm: skipped }, face },
    lips: { status: "skipped", detail: null, url: null, ms: null },
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
  if (req.method === "POST" && p === "/__reset") { companion = null; prepStartedAt = 0; failAt = null; FACE_MS = 1000; voiceDown = false; return send(200, { ok: true }); }
  // a returning account whose face is still being made (F12 / S09-P): companion exists, prep clock starts now, slow face
  if (req.method === "POST" && p === "/__companion") {
    companion = { id: "c1", type: "human", name: b.name ?? "Jin", voiceId: "72", imageId: "img1", createdAt: "t" };
    prepStartedAt = Date.now(); FACE_MS = b.faceMs ?? 1000;
    return send(200, companionView());
  }
  if (req.method === "POST" && p === "/__prep") { failAt = Number.isInteger(b.failAt) ? b.failAt : null; return send(200, { failAt }); }
  if (req.method === "POST" && p === "/__voice") { voiceDown = b.down === true; return send(200, { voiceDown }); }
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
  if (req.method === "GET" && p === "/v1/companion/voices") return send(200, { voices: VOICES, suggested: "72", available: !voiceDown, ms: 5 });
  const pv = p.match(/^\/v1\/companion\/voices\/(\d+)\/preview$/);
  if (req.method === "GET" && pv) {
    if (voiceDown) return send(503, { error: "voice_unavailable" });
    await sleep(600);
    const wav = previewWav();
    res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length });
    return void res.end(wav);
  }
  if (req.method === "PUT" && p === "/v1/companion/voice") {
    if (!companion) return send(404, { error: "no_companion" });
    if (!VOICES.some((v) => v.id === b.voiceId)) return send(400, { error: "unknown_voice" });
    companion.voiceId = b.voiceId;
    return send(200, companionView());
  }
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
  if (req.method === "POST" && p === "/v1/companion/prep/retry") {
    if (!companion) return send(404, { error: "no_companion" });
    const v = prepView();
    if (v.status === "ready") return send(200, v);
    // the runner redoes only what didn't finish: carry on from the images already settled
    const settled = v.steps.face?.settled ?? 0;
    failAt = null;
    prepStartedAt = Date.now() - (SCENE_MS + settled * FACE_MS);
    return send(202, prepView());
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
