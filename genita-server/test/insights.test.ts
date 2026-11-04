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
  // the lines it was linked to when the report was saved (AU-91)
  const behind = ((await h.store.getStyle("u1"))!.insights!.observations.find((o) => o.id === b.id)!.sources ?? []).map((x) => x.text);
  const no = await h.ins.verdict("u1", b.id, { verdict: "not_me", correction: "I just like choices, I still decide fast." });
  assert.ok(!no.observations.some((o) => o.id === b.id), "not me → removed");
  assert.ok(no.learning.length >= 2, "→ something I'm still learning");
  const card = (await h.store.getStyle("u1"))!;
  assert.equal(card.insights!.denied![0].claim, b.claim);
  // AU-91: the findings it was built from leave the call profile too; the call is told never to bring them up
  assert.ok(behind.length >= 1, `the observation stands on a finding: ${JSON.stringify(b.evidence)}`);
  const left = Object.values(card.sections).flat().map((x) => (x as { text: string }).text);
  for (const t of behind) assert.ok(!left.includes(t), `"${t}" is out of the profile`);
  for (const t of behind) assert.ok(card.removed!.some((r) => r.text === t && !r.forget), `"${t}" is a removed line (not a forget tombstone)`);
  assert.ok(!card.removed!.some((r) => r.text === b.claim), "the claim itself is not (it would block any line sharing a word)");
  assert.ok(!insightProfileLines(card).some((l) => /Not true about them/.test(l)), "never quoted back as 'not true'");
  assert.ok(insightProfileLines(card).some((l) => /I just like choices/.test(l)), "their own words of what is right stay");
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

test("Codex #581 r7: 'forget …' finds a fact that only the report holds (an observation's own words)", async (t) => {
  const h = harness(() => RAW);
  t.after(h.cleanup);
  const job = h.ins.begin("u1", PASTE);
  job.commit(await h.p.replaceStyle("u1", CARD));
  await h.ins.get("u1", 3000);
  // the report alone says it (no profile line about leather)
  const c0 = (await h.store.getStyle("u1"))!;
  const o = c0.insights!.observations[0];
  await h.store.putStyle("u1", { ...c0, insights: { ...c0.insights!, observations: [{ ...o, claim: "You carry leather accessories everywhere" }, ...c0.insights!.observations.slice(1)] } });
  assert.ok(!JSON.stringify(c0.sections).toLowerCase().includes("leather"));
  await h.p.voiceCorrection("u1", "Forget about leather accessories.");
  const card = (await h.store.getStyle("u1"))!;
  assert.ok((card.removed ?? []).some((r) => r.forget && /leather/.test(r.text)), JSON.stringify(card.removed));
  assert.ok(!card.insights!.observations.some((x) => x.id === o.id), "the observation is gone");
});

test("Codex #581 r10: 'not me' on one observation built on a setup pick takes the others built on it", async (t) => {
  const h = harness(() => RAW);
  t.after(h.cleanup);
  const job = h.ins.begin("u1", PASTE);
  job.commit(await h.p.replaceStyle("u1", CARD));
  await h.ins.get("u1", 3000);
  const c0 = (await h.store.getStyle("u1"))!;
  const [a, b, ...rest] = c0.insights!.observations;
  const pick = [{ source: "answer" as const, quote: "Think with me", source_label: "Your setup" }];
  await h.store.putStyle("u1", { ...c0, insights: { ...c0.insights!, observations: [{ ...a, evidence: pick }, { ...b, evidence: pick }, ...rest] } });
  const after = await h.ins.verdict("u1", a.id, { verdict: "not_me" });
  assert.ok(!after.observations.some((o) => o.id === b.id), "the other one on the same pick goes too");
});

test("Codex #581 r8: a fact only in the report's headline is forgettable too", async (t) => {
  const h = harness(() => RAW);
  t.after(h.cleanup);
  const job = h.ins.begin("u1", PASTE);
  job.commit(await h.p.replaceStyle("u1", CARD));
  await h.ins.get("u1", 3000);
  const c0 = (await h.store.getStyle("u1"))!;
  await h.store.putStyle("u1", { ...c0, insights: { ...c0.insights!, headline: "You and your fountain pens, always." } });
  await h.p.voiceCorrection("u1", "Forget about fountain pens.");
  const card = (await h.store.getStyle("u1"))!;
  assert.ok((card.removed ?? []).some((r) => r.forget && /fountain/.test(r.text)), JSON.stringify(card.removed));
  assert.doesNotMatch(card.insights!.headline, /fountain/i);
});

