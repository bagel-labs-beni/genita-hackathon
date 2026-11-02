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
const card = (id: string, observation: string, promise = "So I'll keep that in mind.") => ({ id, observation, promise, evidence: "explicit", tags: { style: [], food: [], watch: [], dislikes: [] }, help: [] });
const STORY_RAW = { cards: ["opener", "think", "talk", "taste", "help", "lines"].map((id) => card(id, `You ${id} like this.`)) };

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
  const body = (await r.json()) as { story: Array<{ id: string; observation: string }> | null; style: StyleCard };
  assert.deepEqual(started.sort(), ["story_cards", "style_card"]);
  assert.ok(body.story, "story came back with the import");
  assert.equal(body.story!.length, 7);
  assert.equal(body.story!.find((c) => c.id === "talk")!.observation, "You talk like this.");
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
  const r = (await (await fetch(`${srv.base}/v1/profile/story?wait=3`)).json()) as { status: string; source: string; cards: Array<{ id: string; later: boolean; unknowns?: string[] }> };
  assert.equal(r.status, "ready");
  assert.equal(r.source, "skip");
  const by = Object.fromEntries(r.cards.map((c) => [c.id, c]));
  assert.equal(by.talk.later, false);
  assert.equal(by.taste.later, false, "N1 interests feed the taste card");
  assert.equal(by.think.later, true, "nothing about thinking yet → tell me later");
  assert.ok(by.unknowns.unknowns!.includes("Likes & dislikes"));
  assert.match(String(h.calls[0].input), /<profile>/);
  // stored: the second read is not another Spark call
  await fetch(`${srv.base}/v1/profile/story`);
  assert.equal(h.calls.length, 1);
});

test("PATCH /v1/profile: \"That's not me\" → the line changes, only that card is rewritten, ack", async (t) => {
  const h = harness((req) => {
    if (req.schemaName === "profile_correction") return { updates: [{ field: "likes", text: "Dislikes logos and loud prints.", replaces: ["Style: Clean, minimal clothes."], chip: "no logos" }] };
    if (req.schemaName === "story_cards") return { cards: [card("taste", "You keep it plain: no logos, no loud prints.", "So I'll skip anything with a big logo.")] };
    return null;
  });
  t.after(h.cleanup);
  await h.store.putStyle("u1", toStyleCard(IMPORT_RAW, "import"));
  const srv = await http(h.p, h.store, undefined);
  t.after(srv.close);
  const r = await fetch(`${srv.base}/v1/profile`, { method: "PATCH", body: JSON.stringify({ cardId: "taste", pick: "My taste changed", text: "No logos, ever." }) });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { ack: string; card: { id: string; observation: string }; changed: boolean; profile: string; rows: Array<{ key: string; items: Array<{ text: string }> }> };
  assert.equal(body.ack, "Got it. I'll remember that.");
  assert.equal(body.changed, true);
  assert.equal(body.card.id, "taste");
  assert.equal(body.card.observation, "You keep it plain: no logos, no loud prints.");
  assert.match(body.profile, /Dislikes logos/);
  assert.doesNotMatch(body.profile, /Clean, minimal clothes/);
  const storyReq = h.calls.find((c) => c.schemaName === "story_cards")!;
  assert.match(storyReq.instructions!, /only these cards: taste\./);
  assert.match(String(h.calls[0].input), /My taste changed/);
  const stored = await h.store.getStyle("u1");
  assert.equal(stored!.sections.likes[0].label, "explicit");
});

test("PATCH /v1/profile: bad bodies 400, no profile 404, 10 per minute then 429", async (t) => {
  const h = harness(() => ({ updates: [] }));
  t.after(h.cleanup);
  const srv = await http(h.p, h.store, undefined);
  t.after(srv.close);
  const patch = (b: unknown) => fetch(`${srv.base}/v1/profile`, { method: "PATCH", body: JSON.stringify(b) });
  assert.equal((await patch({ cardId: "taste", text: "x" })).status, 404);
  await h.store.putStyle("u1", toStyleCard(IMPORT_RAW, "import"));
  assert.equal((await patch({ cardId: "nope", text: "x" })).status, 400);
  assert.equal((await patch({ cardId: "taste" })).status, 400);
  assert.equal((await patch({ cardId: "taste", pick: "Not a pick" })).status, 400);
  assert.equal((await patch({ cardId: "taste", text: "x".repeat(201) })).status, 400);
  let last = 0;
  for (let i = 0; i < 11; i++) last = (await patch({ cardId: "taste", text: "I like jazz now." })).status;
  assert.equal(last, 429);
});

test("PATCH unknowns \"Don't ask about these\" clears the list without Spark", async (t) => {
  const h = harness(() => { throw new Error("no spark"); });
  t.after(h.cleanup);
  await h.store.putStyle("u1", toStyleCard(IMPORT_RAW, "import"));
  const srv = await http(h.p, h.store, undefined);
  t.after(srv.close);
  const r = (await (await fetch(`${srv.base}/v1/profile`, { method: "PATCH", body: JSON.stringify({ cardId: "unknowns", pick: "Don't ask about these" }) })).json()) as { card: { unknowns: string[] } };
  assert.deepEqual(r.card.unknowns, []);
  assert.equal(h.calls.length, 0);
});

test("startCall: server profile (latest), one ask per call for 3 calls", async (t) => {
  const h = harness(() => null);
  t.after(h.cleanup);
  assert.equal(await h.p.startCall("u1"), null);
  await h.store.putStyle("u1", toStyleCard(IMPORT_RAW, "import"));
  const asks: Array<string | undefined> = [];
  for (let i = 0; i < 4; i++) asks.push((await h.p.startCall("u1"))!.askItem);
  assert.deepEqual(asks, ["Reminder frequency", "Favorite shows", "Weekend rhythm", undefined]);
  const s = await h.p.startCall("u1");
  assert.match(s!.profile!, /Dislikes cilantro/);
  assert.doesNotMatch(s!.profile!, /Ask naturally on the first call/);
  assert.equal((await h.store.getStyle("u1"))!.growth!.calls, 5);
});

test("voiceCorrection: no Spark call unless the line looks like one; a hit merges and returns the chip", async (t) => {
  const h = harness(() => ({ updates: [{ field: "likes", text: "Avoids mushrooms.", replaces: [], chip: "no mushrooms" }] }));
  t.after(h.cleanup);
  await h.store.putStyle("u1", toStyleCard(IMPORT_RAW, "import"));
  assert.equal(await h.p.voiceCorrection("u1", "What should I cook tonight?"), null);
  assert.equal(h.calls.length, 0);
  const r = await h.p.voiceCorrection("u1", "Actually I don't eat mushrooms anymore.", "Want a mushroom risotto?");
  assert.equal(r!.chip, "Updated: no mushrooms");
  assert.match(r!.profile, /Avoids mushrooms/);
  assert.equal((await h.store.getStyle("u1"))!.sections.likes[0].text, "Avoids mushrooms.");
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
