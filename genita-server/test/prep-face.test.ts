import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FACE_EXPRESSIONS,
  FACE_KEYS,
  MOUTH_KEYS,
  VISEMES,
  driftCheck,
  faceEditPrompt,
  faceSoftPrompt,
  faceManifest,
  imageSize,
  makeFaceSet,
  samPrompt,
  MOUTH_PROMPTS,
  type FaceKey,
} from "../src/prep/face.ts";
import { FACE, MOUTH, box, fakeMedia, fakePng } from "./helpers/fakeMedia.ts";

const keyOf = (kind: "human" | "animal" | "character") => (prompt: string) => {
  for (const k of FACE_KEYS) {
    for (const strict of [false, true]) if (faceEditPrompt(k, kind, strict) === prompt) return strict ? `${k}!` : k;
    if (faceSoftPrompt(k, kind) === prompt) return `${k}~`;
  }
  throw new Error(`unknown prompt: ${prompt.slice(0, 60)}`);
};
const scene = () => fakePng(1000, 2000, "scene");
const urlFor = (k: string) => `/v1/companion/face/${k}`;

test("face keys: blink/smile/warm + the ten visemes + five conversational mouth keys, rest is the scene", () => {
  assert.deepEqual([...FACE_EXPRESSIONS], ["blink", "smile", "warm"]);
  assert.deepEqual([...VISEMES], ["MBP", "FV", "TH", "L", "WQ", "O", "EI", "A", "U", "CDG"]);
  assert.deepEqual([...MOUTH_KEYS], ["MID", "AH", "AH2", "EH", "OH"]);
  assert.equal(FACE_KEYS.length, 18);
});

test("mouth-key prompts (flow morph): jaw wording, nose/eyes kept, not smiling, hold-still line even on the first try", () => {
  for (const kind of ["human", "animal", "character"] as const) {
    for (const k of MOUTH_KEYS) {
      const p = faceEditPrompt(k, kind, false);
      assert.match(p, /and jaw/);
      assert.match(p, /eyebrows, nose, lighting, background, framing and camera exactly the same/);
      assert.match(p, /not smiling/);
      assert.match(p, /stays at exactly the same position and size/);
      assert.match(faceEditPrompt(k, kind, true), /Everything above the upper lip stays identical/);
      assert.doesNotMatch(p, /tongue|wide open|jaw dropped/, "wording that hit the content filter on 11/2");
    }
  }
  assert.match(faceEditPrompt("AH", "human", false), /one finger wide/);
  assert.match(faceEditPrompt("AH2", "human", false), /two fingers wide/);
});

test("soft prompt (content-policy retry): speech framing, same keep line, distinct per key", () => {
  for (const kind of ["human", "animal", "character"] as const) {
    const all = FACE_KEYS.map((k) => faceSoftPrompt(k, kind));
    assert.equal(new Set(all).size, all.length);
    for (const v of VISEMES) assert.match(faceSoftPrompt(v, kind), /mid-word/);
    for (const k of FACE_KEYS) assert.match(faceSoftPrompt(k, kind), /lighting, background, framing and camera exactly the same/);
  }
  assert.doesNotMatch(faceSoftPrompt("A", "human"), /wide|jaw|tongue/);
});

test("face prompts: one scaffold, a distinct shape line per key, kind-aware wording, stricter retry", () => {
  for (const kind of ["human", "animal", "character"] as const) {
    const all = FACE_KEYS.map((k) => faceEditPrompt(k, kind, false));
    assert.equal(new Set(all).size, all.length, "each key has its own prompt");
    for (const k of FACE_KEYS) {
      const p = faceEditPrompt(k, kind, false);
      assert.match(p, /^Edit only the /);
      assert.match(p, /lighting, background, framing and camera exactly the same/);
      const strict = faceEditPrompt(k, kind, true);
      assert.ok(strict.startsWith(p) && strict.length > p.length, "strict = base + extra rule");
      assert.match(strict, /same position and size/);
    }
    for (const v of VISEMES) assert.match(faceEditPrompt(v, kind, false), /mouth/);
    assert.match(faceEditPrompt("blink", kind, false), /eyes/);
  }
  assert.match(faceEditPrompt("A", "human", false), /person/);
  assert.match(faceEditPrompt("A", "animal", false), /muzzle or beak/);
  assert.match(faceEditPrompt("A", "character", false), /art style/);
  // 11/2 probe: "mouth wide open … jaw dropped … tongue" trips Muse Image's content filter; speech framing passes
  for (const kind of ["human", "animal", "character"] as const) assert.doesNotMatch(faceEditPrompt("A", kind, false), /jaw dropped|wide open as in/);
  assert.equal(samPrompt("human", "face"), "the person's face");
  assert.equal(samPrompt("animal", "mouth"), "the animal's mouth");
  assert.equal(samPrompt("character", "mouth"), "the character's mouth");
});

