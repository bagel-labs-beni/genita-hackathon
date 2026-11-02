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