test("AU-91: findingsBehind — a pick takes its labeled finding, a quote its finding; unrelated findings stay", async () => {
  const { findingsBehind } = await import("../src/insights/report.ts");
  const card = { sections: { likes: [{ text: "Food: spicy." }, { text: "Style: Clean, minimal clothes." }], communication: [{ text: "Jokes even in work threads." }] } } as never;
  assert.deepEqual(findingsBehind(card, { claim: "You love spicy food", evidence: [{ source: "answer", quote: "Spicy", source_label: "Your picks" }], chips: [] } as never), ["Food: spicy."]);
  assert.deepEqual(findingsBehind(card, { claim: "You joke around even at work", evidence: [{ source: "import", quote: "jokes even in work threads", source_label: "From the reply you pasted" }], chips: [] } as never), ["Jokes even in work threads."]);
  // Codex #581: a one-word highlight never takes an unrelated finding; an N1 pick takes the line it was written as
  // (communication, not response: the response section is how Genita answers — a setting since link r2)
  const c2 = { sections: { communication: [{ text: "Short, direct replies." }, { text: "Talk it through with me." }], interests: [{ text: "Short films." }] } } as never;
  assert.deepEqual(findingsBehind(c2, { claim: "You like short, direct replies", evidence: [{ source: "import", quote: "short, direct replies", source_label: "x", highlight: "short" }], chips: [] } as never), ["Short, direct replies."]);
  assert.deepEqual(findingsBehind(c2, { claim: "You think out loud", evidence: [{ source: "answer", quote: "Talk it out", source_label: "Your picks" }], chips: [] } as never), ["Talk it through with me."]);
  // Codex #581 r2: N3 "no" picks, chat picks; "short … shorter" is one shared word
  const c3 = { sections: { likes: [{ text: "Dislikes seafood." }, { text: "Dislikes colorful, formal clothes." }], communication: [{ text: "Likes jokes in our chats." }], interests: [{ text: "Short films." }] } } as never;
  assert.deepEqual(findingsBehind(c3, { claim: "You skip seafood", evidence: [{ source: "answer", quote: "Seafood", source_label: "x" }], chips: [] } as never), ["Dislikes seafood."]);
  assert.deepEqual(findingsBehind(c3, { claim: "You keep it light", evidence: [{ source: "answer", quote: "Jokes", source_label: "x" }], chips: [] } as never), ["Likes jokes in our chats."]);
  assert.deepEqual(findingsBehind(c3, { claim: "You want it brief", evidence: [{ source: "import", quote: "I like short replies, the shorter the better.", source_label: "x" }], chips: [] } as never), []);
});

test("AU-91 r3: a list finding loses only the picked item; a single-item finding goes whole", async () => {
  const { editsBehind } = await import("../src/insights/report.ts");
  const card = { sections: { likes: [{ text: "Food: spicy, seafood." }, { text: "Dislikes colorful, formal clothes." }, { text: "Dislikes cilantro." }] } } as never;
  const a = editsBehind(card, { claim: "You love heat", evidence: [{ source: "answer", quote: "Spicy", source_label: "x" }], chips: [] } as never);
  assert.deepEqual([...a.rewrite], [["Food: spicy, seafood.", "Food: seafood."]]);
  assert.deepEqual([...a.drop], []);
  assert.deepEqual(a.picks, ["Spicy"]);
  assert.deepEqual(a.items, ["spicy"]);
  assert.deepEqual(a.removedLines.map((x) => x.text), ["Food: spicy, seafood.", "Food: spicy."], "the original line and the item are removed lines");
  const long = editsBehind({ sections: { interests: [{ text: "Long walks in the mountains." }] } } as never, { claim: "You love long hikes", evidence: [{ source: "answer", quote: "Long walks in the mountains", source_label: "x" }], chips: [] } as never);
  assert.deepEqual(long.picks, ["Long walks in the mountains"], "a long pick leaves card.picks too (Codex #581 r4)");
  assert.deepEqual([...long.drop], ["Long walks in the mountains."], "and its own finding goes (Codex #581 r9)");
  const b = editsBehind(card, { claim: "You keep it casual", evidence: [{ source: "answer", quote: "Formal", source_label: "x" }], chips: [] } as never);
  assert.deepEqual([...b.rewrite], [["Dislikes colorful, formal clothes.", "Dislikes colorful clothes."]]);
  const m = editsBehind({ sections: { likes: [{ text: "Style: Minimal." }] } } as never, { claim: "You keep it simple", evidence: [{ source: "import", quote: "Minimal", source_label: "x" }], chips: [] } as never);
  assert.deepEqual([...m.drop], ["Style: Minimal."], "a paste quote that is exactly the item (Codex #581 r17)");
  const q = editsBehind({ sections: { likes: [{ text: "Food: spicy, seafood." }, { text: "Food: spicy." }] } } as never, { claim: "You like heat", evidence: [{ source: "import", quote: "I like spicy food.", source_label: "x" }], chips: [] } as never);
  assert.deepEqual([...q.rewrite], [["Food: spicy, seafood.", "Food: seafood."]], "an item named inside a paste quote (Codex #581 r23)");
  assert.deepEqual([...q.drop], ["Food: spicy."]);
  assert.ok(q.items.includes("spicy"), "a whole-finding drop records its item too (Codex #581 r24)");
  const c = editsBehind(card, { claim: "You skip cilantro", evidence: [{ source: "answer", quote: "Cilantro", source_label: "x" }], chips: [] } as never);
  assert.deepEqual([...c.drop], ["Dislikes cilantro."]);
});