test("imageSize reads PNG, WebP (VP8/VP8L/VP8X) and JPEG headers", () => {
  assert.deepEqual(imageSize(fakePng(1152, 2048, "x")), [1152, 2048]);
  const vp8x = Buffer.alloc(30);
  vp8x.write("RIFF", 0);
  vp8x.write("WEBP", 8);
  vp8x.write("VP8X", 12);
  vp8x.writeUIntLE(1152 - 1, 24, 3);
  vp8x.writeUIntLE(2048 - 1, 27, 3);
  assert.deepEqual(imageSize(vp8x), [1152, 2048]);
  const vp8 = Buffer.alloc(30);
  vp8.write("RIFF", 0);
  vp8.write("WEBP", 8);
  vp8.write("VP8 ", 12);
  Buffer.from([0x9d, 0x01, 0x2a]).copy(vp8, 23);
  vp8.writeUInt16LE(1024, 26);
  vp8.writeUInt16LE(1820, 28);
  assert.deepEqual(imageSize(vp8), [1024, 1820]);
  const vp8l = Buffer.alloc(30);
  vp8l.write("RIFF", 0);
  vp8l.write("WEBP", 8);
  vp8l.write("VP8L", 12);
  vp8l[20] = 0x2f;
  vp8l.writeUInt32LE(((1820 - 1) << 14) | (1024 - 1), 21);
  assert.deepEqual(imageSize(vp8l), [1024, 1820]);
  // JPEG: SOI, APP0 (len 4), SOF0 h=1820 w=1024
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x07, 0x1c, 0x04, 0x00, 0x03]);
  assert.deepEqual(imageSize(jpg), [1024, 1820]);
  assert.equal(imageSize(Buffer.from("nope")), null);
});

test("driftCheck: centre moved > 3% of width, size changed > 6%, or no mouth → reject", () => {
  const ref = { face: [0.3, 0.2, 0.7, 0.45] as const, mouth: [0.42, 0.38, 0.58, 0.41] as const };
  const size: [number, number] = [1000, 2000];
  assert.equal(driftCheck(ref, { face: [0.3, 0.2, 0.7, 0.45], mouth: [0.42, 0.38, 0.58, 0.41] }, size), null);
  assert.equal(driftCheck(ref, { face: [0.325, 0.2, 0.725, 0.45], mouth: [0.42, 0.38, 0.58, 0.41] }, size), null, "2.5% sideways is fine");
  assert.equal(driftCheck(ref, { face: [0.335, 0.2, 0.735, 0.45], mouth: [0.42, 0.38, 0.58, 0.41] }, size), "face_moved");
  // vertical move counts in pixels against the width: 0.02 of 2000 px = 40 px = 4% of 1000 px
  assert.equal(driftCheck(ref, { face: [0.3, 0.22, 0.7, 0.47], mouth: [0.42, 0.4, 0.58, 0.43] }, size), "face_moved");
  // an open jaw makes the face box ~8% taller: sqrt-area grows ~4%, centre drops 1% of height (2% of width) → kept
  assert.equal(driftCheck(ref, { face: [0.3, 0.2, 0.7, 0.47], mouth: [0.42, 0.38, 0.58, 0.44] }, size), null);
  assert.equal(driftCheck(ref, { face: [0.28, 0.19, 0.72, 0.465], mouth: [0.42, 0.38, 0.58, 0.41] }, size), "face_resized");
  assert.equal(driftCheck(ref, { face: [0.3, 0.2, 0.7, 0.45], mouth: null }, size), "no_mouth");
  assert.equal(driftCheck(ref, { face: null, mouth: [0.42, 0.38, 0.58, 0.41] }, size), "no_face");
});

