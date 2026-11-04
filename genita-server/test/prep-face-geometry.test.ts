import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { facePointsFromSam, outlineFromSam, faceRim, facePrompt, EYES_PROMPT, MOUTH_PROMPT } from "../src/prep/faceGeometry.ts";
import { checkImage, type PrepDeps } from "../src/prep/pipeline.ts";
import { FileStore } from "../src/prep/store.ts";
import { DEFAULT_VOICES } from "../src/prep/voices.ts";
import { encodeOneBit } from "../src/meta/samMask.ts";
import type { SamBox } from "../src/meta/sam.ts";
import { fakePng } from "./helpers/fakeMedia.ts";
import { configureOps } from "../src/ops/limits.ts";

/** a SAM box in a w × h image, no mask */
const box = (x1: number, y1: number, x2: number, y2: number, w = 1000, h = 1000): SamBox =>
  ({ x1, y1, x2, y2, w, h, nx1: x1 / w, ny1: y1 / h, nx2: x2 / w, ny2: y2 / h });

function disc(x1: number, y1: number, x2: number, y2: number, w: number, h: number): SamBox {
  const mw = x2 - x1 + 1, mh = y2 - y1 + 1;
  const bits = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) bits[y * mw + x] = ((x - mw / 2) / (mw / 2)) ** 2 + ((y - mh / 2) / (mh / 2)) ** 2 < 1 ? 1 : 0;
  return { ...box(x1, y1, x2, y2, w, h), mask: { width: mw, height: mh, payload: encodeOneBit(bits, mw, mh) } };
}

test("face outline: SAM's face mask is traced into 32 points on its edge, starting at the top, clockwise", () => {
  const out = outlineFromSam([disc(10, 10, 20, 20, 100, 200), disc(30, 50, 70, 130, 100, 200)])!;
  assert.equal(out.length, 32);
  for (const [x, y] of out) {
    assert.ok(x >= 0.28 && x <= 0.73, `x ${x} inside the big box`);
    assert.ok(y >= 0.23 && y <= 0.675, `y ${y} inside the big box`);
  }
  assert.ok(Math.abs(out[0][0] - 0.505) < 0.03 && out[0][1] < 0.27, "first point = top of the face");
  assert.ok(out[8][0] > 0.68, "a quarter turn later = the right edge");
});

test("face outline: no mask, an empty mask or a bad token = null", () => {
  assert.equal(outlineFromSam([]), null);
  assert.equal(outlineFromSam([box(0, 0, 10, 10, 100, 100)]), null);
  assert.equal(outlineFromSam([{ ...disc(0, 0, 9, 9, 100, 100), mask: { width: 10, height: 10, payload: "!garbage" } }]), null);
});

test("face points: two eye boxes and a mouth box → almond eyes, arched brows, nose, lips (live clay / dog shape)", () => {
  // live SAM 11/4, c2-clay: eyes [0.338,0.41,0.444,0.439] [0.571,0.407,0.677,0.436], mouth [0.423,0.549,0.598,0.565]
  const p = facePointsFromSam([box(571, 407, 677, 436), box(338, 410, 444, 439)], [box(423, 549, 598, 565)], null)!;
  assert.ok(p);
  assert.equal(p.leftEye.length, 6);
  assert.ok(p.leftEye.every(([x]) => x < 0.5) && p.rightEye.every(([x]) => x > 0.5), "left/right as seen in the image");
  assert.deepEqual(p.leftEye[0], [0.338, 0.4245]);
  assert.ok(p.leftBrow.every(([, y]) => y < 0.41), "brows sit above the eyes");
  assert.equal(p.lips.length, 10);
  assert.ok(p.lips.every(([x, y]) => x >= 0.423 && x <= 0.598 && y >= 0.549 && y <= 0.566), "lips stay on the mouth box");
  assert.equal(p.nose.length, 5);
  assert.ok(p.nose.every(([, y]) => y > 0.42 && y < 0.549), "nose between the eyes and the mouth");
});

