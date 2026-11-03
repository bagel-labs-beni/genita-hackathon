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
import { cardTexts } from "../src/personalize/story.ts";
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
  const body = (await r.json()) as { ack: string; card: { id: string; headline: string; tags: Array<{ text: string }> }; changed: string[]; profile: string; rows: Array<{ key: string }> };
  assert.equal(body.ack, "Got it. I'll remember that.");
  // S1 (≤ 1 s): the answer doesn't wait for Spark — the card as shown, the marked tag out, their own words in
  assert.equal(body.card.id, "taste");
  assert.equal(body.card.headline, "taste headline.", "headline kept until the reworded card lands");
  assert.ok(!body.card.tags.some((t) => t.text === "Clean, minimal"), "the marked tag is gone");
  assert.deepEqual(body.changed, ["No logos, ever."]);
  // Spark's profile update and the reword land in the store right after; GET story shows them
  await h.p.drainRewrites();
  const profile = (await h.p.startCall("u1"))?.profile ?? "";
  assert.match(profile, /Dislikes logos/);
  assert.doesNotMatch(profile, /Clean, minimal clothes/);
  const reworded = (await h.p.story("u1")).cards.find((c) => c.id === "taste")!;
  assert.equal(reworded.headline, "Plain, no logos.");
  assert.deepEqual(cardTexts(reworded).filter((x) => /logos|Plain/.test(x)), ["Plain basics", "Not for you: logos"]);
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
  await h.p.drainRewrites(); // S1: the answer is saved in the background
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
  await h.p.drainRewrites();
  const likes = (await h.store.getStyle("u1"))!.sections.likes.map((x) => x.text);
  assert.ok(likes.includes("Dislikes cilantro, really."));
  assert.ok(!likes.includes("Loves cilantro."));
});

test("S1: noteShorter saves an observed line, never over an explicit one about the same thing", async (t) => {
  const h = harness(() => null);
  t.after(h.cleanup);
  await h.store.putStyle("u1", toStyleCard(IMPORT_RAW, "import"));
  const r = await h.p.noteShorter("u1");
  assert.equal(r!.text, "Updated: shorter replies");
  const resp = (await h.store.getStyle("u1"))!.sections.response;
  assert.deepEqual([resp[0].text, resp[0].label], ["Short replies, one or two sentences.", "observed"]);
});

test("QA K-test P2: a line forgotten by voice leaves the story at once (before the stale card is rewritten); what's still said stays", async (t) => {
  const h = harness((req) => (req.schemaName === "story_cards" ? new Promise(() => {}) : { updates: [{ field: "likes", text: "", replaces: ["Media: slow-burn dramas; lo-fi while working."], chip: "forgot lo-fi" }, { field: "likes", text: "Media: slow-burn dramas.", replaces: [], chip: "" }], answered: { field: "", text: "", chip: "" } }));
  t.after(h.cleanup);
  const base = toStyleCard({ ...IMPORT_RAW, sections: { ...IMPORT_RAW.sections, likes: [f("Media: slow-burn dramas; lo-fi while working.")] } }, "import");
  const { toStory } = await import("../src/personalize/story.ts");
  const { cards, topics } = toStory({ cards: [card("taste", "Slow stories.", { tags: [{ group: "watch", text: "Slow-burn dramas", dislike: false }, { group: "watch", text: "Lo-fi while working", dislike: false }] })], topics: [] }, base);
  await h.store.putStyle("u1", { ...base, story: { version: 2, cards, topics, at: "2026-11-03T00:00:00Z", from: "text" } });
  const r = await h.p.voiceCorrection("u1", "Forget that I said I listen to lo-fi.");
  assert.ok(r);
  const s = await h.p.story("u1", 0);
  const tags = s.cards.find((c) => c.id === "taste")!.tags!.map((x) => x.text);
  assert.deepEqual(tags, ["Slow-burn dramas"]);
});