test("makeFaceSet: 18 edits from the scene, SAM face+mouth on scene and every edit, normalised boxes, manifest shape", async () => {
  const { media, calls } = fakeMedia({ keyOf: keyOf("human") });
  const saved: string[] = [];
  const st = await makeFaceSet({ metaKey: "k", media, scene: scene(), kind: "human", size: "1024x1820", onItem: async (k, item, bytes) => void saved.push(`${k}:${item.status}:${bytes ? bytes.length > 0 : "-"}`) });
  assert.equal(calls.edits.length, 18);
  assert.ok(calls.edits.every((e) => !e.key.endsWith("!")), "no retries when nothing drifts");
  assert.equal(calls.sam.length, 2 * 19);
  assert.ok(calls.sam.some((s) => s.tag === "scene" && s.prompt === "the person's face"));
  assert.ok(calls.sam.some((s) => s.tag === "scene" && s.prompt === "the person's mouth"));
  assert.equal(saved.length, 18);
  assert.ok(saved.every((s) => s.endsWith(":done:true")));

  const m = faceManifest(st, urlFor);
  assert.equal(m.version, 1);
  assert.deepEqual(m.size, [1000, 2000]);
  assert.deepEqual(m.faceBox, [0.3, 0.2, 0.7, 0.45]);
  assert.deepEqual(m.mouthBox, [0.42, 0.38, 0.58, 0.41]);
  assert.deepEqual(Object.keys(m.images), ["neutral", "blink", "smile", "warm"]);
  assert.equal(m.images.neutral, "/v1/companion/face/neutral");
  assert.deepEqual(Object.keys(m.visemes), [...VISEMES], "the mouth keys stay out of `visemes` (old apps iterate it)");
  assert.equal(m.visemes.MBP, "/v1/companion/face/MBP");
  assert.deepEqual(Object.keys(m.mouthKeys), [...MOUTH_KEYS]);
  assert.equal(m.mouthKeys.AH2, "/v1/companion/face/AH2");
  assert.equal(m.flow, null, "no flow block until the flow step ran");
  assert.deepEqual(Object.keys(m.boxes).sort(), ["neutral", ...FACE_KEYS].sort());
  for (const b of Object.values(m.boxes)) for (const v of [...b.face, ...b.mouth]) assert.ok(v >= 0 && v <= 1);
  assert.deepEqual(m.rejected, []);
  assert.deepEqual(Object.keys(m.ms), ["total", "edits", "sam"]);
});

