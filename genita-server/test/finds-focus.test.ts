import { test } from "node:test";
import assert from "node:assert/strict";
import { FindsRunner } from "../src/finds/runner.ts";
import { MemoryFindsStore, ownerKey } from "../src/finds/store.ts";
import type { FindCard } from "../src/protocol.ts";
import type { FindsVendors } from "../src/finds/vendors.ts";

const noVendors = {} as FindsVendors;
function card(id: string, title: string): FindCard {
  return { id, kind: "recipe", createdAt: "2026-11-03T10:00:00Z", eyebrow: "From your camera", title, subtitle: "About 15 min", items: [], steps: [{ text: "Fry the kimchi." }], options: [], why: [], ask: [], sources: [], how: [] };
}

test("AU-70 FD-01: 'Talk about this on a call' on yesterday's card puts that card in the prompt", async () => {
  const store = new MemoryFindsStore();
  await store.put(ownerKey("acct-a"), card("11111111-aaaa-4bbb-8ccc-000000000001", "Kimchi fried rice"));
  await store.put(ownerKey("acct-b"), card("22222222-aaaa-4bbb-8ccc-000000000002", "Someone else's soup"));
  const runner = new FindsRunner({ vendors: noVendors, store, images: false, imageBase: "/v1/finds" }, { emit() {}, announce() {}, log() {}, now: () => 0 });
  runner.configure({ owner: "acct-a", memories: [] });
  assert.equal(runner.onScreen(), undefined, "nothing on screen in a new call");
  await runner.focus("11111111-aaaa-4bbb-8ccc-000000000001");
  assert.match(runner.onScreen() ?? "", /^Kimchi fried rice/);
  assert.match(runner.onScreen() ?? "", /steps: 1\. Fry the kimchi\./);
  // another account's card id is never read
  await runner.focus("22222222-aaaa-4bbb-8ccc-000000000002");
  assert.match(runner.onScreen() ?? "", /^Kimchi fried rice/);
  // an unknown id keeps the card that was on screen
  await runner.focus("33333333-aaaa-4bbb-8ccc-000000000003");
  assert.match(runner.onScreen() ?? "", /^Kimchi fried rice/);
});

test("CW-02: an outfit card with no taste line from the model gets the account's top taste line (3 reasons always)", async () => {
  const events: import("../src/protocol.ts").ServerEvent[] = [];
  const vendors = {
    async spark() {
      return { text: '{"pick":0,"title":"Wear the trench.","taste":"","situation":"","options":[{"label":"Beige trench","frame":1},{"label":"Denim jacket","frame":0}],"why":["Clean camel.","Casual blue."],"ask":[],"say":"Trench."}', output: [] };
    },
    async *sparkStream() {},
    async sam() { return []; },
    async image() { return null; },
  } as unknown as FindsVendors;
  const runner = new FindsRunner({ vendors, store: new MemoryFindsStore(), images: false, imageBase: "/v1/finds" }, { emit: (e) => events.push(e), announce() {}, log() {}, now: () => performance.now() });
  runner.configure({ owner: "acct-a", memories: [], profile: "- Taste: Likes clean, minimal clothes.\n- Taste: Dislikes loud logos." });
  runner.onTurn({ text: "Which one for this weekend?", frames: ["data:image/jpeg;base64,AAA", "data:image/jpeg;base64,BBB"], utteranceId: 1, replyText: Promise.resolve(null), recent: [] });
  await runner.settle();
  const created = events.find((e) => e.type === "find.created") as Extract<import("../src/protocol.ts").ServerEvent, { type: "find.created" }>;
  assert.ok(created, JSON.stringify(events.map((e) => e.type)));
  const c = created.card;
  assert.ok(c.subtitle, "taste reason on the card");
  assert.equal(c.evidence?.style, c.subtitle);
  assert.equal(c.evidence?.situation, "Beige trench for this weekend.");
  assert.ok(c.why.length >= 2, "seen reasons");
});

test("AU-70 (Codex r2): a slower read of an earlier pick never takes the newer pick back", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  class SlowFirst extends MemoryFindsStore {
    override async get(owner: string, id: string) {
      if (id.endsWith("01")) await gate;
      return super.get(owner, id);
    }
  }
  const store = new SlowFirst();
  await store.put(ownerKey("acct-a"), card("11111111-aaaa-4bbb-8ccc-000000000001", "Card A"));
  await store.put(ownerKey("acct-a"), card("11111111-aaaa-4bbb-8ccc-000000000002", "Card B"));
  const runner = new FindsRunner({ vendors: noVendors, store, images: false, imageBase: "/v1/finds" }, { emit() {}, announce() {}, log() {}, now: () => 0 });
  runner.configure({ owner: "acct-a", memories: [] });
  const a = runner.focus("11111111-aaaa-4bbb-8ccc-000000000001");
  await runner.focus("11111111-aaaa-4bbb-8ccc-000000000002");
  release();
  await a;
  assert.match(runner.onScreen() ?? "", /^Card B/);
});