test("S1 perf: PATCH /v1/profile answers before any Spark call (slow correction and story calls run behind it)", async (t) => {
  let storyCalls = 0;
  const h = harness(async (req) => {
    if (req.schemaName === "profile_correction") await new Promise((r) => setTimeout(r, 1500));
    if (req.schemaName === "profile_correction") return { updates: [{ field: "likes", text: "Dislikes logos and loud prints.", replaces: ["Style: Clean, minimal clothes."], chip: "no logos" }], answered: { field: "", text: "", chip: "" } };
    if (req.schemaName === "story_cards") {
      if (++storyCalls > 1) await new Promise((r) => setTimeout(r, 1500)); // the reword after the import's story
      return { cards: [card("taste", "Plain, no logos.")], topics: [] };
    }
    return null;
  });
  t.after(h.cleanup);
  await withStory(h);
  const t0 = performance.now();
  const r = await h.p.correct("u1", { cardId: "taste", items: ["Clean, minimal"], text: "No logos, ever." });
  const ms = performance.now() - t0;
  assert.ok(ms < 300, `answered in ${Math.round(ms)} ms (the 1.5 s correction and 1.5 s reword run after)`);
  assert.equal(r.card!.headline, "taste headline.");
  await h.p.drainRewrites();
  assert.equal((await h.p.story("u1")).cards.find((c) => c.id === "taste")!.headline, "Plain, no logos.");
});

test("Codex S1: a reword of an older profile never lands over a newer correction; the interim card is stored and correctable", async (t) => {
  let n = 0;
  let releaseFirst!: () => void;
  const gate = new Promise<void>((r) => (releaseFirst = r));
  let clock = Date.parse("2026-11-03T10:00:00Z");
  const h = harness(async (req) => {
    if (req.schemaName === "profile_correction") {
      n++;
      return n === 1
        ? { updates: [{ field: "likes", text: "Food: Italian.", replaces: [], chip: "Italian" }], answered: { field: "", text: "", chip: "" } }
        : { updates: [{ field: "likes", text: "Food: Thai.", replaces: ["Food: Italian."], chip: "Thai" }], answered: { field: "", text: "", chip: "" } };
    }
    if (req.schemaName === "story_cards") {
      const s = JSON.stringify(req.input);
      if (/only these cards/.test(String(req.instructions)) && /Italian/.test(s) && !/Thai/.test(s)) { await gate; return { cards: [card("taste", "Loves Italian.")], topics: [] }; }
      if (/Thai/.test(s)) return { cards: [card("taste", "Loves Thai.")], topics: [] };
      return STORY_RAW;
    }
    return null;
  });
  t.after(h.cleanup);
  (h.p as unknown as { now: () => Date }).now = () => new Date((clock += 1000));
  await withStory(h);
  const first = await h.p.correct("u1", { cardId: "taste", text: "I love Italian food." });
  // the interim card is stored: a second correction marking one of its new lines validates
  const newLine = first.changed[0] ?? cardTexts(first.card!)[0];
  await h.p.correct("u1", { cardId: "taste", items: [newLine], text: "Actually Thai, not Italian." });
  releaseFirst();
  await h.p.drainRewrites();
  const taste = (await h.p.story("u1")).cards.find((c) => c.id === "taste")!;
  assert.equal(taste.headline, "Loves Thai.", "the late Italian reword was dropped");
});

test("Codex S1: a text-only correction that replaced an unmarked fact answers with the plain corrected card", async (t) => {
  const h = harness((req) => {
    if (req.schemaName === "profile_correction") return { updates: [{ field: "response", text: "Long, detailed answers.", replaces: ["Short answers first."], chip: "detail" }], answered: { field: "", text: "", chip: "" } };
    if (req.schemaName === "story_cards") return STORY_RAW;
    return null;
  });
  t.after(h.cleanup);
  await withStory(h);
  const r = await h.p.correct("u1", { cardId: "talk", text: "I want long detailed answers now." });
  assert.ok(cardTexts(r.card!).includes("I want long detailed answers now."), "their own words, at once");
  await h.p.drainRewrites();
  const profile = (await h.p.startCall("u1"))?.profile ?? "";
  assert.match(profile, /Long, detailed answers/);
  assert.doesNotMatch(profile, /Short answers first/);
});