test("makeFaceSet: drift → one stricter retry; still drifting / no mouth → rejected and absent", async () => {
  const moved = box(380, 400, 780, 900); // centre +80 px = 8% of width
  const big = box(260, 340, 740, 960); // 20% larger
  const { media, calls } = fakeMedia({
    keyOf: keyOf("animal"),
    sam: (tag, part) => {
      if (tag === "TH#1" && part === "face") return [moved]; // retried, then fine
      if (/^A!?#/.test(tag) && part === "face") return [moved]; // both tries move
      if (/^O!?#/.test(tag) && part === "face") return [big];
      if (/^U!?#/.test(tag) && part === "mouth") return [];
      return [part === "face" ? FACE : MOUTH];
    },
  });
  const st = await makeFaceSet({ metaKey: "k", media, scene: scene(), kind: "animal", size: "1024x1820" });
  const retried = calls.edits.filter((e) => e.key.endsWith("!")).map((e) => e.key).sort();
  assert.deepEqual(retried, ["A!", "O!", "TH!", "U!"]);
  assert.ok(calls.edits.filter((e) => e.key === "TH!").every((e) => /same position and size/.test(e.prompt)));
  assert.ok(calls.sam.every((s) => s.prompt.startsWith("the animal's") || s.prompt === "mouth"));
  const m = faceManifest(st, urlFor);
  assert.ok(m.visemes.TH, "TH passed on the retry");
  assert.equal(m.visemes.A, undefined);
  assert.equal(m.visemes.O, undefined);
  assert.equal(m.visemes.U, undefined);
  assert.equal(m.boxes.A, undefined);
  assert.deepEqual(
    m.rejected.sort((a, b) => a.key.localeCompare(b.key)),
    [
      { key: "A", reason: "face_moved", retried: true },
      { key: "O", reason: "face_resized", retried: true },
      { key: "U", reason: "no_mouth", retried: true },
    ],
  );
});

test("makeFaceSet: an edit error is retried once, then rejected; all edits failing throws (runner retries)", async () => {
  const policy = new Error('meta 400: {"error":{"code":"content_policy_violation"}}');
  const one = fakeMedia({ keyOf: keyOf("human"), fail: (t) => (t.startsWith("EI") ? policy : null) });
  const st = await makeFaceSet({ metaKey: "k", media: one.media, scene: scene(), kind: "human", size: "1024x1820" });
  assert.deepEqual(one.calls.edits.filter((e) => e.key.startsWith("EI")).map((e) => e.key), ["EI", "EI~"], "a content-policy refusal is retried with the softer speech framing");
  assert.deepEqual(faceManifest(st, urlFor).rejected, [{ key: "EI", reason: "content_policy", retried: true }]);

  const all = fakeMedia({ keyOf: keyOf("human"), fail: () => new Error("meta 503: down") });
  const saved: string[] = [];
  await assert.rejects(
    () => makeFaceSet({ metaKey: "k", media: all.media, scene: scene(), kind: "human", size: "1024x1820", onItem: async (k) => void saved.push(k) }),
    /face set: every edit failed/,
  );
  assert.deepEqual(saved, [], "upstream failures are not saved as rejections, so a rerun redoes them");
});

test("makeFaceSet: no face or mouth on the scene → face_not_found", async () => {
  const { media } = fakeMedia({ keyOf: keyOf("character"), sam: (tag, part) => (tag === "scene" && part === "mouth" ? [] : [part === "face" ? FACE : MOUTH]) });
  await assert.rejects(() => makeFaceSet({ metaKey: "k", media, scene: scene(), kind: "character", size: "1024x1820" }), /face_not_found/);
});

test("makeFaceSet: picks the mouth inside the face when SAM returns several", async () => {
  const far = box(10, 1700, 400, 1900); // bigger, outside the face
  const { media } = fakeMedia({ keyOf: keyOf("human"), sam: (_t, part) => (part === "face" ? [FACE] : [far, MOUTH]) });
  const st = await makeFaceSet({ metaKey: "k", media, scene: scene(), kind: "human", size: "1024x1820" });
  assert.deepEqual(faceManifest(st, urlFor).mouthBox, [0.42, 0.38, 0.58, 0.41]);
});

test("makeFaceSet: rejects an edit whose aspect ratio differs from the scene", async () => {
  const { media } = fakeMedia({ keyOf: keyOf("human"), size: [1000, 1000] });
  await assert.rejects(() => makeFaceSet({ metaKey: "k", media, scene: scene(), kind: "human", size: "1024x1820" }), /every edit failed|size_mismatch/);
});

test("makeFaceSet: every key in flight at once by default (6 when asked); resume skips settled keys", async () => {
  const six = fakeMedia({ keyOf: keyOf("human"), delayMs: 15 });
  await makeFaceSet({ metaKey: "k", media: six.media, scene: scene(), kind: "human", size: "1024x1820", concurrency: 6 });
  assert.equal(six.calls.maxInFlight, 6);
  const a = fakeMedia({ keyOf: keyOf("human"), delayMs: 15 });
  const first = await makeFaceSet({ metaKey: "k", media: a.media, scene: scene(), kind: "human", size: "1024x1820" });
  assert.equal(a.calls.maxInFlight, 18, "one wave (11/3: prep 96–126 s → 64–94 s)");

  // keep 5 settled items (one of them a rejection), drop the rest: a rerun edits only the 8 missing
  const keep = new Set<FaceKey>(["blink", "smile", "MBP", "FV", "TH"]);
  const prev = { ...first, items: Object.fromEntries(Object.entries(first.items).filter(([k]) => keep.has(k as FaceKey))) };
  prev.items.TH = { status: "rejected", reason: "face_moved", retried: true };
  const b = fakeMedia({ keyOf: keyOf("human") });
  const st = await makeFaceSet({ metaKey: "k", media: b.media, scene: scene(), kind: "human", size: "1024x1820", prev });
  assert.equal(b.calls.edits.length, FACE_KEYS.length - 5);
  assert.ok(!b.calls.edits.some((e) => keep.has(e.key as FaceKey)));
  assert.ok(!b.calls.sam.some((s) => s.tag === "scene"), "scene boxes come from the saved state");
  assert.equal(Object.keys(st.items).length, 18);
  assert.equal(st.items.TH?.status, "rejected");
});

test("makeFaceSet: SAM misses 'the person's mouth' → falls back to the lips / plain 'mouth' prompts (11/2 e2e)", async () => {
  const { media, calls } = fakeMedia({
    keyOf: keyOf("human"),
    sam: (_tag, part) => (part === "face" ? [FACE] : []),
  });
  // the fake answers by part; make only the fallback prompt find the mouth
  const real = media.samDetect;
  media.samDetect = async (k, url, prompt, signal) => (prompt === "the person's lips" ? [MOUTH] : real(k, url, prompt, signal));
  const st = await makeFaceSet({ metaKey: "k", media, scene: scene(), kind: "human", size: "1024x1820" });
  assert.deepEqual(faceManifest(st, urlFor).mouthBox, [0.42, 0.38, 0.58, 0.41]);
  assert.equal(faceManifest(st, urlFor).rejected.length, 0);
  assert.ok(calls.sam.some((s) => s.prompt === "the person's mouth"), "the primary prompt is tried first");
  assert.deepEqual(MOUTH_PROMPTS("animal"), ["the animal's mouth", "the animal's muzzle", "mouth"]);
});

test("makeFaceSet (codex P1): a SAM error on one edit is an edit_failed retry, and nothing is saved after the call settles", async () => {
  const { media } = fakeMedia({
    keyOf: keyOf("human"),
    delayMs: 5,
    sam: (tag, part) => {
      if (/^L!?#/.test(tag)) throw new Error("meta 500: sam down");
      return [part === "face" ? FACE : MOUTH];
    },
  });
  let settled = false;
  const late: string[] = [];
  const st = await makeFaceSet({ metaKey: "k", media, scene: scene(), kind: "human", size: "1024x1820", concurrency: 6, onItem: async (k) => void (settled && late.push(k)) });
  settled = true;
  assert.deepEqual(faceManifest(st, urlFor).rejected, [{ key: "L", reason: "edit_failed", retried: true }]);
  assert.equal(Object.keys(st.items).length, 18);

  // an unexpected failure (here: saving one key) rejects only after every lane has stopped
  const b = fakeMedia({ keyOf: keyOf("human"), delayMs: 5 });
  const saved: string[] = [];
  let rejected = false;
  await assert.rejects(
    () =>
      makeFaceSet({
        concurrency: 6, // fewer lanes than keys: the "no new edit after a failure" path
        metaKey: "k",
        media: b.media,
        scene: scene(),
        kind: "human",
        size: "1024x1820",
        onItem: async (k) => {
          if (rejected) late.push(k);
          if (k === "blink") throw new Error("store down");
          saved.push(k);
        },
      }).finally(() => (rejected = true)),
    /store down/,
  );
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(late, [], "no lane keeps saving after makeFaceSet settled");
  assert.ok(b.calls.edits.length < 18, "no new edit starts once a lane failed");
});

test("makeFaceSet (codex P2): a saved set with no kept image is redone, not skipped", async () => {
  const first = fakeMedia({ keyOf: keyOf("human"), sam: (t, part) => (t === "scene" || part === "face" ? [part === "face" ? FACE : MOUTH] : []) });
  const saved: Record<string, unknown> = {};
  let ref: unknown = null;
  await assert.rejects(
    () => makeFaceSet({ metaKey: "k", media: first.media, scene: scene(), kind: "human", size: "1024x1820", onRef: async (s) => void (ref = s.ref), onItem: async (k, item) => void (saved[k] = item) }),
    /every edit failed/,
  );
  assert.equal(Object.keys(saved).length, 18, "all 18 were saved as no_mouth");
  const prev = { size: [1000, 2000] as [number, number], ref: ref as any, items: saved as any, ms: { total: 0, edits: 0, sam: 0 } };
  const again = fakeMedia({ keyOf: keyOf("human") });
  const st = await makeFaceSet({ metaKey: "k", media: again.media, scene: scene(), kind: "human", size: "1024x1820", prev });
  assert.equal(again.calls.edits.length, 18);
  assert.equal(Object.values(st.items).filter((i) => i?.status === "done").length, 18);
});

test("per-category key sets: a kind generates only its listed mouth keys; prompt overrides per kind", async () => {
  const { MOUTH_KEYS_BY_KIND, MOUTH_PROMPT_BY_KIND, faceKeysFor } = await import("../src/prep/face.ts");
  assert.deepEqual([...faceKeysFor("human")], [...FACE_KEYS]);
  const saved = MOUTH_KEYS_BY_KIND.animal;
  MOUTH_KEYS_BY_KIND.animal = ["MID", "AH"];
  MOUTH_PROMPT_BY_KIND.animal = { MID: "the dog's mouth just barely open, lips relaxed" };
  try {
    assert.ok(!faceKeysFor("animal").includes("EH") && faceKeysFor("animal").includes("AH"));
    assert.match(faceEditPrompt("MID", "animal", false), /the dog's mouth just barely open/);
    const { media, calls } = fakeMedia({ keyOf: keyOf("animal") });
    await makeFaceSet({ metaKey: "k", media, scene: scene(), kind: "animal", size: "1024x1820" });
    assert.equal(calls.edits.length, FACE_KEYS.length - 3);
  } finally {
    MOUTH_KEYS_BY_KIND.animal = saved;
    delete MOUTH_PROMPT_BY_KIND.animal;
  }
});

// ---------- v9.3 mouth on serve (11/3 18:46) ----------

test("withV93Mouth: people on the rig get the v57c block (openMag 0, jaw 1 px), the v93 motion and a still face", async () => {
  const { V93_PERIORAL, STILL_FACE, withV93Mouth, v93MouthOn } = await import("../src/prep/face.ts");
  const map = { rig: { chinLpHz: 2 }, alive: { headX: 3, nodPx: 5 }, motionV2: { amp: 0.35 }, cheek: { spread: 0.8, lift: 3, delayFrames: 1 }, brow: { px: 2.5 } };
  const out = withV93Mouth(map, "human", true);
  assert.deepEqual(out.perioral, { ...V93_PERIORAL, jawDropPx: 1 });
  assert.equal((out.perioral as Record<string, number>).openMag, 0);
  assert.deepEqual(out.alive, { ...STILL_FACE.alive });
  assert.deepEqual(out.brow, { px: 0 });
  assert.deepEqual(out.cheek, { ...STILL_FACE.cheek, delayFrames: 1 });
  const mv = out.motionV2 as Record<string, unknown>;
  assert.equal(mv.amp, 0.35);
  assert.equal(mv.preset, "v93");
  assert.deepEqual((mv.ladders as Record<string, unknown>).spread, [["EI", 0], ["EH", 0.2]]);
  assert.equal(map.alive.nodPx, 5, "the stored map is not mutated");
  assert.equal((map as Record<string, unknown>).perioral, undefined);
  // switch off: the map as prepped
  assert.equal(withV93Mouth(map, "human", false), map);
  // no rig / own perioral: still face only
  const noRig = withV93Mouth({ alive: { headX: 3 } }, "human", true);
  assert.equal(noRig.perioral, undefined);
  assert.deepEqual(noRig.alive, { ...STILL_FACE.alive });
  const own = withV93Mouth({ rig: {}, perioral: { lipThin: 0.5 } }, "human", true);
  assert.deepEqual(own.perioral, { lipThin: 0.5 });
  // switch: default on
  assert.equal(v93MouthOn({}), true);
  assert.equal(v93MouthOn({ GENITA_FACE_V93_MOUTH: "1" }), true);
  for (const v of ["0", "false", "off", " OFF "]) assert.equal(v93MouthOn({ GENITA_FACE_V93_MOUTH: v }), false);
});

test("withV93Mouth: animals close between syllables, 2D opens sooner, 3D quicker — all with a still head; no human block", async () => {
  const { withV93Mouth } = await import("../src/prep/face.ts");
  const animal = withV93Mouth({ drive: "open", shownFloor: 0.6, minHold: 3, jaw: { gain: 1.4, steps: [["AH2", 0.9]], vowel: { A: 1, other: 0.35 } } }, "animal", true);
  assert.equal(animal.shownFloor, 0);
  assert.equal(animal.minHold, 2);
  assert.deepEqual(animal.jaw, { floor: 0, gain: 1.4, steps: [["AH2", 0.9]], vowel: { A: 1, other: 0.1 } });
  assert.equal(animal.perioral, undefined);
  assert.equal((animal.alive as Record<string, number>).headX, 0);
  const twoD = withV93Mouth({ drive: "snap", snap: { hold: 2, minHold: 4, closedBelow: 0.18, rules: [[["A"], 0.75, "WD", 4], [["O"], 0, "OO"], [["EI"], 0.55, "EE"]] } }, "character2d", true);
  const snap = twoD.snap as Record<string, unknown>;
  assert.deepEqual([snap.hold, snap.minHold, snap.closedBelow], [1, 2, 0.08]);
  assert.deepEqual(snap.rules, [[["A"], 0.5, "WD", 2], [["O"], 0, "OO"], [["EI"], 0.4, "EE"]]);
  const threeD = withV93Mouth({ gain: 1.8, smoothing: { fps: 25, attack: 0.75, release: 0.5 } }, "character3d", true);
  assert.equal(threeD.gain, 1.8, "gain untouched (it only saturates)");
  assert.deepEqual(threeD.smoothing, { fps: 25, attack: 0.9, release: 0.7 });
  assert.equal(threeD.minHold, 1);
  // a map without a cheek block still gets the still one (the app's default cheek rules move)
  assert.deepEqual(withV93Mouth({ drive: "open" }, "animal", true).cheek, { spread: 0, pull: 0, lift: 0, cheek: 0, cheekW: 0, naso: 0, nasoW: 0 });
});

test("faceManifest: the served flow map carries the v9.3 mouth; the switch off serves the prepped map", () => {
  const st = {
    size: [1000, 2000],
    ref: { face: [0.3, 0.2, 0.7, 0.45], mouth: [0.42, 0.38, 0.58, 0.41] },
    items: {},
    keys: [],
    ms: { total: 0, edits: 0, sam: 0 },
    flow: { version: 1, roi: [0, 0, 1, 1], size: [10, 10], flowSize: [5, 5], keys: [], files: {}, mask: "m.png", neutralRoi: "n.jpg", lockY: 0.5, lockSource: "x", kind: "human", map: { rig: {}, alive: { nodPx: 5 } } },
  } as unknown as Parameters<typeof faceManifest>[0];
  const on = faceManifest(st, urlFor, (a) => a, { v93Mouth: true });
  assert.equal((on.flow!.map.perioral as Record<string, number>).openMag, 0);
  assert.equal((on.flow!.map.alive as Record<string, unknown>).lockY, true);
  const off = faceManifest(st, urlFor, (a) => a, { v93Mouth: false });
  assert.equal(off.flow!.map.perioral, undefined);
});
