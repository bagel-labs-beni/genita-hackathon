import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore, type CompanionRecord } from "../src/prep/store.ts";
import { MAX_PREP_ATTEMPTS, PrepRunner, emotionVideos, newPrepState, prepProgress, prepView } from "../src/prep/runner.ts";
import { ModalPeterBaker, MouthAtlasBaker, lipBakerFor } from "../src/prep/lips.ts";
import type { PrepDeps } from "../src/prep/pipeline.ts";

test("progress counts scene + 3 clips + lips, and drops a `todo` lips step", () => {
  const p = newPrepState();
  assert.deepEqual(prepProgress(p), { done: 0, total: 5 });
  p.steps.scene = { status: "done", attempts: 1, url: "s" };
  p.steps.videos.neutral = { status: "done", attempts: 1, url: "n" };
  p.steps.lips = { status: "todo", attempts: 1 };
  assert.deepEqual(prepProgress(p), { done: 2, total: 4 });
  assert.deepEqual(emotionVideos(p), { neutral: "n" });
});

test("lip bakers: humans → Peter, others → atlas; both report todo until deployed", async () => {
  const peter = new ModalPeterBaker(null);
  const atlas = new MouthAtlasBaker();
  assert.equal(lipBakerFor("human", peter, atlas), peter);
  assert.equal(lipBakerFor("animal", peter, atlas), atlas);
  const input = { companionId: "c", kind: "human" as const, sceneUrl: "s", videos: {}, voiceId: "v" };
  assert.deepEqual(await peter.bake(input), { status: "todo", reason: "peter_prepare_not_deployed" });
  assert.deepEqual(await atlas.bake({ ...input, kind: "character" }), { status: "todo", reason: "mouth_atlas_not_implemented" });
});

function companion(): CompanionRecord {
  return { id: "c1", userId: "u1", imageId: "img1", type: "human", voiceId: "v", name: "Mira", createdAt: new Date().toISOString(), prep: newPrepState() };
}

test("file store: patchCompanion serializes writers so prep and persona do not clobber each other", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prep-store-"));
  try {
    const s = new FileStore(dir);
    await s.putCompanion(companion());
    await Promise.all([
      s.patchCompanion("u1", (c) => ({ ...c, prep: { ...c.prep, attempts: 2 } })),
      s.patchCompanion("u1", (c) => ({ ...c, name: "Jin" })),
    ]);
    const c = await s.getCompanion("u1");
    assert.equal(c?.prep.attempts, 2);
    assert.equal(c?.name, "Jin");
    assert.equal(await s.patchCompanion("nobody", (c) => c), null);
    assert.equal((await s.listCompanions()).length, 1);
    await assert.rejects(() => s.getCompanion("../etc"), /bad id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner stops at the attempt cap and marks the companion failed (S09-PF)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prep-runner-"));
  try {
    const store = new FileStore(dir);
    await store.putCompanion(companion());
    const logs: string[] = [];
    const d: PrepDeps = { metaKey: "k", elevenKey: "e", ttsModel: "m", falKey: null, store, voices: [], log: (e) => logs.push(e) };
    const runner = new PrepRunner(d, { peter: new ModalPeterBaker(null), atlas: new MouthAtlasBaker() });
    let failed = false;
    runner.events.on("prep.failed", () => (failed = true));
    await runner.run("u1"); // no FAL_KEY → every attempt throws
    const c = (await store.getCompanion("u1"))!;
    assert.equal(c.prep.status, "failed");
    assert.equal(c.prep.attempts, MAX_PREP_ATTEMPTS);
    assert.ok(failed);
    assert.equal(logs.filter((l) => l === "prep.attempt_failed").length, MAX_PREP_ATTEMPTS);
    assert.equal(prepView(c).status, "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resumeAll picks up only companions still running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prep-resume-"));
  try {
    const store = new FileStore(dir);
    await store.putCompanion(companion());
    await store.putCompanion({ ...companion(), id: "c2", userId: "u2", prep: { ...newPrepState(), status: "ready" } });
    const d: PrepDeps = { metaKey: "k", elevenKey: "e", ttsModel: "m", falKey: null, store, voices: [], log: () => {} };
    const runner = new PrepRunner(d, { peter: new ModalPeterBaker(null), atlas: new MouthAtlasBaker() });
    assert.equal(await runner.resumeAll(), 1);
    await runner.run("u1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ModalPeterBaker: POST /prepare once, persists the call id, polls to done; resume skips the POST", async (t) => {
  const { createServer } = await import("node:http");
  const seen: string[] = [];
  let polls = 0;
  const http = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
    res.writeHead(200, { "content-type": "application/json" });
    if (req.method === "POST") return res.end(JSON.stringify({ call_id: "fc-1" }));
    polls++;
    res.end(JSON.stringify(polls < 2 ? { status: "running" } : { status: "done", result: { avatar_id: "c1", bundle_id: "abcd1234abcd1234", n_base: 241, total_s: 90 } }));
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  t.after(() => http.close());
  const url = `http://127.0.0.1:${(http.address() as import("node:net").AddressInfo).port}/`;
  const b = new ModalPeterBaker(url, "tok", { pollMs: 5 });
  const saved: string[] = [];
  const input = { companionId: "c1", kind: "human" as const, sceneUrl: "s", videos: { neutral: "https://v/n.mp4" }, voiceId: "v" };
  const r = await b.bake(input, { onSubmitted: async (id) => void saved.push(id) });
  assert.equal(r.status, "done");
  assert.ok(r.status === "done" && r.kind === "peter" && r.bundleId === "abcd1234abcd1234" && r.nBase === 241);
  assert.deepEqual(saved, ["fc-1"]);
  assert.equal(seen[0], "POST /prepare Bearer tok");
  assert.equal(seen[1], "GET /prepare/fc-1 Bearer tok");
  seen.length = 0;
  await b.bake(input, { resumeId: "fc-1" });
  assert.ok(seen.every((s) => s.startsWith("GET /prepare/fc-1")));
  await assert.rejects(() => b.bake({ ...input, videos: {} }), /no neutral clip/);
  assert.deepEqual(await b.bake({ ...input, kind: "animal" }), { status: "todo", reason: "not_human" });
});
