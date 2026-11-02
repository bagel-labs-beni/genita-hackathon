/**
 * Lane 개인화 service + REST: story in parallel with the import, skip users'
 * story, "That's not me" corrections, first-call asks, voice corrections and
 * post-call growth. Spark is faked (structured calls keyed by schema name).
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
import { toStyleCard, type StyleCard } from "../src/prep/importProfile.ts";

type Req = { schemaName: string; input: unknown; instructions?: string };
type Handler = (req: Req) => unknown | Promise<unknown>;

const f = (text: string, label: "explicit" | "observed" = "explicit") => ({ text, label, scope: "any" });
const IMPORT_RAW = {
  sections: {
    tendencies: [f("Compares two concrete options before deciding.", "observed")],
    communication: [f("Warm, direct and informal.")],
    response: [f("Short answers first.")],
    help: [f("Find things that fit my style.")],
    support: [],
    interests: [f("Visual design.")],
    likes: [f("Style: Clean, minimal clothes."), f("Dislikes cilantro.")],
    boundaries: [f("Ask before acting.")],
    approach: [],
  },
  rules: [],
  to_confirm: ["Reminder frequency", "Favorite shows", "Weekend rhythm", "Music"],
};
const card = (id: string, headline: string, o: Record<string, unknown> = {}) => ({ id, headline, items: [{ text: `You ${id} like this.`, evidence: "explicit" }], promise: "So I'll keep that in mind.", evidence: "explicit", tags: id === "taste" ? [{ group: "style", text: "Clean, minimal", dislike: false }] : [], help: id === "help" ? [{ label: "Find things for me", sub: "Two picks", mode: "just_do_it" }] : [], ...o });
const STORY_RAW = { cards: ["think", "talk", "taste", "help", "lines"].map((id) => card(id, `${id} headline.`)), topics: [] };

function harness(handler: Handler) {
  const dir = mkdtempSync(join(tmpdir(), "personalize-"));
  const store = new FileStore(dir);
  const calls: Req[] = [];
  const json = (async (req: Req) => {
    calls.push(req);
    return handler(req);
  }) as unknown as PrepDeps["spark"];
  const logs: Array<[string, Record<string, unknown>]> = [];
  const p = new Personalize({ store, json: json!, log: (e, d) => logs.push([e, d]) });
  return { dir, store, p, calls, logs, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function http(p: Personalize, store: FileStore, handlerJson: PrepDeps["spark"]) {
  const d = { metaKey: "k", falKey: null, elevenKey: "", ttsModel: "", store, voices: [], log: () => {}, spark: handlerJson, personalize: p } as unknown as PrepDeps;
  const routes = createPrepRoutes(d, {} as PrepRunner);
  const server: Server = createServer((req, res) => void routes.handle(req, res, "u1"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address() as { port: number };
  return { base: `http://127.0.0.1:${a.port}`, close: () => new Promise<void>((r) => server.close(() => r())), routes };
}

const PASTE = `1. Thinking style\n- Compares two options. [Observed]\n\n2. Communication style\n- Warm, direct and informal. [Explicit]\n\n7. Likes and dislikes\n- Dislikes cilantro. [Explicit]\n- Clean, minimal clothes. [Explicit]\n\n10. Preferences still to confirm\n- Reminder frequency`.padEnd(260, " ");

test("import: the story is written in parallel with the parse (no extra wait) and comes back with the style", async (t) => {
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = harness(async (req) => {
    started.push(req.schemaName);
    if (started.length === 2) release();
    await gate; // neither finishes before both started
    return req.schemaName === "style_card" ? IMPORT_RAW : STORY_RAW;
  });
  t.after(h.cleanup);
  const srv = await http(h.p, h.store, (async (req: Req) => { started.push(req.schemaName); if (started.length === 2) release(); await gate; return req.schemaName === "style_card" ? IMPORT_RAW : STORY_RAW; }) as unknown as PrepDeps["spark"]);
  t.after(srv.close);
  const r = await fetch(`${srv.base}/v1/import`, { method: "POST", body: JSON.stringify({ text: PASTE }) });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { story: Array<{ id: string; headline: string; items: Array<{ text: string }> }> | null; style: StyleCard };
  assert.deepEqual(started.sort(), ["story_cards", "style_card"]);
  assert.ok(body.story, "story came back with the import");
  assert.deepEqual(body.story!.map((c) => c.id), ["think", "talk", "taste", "help", "lines", "unknowns"]);
  assert.equal(body.story!.find((c) => c.id === "talk")!.headline, "talk headline.");
  assert.equal(body.story!.find((c) => c.id === "talk")!.items[0].text, "You talk like this.");
  const stored = await h.store.getStyle("u1");
  assert.equal(stored!.story!.from, "text");
});

test("skip user: GET /v1/profile/story?wait writes the story from the card (N1–N3) and stores it", async (t) => {
  const h = harness((req) => (req.schemaName === "story_cards" ? STORY_RAW : null));
  t.after(h.cleanup);
  const srv = await http(h.p, h.store, undefined);
  t.after(srv.close);
  const none = await (await fetch(`${srv.base}/v1/profile/story`)).json();
  assert.deepEqual(none, { status: "none", cards: [] });
  await fetch(`${srv.base}/v1/import/skip`, { method: "POST", body: JSON.stringify({ interests: ["Food"], replies: "Show me options", avoid: ["Unasked advice"] }) });
  const r = (await (await fetch(`${srv.base}/v1/profile/story?wait=3`)).json()) as { status: string; source: string; cards: Array<{ id: string; unknowns?: Array<{ topic: string }> }> };
  assert.equal(r.status, "ready");
  assert.equal(r.source, "skip");
  assert.deepEqual(r.cards.map((c) => c.id), ["talk", "taste", "lines", "unknowns"], "S1–S4: nothing about thinking or help → not shown");
  assert.ok(r.cards.at(-1)!.unknowns!.some((u) => u.topic === "Your taste in clothes and food"));
  assert.match(String(h.calls[0].input), /<profile>/);
  // stored: the second read is not another Spark call
  await fetch(`${srv.base}/v1/profile/story`);
  assert.equal(h.calls.length, 1);
});

async function withStory(h: ReturnType<typeof harness>) {
  const base = toStyleCard(IMPORT_RAW, "import");
  const { Personalize: P } = await import("../src/personalize/service.ts");
  void P;
  const { toStory } = await import("../src/personalize/story.ts");
  const { cards, topics } = toStory(STORY_RAW, base);
  await h.store.putStyle("u1", { ...base, story: { version: 2, cards, topics, at: "", from: "text" } });
}

test("PATCH /v1/profile (C1→C3): marked lines + what's right → profile changes, only that card is rewritten, changed lines, ack", async (t) => {
  const h = harness((req) => {
    if (req.schemaName === "profile_correction") return { updates: [{ field: "likes", text: "Dislikes logos and loud prints.", replaces: ["Style: Clean, minimal clothes."], chip: "no logos" }], answered: { field: "", text: "", chip: "" } };
    if (req.schemaName === "story_cards") return { cards: [card("taste", "Plain, no logos.", { tags: [{ group: "style", text: "Plain basics", dislike: false }, { group: "style", text: "Logos", dislike: true }] })], topics: [] };
    return null;
  });
  t.after(h.cleanup);
  await withStory(h);
  const srv = await http(h.p, h.store, undefined);
  t.after(srv.close);
  const r = await fetch(`${srv.base}/v1/profile`, { method: "PATCH", body: JSON.stringify({ cardId: "taste", items: ["Clean, minimal"], text: "No logos, ever." }) });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { ack: string; card: { id: string; headline: string }; changed: string[]; profile: string; rows: Array<{ key: string }> };
  assert.equal(body.ack, "Got it. I'll remember that.");
  assert.equal(body.card.id, "taste");
  assert.equal(body.card.headline, "Plain, no logos.");
  assert.deepEqual(body.changed, ["Plain basics", "Not for you: logos"]);
  assert.match(body.profile, /Dislikes logos/);
  assert.doesNotMatch(body.profile, /Clean, minimal clothes/);
  const storyReq = h.calls.find((c) => c.schemaName === "story_cards")!;
  assert.match(storyReq.instructions!, /only these cards: taste\./);
  assert.match(String(h.calls[0].input), /marked these as wrong: \"Clean, minimal\"/);
  const stored = await h.store.getStyle("u1");
  assert.equal(stored!.sections.likes[0].label, "explicit");
});

test("PATCH /v1/profile: bad bodies 400, a card not shown 409, no profile 404, 10 per minute then 429", async (t) => {
  const h = harness(() => ({ updates: [], answered: { field: "", text: "", chip: "" } }));
  t.after(h.cleanup);
  const srv = await http(h.p, h.store, undefined);
  t.after(srv.close);
  const patch = (b: unknown) => fetch(`${srv.base}/v1/profile`, { method: "PATCH", body: JSON.stringify(b) });
  assert.equal((await patch({ cardId: "taste", text: "x" })).status, 404);
  await withStory(h);
  assert.equal((await patch({ cardId: "nope", text: "x" })).status, 400);
  assert.equal((await patch({ cardId: "taste" })).status, 400);
  assert.equal((await patch({ cardId: "taste", items: ["Not on the card"] })).status, 400);
  assert.equal((await patch({ cardId: "taste", items: "Clean, minimal" })).status, 400);
  assert.equal((await patch({ cardId: "taste", text: "x".repeat(201) })).status, 400);
  let last = 0;
  for (let i = 0; i < 11; i++) last = (await patch({ cardId: "taste", text: "I like jazz now." })).status;
  assert.equal(last, 429);
});

test("PATCH unknowns: telling one now answers that topic and it leaves the list", async (t) => {
  const h = harness((req) => {
    assert.match(req.instructions!, /just asked about "Reminder frequency/);
    return { updates: [], answered: { field: "boundaries", text: "One reminder a day is fine.", chip: "one reminder a day" } };
  });
  t.after(h.cleanup);
  await withStory(h);
  const srv = await http(h.p, h.store, undefined);
  t.after(srv.close);
  const r = (await (await fetch(`${srv.base}/v1/profile`, { method: "PATCH", body: JSON.stringify({ cardId: "unknowns", items: ["Reminder frequency"], text: "One a day is fine." }) })).json()) as { card: { unknowns: Array<{ item: string }> } };
  assert.ok(!r.card.unknowns.some((u) => u.item === "Reminder frequency"));
  assert.equal((await h.store.getStyle("u1"))!.sections.boundaries[0].text, "One reminder a day is fine.");
});

test("startCall: server profile (latest), one ask per call for 3 calls", async (t) => {
  const h = harness(() => null);
  t.after(h.cleanup);
  assert.equal(await h.p.startCall("u1"), null);
  await h.store.putStyle("u1", toStyleCard(IMPORT_RAW, "import"));
  const asks: Array<string | undefined> = [];
  for (let i = 0; i < 4; i++) asks.push((await h.p.startCall("u1"))!.askItem);
  // (topics come with their sub line for the prompt and the GK-1 chip)
  assert.deepEqual(asks, ["Reminder frequency", "Favorite shows", "Weekend rhythm", undefined]);
  const s = await h.p.startCall("u1");
  assert.match(s!.profile!, /Dislikes cilantro/);
  assert.doesNotMatch(s!.profile!, /Ask naturally on the first call/);
  assert.equal((await h.store.getStyle("u1"))!.growth!.calls, 5);
});

test("voiceCorrection: no Spark call unless the line looks like one; a hit merges and returns the chip", async (t) => {
  const h = harness((req) => (/just asked about/.test(req.instructions!) ? { updates: [], answered: { field: "communication", text: "Quiet company is fine.", chip: "quiet company" } } : { updates: [{ field: "likes", text: "Avoids mushrooms.", replaces: [], chip: "no mushrooms" }], answered: { field: "", text: "", chip: "" } }));
  t.after(h.cleanup);
  await h.store.putStyle("u1", toStyleCard(IMPORT_RAW, "import"));
  assert.equal(await h.p.voiceCorrection("u1", "What should I cook tonight?"), null);
  assert.equal(h.calls.length, 0);
  const r = await h.p.voiceCorrection("u1", "Actually I don't eat mushrooms anymore.", "Want a mushroom risotto?");
  assert.deepEqual(r!.events, [{ text: "Updated: no mushrooms", fields: ["likes"] }]);
  assert.match(r!.profile, /Avoids mushrooms/);
  assert.equal((await h.store.getStyle("u1"))!.sections.likes[0].text, "Avoids mushrooms.");
  // right after the companion asked the call's question, any line is checked for the answer → "Noted: …"
  const ask = { item: "Communication style", topic: "How chatty calls should be", sub: "Quiet company, or lots of talk?" };
  const n = await h.p.voiceCorrection("u1", "quiet is good", "Chatty or quiet?", undefined, ask);
  assert.deepEqual(n!.events, [{ text: "Noted: quiet company", fields: ["communication"] }]);
  assert.equal(n!.answered, true);
});

test("endCall: post-call updates grow the profile; the asked item's answer leaves the unknowns", async (t) => {
  const h = harness((req) => {
    assert.match(req.instructions!, /Reminder frequency/);
    return { updates: [{ field: "interests", text: "Into film photography.", replaces: [], label: "explicit", times: 1 }], answered: { item: "Reminder frequency", field: "boundaries", text: "One reminder a day is fine." } };
  });
  t.after(h.cleanup);
  await h.store.putStyle("u1", toStyleCard(IMPORT_RAW, "import"));
  const s = await h.p.startCall("u1");
  const n = await h.p.endCall("u1", [{ role: "user", text: "I shoot film these days." }, { role: "assistant", text: "Nice." }, { role: "user", text: "One reminder a day is fine." }], s!.askItem ?? null);
  assert.equal(n, 2);
  const stored = (await h.store.getStyle("u1"))!;
  assert.equal(stored.sections.interests[0].text, "Into film photography.");
  assert.ok(!stored.toConfirm.includes("Reminder frequency"));
  assert.equal(stored.growth!.asked[0].answered, true);
  // a one-turn call isn't worth a Spark call
  assert.equal(await h.p.endCall("u1", [{ role: "user", text: "hi" }], null), 0);
  assert.equal(h.calls.length, 1);
});

test("a story still being written after the import answered: GET story waits for it, no second Spark call", async (t) => {
  const h = harness(() => { throw new Error("must not write another story"); });
  t.after(h.cleanup);
  await h.store.putStyle("u1", toStyleCard(IMPORT_RAW, "import"));
  const late = new Promise<{ raw: unknown; ms: number }>((r) => setTimeout(() => r({ raw: STORY_RAW, ms: 9000 }), 150));
  h.p.trackLate("u1", late);
  const s = await h.p.story("u1", 2000);
  assert.equal(s.status, "ready");
  assert.equal(s.ms, 9000);
  assert.equal(h.calls.length, 0);
});

test("Codex #3: a story written while the profile changed stays stale (the next read rewrites it)", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = harness(async (req) => {
    if (req.schemaName === "story_cards") { await gate; return STORY_RAW; }
    return { updates: [{ field: "likes", text: "Avoids mushrooms.", replaces: [], chip: "no mushrooms" }], answered: { field: "", text: "", chip: "" } };
  });
  t.after(h.cleanup);
  await h.store.putStyle("u1", toStyleCard(IMPORT_RAW, "import"));
  const first = h.p.story("u1", 0);
  await first;
  await h.p.voiceCorrection("u1", "Actually I don't eat mushrooms anymore.");
  release();
  // wait for the write (file store; a fixed 30 ms flaked on a busy machine)
  let stored = (await h.store.getStyle("u1"))!;
  for (let i = 0; i < 100 && !stored.story; i++) { await new Promise((r) => setTimeout(r, 20)); stored = (await h.store.getStyle("u1"))!; }
  assert.ok(stored.story, "the story was saved");
  assert.ok((stored.story!.stale ?? []).includes("taste"), "but marked stale");
});

test("Codex #2: the import replaces the style under the same lock as a call start", async (t) => {
  const h = harness(() => null);
  t.after(h.cleanup);
  await h.store.putStyle("u1", toStyleCard(IMPORT_RAW, "import"));
  const fresh = toStyleCard({ ...IMPORT_RAW, sections: { ...IMPORT_RAW.sections, likes: [f("Food: Vegetarian meals.")] } }, "import");
  // a call start and an import at the same moment: the import must win whatever the order of their reads
  await Promise.all([h.p.startCall("u1"), h.p.replaceStyle("u1", fresh)]);
  assert.deepEqual((await h.store.getStyle("u1"))!.sections.likes.map((x) => x.text), ["Food: Vegetarian meals."]);
});

test("Codex round 2: a slow earlier sheet correction can't undo a later one", async (t) => {
  let n = 0;
  let releaseA!: () => void;
  const gateA = new Promise<void>((r) => (releaseA = r));
  let clock = Date.parse("2026-11-03T01:00:00Z");
  const h = harness(async (req) => {
    if (req.schemaName === "story_cards") return STORY_RAW;
    const mine = ++n;
    if (mine === 1) { await gateA; return { updates: [{ field: "likes", text: "Loves cilantro.", replaces: ["Dislikes cilantro."], chip: "cilantro" }], answered: { field: "", text: "", chip: "" } }; }
    return { updates: [{ field: "likes", text: "Dislikes cilantro, really.", replaces: [], chip: "no cilantro" }], answered: { field: "", text: "", chip: "" } };
  });
  t.after(h.cleanup);
  (h.p as unknown as { now: () => Date }).now = () => new Date((clock += 1000));
  await withStory(h);
  const a = h.p.correct("u1", { cardId: "taste", text: "I love cilantro" });
  await new Promise((r) => setTimeout(r, 20));
  await h.p.correct("u1", { cardId: "taste", text: "No wait, I hate cilantro" });
  releaseA();
  await a;
  const likes = (await h.store.getStyle("u1"))!.sections.likes.map((x) => x.text);
  assert.ok(likes.includes("Dislikes cilantro, really."));
  assert.ok(!likes.includes("Loves cilantro."));
});