test("face points: one wide box over both eyes (live human) is split in two", () => {
  // live SAM 11/4, p1-front: eyes [0.356,0.375,0.674,0.399], mouth [0.422,0.498,0.586,0.526]
  const p = facePointsFromSam([box(356, 375, 674, 399)], [box(422, 498, 586, 526)], null)!;
  assert.ok(p);
  assert.ok(Math.max(...p.leftEye.map(([x]) => x)) < 0.5 && Math.min(...p.rightEye.map(([x]) => x)) > 0.5);
});

test("face points: no eyes, no mouth, a mouth above the eyes or features outside the face = null", () => {
  const eyes = [box(338, 410, 444, 439), box(571, 407, 677, 436)];
  const mouth = [box(423, 549, 598, 565)];
  assert.equal(facePointsFromSam([], mouth, null), null);
  assert.equal(facePointsFromSam(eyes, [], null), null);
  assert.equal(facePointsFromSam(eyes, [box(423, 200, 598, 230)], null), null);
  assert.equal(facePointsFromSam([box(338, 410, 444, 439)], mouth, null), null, "one small eye box is not two eyes");
  const elsewhere: [number, number][] = [[0.8, 0.8], [0.95, 0.8], [0.95, 0.95], [0.8, 0.95]];
  assert.equal(facePointsFromSam(eyes, mouth, elsewhere), null, "features outside the traced face are ignored");
  assert.equal(facePrompt("animal"), "the animal's face");
});

test("checkImage: a photo with a face carries faceOutline (SAM face mask) and facePoints (SAM eyes + mouth), passed or not; no face carries none", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genita-face-geo-"));
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; rmSync(dir, { recursive: true, force: true }); });
  const prompts: string[] = [];
  let passed = true, noFace = false;
  const face = disc(300, 500, 700, 1300, 1000, 2000);
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    let text: string;
    if (body.model === "sam-3.1") {
      const prompt = body.input[0].content[0].text as string;
      prompts.push(prompt);
      text = prompt === "the person's face"
        ? `<|box;x1=300;y1=500;x2=700;y2=1300;w=1000;h=2000|><|mask;data=${face.mask!.height},${face.mask!.width},${face.mask!.payload}|>`
        : prompt === EYES_PROMPT
          ? "<|box;x1=380;y1=780;x2=470;y2=820;w=1000;h=2000|><|box;x1=530;y1=780;x2=620;y2=820;w=1000;h=2000|>"
          : prompt === MOUTH_PROMPT
            ? "<|box;x1=420;y1=1080;x2=580;y2=1130;w=1000;h=2000|>"
            : "<|box;x1=250;y1=300;x2=750;y2=1400;w=1000;h=2000|>";
    } else {
      text = JSON.stringify({ subject: noFace ? "none" : "person", face_count: noFace ? 0 : 1, front_facing: true, face_covered: false, sharp: passed, well_lit: true, text_on_image: false, public_figure: false, any_public_figure: false, species: "", character_style: "none" });
    }
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text }] }] });
  }) as typeof fetch;
  const d: PrepDeps = { metaKey: "k", store: new FileStore(dir), voices: DEFAULT_VOICES, log: () => {} };
  const rec = await checkImage(d, "u1", fakePng(1000, 2000, "face-geo"), true);
  assert.equal(rec.check.passed, true);
  assert.deepEqual(prompts.sort(), ["the eyes", "the mouth", "the person's face", "the person's head"]);
  assert.equal(rec.faceOutline?.length, 32);
  assert.equal(rec.facePoints?.leftEye.length, 6);
  assert.ok(rec.facePoints!.lips.every(([, y]) => y > 0.53 && y < 0.57));
  passed = false;   // blurry: fails the check (V02-F / polish), but there is a face, so it gets the net (lead 11/4 05:3x)
  const failed = await checkImage(d, "u1", fakePng(1000, 2000, "face-geo-2"), true);
  assert.equal(failed.check.passed, false);
  assert.equal(failed.faceOutline?.length, 32);
  assert.equal(failed.facePoints?.leftEye.length, 6);
  noFace = true;
  const none = await checkImage(d, "u1", fakePng(1000, 2000, "face-geo-3"), true);
  assert.ok(none.check.reasons.some((r) => r.code === "no_face"));
  assert.equal(none.faceOutline, null, "no face = no net (the cat facing away)");
  assert.equal(none.facePoints, null);
});

