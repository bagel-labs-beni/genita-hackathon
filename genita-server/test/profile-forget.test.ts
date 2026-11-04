/** AU-92: About you → "Forget all of this" = DELETE /v1/profile — what Genita knows goes, the companion stays. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { FileStore } from "../src/prep/store.ts";
import { createPrepRoutes } from "../src/prep/routes.ts";
import type { PrepDeps } from "../src/prep/pipeline.ts";
import type { PrepRunner } from "../src/prep/runner.ts";
import { Personalize } from "../src/personalize/service.ts";
import { skipStyleCard } from "../src/prep/importProfile.ts";

test("DELETE /v1/profile: the profile row goes (import, corrections, growth), call memory is forgotten, the companion stays", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "profile-forget-"));
  const store = new FileStore(dir);
  const p = new Personalize({ store, json: (async () => null) as never });
  const forgotten: string[] = [];
  const d = { metaKey: "k", store, voices: [], log: () => {}, personalize: p, onProfileForgotten: async (u: string) => void forgotten.push(u) } as unknown as PrepDeps;
  const routes = createPrepRoutes(d, {} as PrepRunner);
  const server = createServer((req, res) => void routes.handle(req, res, "u1"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const style = skipStyleCard({ interests: ["Design"], replies: "Start with the answer", avoid: [] });
  assert.ok(style.ok);
  await store.putStyle("u1", { ...style.card, growth: { calls: 4, asked: [] } });
  await store.putCompanion({ id: "c1", userId: "u1", imageId: "img", type: "human", voiceId: "v", name: "Jin", createdAt: new Date().toISOString(), prep: { status: "ready" } } as never);

  const r = await fetch(`${base}/v1/profile`, { method: "DELETE" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  const left = await store.getStyle("u1");
  assert.equal(left?.forgotten, true, "an emptied marker row");
  assert.equal(left?.display.flatMap((r) => r.items).length ?? 0, 0, "what Genita knows is gone");
  assert.equal(left?.growth, undefined);
  assert.deepEqual(await (await fetch(`${base}/v1/import`)).json(), { status: "none" }, "the app sees no import");
  // the call knows nothing, whatever copy the app sends (another device's old profile)
  assert.deepEqual(await p.startCall("u1"), { profile: "", taste: [] });
  assert.deepEqual(forgotten, ["u1"], "call memory and summaries are forgotten too");
  assert.ok(await store.getCompanion("u1"), "the companion stays");
  // a correction queued after it writes nothing back (no card to update)
  await p.correct("u1", { cardId: "talk", items: ["Likes jokes in our chats."] }).catch(() => null);
  assert.equal((await store.getStyle("u1"))?.forgotten, true, "nothing written back");
  // twice is fine
  assert.equal((await fetch(`${base}/v1/profile`, { method: "DELETE" })).status, 200);
});

test("AU-92: an import that started before 'Forget all of this' is not saved; a new one after it is", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "profile-forget-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new FileStore(dir);
  const p = new Personalize({ store, json: (async () => null) as never });
  const style = skipStyleCard({ interests: ["Design"], replies: "Start with the answer", avoid: [] });
  assert.ok(style.ok);
  const before = p.generation("u1");
  await p.forgetAll("u1");
  await assert.rejects(p.replaceStyle("u1", style.card, before), { code: "profile_forgotten" });
  assert.equal((await store.getStyle("u1"))?.forgotten, true);
  await p.replaceStyle("u1", style.card, p.generation("u1"));
  assert.equal((await store.getStyle("u1"))?.forgotten, undefined, "a new import replaces the marker");
});

test("AU-92 r2: a paste's late story from before the forget is dropped; a timed-out call profile read after it uses none", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "profile-forget-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new FileStore(dir);
  const p = new Personalize({ store, json: (async () => null) as never });
  let land!: (v: { raw: unknown; ms: number }) => void;
  p.trackLate("u1", new Promise((r) => { land = r; }));
  await p.forgetAll("u1");
  assert.equal(p.isForgotten("u1"), true);
  const style = skipStyleCard({ interests: ["Design"], replies: "Ask me questions", avoid: [] });
  assert.ok(style.ok);
  await p.replaceStyle("u1", style.card, p.generation("u1"));
  assert.equal(p.isForgotten("u1"), false, "a new profile: not forgotten any more");
  land({ raw: { cards: [{ id: "talk", headline: "Short, direct replies.", items: [] }], topics: [] }, ms: 1 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await store.getStyle("u1"))?.story, undefined, "the old paste's story never lands on the new profile");
});

test("AU-92 r11: after 'Forget all of this', new things learned in calls are kept again (onto the empty profile)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "profile-forget-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new FileStore(dir);
  const p = new Personalize({ store, json: (async () => null) as never });
  await p.forgetAll("u1");
  await new Promise((r) => setTimeout(r, 5));   // said after the forget
  const r = await p.noteShorter("u1");
  assert.ok(r, "learned");
  const card = await store.getStyle("u1");
  assert.equal(card?.forgotten, undefined, "a profile again");
  assert.match(JSON.stringify(card?.sections.response), /Short replies/);
  assert.match((await p.startCall("u1"))?.profile ?? "", /Short replies/);
});
