import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { FileStore, type ImageRecord } from "../src/prep/store.ts";
import { createPrepRoutes } from "../src/prep/routes.ts";
import { PrepRunner } from "../src/prep/runner.ts";
import { DEFAULT_VOICES } from "../src/prep/voices.ts";
import { interpretCheck, type ClassifyRaw } from "../src/prep/classify.ts";
import { POLISH_MAX_ATTEMPTS, POLISH_PROMPT, POLISH_SIZE, canPolish, headsView, uploadPolish } from "../src/prep/polish.ts";
import type { PrepDeps } from "../src/prep/pipeline.ts";
import { MOUTH_PROMPTS, type MediaApi } from "../src/prep/face.ts";
import { checkPhotoInput } from "../src/prep/photoInput.ts";
import { OpsLimits, rejectGeneration } from "../src/ops/limits.ts";

const ok: ClassifyRaw = {
  subject: "person", face_count: 1, front_facing: true, face_covered: false, sharp: true, well_lit: true, text_on_image: false,
  public_figure: false, any_public_figure: false, species: "", character_style: "none",
};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);

test("polish: which checked photos can be polished", () => {
  assert.equal(canPolish(interpretCheck(ok)), true, "a passed photo is polished too");
  // fixable by the edit: a side view, poor light / blur, text over the image
  assert.equal(canPolish(interpretCheck({ ...ok, front_facing: false })), true);
  assert.equal(canPolish(interpretCheck({ ...ok, well_lit: false, text_on_image: true })), true);
  assert.equal(canPolish(interpretCheck({ ...ok, subject: "animal", species: "dog", front_facing: false })), true);
  // 11/4 (Chelsea): any photo — a group photo (the largest one is kept) and a half-covered face are polished too
  assert.equal(canPolish(interpretCheck({ ...ok, face_count: 3 })), true);
  // codex P1: a group photo with a well-known person anywhere in it never goes to the image model
  assert.equal(canPolish(interpretCheck({ ...ok, face_count: 3, any_public_figure: true })), false);
  assert.equal(canPolish(interpretCheck({ ...ok, any_public_figure: true })), false);
  const { any_public_figure: _drop, ...older } = ok;
  assert.equal(canPolish(interpretCheck({ ...older, face_count: 3 })), false, "unknown → a group photo is not polished");
  assert.equal(canPolish(interpretCheck({ ...older, front_facing: false })), true, "one face: the main-subject rule covers it");
  assert.equal(canPolish(interpretCheck({ ...ok, face_covered: true, well_lit: false, sharp: false })), true);
  // never: a public figure (D26, refused before any edit), no face at all
  assert.equal(canPolish(interpretCheck({ ...ok, public_figure: true })), false);
  assert.equal(canPolish(interpretCheck({ ...ok, public_figure: true, front_facing: false })), false);
  assert.equal(canPolish(interpretCheck({ ...ok, subject: "none", face_count: 0 })), false);
  assert.equal(canPolish(interpretCheck({ ...ok, face_count: 0 })), false);
  // the upload answer's flag: only with the server flag on
  assert.equal(uploadPolish(interpretCheck({ ...ok, front_facing: false }), true), true);
  assert.equal(uploadPolish(interpretCheck({ ...ok, front_facing: false }), false), false);
  assert.equal(uploadPolish(interpretCheck({ ...ok, public_figure: true }), true), false);
});

test("polish: the upload answer lists every head, largest first (group photo → pick someone else)", () => {
  const heads = headsView([{ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 50, y1: 50, x2: 150, y2: 170 }, { x1: 5, y1: 5, x2: 45, y2: 45 }] as never);
  assert.deepEqual(heads.map((b) => b.x1), [50, 5, 0]);
  assert.equal(headsView(Array.from({ length: 12 }, (_, i) => ({ x1: i, y1: 0, x2: i + 10, y2: 10 })) as never).length, 6);
  assert.deepEqual(headsView(null), []);
});

