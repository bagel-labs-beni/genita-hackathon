import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore, type CompanionRecord } from "../src/prep/store.ts";
import { MAX_PREP_ATTEMPTS, PrepRunner, emotionVideos, newPrepState, prepProgress, prepView } from "../src/prep/runner.ts";
import type { PrepDeps } from "../src/prep/pipeline.ts";
import { FACE_KEYS, faceEditPrompt } from "../src/prep/face.ts";
import { SCENE_PROMPT } from "../src/prep/prompts.ts";
import { interpretCheck } from "../src/prep/classify.ts";
import { fakeMedia, fakePng } from "./helpers/fakeMedia.ts";

test("progress (GENITA_KLING=1) counts scene + 3 clips + lips, and drops a `todo` lips step", () => {
  const p = newPrepState({ kling: true });
  assert.deepEqual(prepProgress(p), { done: 0, total: 5 });
  p.steps.scene = { status: "done", attempts: 1, url: "s" };
  p.steps.videos.neutral = { status: "done", attempts: 1, url: "n" };
  p.steps.lips = { status: "todo", attempts: 1 };
  assert.deepEqual(prepProgress(p), { done: 2, total: 4 });
  assert.deepEqual(emotionVideos(p), { neutral: "n" });
});

function companion(): CompanionRecord {
  return { id: "c1", userId: "u1", imageId: "img1", type: "human", voiceId: "v", name: "Mira", createdAt: new Date().toISOString(), prep: newPrepState({ kling: true }) };
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
    const d: PrepDeps = { metaKey: "k", falKey: "fal-test", store, voices: [], log: (e) => logs.push(e), kling: true };
    const runner = new PrepRunner(d);
    let failed = false;
    runner.events.on("prep.failed", () => (failed = true));
    await runner.run("u1"); // the source image is not in the store → every attempt throws
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
    await store.putCompanion({ ...companion(), id: "c2", userId: "u2", prep: { ...newPrepState({ kling: true }), status: "ready" } });
    const d: PrepDeps = { metaKey: "k", falKey: null, store, voices: [], log: () => {}, kling: true };
    const runner = new PrepRunner(d);
    assert.equal(await runner.resumeAll(), 1);
    await runner.run("u1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Meta-only runtime: no FAL_KEY and GENITA_KLING unset → scene + face set, clips and lips skipped, ready (no failure)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prep-meta-only-"));
  try {
    const store = new FileStore(dir);
    await store.putImage({ ...imageRec(), id: "img1" }, fakePng(800, 1000, "upload"));
    await store.putCompanion({ ...companion(), prep: newPrepState() });
    const { media } = fakeMedia({ keyOf: (p) => (p === SCENE_PROMPT.human ? "scene" : FACE_KEYS.find((k) => faceEditPrompt(k, "human", false) === p) ?? "x") });
    const d: PrepDeps = { metaKey: "k", falKey: null, store, voices: [], log: () => {}, media };
    const runner = new PrepRunner(d);
    let ready = false;
    runner.events.on("prep.ready", () => (ready = true));
    await runner.run("u1");
    const c = (await store.getCompanion("u1"))!;
    assert.equal(c.prep.status, "ready");
    assert.ok(ready);
    assert.equal(c.prep.steps.scene.status, "done");
    assert.equal(c.prep.steps.face?.status, "done");
    assert.equal(c.prep.steps.lips.status, "skipped");
    assert.ok(Object.values(c.prep.steps.videos).every((v) => v.status === "skipped"));
    assert.equal(prepView(c).status, "ready");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function imageRec() {
  return {
    id: "img1",
    userId: "u1",
    mime: "image/png",
    bytes: 10,
    check: interpretCheck({ subject: "person", face_count: 1, front_facing: true, face_covered: false, sharp: true, well_lit: true, text_on_image: false }),
    headBox: null,
    rightsAck: true,
    createdAt: new Date().toISOString(),
    ms: { check: 1, sam: 1 },
  };
}