test("AU-91 r5: a report already being written can't bring a 'not me' pick or item back under another claim", async () => {
  const { standsOnDenied, quoteKey, quoteWords } = await import("../src/insights/service.ts");
  const d = { picks: ["Spicy"], items: ["spicy"] };
  assert.equal(standsOnDenied({ claim: "You like heat in dinner", use_in_call: "I'll pick hot dishes", evidence: [{ source: "answer", quote: "Spicy" }] }, d), true, "the same pick");
  assert.equal(standsOnDenied({ claim: "You want spicy dishes with seafood", use_in_call: "", evidence: [{ source: "import", quote: "seafood" }] }, d), true, "the item named");
  assert.equal(standsOnDenied({ claim: "You love seafood", use_in_call: "I'll suggest fish", evidence: [{ source: "answer", quote: "Seafood" }] }, d), false, "what's left stays");
  assert.equal(standsOnDenied({ claim: "You go clean", use_in_call: "", evidence: [{ source: "import", quote: "Minimal" }] }, { picks: ["Minimal"] }), true, "the same pick cited as an import quote (Codex #581 r21)");
  assert.equal(standsOnDenied({ claim: "You keep things brief", use_in_call: "", evidence: [{ source: "import", quote: "Prefers short, direct replies." }] }, { quotes: [quoteWords("Prefers short, direct replies.")] }), true, "the same paste quote, reworded claim (Codex #581 r12)");
  assert.equal(standsOnDenied({ claim: "You keep it tight", use_in_call: "", evidence: [{ source: "import", quote: "short, direct replies" }] }, { quotes: [quoteWords("Prefers short, direct replies when deciding.")] }), true, "a narrower quote of the same words (Codex #581 r15)");
  assert.equal(standsOnDenied({ claim: "You enjoy heat", use_in_call: "", evidence: [{ source: "import", quote: "I enjoy spicy food." }] }, { quotes: [quoteWords("spicy food")] }), true, "a wider quote of a short denied one (Codex #581 r16)");
  assert.equal(standsOnDenied({ claim: "You love nature films", use_in_call: "", evidence: [{ source: "import", quote: "I like to watch nature documentaries." }] }, { quotes: [quoteWords("I like to cook spicy food.")] }), false, "sharing 'I like to' is not the same evidence (Codex #581 r16)");
  assert.equal(quoteKey("Prefers short, direct answers."), quoteKey("Prefers short direct answers"), "punctuation-blind (Codex #581 r13)");
});

test("AU-91 r6: a removed line (not a forget) never takes the 'not me' record or its correction", () => {
  const r = toReport(RAW, INPUTS, { at: "", from: "import" });
  const stored = { ...r, denied: [{ id: "x", claim: "You want the answer first.", category: "talk" as const, at: "t", correction: "I prefer a detailed explanation first.", picks: ["Start with the answer"] }] };
  const kept = scrubRemoved(stored, [{ text: "Start with the answer, then explain." }]);
  assert.equal(kept.denied?.length, 1);
  assert.equal(kept.denied?.[0].correction, "I prefer a detailed explanation first.");
  const forgot = scrubRemoved(stored, [{ text: "detailed explanation", forget: true }]);
  assert.equal(forgot.denied?.length, 0, "an explicit forget still clears it");
  const byPick = scrubRemoved({ ...r, denied: [{ id: "y", claim: "You love heat", category: "taste" as const, at: "t", picks: ["Spicy"], items: ["spicy"] }] }, [{ text: "spicy", forget: true }]);
  assert.equal(byPick.denied?.length, 0, "a forget of the pick clears the record that only held it (Codex #581 r14)");
});

test("Codex #581 r11: rulesBehind takes the 'When …' rule that says the same, not others", async () => {
  const { rulesBehind } = await import("../src/insights/report.ts");
  const rules = [{ when: "When deciding", then: "keep replies short and direct", label: "explicit" }, { when: "When they're stressed", then: "slow down and check in", label: "explicit" }];
  const o = { claim: "You want short, direct replies", evidence: [{ source: "import", quote: "Prefers short, direct replies.", source_label: "x" }] } as never;
  assert.deepEqual(rulesBehind(rules, o, ["Prefers short, direct replies."]).map((r) => r.then), ["keep replies short and direct"]);
});

