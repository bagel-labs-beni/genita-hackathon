import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore, type CompanionRecord } from "../src/prep/store.ts";
import { MAX_PREP_ATTEMPTS, PrepRunner, newPrepState, prepProgress, prepView } from "../src/prep/runner.ts";
import type { PrepDeps } from "../src/prep/pipeline.ts";
import { FACE_KEYS, faceEditPrompt } from "../src/prep/face.ts";
import { SCENE_PROMPT } from "../src/prep/prompts.ts";
import { interpretCheck } from "../src/prep/classify.ts";
import { fakeMedia, fakePng } from "./helpers/fakeMedia.ts";

test("progress ignores legacy video and lip steps, and views never expose their URLs", () => {
  const p = newPrepState();
  assert.deepEqual(prepProgress(p), { done: 0, total: 14 });
  p.steps.scene = { status: "done", attempts: 1, url: "/v1/companion/face/neutral" };
  p.steps.videos.neutral = { status: "done", attempts: 1, url: "https://retired.test/n.mp4" };
  p.steps.lips = { status: "done", attempts: 1, url: "https://retired.test/lips" };
  assert.deepEqual(prepProgress(p), { done: 1, total: 14 });
  const view = prepView({ ...companion(), prep: p });
  assert.deepEqual(view.emotionVideos, {});
  assert.deepEqual(view.lips, { status: "skipped", detail: null, url: null, ms: null });
  for (const step of Object.values(view.steps.videos)) assert.deepEqual(step, { status: "skipped", ms: null });
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
    const d: PrepDeps = { metaKey: "k", store, voices: [], log: (e) => logs.push(e) };
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
    const done = newPrepState();
    await store.putCompanion({ ...companion(), id: "c2", userId: "u2", prep: { ...done, status: "ready", steps: { ...done.steps, scene: { status: "done", attempts: 1 }, face: { status: "done", attempts: 1 } } } });
    const d: PrepDeps = { metaKey: "k", store, voices: [], log: () => {} };
    const runner = new PrepRunner(d);
    assert.equal(await runner.resumeAll(), 1);
    await runner.run("u1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Meta-only runtime: scene + face set, clips and lips skipped, ready (no failure)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prep-meta-only-"));
  try {
    const store = new FileStore(dir);
    await store.putImage({ ...imageRec(), id: "img1" }, fakePng(800, 1000, "upload"));
    await store.putCompanion({ ...companion(), prep: newPrepState() });
    const { media } = fakeMedia({ keyOf: (p) => (p === SCENE_PROMPT.human ? "scene" : FACE_KEYS.find((k) => faceEditPrompt(k, "human", false) === p) ?? "x") });
    const d: PrepDeps = { metaKey: "k", store, voices: [], log: () => {}, media };
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

test("legacy ready record without a face set: resumeAll migrates it, reuses the scene and serves it from our URL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prep-legacy-"));
  try {
    const store = new FileStore(dir);
    await store.putImage({ ...imageRec(), id: "img1" }, fakePng(800, 1000, "upload"));
    const base = newPrepState();
    const legacy: CompanionRecord = {
      ...companion(),
      prep: { ...base, status: "ready", steps: { ...base.steps, scene: { status: "done", attempts: 1, url: "https://cdn.example.invalid/old-scene.png" }, face: undefined as never } },
    };
    delete (legacy.prep.steps as { face?: unknown }).face;
    await store.putCompanion(legacy);
    await store.putAsset("u1", legacy.id, "neutral", fakePng(1000, 2000, "scene"));
    let scenePrompts = 0;
    const { media } = fakeMedia({ keyOf: (p) => (p === SCENE_PROMPT.human ? (scenePrompts++, "scene") : FACE_KEYS.find((k) => faceEditPrompt(k, "human", false) === p) ?? "x") });
    const logs: string[] = [];
    const runner = new PrepRunner({ metaKey: "k", store, voices: [], log: (e) => logs.push(e), media });
    let ready = false;
    runner.events.on("prep.ready", () => (ready = true));
    assert.equal(await runner.resumeAll(), 1);
    for (let i = 0; i < 200 && !ready; i++) await new Promise((r) => setTimeout(r, 10));
    const c = (await store.getCompanion("u1"))!;
    assert.ok(ready);
    assert.equal(c.prep.status, "ready");
    assert.equal(c.prep.steps.face?.status, "done");
    assert.equal(scenePrompts, 0, "the existing scene is reused");
    assert.equal(c.prep.steps.scene.url, "/v1/companion/face/neutral");
    assert.ok(logs.includes("prep.migrated"));
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