test("S1: Spark down — the save still answers, is kept pending, and is applied on a later read once Spark is back", async (t) => {
  let tries = 0;
  let down = true;
  const h = harness(async (req) => {
    if (req.schemaName === "profile_correction") {
      tries++;
      if (down) throw new Error("meta 504: request timed out");
      return { updates: [{ field: "likes", text: "Dislikes logos and loud prints.", replaces: ["Style: Clean, minimal clothes."], chip: "no logos" }], answered: { field: "", text: "", chip: "" } };
    }
    if (req.schemaName === "story_cards") return STORY_RAW;
    return null;
  });
  t.after(h.cleanup);
  await withStory(h);
  const r = await h.p.correct("u1", { cardId: "taste", items: ["Clean, minimal"], text: "No logos, ever." });
  assert.deepEqual(r.changed, ["No logos, ever."]);
  await h.p.drainRewrites();
  assert.equal(tries, 2, "one retry");
  assert.ok(h.logs.some(([e]) => e === "profile.correct_failed"));
  assert.equal((await h.store.getStyle("u1"))!.pendingCorrections?.length, 1, "kept for later");
  down = false;
  await h.p.story("u1"); // a later read replays it
  await h.p.drainRewrites();
  assert.equal((await h.store.getStyle("u1"))!.pendingCorrections?.length ?? 0, 0);
  assert.match((await h.p.startCall("u1"))?.profile ?? "", /Dislikes logos/);
});

test("S1: an answered unknown leaves GET story at once, before Spark merges it", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = harness(async (req) => {
    if (req.schemaName === "profile_correction") { await gate; return { updates: [], answered: { field: "boundaries", text: "One reminder a day is fine.", chip: "one a day" } }; }
    if (req.schemaName === "story_cards") return STORY_RAW;
    return null;
  });
  t.after(h.cleanup);
  await withStory(h);
  await h.p.correct("u1", { cardId: "unknowns", items: ["Reminder frequency"], text: "One a day is fine." });
  const unknowns = (await h.p.story("u1")).cards.find((c) => c.id === "unknowns");
  assert.ok(!unknowns?.unknowns?.some((u) => u.topic === "Reminder frequency"));
  release();
  await h.p.drainRewrites();
});

test("Codex P1: 'forget that I have diabetes' stores nothing and sends nothing on; a plain target is kept out", async (t) => {
  const h = harness(() => ({ updates: [], answered: { field: "", text: "", chip: "" } }));
  t.after(h.cleanup);
  await h.store.putStyle("u1", toStyleCard({ ...IMPORT_RAW, sections: { ...IMPORT_RAW.sections, likes: [f("Likes leather accessories.")] } }, "import"));
  await h.p.voiceCorrection("u1", "Forget that I have diabetes.");
  assert.ok(!JSON.stringify((await h.store.getStyle("u1"))!.removed ?? []).includes("diabetes"));
  assert.doesNotMatch((await h.p.startCall("u1"))?.profile ?? "", /diabetes/);
  await h.p.voiceCorrection("u1", "Actually, forget that I like leather accessories.");
  const removed = (await h.store.getStyle("u1"))!.removed ?? [];
  assert.deepEqual(removed.filter((r) => r.forget).map((r) => [r.text, r.forget]), [["leather accessories", true]]);
  assert.ok(!(await h.store.getStyle("u1"))!.sections.likes.some((x) => /leather/.test(x.text)), "the line itself is gone");
});

test("Codex P1 r2: a sensitive sheet correction is never stored or shown; an email hidden by punctuation stripping is never kept", async (t) => {
  const h = harness(() => ({ updates: [], answered: { field: "", text: "", chip: "" } }));
  t.after(h.cleanup);
  await withStory(h);
  const r = await h.p.correct("u1", { cardId: "taste", text: "Forget that I have diabetes." });
  assert.deepEqual(r.changed, []);
  const stored = (await h.store.getStyle("u1"))!;
  assert.ok(!JSON.stringify(stored).includes("diabetes"));
  await h.p.voiceCorrection("u1", "Forget that my email is alice@example.com.");
  assert.ok(!JSON.stringify((await h.store.getStyle("u1"))!).includes("alice"));
  assert.doesNotMatch((await h.p.startCall("u1"))?.profile ?? "", /alice|example/);
});

test("Codex P1 r3: an address is never stored (voice forget or sheet), 'lives in hoodies' is still a taste", async (t) => {
  const { isSensitiveDetail } = await import("../src/personalize/sensitive.ts");
  assert.ok(isSensitiveDetail("Forget that I live at 12 Example Street."));
  assert.ok(isSensitiveDetail("My address is 123 Example Street, Apt 4."));
  assert.ok(!isSensitiveDetail("Lives in hoodies and plain sneakers."));
  assert.ok(isSensitiveDetail("My home is 42 5th Avenue."));
  const h = harness(() => ({ updates: [], answered: { field: "", text: "", chip: "" } }));
  t.after(h.cleanup);
  await withStory(h);
  await h.p.voiceCorrection("u1", "Forget that I live at 12 Example Street.");
  await h.p.correct("u1", { cardId: "taste", text: "My address is 123 Example Street, Apt 4." });
  await h.p.voiceCorrection("u1", "Forget that my home is 42 5th Avenue.");
  assert.ok(!JSON.stringify((await h.store.getStyle("u1"))!).includes("Example"));
  assert.ok(!JSON.stringify((await h.store.getStyle("u1"))!).includes("5th Avenue"));
});