test("Codex #581 r18: a word overlap never takes an approval boundary or rule", async () => {
  const { findingsBehind, rulesBehind } = await import("../src/insights/report.ts");
  const card = { sections: { help: [{ text: "Likes help drafting messages and emails." }], boundaries: [{ text: "Never send messages or emails without my approval." }] } } as never;
  const o = { claim: "You like help drafting messages", evidence: [{ source: "import", quote: "Likes help drafting messages and emails.", source_label: "x" }], chips: [] } as never;
  assert.deepEqual(findingsBehind(card, o), [], "the help section is a setting: never removed by a 'not me', even quoted whole (link r1)");
  assert.deepEqual(rulesBehind([{ when: "When messages or emails are ready", then: "never send without my approval", label: "explicit" }], o, ["Likes help drafting messages and emails."]), []);
  const o2 = { claim: "You draft emails with help", evidence: [{ source: "import", quote: "Draft emails with me before sending them.", source_label: "x" }], chips: [] } as never;
  assert.deepEqual(rulesBehind([{ when: "When drafting messages", then: "never include private screen contents", label: "explicit" }], { claim: "You draft messages", evidence: [{ source: "import", quote: "Likes help to draft messages.", source_label: "x" }] } as never, []), [], "a protective rule stays (Codex #581 r20)");
  assert.deepEqual(rulesBehind([{ when: "When answering clients", then: "redact screen contents from outgoing messages", label: "explicit" }], { claim: "You answer clients", evidence: [{ source: "import", quote: "answering clients", source_label: "x" }] } as never, []), [], "a specific When, a privacy rule (Codex #581 r34)");
  assert.deepEqual(rulesBehind([{ when: "When I say yes", then: "send drafted messages", label: "explicit" }], { claim: "You send drafts", evidence: [{ source: "import", quote: "send drafted messages", source_label: "x" }] } as never, []), [], "a rule on what they do stays (Codex #581 r33)");
  assert.deepEqual(rulesBehind([{ when: "When I give the go-ahead", then: "send drafted messages", label: "explicit" }], { claim: "You send drafts", evidence: [{ source: "import", quote: "send drafted messages", source_label: "x" }] } as never, []), [], "a gate in the When part (Codex #581 r32)");
  assert.deepEqual(rulesBehind([{ when: "When drafting", then: "keep drafted messages confidential", label: "explicit" }], { claim: "You keep drafts", evidence: [{ source: "import", quote: "I keep drafted messages.", source_label: "x" }] } as never, []), [], "confidential (Codex #581 r31)");
  assert.deepEqual(rulesBehind([{ when: "When drafting messages", then: "require clearance to send", label: "explicit" }], { claim: "You like help drafting", evidence: [{ source: "import", quote: "Help drafting messages.", source_label: "x" }] } as never, ["Help drafting messages."]), [], "a separate condition on the same topic stays (Codex #581 r25)");
  for (const then of ["get my consent before sending", "confirm with me before sending", "check with me first", "get authorization first"]) assert.deepEqual(rulesBehind([{ when: "When drafting emails", then, label: "explicit" }], o2, []), [], then);
});

test("Codex #581 r26: an approval line in any section never goes on a word overlap", async () => {
  const { findingsBehind } = await import("../src/insights/report.ts");
  const card = { sections: { help: [{ text: "Never send messages or emails without my approval." }], boundaries: [{ text: "Never send messages or emails without my approval." }] } } as never;
  assert.deepEqual(findingsBehind(card, { claim: "You live in your inbox", evidence: [{ source: "import", quote: "messages or emails", source_label: "x" }], chips: [] } as never), []);
  const c2 = { sections: { help: [{ text: "Ask for approval before sending messages and emails." }] } } as never;
  assert.deepEqual(findingsBehind(c2, { claim: "You like drafting help", evidence: [{ source: "import", quote: "I like help drafting emails.", source_label: "x" }], chips: [] } as never), [], "not via an item inside a quote either (Codex #581 r27)");
  assert.deepEqual(findingsBehind({ sections: { help: [{ text: "Likes help drafting messages." }, { text: "Only send drafted messages with my go-ahead." }] } } as never, { claim: "You like drafting help", evidence: [{ source: "import", quote: "help drafting messages", source_label: "x" }], chips: [] } as never), [], "the help section only changes on an exact link (Codex #581 r29)");
  assert.deepEqual(findingsBehind({ sections: { response: [{ text: "Keep screen contents out of replies." }] } } as never, { claim: "You share your screen a lot", evidence: [{ source: "import", quote: "screen contents", source_label: "x" }], chips: [] } as never), [], "a partial quote never takes a longer line (Codex #581 r35)");
  assert.deepEqual(findingsBehind({ sections: { response: [{ text: "Keep screen contents out of replies." }] } } as never, { claim: "You share your screen a lot", evidence: [{ source: "import", quote: "screen contents out of replies", source_label: "x" }], chips: [] } as never), [], "an 'out of' line is a gate (Codex #581 r36)");
  assert.deepEqual(findingsBehind({ sections: { response: [{ text: "Keep replies free of screen contents." }] } } as never, { claim: "You explain screen contents through your replies.", evidence: [{ source: "import", quote: "screen contents", source_label: "x" }], chips: [] } as never), [], "the model's claim never decides (Codex #581 r37)");
  assert.deepEqual(findingsBehind({ sections: { response: [{ text: "Keep replies free of screen contents." }] } } as never, { claim: "You narrate your screen", evidence: [{ source: "import", quote: "I describe screen contents in replies.", source_label: "x" }], chips: [] } as never), [], "no partial match removes a line (Codex #581 r38)");
  assert.deepEqual(findingsBehind({ sections: { response: [{ text: "No private details in drafted messages." }] } } as never, { claim: "You draft a lot", evidence: [{ source: "import", quote: "drafted messages", source_label: "x" }], chips: [] } as never), [], "'No …' and privacy lines (Codex #581 r30)");
  assert.deepEqual(findingsBehind({ sections: { help: [{ text: "Send messages only after I authorize them." }] } } as never, { claim: "You send lots", evidence: [{ source: "import", quote: "sending messages", source_label: "x" }], chips: [] } as never), [], "authorize / only after (Codex #581 r28)");
});

