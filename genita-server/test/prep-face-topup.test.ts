import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACE_KEYS, faceEditPrompt, faceManifest, faceSoftPrompt, type FaceState } from "../src/prep/face.ts";
import { topUpFaceKeys } from "../src/prep/faceTopUp.ts";
import { FileStore, type CompanionRecord } from "../src/prep/store.ts";
import { newPrepState } from "../src/prep/runner.ts";
import { fakeMedia, fakePng } from "./helpers/fakeMedia.ts";

const keyOf = (prompt: string) => {
  for (const k of FACE_KEYS) {
    if (faceEditPrompt(k, "human", false) === prompt) return k;
    if (faceEditPrompt(k, "human", true) === prompt) return `${k}!`;
    if (faceSoftPrompt(k, "human") === prompt) return `${k}~`;
  }
  throw new Error(`unknown prompt: ${prompt.slice(0, 60)}`);
};
const BOX = { face: [0.3, 0.2, 0.7, 0.45], mouth: [0.42, 0.38, 0.58, 0.41] } as const;
const OLD = FACE_KEYS.filter((k) => k !== "surprised" && k !== "concerned");

/** A companion prepped before the new keys: face done with the 18 old keys, flow data and a person matte. */
function prepped(): CompanionRecord {
  const face: FaceState = {
    size: [1000, 2000], ref: BOX, ms: { total: 1, edits: 1, sam: 1 }, person: true, profile: "human", keys: [...OLD],
    items: Object.fromEntries(OLD.map((k) => [k, { status: "done", box: BOX, retried: false, ms: 1 }])),
    flow: { version: 1, roi: [0, 0, 1, 1], size: [10, 10], flowSize: [5, 5], keys: ["AH"], files: { AH: { key: "flow-AH" } }, mask: "m", neutralRoi: "n", lockY: 0.5, lockSource: "sam", kind: "human", map: { rig: {} } },
  };
  const prep = newPrepState();
  prep.status = "ready";
  prep.steps.face = { status: "done", attempts: 1, face };
  return { id: "c1", userId: "u1", imageId: "img1", type: "human", voiceId: "v", name: "Jin", createdAt: new Date().toISOString(), prep };
}

test("face top-up: only the missing expression keys are edited, saved, and served; flow / matte / old keys kept; idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "face-topup-"));
  try {
    const store = new FileStore(dir);
    await store.putCompanion(prepped());
    await store.putAsset("u1", "c1", "neutral", fakePng(1000, 2000, "scene"));
    const { media, calls } = fakeMedia({ keyOf });
    const r = await topUpFaceKeys({ store, media, metaKey: "k", companion: (await store.getCompanion("u1"))!, env: {} });
    assert.equal(r.status, "added");
    assert.deepEqual([...r.added].sort(), ["concerned", "surprised"]);
    assert.deepEqual(calls.edits.map((e) => e.key).sort(), ["concerned", "surprised"], "no old key is redone");
    for (const k of ["surprised", "concerned"]) assert.ok(await store.getAsset("u1", "c1", k), `${k} stored`);
    const c = (await store.getCompanion("u1"))!;
    const f = c.prep.steps.face!.face!;
    assert.equal(f.person, true);
    assert.deepEqual(f.flow?.keys, ["AH"]);
    assert.ok(f.keys?.includes("surprised"), "the key plan grows, so the manifest lists them");
    const m = faceManifest(f, (k) => `/v1/companion/face/${k}`);
    assert.deepEqual(Object.keys(m.images), ["neutral", "person", "blink", "smile", "warm", "surprised", "concerned"]);
    // second run: nothing to do
    const again = await topUpFaceKeys({ store, media, metaKey: "k", companion: c, env: {} });
    assert.equal(again.status, "complete");
    assert.equal(calls.edits.length, 2);
    // the switch off: nothing is made
    const off = prepped();
    const r2 = await topUpFaceKeys({ store, media, metaKey: "k", companion: off, env: { GENITA_FACE_EMOTION_KEYS: "0" } });
    assert.equal(r2.status, "complete");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("face top-up: a companion still prepping (or without a face) is skipped, never edited", async () => {
  const dir = mkdtempSync(join(tmpdir(), "face-topup-"));
  try {
    const store = new FileStore(dir);
    const c = prepped();
    c.prep.steps.face = { status: "running", attempts: 1 };
    await store.putCompanion(c);
    const { media, calls } = fakeMedia({ keyOf });
    const r = await topUpFaceKeys({ store, media, metaKey: "k", companion: c, env: {} });
    assert.equal(r.status, "skipped");
    assert.equal(calls.edits.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("face top-up (codex P1/P2): a companion deleted mid-run keeps no new image; a finished key is never downgraded; edit_failed keys are retried", async () => {
  const dir = mkdtempSync(join(tmpdir(), "face-topup-"));
  try {
    // P1: deleted while the edits run
    const store = new FileStore(dir);
    await store.putCompanion(prepped());
    await store.putAsset("u1", "c1", "neutral", fakePng(1000, 2000, "scene"));
    const c = (await store.getCompanion("u1"))!;
    const slow = fakeMedia({ keyOf, delayMs: 30 });
    const run = topUpFaceKeys({ store, media: slow.media, metaKey: "k", companion: c, env: {} });
    await new Promise((r) => setTimeout(r, 5));
    await store.deleteCompanion("u1");
    const r = await run;
    assert.equal(r.status, "skipped");
    for (const k of ["surprised", "concerned"]) assert.equal(await store.getAsset("u1", "c1", k), null, `${k} not written back`);

    // P2: another run already finished `surprised`; this run's rejection does not overwrite it
    const s2 = new FileStore(join(dir, "b"));
    const a = prepped();
    a.prep.steps.face!.face!.items.surprised = { status: "rejected", reason: "edit_failed", retried: true };
    await s2.putCompanion(a);
    await s2.putAsset("u1", "c1", "neutral", fakePng(1000, 2000, "scene"));
    const failing = fakeMedia({ keyOf, fail: (tag) => (tag.startsWith("surprised") ? new Error("upstream 503") : null) });
    const run2 = topUpFaceKeys({ store: s2, media: failing.media, metaKey: "k", companion: a, env: {} });
    await s2.patchCompanion("u1", (x) => {
      const f = x.prep.steps.face!;
      return { ...x, prep: { ...x.prep, steps: { ...x.prep.steps, face: { ...f, face: { ...f.face!, items: { ...f.face!.items, surprised: { status: "done", box: BOX, retried: false, ms: 1 } } } } } } };
    });
    await run2;
    assert.ok(failing.calls.edits.some((e) => e.key.startsWith("surprised")), "the edit_failed key was retried");
    const after = (await s2.getCompanion("u1"))!.prep.steps.face!.face!.items;
    assert.equal(after.surprised?.status, "done", "never downgraded");
    assert.equal(after.concerned?.status, "done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
