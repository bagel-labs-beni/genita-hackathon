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
  assert.equal(await store.getStyle("u1"), null, "what Genita knows is gone");
  assert.deepEqual(forgotten, ["u1"], "call memory and summaries are forgotten too");
  assert.ok(await store.getCompanion("u1"), "the companion stays");
  // a correction queued after it writes nothing back (no card to update)
  await p.correct("u1", { cardId: "talk", items: ["Likes jokes in our chats."] }).catch(() => null);
  assert.equal(await store.getStyle("u1"), null);
  // twice is fine
  assert.equal((await fetch(`${base}/v1/profile`, { method: "DELETE" })).status, 200);
});
