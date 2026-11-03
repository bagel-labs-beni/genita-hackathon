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
const OLD = FACE_KEYS.filter((k) => k !== "laugh" && k !== "surprised" && k !== "concerned");

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
    assert.deepEqual([...r.added].sort(), ["concerned", "laugh", "surprised"]);
    assert.deepEqual(calls.edits.map((e) => e.key).sort(), ["concerned", "laugh", "surprised"], "no old key is redone");
    for (const k of ["laugh", "surprised", "concerned"]) assert.ok(await store.getAsset("u1", "c1", k), `${k} stored`);
    const c = (await store.getCompanion("u1"))!;
    const f = c.prep.steps.face!.face!;
    assert.equal(f.person, true);
    assert.deepEqual(f.flow?.keys, ["AH"]);
    assert.ok(f.keys?.includes("surprised"), "the key plan grows, so the manifest lists them");
    const m = faceManifest(f, (k) => `/v1/companion/face/${k}`);
    assert.deepEqual(Object.keys(m.images), ["neutral", "person", "blink", "smile", "warm", "laugh", "surprised", "concerned"]);
    // second run: nothing to do
    const again = await topUpFaceKeys({ store, media, metaKey: "k", companion: c, env: {} });
    assert.equal(again.status, "complete");
    assert.equal(calls.edits.length, 3);
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