test("AU-91 link model: a saved observation links its lines; 'not me' removes exactly those; settings are never linked", async () => {
  const { linkSources, editsFromSources } = await import("../src/insights/report.ts");
  const card = { sections: {
    likes: [{ text: "Food: spicy, seafood." }, { text: "Style: Minimal." }],
    response: [{ text: "Keep replies free of screen contents." }],
    communication: [{ text: "Short, direct replies." }],
    help: [{ text: "Help drafting messages." }],
  } } as never;
  const o = (evidence: Array<{ source: string; quote: string }>, basis?: string[]) => ({ evidence: evidence.map((e) => ({ ...e, source_label: "x" })), chips: [], ...(basis ? { basis } : {}) }) as never;
  // cited by Spark (skip / card path), said whole, a list item by its pick
  assert.deepEqual(linkSources(card, o([{ source: "import", quote: "screen contents" }], ["Short, direct replies."])), [{ section: "communication", text: "Short, direct replies." }]);
  assert.deepEqual(linkSources({ sections: { response: [{ text: "Anonymize names in replies." }] } } as never, o([{ source: "import", quote: "Anonymize names in replies." }])), [], "how Genita answers is a setting (Codex link r2)");
  assert.deepEqual(linkSources(card, o([{ source: "answer", quote: "Spicy" }])), [{ section: "likes", text: "Food: spicy, seafood.", item: "spicy" }]);
  // a gate / privacy line or an operational section is never linked, even when cited or quoted whole
  assert.deepEqual(linkSources(card, o([{ source: "import", quote: "Keep replies free of screen contents." }], ["Keep replies free of screen contents.", "Help drafting messages."])), []);
  // a partial quote links nothing
  assert.deepEqual(linkSources(card, o([{ source: "import", quote: "screen contents" }])), []);
  // removal by the link
  const e = editsFromSources(card, { evidence: [], chips: [], sources: [{ section: "likes", text: "Food: spicy, seafood.", item: "spicy" }] } as never);
  assert.deepEqual([...e.rewrite], [["Food: spicy, seafood.", "Food: seafood."]]);
  assert.deepEqual(e.items, ["spicy"]);
  // a line changed since (a correction) is left alone
  assert.equal(editsFromSources(card, { evidence: [], chips: [], sources: [{ section: "likes", text: "Food: spicy." }] } as never).drop.size, 0);
});

test("AU-91 link model: Spark's based_on numbers map to the profile lines it was shown (skip path only)", async () => {
  const { toReport, buildInsightRequest } = await import("../src/insights/report.ts");
  const inputs = { findings: ["Prefers short, direct replies.", "Food: spicy."], picks: [], source: "skip" as const };
  assert.match(String(buildInsightRequest(inputs).input), /1\. Prefers short, direct replies\.\n2\. Food: spicy\./);
  const raw = { ...RAW, observations: (RAW as { observations: Array<Record<string, unknown>> }).observations.map((x) => ({ ...x, based_on: [1, 9] })) };
  const r = toReport(raw, { ...INPUTS, findings: inputs.findings, text: undefined }, { at: "", from: "skip" });
  for (const ob of r.observations) assert.ok(!ob.basis || ob.basis.every((b) => inputs.findings.includes(b)), JSON.stringify(ob.basis));
});