test("Codex r5: a forget target is only kept when the stored profile speaks about it ('asthma' never stored)", async (t) => {
  const h = harness(() => ({ updates: [], answered: { field: "", text: "", chip: "" } }));
  t.after(h.cleanup);
  await h.store.putStyle("u1", toStyleCard({ ...IMPORT_RAW, sections: { ...IMPORT_RAW.sections, likes: [f("Likes leather accessories.")] } }, "import"));
  await h.p.voiceCorrection("u1", "Actually, forget that I have asthma.");
  assert.ok(!JSON.stringify((await h.store.getStyle("u1"))!).includes("asthma"));
  await h.p.voiceCorrection("u1", "Actually, forget that I like leather accessories.");
  assert.deepEqual(((await h.store.getStyle("u1"))!.removed ?? []).filter((r) => r.forget).map((r) => r.text), ["leather accessories"]);
});

test("Codex r6: only the stored profile's own words are kept ('asthma when running' with 'Likes running.' keeps 'running')", async (t) => {
  const h = harness(() => ({ updates: [], answered: { field: "", text: "", chip: "" } }));
  t.after(h.cleanup);
  await h.store.putStyle("u1", toStyleCard({ ...IMPORT_RAW, sections: { ...IMPORT_RAW.sections, likes: [f("Likes running.")] } }, "import"));
  await h.p.voiceCorrection("u1", "Actually, forget that I have asthma when running.");
  const stored = JSON.stringify((await h.store.getStyle("u1"))!);
  assert.ok(!stored.includes("asthma"));
  assert.deepEqual(((await h.store.getStyle("u1"))!.removed ?? []).filter((r) => r.forget).map((r) => r.text), ["running"]);
});

test("Codex r7: 'Forget that I have asthma' on the sheet stores and shows nothing; a profile thing is kept out by its own words", async (t) => {
  const h = harness(() => ({ updates: [], answered: { field: "", text: "", chip: "" } }));
  t.after(h.cleanup);
  await withStory(h);
  const r = await h.p.correct("u1", { cardId: "taste", text: "Forget that I have asthma." });
  assert.deepEqual(r.changed, []);
  assert.ok(!JSON.stringify((await h.store.getStyle("u1"))!).includes("asthma"));
  await h.p.correct("u1", { cardId: "taste", text: "Forget that I like clean minimal clothes." });
  const removed = ((await h.store.getStyle("u1"))!.removed ?? []).filter((x) => x.forget).map((x) => x.text);
  assert.ok(removed.length === 1 && /clean|minimal|clothes/.test(removed[0]), JSON.stringify(removed));
  assert.ok(!JSON.stringify((await h.store.getStyle("u1"))!.pendingCorrections ?? []).includes("Forget"));
});

test("Codex r8: the sheet's 'forget that I like leather accessories' really removes the line (no Spark), not 'Likes running' for 'asthma when running'", async (t) => {
  const h = harness(() => ({ updates: [], answered: { field: "", text: "", chip: "" } }));
  t.after(h.cleanup);
  await h.store.putStyle("u1", toStyleCard({ ...IMPORT_RAW, sections: { ...IMPORT_RAW.sections, likes: [f("Likes leather accessories."), f("Likes running.")] } }, "import"));
  const { toStory } = await import("../src/personalize/story.ts");
  const c0 = (await h.store.getStyle("u1"))!;
  const { cards, topics } = toStory(STORY_RAW, c0);
  await h.store.putStyle("u1", { ...c0, story: { version: 2, cards, topics, at: "", from: "text" } });
  await h.p.correct("u1", { cardId: "taste", text: "Forget that I like leather accessories." });
  await h.p.voiceCorrection("u1", "Actually, forget that I have asthma when running.");
  const likes = (await h.store.getStyle("u1"))!.sections.likes.map((x) => x.text);
  assert.deepEqual(likes, ["Likes running."]);
  assert.doesNotMatch((await h.p.startCall("u1"))?.profile ?? "", /leather accessories\./);
});