test("checkImage: the Spark check is requested before the optional face-scan SAM calls, and a hung SAM call never holds the answer", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genita-face-geo-slow-"));
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; rmSync(dir, { recursive: true, force: true }); });
  const order: string[] = [];
  const face = disc(300, 500, 700, 1300, 1000, 2000);
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    const prompt = body.model === "sam-3.1" ? body.input[0].content[0].text as string : "spark";
    order.push(prompt);
    if (prompt === EYES_PROMPT) {
      // never answers; only the abort ends it
      return new Promise<Response>((_, reject) => init!.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    const text = prompt === "spark"
      ? JSON.stringify({ subject: "person", face_count: 1, front_facing: true, face_covered: false, sharp: true, well_lit: true, text_on_image: false, public_figure: false, any_public_figure: false, species: "", character_style: "none" })
      : prompt === "the person's face"
        ? `<|box;x1=300;y1=500;x2=700;y2=1300;w=1000;h=2000|><|mask;data=${face.mask!.height},${face.mask!.width},${face.mask!.payload}|>`
        : prompt === MOUTH_PROMPT ? "<|box;x1=420;y1=1080;x2=580;y2=1130;w=1000;h=2000|>" : "<|box;x1=250;y1=300;x2=750;y2=1400;w=1000;h=2000|>";
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text }] }] });
  }) as typeof fetch;
  const d: PrepDeps = { metaKey: "k", store: new FileStore(dir), voices: DEFAULT_VOICES, log: () => {} };
  const t0 = performance.now();
  const rec = await checkImage(d, "u1", fakePng(1000, 2000, "face-geo-slow"), true);
  const ms = performance.now() - t0;
  assert.equal(rec.check.passed, true);
  assert.ok(ms < 4000, `answered in ${Math.round(ms)} ms despite the hung eyes call`);
  assert.equal(rec.faceOutline?.length, 32, "the outline that did come back is kept");
  assert.equal(rec.facePoints, null, "no eyes = no feature points");
  assert.deepEqual(order.slice(0, 2), ["the person's head", "spark"], "head box and the check reserve their Meta budget first");
});

test("checkImage: near the daily Meta cap the face scan is skipped (the check and its retry keep the budget); slow scan calls share one 1.5 s grace", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genita-face-geo-cap-"));
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; configureOps({}); rmSync(dir, { recursive: true, force: true }); });
  const prompts: string[] = [];
  let hang = false;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    const prompt = body.model === "sam-3.1" ? body.input[0].content[0].text as string : "spark";
    prompts.push(prompt);
    if (hang && prompt !== "spark" && prompt !== "the person's head") {
      return new Promise<Response>((_, reject) => init!.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    const text = prompt === "spark"
      ? JSON.stringify({ subject: "person", face_count: 1, front_facing: true, face_covered: false, sharp: true, well_lit: true, text_on_image: false, public_figure: false, any_public_figure: false, species: "", character_style: "none" })
      : "<|box;x1=250;y1=300;x2=750;y2=1400;w=1000;h=2000|>";
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text }] }] });
  }) as typeof fetch;
  const d: PrepDeps = { metaKey: "k", store: new FileStore(dir), voices: DEFAULT_VOICES, log: () => {} };
  configureOps({ metaDailyCalls: 7 });   // head + Spark leave 5: below the scan's floor
  const rec = await checkImage(d, "u1", fakePng(1000, 2000, "face-geo-cap"), true);
  assert.equal(rec.check.passed, true);
  assert.deepEqual(prompts.sort(), ["spark", "the person's head"], "no face-scan SAM calls near the cap");
  assert.equal(rec.faceOutline?.length, 32, "still a net: an oval in the head box (no extra calls)");
  assert.equal(rec.facePoints, null);
  configureOps({});
  hang = true;
  const t0 = performance.now();
  await checkImage(d, "u1", fakePng(1000, 2000, "face-geo-cap-2"), true);
  const ms = performance.now() - t0;
  assert.ok(ms < 2500, `face, eyes and mouth all hung: one shared 1.5 s grace, answered in ${Math.round(ms)} ms`);
});