test("AU-91 link model r1: a cited list links only named items; links follow a rewrite; an edit stays in its section", async (t) => {
  const { linkSources } = await import("../src/insights/report.ts");
  const card = { sections: { likes: [{ text: "Food: spicy, seafood." }] } } as never;
  assert.deepEqual(linkSources(card, { evidence: [{ source: "answer", quote: "Spicy", source_label: "x" }], chips: [], basis: ["Food: spicy, seafood."] } as never), [{ section: "likes", text: "Food: spicy, seafood.", item: "spicy" }], "the cited list: only the named item");
  // two observations on one list, denied one after the other
  const h = harness(() => RAW);
  t.after(h.cleanup);
  const job = h.ins.begin("u1", PASTE);
  job.commit(await h.p.replaceStyle("u1", CARD));
  await h.ins.get("u1", 3000);
  const c0 = (await h.store.getStyle("u1"))!;
  const [a, b, ...rest] = c0.insights!.observations;
  const likes = [{ text: "Food: spicy, seafood.", label: "explicit", scope: "any" }];
  await h.store.putStyle("u1", { ...c0, sections: { ...c0.sections, likes, response: [...c0.sections.response, { text: "Food: spicy, seafood.", label: "explicit", scope: "any" }] } as never,
    insights: { ...c0.insights!, observations: [{ ...a, sources: [{ section: "likes", text: "Food: spicy, seafood.", item: "spicy" }] }, { ...b, sources: [{ section: "likes", text: "Food: spicy, seafood.", item: "seafood" }] }, ...rest] } });
  await h.ins.verdict("u1", a.id, { verdict: "not_me" });
  let card1 = (await h.store.getStyle("u1"))!;
  assert.deepEqual(card1.sections.likes.map((f) => f.text), ["Food: seafood."]);
  assert.ok(card1.sections.response.some((f) => f.text === "Food: spicy, seafood."), "the same words in another section stay");
  assert.equal(card1.insights!.observations.find((o) => o.id === b.id)?.sources?.[0].text, "Food: seafood.", "b's link follows the rewrite");
  await h.ins.verdict("u1", b.id, { verdict: "not_me" });
  card1 = (await h.store.getStyle("u1"))!;
  assert.deepEqual(card1.sections.likes.map((f) => f.text), [], "the second 'not me' still finds its line");
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

test("eval 11/4: reading them against themselves is creepy — counts of how often, 'says X then does Y anyway'", () => {
  for (const s of ["You order serious, then send memes anyway.", "You asked for sneaker help six times.", "You say no jokes but still send memes."]) assert.equal(insightProblem(s), "creepy", s);
  assert.equal(insightProblem("You ask for two or three options, then decide fast."), null, "an ordinary 'then' is fine");
  assert.equal(insightProblem("You decide by comparing, not by being told."), null);
  assert.equal(insightProblem("You keep the final say on anything that leaves your hands."), null);
});

test("settings lane Codex: after 'forget about seafood' the N3 pick isn't sent to Spark again", async (t) => {
  const h = harness(() => RAW);
  t.after(h.cleanup);
  await h.p.replaceStyle("u1", { ...CARD, source: "skip", picks: [{ question: "Food: you don't want", label: "Seafood" }, { question: "Food: you like", label: "Spicy" }], removed: [{ text: "seafood", at: new Date(Date.now() - 60_000).toISOString(), forget: true }] });
  await h.ins.fromAnswers("u1", { help: "Think with me" });
  await h.ins.get("u1", 3000);
  const sent = String(h.calls.find((c) => c.schemaName === "insight_report")!.input);
  assert.ok(!/seafood/i.test(sent), sent.slice(0, 300));
  assert.match(sent, /Spicy/);
});

test("Codex r12: a real 'forget about seafood' (voice path) leaves nothing about seafood in what goes to Spark", async (t) => {
  const h = harness((req) => (req.schemaName === "insight_report" ? RAW : { updates: [], answered: false }));
  t.after(h.cleanup);
  const card = toStyleCard({ sections: { tendencies: [f("Asks for two or three options before deciding.")], communication: [], response: [], help: [], support: [], interests: [], likes: [f("Dislikes seafood."), f("Food: spicy.")], boundaries: [], approach: [] }, rules: [], to_confirm: [] }, "skip");
  await h.p.replaceStyle("u1", { ...card, picks: [{ question: "Food: you don't want", label: "Seafood" }, { question: "Food: you like", label: "Spicy" }] });
  await h.p.voiceCorrection("u1", "Forget about seafood.", "");
  const n = h.calls.length;
  await new Promise((r) => setTimeout(r, 1100)); // the write starts after the forget
  await h.ins.fromAnswers("u1", { help: "Think with me" });
  await h.ins.get("u1", 3000);
  const sent = h.calls.slice(n).filter((c) => c.schemaName === "insight_report").map((c) => String(c.input)).join("\n");
  assert.ok(sent.length > 0, "a write went out");
  assert.ok(!/seafood/i.test(sent), sent.slice(0, 400));
});

test("design-lane Codex: a trait resting on a line the user marked wrong leaves the call profile at once (pending or saved)", () => {
  const r = toReport(RAW, INPUTS, { at: "", from: "import" });
  const humor = r.observations.find((o) => o.category === "humor")!;
  const pending = { ...CARD, insights: r, pendingCorrections: [{ cardId: "talk", items: ["ok but which one is cheaper lol"], text: "", asOf: "t" }] };
  assert.ok(!insightProfileLines(pending).some((l) => l.includes(humor.use_in_call)));
  const saved = { ...CARD, insights: r, removed: [{ text: "Jokes even in work threads.", at: "t" }] };
  assert.ok(!insightProfileLines(saved).some((l) => l.includes(humor.use_in_call)));
  assert.ok(insightProfileLines(saved).some((l) => l.includes(r.observations.find((o) => o.category === "think")!.use_in_call)), "the others stay");
});

test("demo P0: setup answers land on the stored report at once (settings, mix, refreshing); the slow rewrite is quick-mode and clears it", async (t) => {
  let release!: () => void;
  let gated = false;
  const gate = new Promise<void>((r) => (release = r));
  const h = harness(async (req) => { if (gated) await gate; return req.schemaName === "insight_report" ? RAW : null; });
  t.after(h.cleanup);
  const job = h.ins.begin("u1", PASTE);
  job.commit(await h.p.replaceStyle("u1", CARD));
  await h.ins.get("u1", 3000);
  gated = true;
  const t0 = Date.now();
  await h.ins.fromAnswers("u1", { help: "Be there", relationship: "Close companion", presence: ["Warm"], challenge: 2, pace: 4 });
  const now = await h.ins.get("u1", 0);
  assert.ok(Date.now() - t0 < 500, "no wait for Spark");
  assert.equal(now.report!.settings!.why, "Be there");
  assert.ok(now.report!.mix.some((m) => m.id === "pace"), "Your mix from the answers");
  assert.equal(now.report!.refreshing, true);
  await new Promise((r) => setTimeout(r, 30)); // the rewrite reads the card, then sends
  const sent = h.calls.filter((c) => c.schemaName === "insight_report").at(-1)!;
  assert.equal((sent as unknown as { effort?: string }).effort, "minimal", "quick rewrite");
  release();
  const done = await h.ins.get("u1", 3000);
  assert.equal(done.status, "ready");
  assert.ok(!done.report!.refreshing);

  // a failed rewrite also clears "refreshing" (the app stops waiting)
  const h2 = harness(async (req) => { if (req.schemaName === "insight_report" && h2calls++ > 0) throw new Error("504"); return RAW; });
  let h2calls = 0;
  t.after(h2.cleanup);
  const j2 = h2.ins.begin("u1", PASTE);
  j2.commit(await h2.p.replaceStyle("u1", CARD));
  await h2.ins.get("u1", 3000);
  await h2.ins.fromAnswers("u1", { help: "Be there" });
  await h2.ins.get("u1", 3000);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!(await h2.store.getStyle("u1"))!.insights!.refreshing);
});

test("demo P0 #1 (Codex P2): an older write failing while new answers land doesn't clear their 'refreshing'", async (t) => {
  let failOld!: () => void;
  const oldGate = new Promise<void>((r) => (failOld = r));
  let n = 0;
  let releaseNew!: () => void;
  const newGate = new Promise<void>((r) => (releaseNew = r));
  const h = harness(async (req) => {
    if (req.schemaName !== "insight_report") return null;
    const k = n++;
    if (k === 0) return RAW; // the import's report
    if (k === 1) { await oldGate; throw new Error("504"); } // the first answers' rewrite: fails late
    await newGate; return RAW; // the second answers' rewrite
  });
  t.after(h.cleanup);
  const job = h.ins.begin("u1", PASTE);
  job.commit(await h.p.replaceStyle("u1", CARD));
  await h.ins.get("u1", 3000);
  await h.ins.fromAnswers("u1", { help: "Be there" });
  await new Promise((r) => setTimeout(r, 30));
  // the old write fails while the new answers are being saved
  const second = h.ins.fromAnswers("u1", { help: "Be there", pace: 4 });
  failOld();
  await second;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await h.ins.get("u1", 0)).report!.refreshing, true, "still adding the newer answers");
  releaseNew();
  const done = await h.ins.get("u1", 3000);
  assert.ok(!done.report!.refreshing);
  assert.equal(h.calls.filter((c) => c.schemaName === "insight_report").length, 3, "one rewrite per answers POST, no second try");
});

