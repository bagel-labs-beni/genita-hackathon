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

// D47 "How I see you": the seven cards (genita-server/src/personalize/story.ts shape, TITLES / PICKS)
const card = (id, title, observation, promise, evidence, picks, extra = {}) => ({ id, title, observation, promise, evidence, later: false, picks, ...extra });
let story = [
  card("opener", "How I see you", "You come to me to think things through and find what fits you.", "So I'll keep it short, honest and on your side.", "explicit", ["That's not why I'm here", "Something's missing"]),
  card("think", "How you think things through", "You like two or three options, with one picked for you.", "So I'll always say which one I'd choose.", "explicit", ["That's not how I decide", "Something's missing"]),
  card("talk", "How you like to talk", "You want it warm, direct and informal. Short first, details if you ask.", "So I'll lead with the answer, not the windup.", "observed", ["Shorter replies", "More back-and-forth", "Less joking", "Something else"]),
  card("taste", "Your taste", "You lean clean and minimal, in understated colors.", "So I'll pick things with that in mind.", "observed", ["I don't like one of these", "My taste changed", "Something's missing"],
    { tags: { style: ["Clean, minimal", "Understated colors"], food: ["Spicy noodles"], watch: ["Design talks"], dislikes: ["Loud logos"] } }),
  card("help", "How I can help", "You want me to find things that fit your style and send the links.", "So I'll look things up without asking, and check before anything costs money.", "observed", ["Ask me first", "Just do it", "I don't need this"],
    { help: [{ label: "Find what fits", mode: "just_do_it" }, { label: "Send the links", mode: "just_do_it" }, { label: "Buy something", mode: "ask_first" }] }),
  card("lines", "Your lines", "You want me to ask before I do anything for you.", "So I'll stay on the right side of that.", "explicit", ["That's fine with me", "Something's missing"]),
  card("unknowns", "Still getting to know you", "There's still a little I don't know about you.", "So I'll ask about one of these on our next call, in passing.", "suggested", ["Let me tell you now", "Don't ask about these"], { unknowns: ["Budget", "Food you love"] }),
];
const ACK = "Got it. I'll remember that.";

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
  if (req.method === "POST" && p === "/v1/import") { await sleep(1500); return send(200, { ...style("import"), story }); }
  // skip users get their story from GET /v1/profile/story (as on the server)
  if (req.method === "POST" && p === "/v1/import/skip") return send(200, style("skip"));
  if (req.method === "GET" && p === "/v1/profile/story") { await sleep(1200); return send(200, { status: "ready", source: "import", cards: story, ms: 1200 }); }
  if (req.method === "PATCH" && p === "/v1/profile") {
    const i = story.findIndex((c) => c.id === b.cardId);
    if (i < 0) return send(400, { error: "bad_correction" });
    if (b.pick != null && !story[i].picks.includes(b.pick)) return send(400, { error: "bad_correction" });
    if (!b.pick && !String(b.text ?? "").trim()) return send(400, { error: "bad_correction" });
    if (String(b.text ?? "").length > 200) return send(400, { error: "bad_correction" });
    await sleep(1200);
    const said = String(b.text ?? "").trim();
    if (b.cardId === "taste") {
      const tags = { ...story[i].tags, food: [], dislikes: ["Loud logos", "Cilantro"] };
      story[i] = { ...story[i], observation: "You lean clean and minimal. And no cilantro, ever.", promise: "So I'll leave it out of anything I cook up for you.", evidence: "explicit", tags };
    } else story[i] = { ...story[i], observation: said ? `You told me: ${said}.` : story[i].observation, promise: "So I'll go by what you said.", evidence: "explicit" };
    const likes = rows.find((r) => r.key === "likes");
    if (b.cardId === "taste") likes.items = [...likes.items.filter((x) => !/cilantro/i.test(x.text)), { text: "No cilantro.", label: "explicit" }];
    return send(200, { card: story[i], ack: ACK, changed: true, profile: style("import").profile + "\n- Likes: no cilantro", rows });
  }
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
