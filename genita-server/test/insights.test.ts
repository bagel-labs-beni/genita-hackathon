/**
 * SUM insight report (Chelsea 11/4 03:43, 춘식이 r01 data model): Spark writes 3–5 observations about the user;
 * the server keeps only grounded, specific, safe ones. Spark is faked (keyed by schema name).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { FileStore } from "../src/prep/store.ts";
import { createPrepRoutes } from "../src/prep/routes.ts";
import type { PrepDeps } from "../src/prep/pipeline.ts";
import type { PrepRunner } from "../src/prep/runner.ts";
import { Personalize } from "../src/personalize/service.ts";
import { styleProfileText, toStyleCard, type StyleCard } from "../src/prep/importProfile.ts";
import { GENERIC_PHRASES, genericHit, insightProblem, picksFromAnswers, picksFromSkip, scrubRemoved, settingsFrom, toReport, type InsightInputs } from "../src/insights/report.ts";
import { Insights, insightProfileLines } from "../src/insights/service.ts";

const PASTE = [
  "1. Thinking style",
  "- Prefers short, direct answers and usually asks for two or three options before deciding. [Observed]",
  "2. Communication style",
  "- Jokes even in work threads ('ok but which one is cheaper lol'). [Observed]",
  "3. Boundaries",
  "- Wants to approve anything before it's sent. [Explicit]",
  "4. Rhythm",
  "- Often works late at night. [Observed]",
].join("\n");

const INPUTS: InsightInputs = {
  text: PASTE,
  findings: [],
  picks: [{ question: "How should I help?", label: "Think with me" }, { question: "Food you like", label: "Spicy" }],
  source: "import",
};

const ev = (source: string, quote: string) => ({ source, quote });
const obs = (o: Record<string, unknown> = {}) => ({
  category: "think",
  claim: "You decide by comparing, not by being told.",
  evidence: [ev("import", "usually asks for two or three options before deciding")],
  confidence: "high",
  score: 0.9,
  surprise: 0.7,
  use_in_call: "I'll lay out two options and say which one I'd pick.",
  chips: [],
  ...o,
});
const RAW = {
  headline: "You want a shortlist, a joke, and the last word.",
  observations: [
    obs(),
    obs({ category: "humor", claim: "You joke to keep work from feeling heavy.", evidence: [ev("import", "ok but which one is cheaper lol")], surprise: 0.9, use_in_call: "I'll keep a joke ready, even when we're being practical." }),
    obs({ category: "boundary", claim: "You keep the final say on anything that leaves your hands.", evidence: [ev("import", "Wants to approve anything before it's sent.")], surprise: 0.5, use_in_call: "I'll ask before I act on anything." }),
  ],
  learning: [{ label: "How long you like answers" }],
  usage: "In our calls: two options, my pick, a joke when it fits, and I ask before I act.",
};

test("report: grounded observations are kept, sorted by surprise, with the server's source labels", () => {
  const r = toReport(RAW, INPUTS, { at: "2026-11-04T00:00:00Z", from: "import" });
  assert.equal(r.observations.length, 3);
  assert.deepEqual(r.observations.map((o) => o.category), ["humor", "think", "boundary"]);
  assert.equal(r.observations[0].evidence[0].source_label, "From the reply you pasted");
  assert.equal(r.observations[0].verdict, null);
  assert.ok(r.observations.every((o) => o.id && o.id.length >= 6));
  assert.equal(r.headline, RAW.headline);
  assert.equal(r.usage, RAW.usage);
  assert.deepEqual(r.learning.map((l) => l.label), ["How long you like answers"]);
});

test("report: an import quote that isn't in the pasted text is invented — the observation goes", () => {
  const raw = { ...RAW, observations: [obs({ evidence: [ev("import", "loves hiking every weekend")] }), ...RAW.observations.slice(1)] };
  const r = toReport(raw, INPUTS, { at: "", from: "import" });
  assert.ok(!r.observations.some((o) => o.category === "think"), "no evidence left → dropped");
  // quotes match loosely (case, curly quotes, spacing) but must really be there
  const loose = { ...RAW, observations: [obs({ evidence: [ev("import", "Usually asks  for two or three options")] })] };
  assert.equal(toReport(loose, INPUTS, { at: "", from: "import" }).observations.length, 1);
});

test("report: an answer quote must be one of the user's own picks", () => {
  const raw = { ...RAW, observations: [obs({ evidence: [ev("answer", "Spicy"), ev("answer", "Seafood")] })] };
  const r = toReport(raw, INPUTS, { at: "", from: "answers" });
  assert.deepEqual(r.observations[0].evidence.map((e) => e.quote), ["Spicy"]);
  assert.equal(r.observations[0].evidence[0].source_label, "You picked");
});

test("report: generic horoscope lines, sensitive or creepy inferences and minors' details never show", () => {
  const bad = [
    "You value deep connections with people.",
    "You have a great sense of humor.",
    "You're curious and love learning new things.",
    "You might be struggling with anxiety at night.",
    "You're probably religious, given the late nights.",
    "You seem lonely when you work late.",
    "You're still in high school, so evenings are busy.",
    "You live near the office.",
    "You're single and like it.",
  ];
  for (const claim of bad) assert.ok(insightProblem(claim), `flagged: ${claim}`);
  assert.equal(insightProblem("You decide by comparing, not by being told."), null);
  assert.ok(genericHit("Deep down, you care about others."));
  assert.ok(GENERIC_PHRASES.length >= 30);
  const raw = { ...RAW, observations: [...RAW.observations, ...bad.map((claim) => obs({ claim, surprise: 1 }))] };
  const r = toReport(raw, INPUTS, { at: "", from: "import" });
  assert.equal(r.observations.length, 3);
});

test("report: an echo of the quote is not an insight; low confidence becomes something I'm still learning", () => {
  const echo = obs({ claim: "You often work late at night.", evidence: [ev("import", "Often works late at night.")], surprise: 1 });
  const low = obs({ category: "rhythm", claim: "You do your best thinking after midnight.", confidence: "low", evidence: [ev("import", "Often works late at night.")], surprise: 1 });
  const r = toReport({ ...RAW, observations: [...RAW.observations, echo, low] }, INPUTS, { at: "", from: "import" });
  assert.equal(r.observations.length, 3);
  assert.ok(r.learning.some((l) => /rhythm|day/i.test(l.label)), JSON.stringify(r.learning));
});

test("report: claim / use_in_call shape — 'I think' is the app's, 'I'll …' is required, ≤ 5 kept", () => {
  const many = Array.from({ length: 7 }, (_, i) => obs({ claim: `I think you decide by comparing option ${i}, not by being told.`, surprise: i / 10 }));
  const r = toReport({ ...RAW, observations: many }, INPUTS, { at: "", from: "import" });
  assert.ok(r.observations.length <= 5);
  assert.ok(r.observations.every((o) => o.claim.startsWith("You ")), "the 'I think' prefix is removed");
  const noIll = toReport({ ...RAW, observations: [obs({ use_in_call: "Two options with a pick." })] }, INPUTS, { at: "", from: "import" });
  assert.equal(noIll.observations.length, 0);
  const iWill = toReport({ ...RAW, observations: [obs({ use_in_call: "I will lay out two options." })] }, INPUTS, { at: "", from: "import" });
  assert.equal(iWill.observations[0].use_in_call, "I'll lay out two options.");
});

test("report: a bad headline / usage falls back to safe lines; chips only on taste and interest", () => {
  const raw = { ...RAW, headline: "You value deep connections.", usage: "", observations: [obs({ category: "taste", claim: "You pick clean lines over loud ones, at the table too.", evidence: [ev("answer", "Spicy")], chips: [{ label: "Spicy", polarity: "like" }, { label: "Seafood", polarity: "dislike" }] }), obs({ chips: [{ label: "x", polarity: "like" }] })] };
  // Seafood is grounded by the user's own "don't want" pick (chips must be grounded, Codex r1)
  const r = toReport(raw, { ...INPUTS, picks: [...INPUTS.picks, { question: "Food: you don't want", label: "Seafood" }] }, { at: "", from: "answers" });
  assert.notEqual(r.headline, raw.headline);
  assert.match(r.headline, /^You /);
  assert.match(r.usage, /^In our calls/);
  const taste = r.observations.find((o) => o.category === "taste")!;
  assert.deepEqual(taste.chips, [{ label: "Spicy", polarity: "like" }, { label: "Seafood", polarity: "dislike" }]);
  assert.equal(r.observations.find((o) => o.category === "think")!.chips, undefined);
});

test("settings: the old SUM four lines come from the answers; picks read the server keys", () => {
  const a = { help: "Think with me", relationship: "Trusted partner", presence: ["Warm", "Witty"], challenge: 4, pace: 2, reachOut: 1, never: ["Message anyone for me"] };
  assert.deepEqual(settingsFrom(a), { why: "Think with me", energy: "Warm, Witty", initiative: "Only when asked", never: "Message anyone for me" });
  assert.equal(settingsFrom({ help: "Be there" }).never, "No messages or actions without approval");
  const picks = picksFromAnswers({ ...a, help: "made up", bogus: "x" });
  assert.ok(!picks.some((p) => p.label === "made up" || p.label === "x"));
  assert.ok(picks.some((p) => p.label === "Trusted partner"));
  assert.ok(picks.some((p) => p.label === "Direct-leaning"), JSON.stringify(picks));
});

// ───────── service + routes ─────────

type Req = { schemaName: string; input: unknown; instructions?: string };

function harness(handler: (req: Req) => unknown | Promise<unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "insights-"));
  const store = new FileStore(dir);
  const calls: Req[] = [];
  const json = (async (req: Req) => { calls.push(req); return handler(req); }) as unknown as PrepDeps["spark"];
  const p = new Personalize({ store, json: json! });
  const ins = new Insights({ json: json!, personalize: p, store });
  return { dir, store, p, ins, calls, json, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

const f = (text: string) => ({ text, label: "explicit" as const, scope: "any" });
const CARD = toStyleCard({ sections: { tendencies: [f("Asks for two or three options before deciding.")], communication: [f("Jokes even in work threads.")], response: [], help: [], support: [], interests: [], likes: [], boundaries: [f("Wants to approve anything before it's sent.")], approach: [] }, rules: [], to_confirm: ["Music"] }, "import");

test("service: the import's report is written in the background and saved only after the card is", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = harness(async () => { await gate; return RAW; });
  t.after(h.cleanup);
  const job = h.ins.begin("u1", PASTE);
  job.commit(await h.p.replaceStyle("u1", CARD));
  const pending = await h.ins.get("u1", 0);
  assert.equal(pending.status, "pending");
  release();
  const ready = await h.ins.get("u1", 3000);
  assert.equal(ready.status, "ready");
  assert.equal(ready.report!.observations.length, 3);
  assert.equal((await h.store.getStyle("u1"))!.insights!.observations.length, 3);
  // a cancelled job (the import failed) never writes
  const h2 = harness(() => RAW);
  t.after(h2.cleanup);
  await h2.p.replaceStyle("u1", CARD);
  h2.ins.begin("u1", PASTE).cancel();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await h2.store.getStyle("u1"))!.insights, undefined);
});

test("service: setup answers re-write the report (import text kept in memory only) with settings; verdicts stick", async (t) => {
  const h = harness((req) => (req.schemaName === "insight_report" ? RAW : null));
  t.after(h.cleanup);
  const job = h.ins.begin("u1", PASTE);
  job.commit(await h.p.replaceStyle("u1", CARD));
  await h.ins.get("u1", 3000);
  await h.ins.fromAnswers("u1", { help: "Think with me", relationship: "Trusted partner", presence: ["Warm"] });
  const r = await h.ins.get("u1", 3000);
  assert.equal(r.report!.from, "answers");
  assert.deepEqual(r.report!.settings, { why: "Think with me", energy: "Warm", initiative: "Only when asked", never: "No messages or actions without approval" });
  const second = h.calls.filter((c) => c.schemaName === "insight_report")[1];
  assert.match(String(second.input), /ok but which one is cheaper lol/, "the paste is still the source in this process");
  assert.match(String(second.input), /Think with me/);
  const stored = JSON.stringify(await h.store.getStyle("u1"));
  assert.ok(!stored.includes("Often works late at night"), "the pasted reply itself is never stored");

  const [a, b] = r.report!.observations;
  const right = await h.ins.verdict("u1", a.id, { verdict: "right" });
  assert.equal(right.observations.find((o) => o.id === a.id)!.verdict, "right");
  const no = await h.ins.verdict("u1", b.id, { verdict: "not_me", correction: "I just like choices, I still decide fast." });
  assert.ok(!no.observations.some((o) => o.id === b.id), "not me → removed");
  assert.ok(no.learning.length >= 2, "→ something I'm still learning");
  const card = (await h.store.getStyle("u1"))!;
  assert.equal(card.insights!.denied![0].claim, b.claim);
  // the next write is told what was wrong
  await h.ins.fromAnswers("u1", { help: "Think with me", relationship: "Trusted partner", presence: ["Warm"] });
  await h.ins.get("u1", 3000);
  assert.match(String(h.calls.at(-1)!.input), /I just like choices/);
  await assert.rejects(h.ins.verdict("u1", "nope", { verdict: "right" }), { code: "not_found" });
  await assert.rejects(h.ins.verdict("u1", a.id, { verdict: "maybe" }), { code: "bad_verdict" });

  // the call profile carries what was noticed (not the denied one) and the correction
  const lines = insightProfileLines(card);
  assert.ok(lines.some((l) => l.includes(a.use_in_call)));
  assert.ok(!lines.some((l) => l.includes(b.use_in_call)));
  assert.match(styleProfileText(card), /What I noticed/);
});

test("service: a Spark failure leaves the old report (or none) and GET says so; flag off = no Spark call", async (t) => {
  const h = harness(() => { throw new Error("504"); });
  t.after(h.cleanup);
  await h.p.replaceStyle("u1", CARD);
  const r = await h.ins.get("u1", 3000);
  assert.equal(r.status, "failed");
  assert.equal(r.report, null);
  const off = new Insights({ json: h.json!, personalize: h.p, store: h.store, enabled: false });
  const before = h.calls.length;
  off.begin("u1", PASTE).commit("x");
  assert.equal((await off.get("u1", 0)).status, "none");
  assert.equal(h.calls.length, before);
});

async function http(h: ReturnType<typeof harness>) {
  const d = { metaKey: "k", store: h.store, voices: [], log: () => {}, spark: h.json, personalize: h.p, insights: h.ins } as unknown as PrepDeps;
  const routes = createPrepRoutes(d, {} as PrepRunner);
  const server: Server = createServer((req, res) => void routes.handle(req, res, "u1"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address() as { port: number };
  return { base: `http://127.0.0.1:${a.port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("routes: POST /v1/import starts the report; GET/POST /v1/profile/insights; verdict", async (t) => {
  const IMPORT_RAW = { sections: { tendencies: [f("Asks for options.")], communication: [], response: [], help: [], support: [], interests: [], likes: [], boundaries: [], approach: [] }, rules: [], to_confirm: [] };
  const h = harness((req) => (req.schemaName === "insight_report" ? RAW : req.schemaName === "style_card" ? IMPORT_RAW : { cards: [], topics: [] }));
  t.after(h.cleanup);
  const s = await http(h);
  t.after(s.close);
  const imp = await fetch(`${s.base}/v1/import`, { method: "POST", body: JSON.stringify({ text: PASTE.padEnd(260, " ") }) });
  assert.equal(imp.status, 200);
  const g = (await (await fetch(`${s.base}/v1/profile/insights?wait=3`)).json()) as { status: string; report: { observations: Array<{ id: string }> } };
  assert.equal(g.status, "ready");
  assert.equal(g.report.observations.length, 3);
  const post = await fetch(`${s.base}/v1/profile/insights`, { method: "POST", body: JSON.stringify({ answers: { help: "Be there", relationship: "Close companion", presence: ["Calm"] } }) });
  assert.equal(post.status, 202);
  const bad = await fetch(`${s.base}/v1/profile/insights`, { method: "POST", body: JSON.stringify({ answers: "x" }) });
  assert.equal(bad.status, 400);
  const id = g.report.observations[0].id;
  const v = await fetch(`${s.base}/v1/profile/insights/${id}/verdict`, { method: "POST", body: JSON.stringify({ verdict: "right" }) });
  assert.equal(v.status, 200);
  assert.equal((await fetch(`${s.base}/v1/profile/insights/zzz/verdict`, { method: "POST", body: JSON.stringify({ verdict: "right" }) })).status, 404);
  assert.equal((await fetch(`${s.base}/v1/profile/insights/${id}/verdict`, { method: "POST", body: JSON.stringify({ verdict: "not_me", correction: "x".repeat(400) }) })).status, 400);
});

test("routes: N1–N3 skip starts the report from the picks", async (t) => {
  const h = harness((req) => (req.schemaName === "insight_report" ? { ...RAW, observations: [obs({ category: "taste", claim: "You keep it clean on the rack and bold on the plate.", evidence: [ev("answer", "Minimal"), ev("answer", "Spicy")] })] } : null));
  t.after(h.cleanup);
  const s = await http(h);
  t.after(s.close);
  const r = await fetch(`${s.base}/v1/import/skip`, { method: "POST", body: JSON.stringify({ replies: "Show me options", n3: { clothes: { like: ["Minimal"] }, food: { like: ["Spicy"], no: ["Seafood"] }, chats: { like: ["Jokes"] } } }) });
  assert.equal(r.status, 200);
  const g = (await (await fetch(`${s.base}/v1/profile/insights?wait=3`)).json()) as { status: string; report: { from: string; observations: Array<{ evidence: Array<{ quote: string; source_label: string }> }> } };
  assert.equal(g.status, "ready");
  assert.equal(g.report.from, "skip");
  assert.deepEqual(g.report.observations[0].evidence.map((e) => e.quote), ["Minimal", "Spicy"]);
});

test("report: highlight is a phrase inside its own quote, or nothing", () => {
  const raw = { ...RAW, observations: [obs({ evidence: [{ source: "import", quote: "usually asks for two or three options before deciding", highlight: "Two or three options" }] }), obs({ category: "humor", claim: "You joke to keep work from feeling heavy.", evidence: [{ source: "import", quote: "ok but which one is cheaper lol", highlight: "not in there" }], use_in_call: "I'll keep a joke ready." })] };
  const r = toReport(raw, INPUTS, { at: "", from: "import" });
  assert.equal(r.observations.find((o) => o.category === "think")!.evidence[0].highlight, "two or three options");
  assert.equal(r.observations.find((o) => o.category === "humor")!.evidence[0].highlight, undefined);
});

test("report: the type read (춘식이 r02) — type, strengths, watch-outs, chain tied to kept traits; mix only from picks", () => {
  const raw = {
    ...RAW,
    type: { name: "The Playful Editor", line: "You shortlist options, joke about prices, and keep the final say.", signature: ["Options", "Light", "Final say"], basis: [0, 1, 7] },
    strengths: [{ text: "Two or three options and you're already deciding.", trait: 0 }, { text: "You value deep connections.", trait: 1 }, { text: "Ghost trait strength here.", trait: 9 }],
    watchouts: [{ text: "Two or three options can freeze the whole decision.", fix: "I'll stop at two options and name my favorite.", trait: 0 }, { text: "Menus are your villain origin story.", fix: "Pick one.", trait: 0 }],
    chain: { you_are: "You weigh two or three options before you commit.", so_you: "So you want options, not a lecture.", so_ill: "So I'll bring two options and my favorite." },
  };
  const inputs = { ...INPUTS, picks: [...INPUTS.picks, { question: "How you like replies", label: "Show me options" }, { question: "pace", label: "Quick-leaning" }] };
  const r = toReport(raw, inputs, { at: "", from: "answers" });
  const think = r.observations.find((o) => o.category === "think")!;
  assert.deepEqual(r.type, { name: "The Playful Editor", line: raw.type.line, signature: ["Options", "Light", "Final say"], basis: [think.id, r.observations.find((o) => o.category === "humor")!.id] });
  assert.deepEqual(r.strengths.map((x) => ({ text: x.text, basis: x.basis })), [{ text: "Two or three options and you're already deciding.", basis: think.id }]);
  assert.equal(r.strengths[0].evidence.quote, "usually asks for two or three options before deciding", "each strength carries its receipt");
  assert.ok(r.watchouts.every((w) => w.evidence && w.evidence.quote), "each watch-out carries its receipt");
  assert.deepEqual(r.watchouts.map((w) => w.fix), ["I'll stop at two options and name my favorite."], "a fix must be 'I'll …'");
  assert.equal(r.chain!.so_ill, "So I'll bring two options and my favorite.");
  assert.deepEqual(r.share, { title: "{name} is The Playful Editor", lines: ["Options", "Light", "Final say"] });
  assert.deepEqual(r.mix.map((m) => [m.left, m.right, m.position, m.evidence.quote]), [["Options", "One answer", 1, "Show me options"], ["Reflective", "Quick", 3, "Quick-leaning"]]);
  assert.deepEqual(toReport(raw, INPUTS, { at: "", from: "import" }).mix, [], "no picks for it → no mix row");
  for (const bad of ["The INTJ Strategist", "The Introvert", "The Scorpio Soul", "The Curious Creative", "Playful Editor"]) assert.equal(toReport({ ...raw, type: { ...raw.type, name: bad } }, INPUTS, { at: "", from: "import" }).type, null, bad);
  assert.equal(toReport({ ...raw, type: { ...raw.type, signature: ["Options", "Light"] } }, INPUTS, { at: "", from: "import" }).type, null, "exactly three");
  assert.equal(toReport({ ...raw, observations: [] }, INPUTS, { at: "", from: "import" }).type, null, "no traits → no type");
  assert.equal(toReport({ ...raw, observations: [] }, INPUTS, { at: "", from: "import" }).share, null);
});

// ───────── Codex review round 1 ─────────

test("codex: a profile update (merge) keeps the report, the picks and the not-me list", async () => {
  const { mergeUpdates } = await import("../src/personalize/merge.ts");
  const card = { ...CARD, insights: { ...toReport(RAW, INPUTS, { at: "t", from: "import" }), denied: [{ id: "x", claim: "You hate mornings.", category: "rhythm" as const, at: "t" }] }, picks: [{ question: "q", label: "Spicy" }] };
  const r = mergeUpdates(card, [{ field: "likes", text: "Likes ramen.", label: "explicit" }] as never, "2026-11-04T00:00:00Z");
  assert.ok(r.applied.length);
  assert.equal(r.card.insights!.observations.length, 3);
  assert.equal(r.card.insights!.denied![0].claim, "You hate mornings.");
  assert.deepEqual(r.card.picks, [{ question: "q", label: "Spicy" }]);
});

test("codex: skip picks go through the same privacy filters", () => {
  const picks = picksFromSkip({ interests: ["Design", "synthetic@example.invalid", "my therapist"], replies: "Show me options", n3: { food: { like: ["Spicy"] } } });
  assert.deepEqual(picks.map((p) => p.label), ["Design", "Show me options", "Spicy"]);
});

test("codex: a late import report never lands on the card of a newer import; an older write never lands over a newer one", async (t) => {
  let releaseA!: () => void;
  const gateA = new Promise<void>((r) => (releaseA = r));
  let n = 0;
  const h = harness(async () => { n++; if (n === 1) await gateA; return RAW; });
  t.after(h.cleanup);
  const a = h.ins.begin("u1", PASTE);
  a.commit(await h.p.replaceStyle("u1", CARD));
  await new Promise((r) => setTimeout(r, 5));
  await h.p.replaceStyle("u1", { ...CARD, toConfirm: ["B"] }); // import B replaced the card (its own report job not started here)
  releaseA();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await h.store.getStyle("u1"))!.insights, undefined, "A's report is not B's");

  // answers: the first (slow) write must not land after the second
  let releaseSlow!: () => void;
  const slow = new Promise<void>((r) => (releaseSlow = r));
  let m = 0;
  // keyed by the request (not call order): the first write may now stop before its call (Codex r8 checks)
  const h2 = harness(async (req) => { m++; const old = String(req.input).includes("Think with me"); if (old) await slow; return { ...RAW, headline: old ? "You are the old one." : RAW.headline }; });
  t.after(h2.cleanup);
  await h2.p.replaceStyle("u1", CARD);
  await h2.ins.fromAnswers("u1", { help: "Think with me" });
  await h2.ins.fromAnswers("u1", { help: "Be there" });
  await h2.ins.get("u1", 3000);
  releaseSlow();
  await new Promise((r) => setTimeout(r, 30));
  const ins = (await h2.store.getStyle("u1"))!.insights!;
  assert.equal(ins.settings!.why, "Be there");
  assert.notEqual(ins.headline, "You are the old one.", "the slow older write never landed");
});

test("codex: a 'not me' made while a rewrite runs is not brought back; what was built on it goes", async (t) => {
  let release!: () => void;
  let gated = false;
  const gate = new Promise<void>((r) => (release = r));
  const TYPED = { ...RAW, type: { name: "The Playful Editor", line: "You shortlist options, joke about prices, and keep the final say.", signature: ["Options", "Light", "Final say"], basis: [0] }, strengths: [{ text: "Two or three options and you're already deciding.", trait: 0 }] };
  const h = harness(async () => { if (gated) await gate; return TYPED; });
  t.after(h.cleanup);
  const job = h.ins.begin("u1", PASTE);
  job.commit(await h.p.replaceStyle("u1", CARD));
  const first = (await h.ins.get("u1", 3000)).report!;
  const think = first.observations.find((o) => o.category === "think")!;
  assert.ok(first.type && first.strengths.length === 1);
  gated = true;
  await h.ins.fromAnswers("u1", { help: "Think with me" });
  const after = await h.ins.verdict("u1", think.id, { verdict: "not_me" });
  assert.equal(after.type, null, "the type was built only on it");
  assert.equal(after.share, null);
  assert.equal(after.strengths.length, 0);
  release();
  const r = await h.ins.get("u1", 3000);
  assert.ok(!r.report!.observations.some((o) => o.id === think.id), "the rewrite doesn't bring it back");
});

test("codex: quotes match whole words; creepy quotes and corrections are dropped; chips must be grounded", async (t) => {
  const text = "Dislikes seafood. Often feels lonely after work. Korean food, the spicier the better.";
  const inputs: InsightInputs = { text, findings: [], picks: [{ question: "Food: you like", label: "Spicy" }], source: "import" };
  const half = toReport({ ...RAW, observations: [obs({ evidence: [ev("import", "likes seafood.")] })] }, inputs, { at: "", from: "import" });
  assert.equal(half.observations.length, 0, "'likes seafood' is not in 'Dislikes seafood'");
  const lonely = toReport({ ...RAW, observations: [obs({ evidence: [ev("import", "Often feels lonely after work.")] })] }, inputs, { at: "", from: "import" });
  assert.equal(lonely.observations.length, 0);
  const chips = toReport({ ...RAW, observations: [obs({ category: "taste", claim: "You eat loud and dress quiet on purpose.", evidence: [ev("import", "the spicier the better")], chips: [{ label: "Spicy", polarity: "like" }, { label: "Seafood", polarity: "dislike" }, { label: "Sushi", polarity: "dislike" }, { label: "Spicy", polarity: "dislike" }] })] }, inputs, { at: "", from: "import" });
  assert.deepEqual(chips.observations[0].chips, [{ label: "Spicy", polarity: "like" }, { label: "Seafood", polarity: "dislike" }]);

  const h = harness(() => RAW);
  t.after(h.cleanup);
  const job = h.ins.begin("u1", PASTE);
  job.commit(await h.p.replaceStyle("u1", CARD));
  const r = (await h.ins.get("u1", 3000)).report!;
  await h.ins.verdict("u1", r.observations[0].id, { verdict: "not_me", correction: "I live in Seoul." });
  assert.equal((await h.store.getStyle("u1"))!.insights!.denied![0].correction, undefined);
});

// ───────── Codex review round 2 ─────────

test("codex r2: 'forget that …' takes the traits that cite it out of the report (and the call profile)", () => {
  const LEATHER = "Loves leather accessories and wears a leather jacket every day.";
  const inputs: InsightInputs = { ...INPUTS, text: `${PASTE}\n- ${LEATHER}` };
  const raw = { ...RAW, observations: [...RAW.observations, obs({ category: "taste", claim: "You dress quiet but your jacket does the talking.", evidence: [ev("import", LEATHER)], surprise: 1, use_in_call: "I'll suggest leather accessories that fit your look." })] };
  const r = toReport(raw, inputs, { at: "", from: "import" });
  assert.ok(r.observations.some((o) => /leather/.test(o.use_in_call)));
  const removed = [{ text: "leather accessories", at: "t", forget: true as const }];
  const scrubbed = scrubRemoved(r, removed);
  assert.ok(!JSON.stringify(scrubbed).includes("leather"));
  assert.equal(scrubbed.observations.length, r.observations.length - 1);
  const card = { ...CARD, insights: scrubbed, removed };
  assert.ok(!styleProfileText(card).toLowerCase().includes("leather accessories that"));
});

test("codex r2: 'not me' drops a type built on it; a like chip needs a plain mention; a minor's age is never kept", async (t) => {
  const text = "Dislikes seafood. Korean food, the spicier the better.";
  const inputs: InsightInputs = { text, findings: [], picks: [], source: "import" };
  const like = toReport({ ...RAW, observations: [obs({ category: "taste", claim: "You eat loud and dress quiet on purpose.", evidence: [ev("import", "the spicier the better")], chips: [{ label: "Seafood", polarity: "like" }] })] }, inputs, { at: "", from: "import" });
  assert.equal(like.observations[0].chips, undefined, "'Dislikes seafood' is never a like");

  const TYPED = { ...RAW, type: { name: "The Playful Editor", line: "You shortlist options, joke about prices, and keep the final say.", signature: ["Options", "Light", "Final say"], basis: [0, 1] } };
  const h = harness(() => TYPED);
  t.after(h.cleanup);
  const job = h.ins.begin("u1", PASTE);
  job.commit(await h.p.replaceStyle("u1", CARD));
  const r = (await h.ins.get("u1", 3000)).report!;
  assert.ok(r.type);
  const think = r.observations.find((o) => o.category === "think")!;
  const after = await h.ins.verdict("u1", think.id, { verdict: "not_me", correction: "I'm 15 and I just like choices." });
  assert.equal(after.type, null, "one of its two bases is gone → the type goes");
  assert.equal(after.share, null);
  assert.equal((await h.store.getStyle("u1"))!.insights!.denied![0].correction, undefined, "a minor's age is never stored");
});

test("codex r3: forget also clears the not-me list and stitched lines; a curly-apostrophe age is caught", async (t) => {
  const r = toReport({ ...RAW, headline: "You want two good options and leather everything." }, INPUTS, { at: "", from: "import" });
  const stored = { ...r, denied: [{ id: "x", claim: "You let leather do the talking.", category: "taste" as const, at: "t" }] };
  const scrubbed = scrubRemoved(stored, [{ text: "leather accessories", forget: true }]);
  assert.ok(!JSON.stringify(scrubbed).toLowerCase().includes("leather"), JSON.stringify(scrubbed).slice(0, 200));
  const h = harness(() => RAW);
  t.after(h.cleanup);
  const job = h.ins.begin("u1", PASTE);
  job.commit(await h.p.replaceStyle("u1", CARD));
  const rep = (await h.ins.get("u1", 3000)).report!;
  await h.ins.verdict("u1", rep.observations[0].id, { verdict: "not_me", correction: "I’m 15 and I just like choices." });
  assert.equal((await h.store.getStyle("u1"))!.insights!.denied![0].correction, undefined);
});

test("codex r4: a fact only in a not-me correction is forgotten too (off the list and the call profile)", async (t) => {
  const h = harness(() => RAW);
  t.after(h.cleanup);
  const job = h.ins.begin("u1", PASTE);
  job.commit(await h.p.replaceStyle("u1", CARD));
  const rep = (await h.ins.get("u1", 3000)).report!;
  await h.ins.verdict("u1", rep.observations[0].id, { verdict: "not_me", correction: "I collect fountain pens." });
  assert.match(JSON.stringify((await h.store.getStyle("u1"))!.insights!.denied), /fountain pens/);
  await h.p.voiceCorrection("u1", "Forget about fountain pens.");
  const card = (await h.store.getStyle("u1"))!;
  assert.ok(!/fountain/i.test(JSON.stringify(card.insights!.denied ?? [])), JSON.stringify(card.insights!.denied));
  assert.ok((card.removed ?? []).some((r) => r.forget && /fountain/.test(r.text)), JSON.stringify(card.removed));
});

test("codex r6: forgetting a fact only the report holds removes it from the report and the call profile", async (t) => {
  const FP = "Collects fountain pens and inks every letter by hand.";
  const raw = { ...RAW, observations: [...RAW.observations, obs({ category: "interest", claim: "You write slow on purpose, ink and all.", evidence: [ev("import", FP)], surprise: 1, use_in_call: "I'll ask about your fountain pens." })] };
  const h = harness((req) => (req.schemaName === "insight_report" ? raw : { updates: [], answered: false }));
  t.after(h.cleanup);
  const job = h.ins.begin("u1", `${PASTE}\n- ${FP}`);
  job.commit(await h.p.replaceStyle("u1", CARD));
  const r = (await h.ins.get("u1", 3000)).report!;
  assert.ok(JSON.stringify(r).includes("fountain pens"));
  await h.p.voiceCorrection("u1", "Forget about fountain pens.", "");
  const card = (await h.store.getStyle("u1"))!;
  assert.ok(!JSON.stringify(card.insights).toLowerCase().includes("fountain"), JSON.stringify(card.insights?.observations.map((o) => o.claim)));
  assert.ok(!insightProfileLines(card).join(" ").toLowerCase().includes("fountain"), "not in the call profile's noticed block");
});

test("codex r7: a minor's age never shows ('You're 15 and …'); a forget stops the kept paste from being sent again", async (t) => {
  for (const claim of ["You're 15 and redraw the map every night.", "You’re 16 and plan around practice.", "You're a 14-year-old night planner."]) assert.equal(insightProblem(claim), "minor", claim);
  assert.equal(insightProblem("You keep 2 options open."), null);
  const h = harness(() => RAW);
  t.after(h.cleanup);
  const job = h.ins.begin("u1", PASTE);
  job.commit(await h.p.replaceStyle("u1", CARD));
  await h.ins.get("u1", 3000);
  await h.p.patchStyle("u1", (c) => ({ ...c, removed: [...(c.removed ?? []), { text: "cheaper lol", at: new Date().toISOString(), forget: true as const }] }));
  const n = h.calls.length;
  await h.ins.fromAnswers("u1", { help: "Think with me" });
  await h.ins.get("u1", 3000);
  const sent = h.calls.slice(n).map((c) => String(c.input)).join("\n");
  assert.ok(!sent.includes("which one is cheaper lol"), "the paste is no longer sent after a forget");
});

test("codex r8: a retry after a forget doesn't send the paste again", async (t) => {
  let n = 0;
  let h!: ReturnType<typeof harness>;
  h = harness(async (req) => {
    if (req.schemaName !== "insight_report") return null;
    n++;
    if (n === 2) {
      // the answers write's first call: the user says "forget …" meanwhile, then this call fails
      await h.p.patchStyle("u1", (c) => ({ ...c, removed: [...(c.removed ?? []), { text: "cheaper lol", at: new Date().toISOString(), forget: true as const }] }));
      throw new Error("504");
    }
    return RAW;
  });
  t.after(h.cleanup);
  const job = h.ins.begin("u1", PASTE);
  job.commit(await h.p.replaceStyle("u1", CARD));
  await h.ins.get("u1", 3000); // call 1
  await h.ins.fromAnswers("u1", { help: "Think with me" });
  await h.ins.get("u1", 3000); // call 2 fails; no retry with the paste
  assert.equal(n, 2, "no third call");
});

// ───────── audit 11/4 (AU-21, AU-22, AU-23) ─────────

test("AU-21: headline, type line and chain must reuse a concrete word of the kept traits or picks", () => {
  const raw = {
    ...RAW,
    headline: "You climb mountains every weekend at dawn.",
    type: { name: "The Shortlist Joker", line: "You run marathons and paint watercolors.", signature: ["Options", "Jokes", "Say-so"], basis: [0] },
    chain: { you_are: "You love sailing.", so_you: "So you want sea air.", so_ill: "So I'll bring boat tips." },
  };
  const r = toReport(raw, INPUTS, { at: "", from: "import" });
  assert.equal(r.headline, r.observations[0].claim, "an ungrounded headline falls back to the top trait");
  assert.equal(r.type, null);
  assert.equal(r.chain, null);
  const ok = toReport({ ...raw, chain: { you_are: "You weigh two or three options first.", so_you: "So you want options laid out.", so_ill: "So I'll lay out two options and my pick." } }, INPUTS, { at: "", from: "import" });
  assert.ok(ok.chain);
});

test("AU-22: a 'don't want' pick reads 'You said no to' and never backs a claim that likes it", () => {
  const inputs: InsightInputs = { ...INPUTS, picks: [{ question: "Food: you like", label: "Spicy" }, { question: "Food: you don't want", label: "Seafood" }] };
  const liked = toReport({ ...RAW, observations: [obs({ category: "taste", claim: "You're all in on seafood nights.", evidence: [ev("answer", "Seafood")] })] }, inputs, { at: "", from: "answers" });
  assert.equal(liked.observations.length, 0, "no receipt left → no trait");
  const said = toReport({ ...RAW, observations: [obs({ category: "taste", claim: "You keep the heat and skip the seafood.", evidence: [ev("answer", "Spicy"), ev("answer", "Seafood")] })] }, inputs, { at: "", from: "answers" });
  assert.deepEqual(said.observations[0].evidence.map((e) => e.source_label), ["You picked", "You said no to"]);
});

test("AU-23: the stored profile (with corrections) goes to Spark with the paste, and wins", async () => {
  const { buildInsightRequest } = await import("../src/insights/report.ts");
  const req = buildInsightRequest({ text: PASTE, findings: ["Likes olive green too."], picks: [], source: "import", denied: [{ claim: "Wears only black." }] });
  assert.match(String(req.input), /<pasted_reply>/);
  assert.match(String(req.input), /<profile>[\s\S]*olive green/);
  assert.match(String(req.input), /<not_true>[\s\S]*only black/);
  assert.match(String(req.instructions), /profile wins/);
});

test("AU-21/22 (Codex): one shared word isn't grounding; a 'no' must be about that pick; a flipped like drops the trait", () => {
  const inputs: InsightInputs = { ...INPUTS, picks: [{ question: "Food: you like", label: "Spicy" }, { question: "Food: you don't want", label: "Seafood" }] };
  const r = toReport({ ...RAW, headline: "You finish marathons after spicy dinners." }, inputs, { at: "", from: "answers" });
  assert.notEqual(r.headline, "You finish marathons after spicy dinners.");
  const notAbout = toReport({ ...RAW, observations: [obs({ category: "taste", claim: "You love seafood, not bland dinners.", evidence: [ev("answer", "Seafood")] })] }, inputs, { at: "", from: "answers" });
  assert.equal(notAbout.observations.length, 0);
  const mixed = toReport({ ...RAW, observations: [obs({ category: "taste", claim: "You crave seafood for a fiery dinner.", evidence: [ev("answer", "Spicy"), ev("answer", "Seafood")] })] }, inputs, { at: "", from: "answers" });
  assert.equal(mixed.observations.length, 0, "the whole trait goes, not just the contradicting receipt");
});

test("SY-01: 'Forget all of this' — the quotes go with the profile row, the paste leaves memory, a running write lands nowhere", async (t) => {
  let release!: () => void;
  let gated = false;
  const gate = new Promise<void>((r) => (release = r));
  const h = harness(async () => { if (gated) await gate; return RAW; });
  t.after(h.cleanup);
  const job = h.ins.begin("u1", PASTE);
  job.commit(await h.p.replaceStyle("u1", CARD));
  const r = (await h.ins.get("u1", 3000)).report!;
  assert.ok(r.observations.some((o) => o.evidence.some((e) => e.source === "import")), "quotes stored");
  gated = true;
  await h.ins.fromAnswers("u1", { help: "Think with me" }); // a rewrite is running
  // DELETE /v1/profile: the row goes (FileStore: the style file), then the service forgets
  rmSync(join(h.dir, "styles"), { recursive: true, force: true });
  h.ins.forget("u1");
  release();
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(await h.store.getStyle("u1"), null, "nothing written back");
  // a later card (a new import or skip) never gets the old paste quoted
  await h.p.replaceStyle("u1", CARD);
  const calls = h.calls.length;
  await h.ins.fromAnswers("u1", { help: "Be there" });
  await h.ins.get("u1", 3000);
  const last = h.calls.slice(calls).find((c) => c.schemaName === "insight_report");
  assert.ok(last && !String(last.input).includes("ok but which one is cheaper lol"), "the forgotten paste is not sent again");
});

test("lead 11/4: a strength / watch-out that reuses no word of a quote or pick has no receipt and isn't shown", () => {
  const raw = { ...RAW,
    strengths: [{ text: "You keep calm under pressure, always.", trait: 0 }, { text: "Two or three options and you're already deciding.", trait: 0 }],
    watchouts: [{ text: "You might overcommit on weekends.", fix: "I'll check in before plans.", trait: 1 }] };
  const r = toReport(raw, INPUTS, { at: "", from: "import" });
  assert.deepEqual(r.strengths.map((s) => s.text), ["Two or three options and you're already deciding."]);
  assert.equal(r.watchouts.length, 0, "an empty watch-outs section is fine");
});