test("demo P0 #2: 'Not quite' / Remove takes the profile lines the trait rests on out of the call profile", async (t) => {
  const SOUP = "Loves tomato soup on rainy days.";
  const card = toStyleCard({ sections: { tendencies: [f("Asks for two or three options before deciding.")], communication: [f("Jokes even in work threads.")], response: [], help: [], support: [], interests: [], likes: [f(SOUP), f("Style: Clean, minimal clothes.")], boundaries: [], approach: [] }, rules: [], to_confirm: [] }, "import");
  const raw = { ...RAW, observations: [...RAW.observations, obs({ category: "taste", claim: "You make rain an excuse for soup.", evidence: [ev("import", "tomato soup on rainy days")], surprise: 1, use_in_call: "I'll bring up soup when it rains." })] };
  const h = harness(() => raw);
  t.after(h.cleanup);
  const job = h.ins.begin("u1", `${PASTE}\n- ${SOUP}`);
  job.commit(await h.p.replaceStyle("u1", card));
  const r = (await h.ins.get("u1", 3000)).report!;
  const soup = r.observations.find((o) => /soup/.test(o.claim))!;
  assert.match(styleProfileText((await h.store.getStyle("u1"))!), /tomato soup/);
  await h.ins.verdict("u1", soup.id, { verdict: "not_me" });
  const after = (await h.store.getStyle("u1"))!;
  assert.ok(!after.sections.likes.some((x) => /tomato/.test(x.text)), "the source line left the profile");
  assert.ok(!/tomato soup on rainy/i.test(styleProfileText(after).split("Never bring")[0]), "not a fact in the call profile");
  assert.ok(after.sections.likes.some((x) => /Clean, minimal/.test(x.text)), "other lines stay");
  assert.ok(after.sections.tendencies.length === 1, "an unrelated section stays");
});