test("face rim: SAM's traced mask; else an ellipse in the face box; a goggle-sized face or none -> the lower head box", () => {
  const head = box(200, 100, 800, 900);
  const traced = faceRim([disc(300, 300, 700, 850, 1000, 1000)], head)!;
  assert.equal(traced.length, 32);
  // a box with no mask: an ellipse inscribed in it, starting at its top centre
  const oval = faceRim([box(300, 300, 700, 850)], head)!;
  assert.deepEqual(oval[0], [0.5, 0.3]);
  assert.ok(oval.every(([x, y]) => x >= 0.3 - 1e-9 && x <= 0.7 + 1e-9 && y >= 0.3 - 1e-9 && y <= 0.85 + 1e-9));
  // PH-06 c4: SAM's "face" is the goggles (under 20 % of the head box): the head box's lower oval instead
  const goggles = faceRim([disc(380, 380, 620, 440, 1000, 1000)], head)!;
  const ys = goggles.map((p) => p[1]);
  assert.ok(Math.max(...ys) - Math.min(...ys) > 0.5, "spans the head's face, not the goggle band");
  // no face box: the head box alone; neither: null
  assert.equal(faceRim([], head)!.length, 32);
  assert.equal(faceRim([], null), null);
});

test("checkImage: a failed animal photo asks SAM for an animal face and head for its net, inside the same 1.5 s grace", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genita-face-geo-animal-"));
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; rmSync(dir, { recursive: true, force: true }); });
  const prompts: string[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    const prompt = body.model === "sam-3.1" ? body.input[0].content[0].text as string : "spark";
    prompts.push(prompt);
    if (prompt === "the animal's head") {
      // hangs: the answer must not wait for it past the grace
      return new Promise<Response>((_, reject) => init!.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    const text = prompt === "spark"
      ? JSON.stringify({ subject: "animal", face_count: 1, front_facing: true, face_covered: false, sharp: false, well_lit: true, text_on_image: false, public_figure: false, any_public_figure: false, species: "dog", character_style: "none" })
      : prompt === "the animal's face" ? "<|box;x1=300;y1=500;x2=700;y2=1300;w=1000;h=2000|>" : "";
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text }] }] });
  }) as typeof fetch;
  const d: PrepDeps = { metaKey: "k", store: new FileStore(dir), voices: DEFAULT_VOICES, log: () => {} };
  const t0 = performance.now();
  const rec = await checkImage(d, "u1", fakePng(1000, 2000, "face-geo-animal"), true);
  assert.equal(rec.check.passed, false);
  assert.ok(prompts.includes("the animal's face") && prompts.includes("the animal's head"));
  assert.ok(performance.now() - t0 < 2500, "the hung head call stays inside the grace");
  assert.equal(rec.faceOutline?.length, 32, "an ellipse in SAM's animal face box");
  assert.deepEqual(rec.faceOutline![0], [0.5, 0.25]);
  assert.equal(rec.headBox, null, "the stored head box is untouched on a failed check");
});

test("face rim (PH-06 p5, a mug held up): a real face inside a big head box is kept; a mask-less box is cut below the eyes", () => {
  // live SAM 11/4: face [0.481,0.157,0.728,0.543] (masked), head [0.213,0,0.824,0.947] (hair, hands and the mug)
  const head = box(213, 0, 824, 947);
  const traced = faceRim([disc(481, 157, 728, 543, 1000, 1000)], head)!;
  const ys = traced.map((p) => p[1]);
  assert.ok(Math.max(...ys) < 0.56, "the net stays on the face, not down the mug");
  // a box without a mask that runs down over the mug (to 0.95), eyes at ~0.37: cut at 0.37 + 1.6 × (0.37 − 0.16)
  const cut = faceRim([box(481, 160, 728, 950)], head, [box(590, 351, 673, 387)])!;
  const bottom = Math.max(...cut.map((p) => p[1]));
  assert.ok(Math.abs(bottom - (0.369 + 1.6 * (0.369 - 0.16))) < 0.01, `bottom ${bottom}`);
});