test("polish: one prompt for every subject, no type branch", () => {
  assert.equal(typeof POLISH_PROMPT, "string");
  // 11/4 lead: the best input for lip-sync / expressions, not a pretty photo
  for (const w of [/person, animal or character/, /largest/, /mouth closed/i, /facing the viewer/i, /eyes open/i, /hair kept away from the mouth and chin/i,
    /no hands/i, /jawline/i, /chin clearly separated/i, /even/i, /blurred/i, /hint of the original place/i, /no text/i, /real photo stays a real photo/i, /art style/i, /clothing/i]) assert.match(POLISH_PROMPT, w);
  assert.equal(POLISH_SIZE, "1024x1820", "9:16, the call screen's shape");
  assert.equal(POLISH_MAX_ATTEMPTS, 3, "first polish + two Try again");
});

async function harness(t: import("node:test").TestContext, opts: { polish?: boolean; recheck?: (n: number) => ClassifyRaw; editFails?: boolean; editErrors?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "prep-polish-"));
  const store = new FileStore(dir);
  const edits: Array<{ prompt: string; size?: string; mime?: string }> = [];
  let checks = 0;
  const media: MediaApi = {
    imageEdit: async (_k, _img, prompt, o) => {
      edits.push({ prompt, size: o.size, mime: o.mime });
      if (opts.editFails && prompt === POLISH_PROMPT) throw new Error("meta 500");
      const e = prompt === POLISH_PROMPT ? opts.editErrors?.shift() : undefined;
      if (e) throw new Error(e);
      return PNG;
    },
    samDetect: async () => [{ x1: 100, y1: 100, x2: 600, y2: 700 } as never],
  };
  const d: PrepDeps = {
    metaKey: "", store, voices: DEFAULT_VOICES, log: () => {}, media,
    photoPolish: opts.polish ?? true,
    spark: (async () => { checks++; return (opts.recheck ?? (() => ok))(checks); }) as PrepDeps["spark"],
  };
  const runner = new PrepRunner(d);
  t.after(() => runner.stop("u1"));
  const routes = createPrepRoutes(d, runner);
  const http = createServer((req, res) => (routes.handles(req) ? void routes.handle(req, res) : (res.writeHead(404), res.end())));
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.startsWith(base + "/") ? realFetch(input, init) : Promise.resolve(new Response("stubbed upstream failure", { status: 503 }));
  });
  t.after(() => { http.close(); rmSync(dir, { recursive: true, force: true }); });
  const call = async (method: string, path: string, body?: unknown, user = "u1") => {
    const r = await fetch(base + path, { method, headers: { "x-genita-user": user, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
  };
  const put = async (id: string, raw: ClassifyRaw, user = "u1") => {
    const rec: ImageRecord = { id, userId: user, mime: "image/jpeg", bytes: JPEG.length, check: interpretCheck(raw), headBox: null, rightsAck: true, createdAt: new Date().toISOString(), ms: { check: 1, sam: 1 } };
    await store.putImage(rec, JPEG);
  };
  return { call, put, edits, base, store, polishEdits: () => edits.filter((e) => e.prompt === POLISH_PROMPT) };
}

test("polish route: a side-view photo → polished, re-checked, shown, used for the companion", async (t) => {
  const h = await harness(t);
  await h.put("orig1", { ...ok, front_facing: false });
  const r = await h.call("POST", "/v1/companion/image/polish", { imageId: "orig1" });
  assert.equal(r.status, 200);
  assert.equal(r.json.passed, true);
  assert.equal(r.json.type, "human");
  assert.equal(r.json.sourceImageId, "orig1");
  assert.notEqual(r.json.imageId, "orig1");
  assert.equal(r.json.attempt, 1);
  assert.equal(r.json.retriesLeft, 2);
  assert.equal("originalUsable" in r.json, false, "Chelsea 11/4 00:34: no \"Use my original\"");
  assert.equal(typeof r.json.ms.polish, "number");
  assert.equal(h.polishEdits().length, 1);
  assert.equal(h.polishEdits()[0].size, POLISH_SIZE);

  // the confirm screen loads the polished picture; only its owner can
  const img = await fetch(`${h.base}/v1/companion/image/${r.json.imageId}`, { headers: { "x-genita-user": "u1" } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
  assert.equal((await fetch(`${h.base}/v1/companion/image/${r.json.imageId}`, { headers: { "x-genita-user": "u2" } })).status, 404);

  // "Use this image": the companion is made from the polished picture
  const created = await h.call("POST", "/v1/companion", { imageId: r.json.imageId, voiceId: DEFAULT_VOICES[0].id });
  assert.equal(created.status, 201);
  assert.equal(created.json.imageId, r.json.imageId);
  assert.equal(created.json.type, "human");
});

test("prep: a confirmed polished image is the call scene itself (no second edit); an upload still gets the scene edit", async (t) => {
  const h = await harness(t);
  const sceneOf = async (user: string, imageId: string) => {
    assert.equal((await h.call("POST", "/v1/companion", { imageId, voiceId: DEFAULT_VOICES[0].id }, user)).status, 201);
    for (let i = 0; i < 200; i++) {
      const c = await h.store.getCompanion(user);
      if (c && c.prep.steps.scene.status !== "pending" && c.prep.steps.scene.status !== "running") return c;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("scene never settled");
  };
  await h.put("orig2", ok);
  const p = await h.call("POST", "/v1/companion/image/polish", { imageId: "orig2" });
  const before = h.edits.length;
  const c = await sceneOf("u1", p.json.imageId);
  assert.equal(c.prep.steps.scene.status, "done");
  assert.equal(c.prep.steps.scene.source, "polish");
  assert.deepEqual(await h.store.getAsset("u1", c.id, "neutral"), PNG);
  assert.equal(h.edits.slice(before).some((e) => e.prompt.includes("9:16 portrait")), false, "no scene edit");
  // flag-off / old-build path: the uploaded photo still goes through the scene edit
  await h.put("orig3", ok, "u3");
  const c3 = await sceneOf("u3", "orig3");
  assert.equal(c3.prep.steps.scene.source, "muse-image");
  t.after(() => undefined);
});

test("polish route: Try again twice, then the limit", async (t) => {
  const h = await harness(t);
  await h.put("orig3", ok);
  const left = [];
  for (let i = 0; i < POLISH_MAX_ATTEMPTS; i++) left.push((await h.call("POST", "/v1/companion/image/polish", { imageId: "orig3" })).json.retriesLeft);
  assert.deepEqual(left, [2, 1, 0]);
  const over = await h.call("POST", "/v1/companion/image/polish", { imageId: "orig3" });
  assert.equal(over.status, 429);
  assert.equal(over.json.error, "polish_limit");
  assert.equal(h.polishEdits().length, POLISH_MAX_ATTEMPTS);
});

test("polish route: refusals never reach the image model", async (t) => {
  const h = await harness(t);
  await h.put("famous", { ...ok, public_figure: true });
  await h.put("noface", { ...ok, subject: "none", face_count: 0 });
  await h.put("other", ok, "u2");
  const famous = await h.call("POST", "/v1/companion/image/polish", { imageId: "famous" });
  assert.equal(famous.status, 422);
  assert.equal(famous.json.error, "not_polishable");
  assert.equal((await h.call("POST", "/v1/companion/image/polish", { imageId: "noface" })).status, 422);
  assert.equal((await h.call("POST", "/v1/companion/image/polish", { imageId: "other" })).json.error, "unknown_image");
  assert.equal((await h.call("POST", "/v1/companion/image/polish", { imageId: 7 })).json.error, "unknown_image");
  assert.equal(h.polishEdits().length, 0);
  // a polished picture is not polished again (Try again sends the original)
  await h.put("orig4", ok);
  const p = await h.call("POST", "/v1/companion/image/polish", { imageId: "orig4" });
  assert.equal((await h.call("POST", "/v1/companion/image/polish", { imageId: p.json.imageId })).json.error, "not_polishable");
});

test("polish route: flag off (GENITA_PHOTO_POLISH=0) → 404 polish_off, no edit", async (t) => {
  const h = await harness(t, { polish: false });
  await h.put("orig5", ok);
  const r = await h.call("POST", "/v1/companion/image/polish", { imageId: "orig5" });
  assert.equal(r.status, 404);
  assert.equal(r.json.error, "polish_off");
  assert.equal(h.polishEdits().length, 0);
});

test("polish route: a result that changed the subject type fails the re-check and can't be used", async (t) => {
  // the drawing came back as a photo of a person: style not kept
  const h = await harness(t, { recheck: () => ok });
  await h.put("drawn", { ...ok, subject: "character", character_style: "2d", front_facing: false });
  const r = await h.call("POST", "/v1/companion/image/polish", { imageId: "drawn" });
  assert.equal(r.status, 200);
  assert.equal(r.json.passed, false);
  assert.deepEqual(r.json.reasons.map((x: { code: string }) => x.code), ["style_changed"]);
  assert.equal((await h.call("POST", "/v1/companion", { imageId: r.json.imageId, voiceId: DEFAULT_VOICES[0].id })).json.error, "image_not_passed");
});

test("polish route: a re-check that fails (e.g. still a side view) is reported with its reasons", async (t) => {
  const h = await harness(t, { recheck: () => ({ ...ok, subject: "animal", species: "dog", front_facing: false }) });
  await h.put("dog", { ...ok, subject: "animal", species: "dog", front_facing: false });
  const r = await h.call("POST", "/v1/companion/image/polish", { imageId: "dog" });
  assert.equal(r.json.passed, false);
  assert.deepEqual(r.json.reasons.map((x: { code: string }) => x.code), ["side_view"]);
});

test("polish route: the polished picture keeps the original's species and character style", async (t) => {
  const h = await harness(t, { recheck: () => ({ ...ok, subject: "character", character_style: "3d", species: "" }) });
  await h.put("clay", { ...ok, subject: "character", character_style: "toy" });
  const r = await h.call("POST", "/v1/companion/image/polish", { imageId: "clay" });
  assert.equal(r.json.passed, true);
  const stored = await h.store.getImage(r.json.imageId);
  assert.equal(stored?.rec.check.raw.character_style, "toy");
  assert.equal(stored?.rec.check.polishedFrom, "clay");
  assert.equal(stored?.rec.rightsAck, true);
});

test("polish route: Muse Image failure → 502 polish_failed (retryable), the attempt counts", async (t) => {
  const h = await harness(t, { editFails: true });
  await h.put("orig6", ok);
  const r = await h.call("POST", "/v1/companion/image/polish", { imageId: "orig6" });
  assert.equal(r.status, 502);
  assert.equal(r.json.error, "polish_failed");
  assert.equal(r.json.retryable, true);
  assert.equal(r.json.retriesLeft, 2);
});

test("polish route: an empty or failed answer is retried once by itself", async (t) => {
  const h = await harness(t, { editErrors: ["muse image: empty response"] });
  await h.put("e1", ok);
  const r = await h.call("POST", "/v1/companion/image/polish", { imageId: "e1" });
  assert.equal(r.status, 200);
  assert.equal(r.json.attempt, 1, "the automatic retry is not a user's Try again");
  assert.equal(h.polishEdits().length, 2);
});

test("polish route: a model refusal → 422 polish_refused, choose another photo, no retry", async (t) => {
  const h = await harness(t, { editErrors: ["UpstreamError: meta 400: {\"error\":{\"code\":\"content_policy_violation\"}}"] });
  await h.put("r1", ok);
  const r = await h.call("POST", "/v1/companion/image/polish", { imageId: "r1" });
  assert.equal(r.status, 422);
  assert.equal(r.json.error, "polish_refused");
  assert.match(r.json.message, /another photo/);
  assert.equal(h.polishEdits().length, 1);
});

test("photo input: format, size and damage are checked from the bytes before any model call", () => {
  const png = (w: number, h: number) => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
    return b;
  };
  // a JPEG with an APP0 segment then a SOF0 frame header (height 600, width 800)
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(checkPhotoInput(png(512, 640)), { ok: true, width: 512, height: 640 });
  assert.deepEqual(checkPhotoInput(jpeg), { ok: true, width: 800, height: 600 });
  assert.deepEqual(checkPhotoInput(png(40, 900)), { ok: false, reason: "bad_dimensions" });
  assert.deepEqual(checkPhotoInput(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])), { ok: false, reason: "corrupt" });
  assert.deepEqual(checkPhotoInput(Buffer.from("GIF89a-not-supported")), { ok: false, reason: "unsupported" });
});

test("upload route: with polish on, an unreadable image is refused before the quota and the model", async (t) => {
  const h = await harness(t);
  const r = await fetch(`${h.base}/v1/companion/image?rights=1`, { method: "POST", headers: { "x-genita-user": "u1", "content-type": "image/jpeg" }, body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]) });
  assert.equal(r.status, 422);
  const j = (await r.json()) as Record<string, string>;
  assert.equal(j.error, "unreadable_image");
  assert.match(j.message, /another photo/);
});