test("demo P0 #1 (Codex P2): a 'refreshing' flag left by a restart (no write running) is cleared on read", async (t) => {
  const h = harness(() => RAW);
  t.after(h.cleanup);
  const job = h.ins.begin("u1", PASTE);
  job.commit(await h.p.replaceStyle("u1", CARD));
  await h.ins.get("u1", 3000);
  // a restart: the flag is stored, no write runs
  await h.p.patchStyle("u1", (c) => ({ ...c, insights: { ...c.insights!, refreshing: true } }));
  const fresh = new Insights({ json: h.json!, personalize: h.p, store: h.store });
  const r = await fresh.get("u1", 0);
  assert.equal(r.report!.refreshing, false);
  assert.ok(!(await h.store.getStyle("u1"))!.insights!.refreshing);
});

test("demo P0 #2 (Codex r3): a quoted phrase two profile lines share links neither", async () => {
  const { linkSources } = await import("../src/insights/report.ts");
  const card = toStyleCard({ sections: { tendencies: [], communication: [], response: [], help: [], support: [], interests: [], likes: [f("Loves tomato soup on rainy days."), f("Reads science fiction on rainy days.")], boundaries: [], approach: [] }, rules: [], to_confirm: [] }, "import");
  const links = linkSources(card, { evidence: [ev("import", "tomato soup"), ev("import", "on rainy days")], chips: [] } as never);
  assert.ok(!links.some((l) => /science fiction/.test(l.text)), "the unrelated line isn't linked");
  const one = linkSources(card, { evidence: [ev("import", "tomato soup on rainy days")], chips: [] } as never);
  assert.deepEqual(one.map((l) => l.text), ["Loves tomato soup on rainy days."]);
});

test("Codex #581 recut P1: a report saved with no linked lines (sources: []) still takes the quoted list item out of the call profile", async (t) => {
  const h = harness(() => RAW);
  t.after(h.cleanup);
  const job = h.ins.begin("u1", PASTE);
  job.commit(await h.p.replaceStyle("u1", CARD));
  await h.ins.get("u1", 3000);
  const c0 = (await h.store.getStyle("u1"))!;
  const [a, ...rest] = c0.insights!.observations;
  const likes = [{ text: "Food: spicy, seafood.", label: "explicit", scope: "any" }];
  const quoted = { ...a, claim: "You love spicy food", chips: [], evidence: [{ source: "import", quote: "I like spicy food.", source_label: "From the reply you pasted" }], sources: [] };
  await h.store.putStyle("u1", { ...c0, sections: { ...c0.sections, likes } as never, insights: { ...c0.insights!, observations: [quoted, ...rest] } as never });
  await h.ins.verdict("u1", a.id, { verdict: "not_me" });
  const card1 = (await h.store.getStyle("u1"))!;
  assert.deepEqual(card1.sections.likes.map((f) => f.text), ["Food: seafood."], "spicy leaves the call profile");
});

test("Codex #581 recut r2 P1: a list item named inside a paste quote is linked too, next to another linked line", async () => {
  const { linkSources } = await import("../src/insights/report.ts");
  const card = { sections: { likes: [{ text: "Food: spicy, seafood." }, { text: "Style: Minimal." }] } } as never;
  const got = linkSources(card, { evidence: [{ source: "import", quote: "I like spicy food.", source_label: "x" }, { source: "answer", quote: "Minimal", source_label: "x" }], chips: [] } as never);
  assert.deepEqual(got, [{ section: "likes", text: "Food: spicy, seafood.", item: "spicy" }, { section: "likes", text: "Style: Minimal." }]);
});

test("Codex #581 recut r3 P1: a one-item line named inside a paste quote is linked too", async () => {
  const { linkSources } = await import("../src/insights/report.ts");
  const card = { sections: { likes: [{ text: "Food: spicy." }, { text: "Style: Minimal." }] } } as never;
  const got = linkSources(card, { evidence: [{ source: "import", quote: "I like spicy food.", source_label: "x" }, { source: "answer", quote: "Minimal", source_label: "x" }], chips: [] } as never);
  assert.deepEqual(got, [{ section: "likes", text: "Food: spicy." }, { section: "likes", text: "Style: Minimal." }]);
});