test("polish route: a 2D drawing that came back 3D fails the re-check (codex P2)", async (t) => {
  const h = await harness(t, { recheck: () => ({ ...ok, subject: "character", character_style: "3d" }) });
  await h.put("flat", { ...ok, subject: "character", character_style: "2d" });
  const r = await h.call("POST", "/v1/companion/image/polish", { imageId: "flat" });
  assert.equal(r.json.passed, false);
  assert.deepEqual(r.json.reasons.map((x: { code: string }) => x.code), ["style_changed"]);
});

test("polish route: a dog that came back a cat fails the re-check (codex P2)", async (t) => {
  const h = await harness(t, { recheck: () => ({ ...ok, subject: "animal", species: "cat" }) });
  await h.put("dog", { ...ok, subject: "animal", species: "dog" });
  assert.equal((await h.call("POST", "/v1/companion/image/polish", { imageId: "dog" })).json.passed, false);
});

test("polish route: a closer species name is the same animal", async (t) => {
  const h = await harness(t, { recheck: () => ({ ...ok, subject: "animal", species: "golden retriever dog" }) });
  await h.put("dog2", { ...ok, subject: "animal", species: "dog" });
  assert.equal((await h.call("POST", "/v1/companion/image/polish", { imageId: "dog2" })).json.passed, true);
});

test("polish route: a re-check that throws after the edit is polish_failed with the tries left (codex P2)", async (t) => {
  const h = await harness(t, { recheck: (n) => { if (n >= 1) throw new Error("spark down"); return ok; } });
  await h.put("x1", ok);
  const r = await h.call("POST", "/v1/companion/image/polish", { imageId: "x1" });
  assert.equal(r.status, 502);
  assert.equal(r.json.error, "polish_failed");
  assert.equal(r.json.retriesLeft, 2);
  assert.equal(r.json.retryable, true);
});

test("ops: GENITA_PAUSED and the image budget stop the polish route too (codex P1)", () => {
  const ops = new OpsLimits({ paused: true });
  let status = 0;
  const res = { writeHead: (s: number) => { status = s; }, end: () => {} } as unknown as import("node:http").ServerResponse;
  const req = { method: "POST", url: "/v1/companion/image/polish" } as import("node:http").IncomingMessage;
  assert.equal(rejectGeneration(req, res, ops), true);
  assert.equal(status, 503);
  const budget = new OpsLimits({ metaDailyImages: 1 });
  budget.consumeMeta(true);
  assert.equal(rejectGeneration(req, res, budget), true, "an image route: the daily image cap applies");
  assert.equal(status, 429);
});

test("prep: a polished dog with its mouth closed is still found by its species (11/4 e2e: \"the animal's mouth\" → none, \"the dog's mouth\" → hit)", () => {
  assert.deepEqual(MOUTH_PROMPTS("animal", "dog"), ["the animal's mouth", "the animal's muzzle", "the dog's mouth", "mouth"]);
  assert.deepEqual(MOUTH_PROMPTS("animal"), ["the animal's mouth", "the animal's muzzle", "mouth"]);
  assert.deepEqual(MOUTH_PROMPTS("animal", "dog's\" <x>"), ["the animal's mouth", "the animal's muzzle", "mouth"], "only plain words go into a prompt");
  assert.deepEqual(MOUTH_PROMPTS("human", "dog"), ["the person's mouth", "the person's lips", "mouth"]);
});
