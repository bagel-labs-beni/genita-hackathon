/**
 * Meta-only prep (GENITA_KLING off, the default): scene → face set, no fal,
 * no Kling, no Peter; device voices when server TTS is off.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { FileStore, type CompanionRecord, type ImageRecord } from "../src/prep/store.ts";
import { PrepRunner, newPrepState, prepProgress, prepView } from "../src/prep/runner.ts";
import { createPrepRoutes } from "../src/prep/routes.ts";
import { ModalPeterBaker, MouthAtlasBaker } from "../src/prep/lips.ts";
import { DEVICE_VOICES } from "../src/prep/voices.ts";
import { FACE_KEYS, VISEMES, faceEditPrompt } from "../src/prep/face.ts";
import { SCENE_PROMPT } from "../src/prep/prompts.ts";
import { interpretCheck } from "../src/prep/classify.ts";
import type { PrepDeps } from "../src/prep/pipeline.ts";
import { fakeMedia, fakePng, tagOf } from "./helpers/fakeMedia.ts";

const keyOf = (prompt: string) => {
  for (const kind of ["human", "animal", "character"] as const) {
    if (SCENE_PROMPT[kind] === prompt) return "scene";
    for (const k of FACE_KEYS) for (const strict of [false, true]) if (faceEditPrompt(k, kind, strict) === prompt) return strict ? `${k}!` : k;
  }
  throw new Error(`unknown prompt: ${prompt.slice(0, 60)}`);
};

function imageRec(userId = "u1"): ImageRecord {
  return {
    id: `img-${userId}`,
    userId,
    mime: "image/png",
    bytes: 10,
    check: interpretCheck({ subject: "person", face_count: 1, front_facing: true, face_covered: false, sharp: true, well_lit: true, text_on_image: false }),
    headBox: null,
    rightsAck: true,
    createdAt: new Date().toISOString(),
    ms: { check: 1, sam: 1 },
  };
}

function companion(prep = newPrepState()): CompanionRecord {
  return { id: "c1", userId: "u1", imageId: "img-u1", type: "human", voiceId: DEVICE_VOICES[0].id, name: "Jin", createdAt: new Date().toISOString(), prep };
}

/** Any real network call fails the test (fal, Kling, Peter, ElevenLabs, Meta). */
function noNetwork(t: { after: (fn: () => void) => void }) {
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    seen.push(String(input instanceof Request ? input.url : input));
    throw new Error("network is off in this test");
  }) as typeof fetch;
  t.after(() => void (globalThis.fetch = real));
  return seen;
}

test("progress (Meta-only): scene + 13 face images; Kling clips and lips are skipped", () => {
  const p = newPrepState();
  assert.equal(p.steps.videos.neutral.status, "skipped");
  assert.equal(p.steps.lips.status, "skipped");
  assert.equal(p.steps.face?.status, "pending");
  assert.deepEqual(prepProgress(p), { done: 0, total: 14 });
  p.steps.scene = { status: "done", attempts: 1, url: "/v1/companion/face/neutral" };
  p.steps.face = { status: "running", attempts: 1, face: { size: [1, 2], ref: { face: [0, 0, 1, 1], mouth: [0, 0, 1, 1] }, items: { blink: { status: "rejected", reason: "face_moved", retried: true }, A: { status: "done", box: { face: [0, 0, 1, 1], mouth: [0, 0, 1, 1] }, retried: false, ms: 1 } }, ms: { total: 0, edits: 0, sam: 0 } } };
  assert.deepEqual(prepProgress(p), { done: 3, total: 14 });
  const k = newPrepState({ kling: true });
  assert.equal(k.steps.face, undefined);
  assert.deepEqual(prepProgress(k), { done: 0, total: 5 });
});

test("runner without GENITA_KLING: scene → face set, no fal/Kling/Peter call even with FAL_KEY set", async (t) => {
  const net = noNetwork(t);
  const dir = mkdtempSync(join(tmpdir(), "prep-meta-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new FileStore(dir);
  await store.putImage(imageRec(), fakePng(800, 1000, "upload"));
  await store.putCompanion(companion());
  const { media, calls } = fakeMedia({ keyOf });
  const d: PrepDeps = { metaKey: "k", elevenKey: null, ttsModel: "m", falKey: "fal-set", store, voices: DEVICE_VOICES, log: () => {}, media };
  // a configured Peter URL must not be reached either: the runner never asks for lips on this path
  const runner = new PrepRunner(d, { peter: new ModalPeterBaker("http://peter.invalid", "t"), atlas: new MouthAtlasBaker() });
  const progress: string[] = [];
  runner.events.on("prep.progress", (p) => progress.push(`${p.done}/${p.total}`));
  let ready: any = null;
  runner.events.on("prep.ready", (e) => (ready = e));
  await runner.run("u1");

  assert.deepEqual(net, [], "no network call at all");
  const c = (await store.getCompanion("u1"))!;
  assert.equal(c.prep.status, "ready");
  assert.equal(c.prep.steps.scene.url, "/v1/companion/face/neutral");
  assert.equal(c.prep.steps.scene.source, "muse-image");
  assert.equal(calls.edits.filter((e) => e.key === "scene").length, 1);
  assert.equal(calls.edits.length, 14);
  assert.ok(progress.includes("14/14"));
  assert.equal(tagOf((await store.getAsset("u1", "c1", "neutral"))!), "scene");
  assert.equal(tagOf((await store.getAsset("u1", "c1", "A"))!), "A#1");

  const v = prepView(c);
  assert.deepEqual(v.progress, { done: 14, total: 14 });
  assert.deepEqual(v.emotionVideos, {});
  assert.equal(v.sceneUrl, "/v1/companion/face/neutral");
  assert.ok(v.face);
  assert.deepEqual(Object.keys(v.face.visemes), [...VISEMES]);
  assert.equal(v.face.images.blink, "/v1/companion/face/blink");
  assert.equal(v.steps.face?.status, "done");
  assert.ok(ready?.face, "prep.ready carries the manifest");
});

test("runner resume: an interrupted face step redoes only the missing images", async (t) => {
  noNetwork(t);
  const dir = mkdtempSync(join(tmpdir(), "prep-meta-resume-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new FileStore(dir);
  await store.putImage(imageRec(), fakePng(800, 1000, "upload"));
  // first run, then rewind the record to "face running with 4 items" as if the server died mid-step
  const first = fakeMedia({ keyOf });
  const d: PrepDeps = { metaKey: "k", elevenKey: null, ttsModel: "m", falKey: null, store, voices: DEVICE_VOICES, log: () => {}, media: first.media };
  await store.putCompanion(companion());
  await new PrepRunner(d, { peter: new ModalPeterBaker(null), atlas: new MouthAtlasBaker() }).run("u1");
  const done = (await store.getCompanion("u1"))!;
  const face = done.prep.steps.face!.face!;
  const kept = ["blink", "MBP", "FV", "A"] as const;
  const partial = { ...face, items: Object.fromEntries(kept.map((k) => [k, face.items[k]])) };
  await store.patchCompanion("u1", (x) => ({ ...x, prep: { ...x.prep, status: "running", attempts: 1, steps: { ...x.prep.steps, face: { status: "running", attempts: 1, face: partial } } } }));

  const second = fakeMedia({ keyOf });
  const runner = new PrepRunner({ ...d, media: second.media }, { peter: new ModalPeterBaker(null), atlas: new MouthAtlasBaker() });
  assert.equal(await runner.resumeAll(), 1);
  await runner.run("u1");
  const c = (await store.getCompanion("u1"))!;
  assert.equal(c.prep.status, "ready");
  assert.equal(second.calls.edits.length, 13 - kept.length, "only the missing images");
  assert.ok(!second.calls.edits.some((e) => e.key === "scene" || (kept as readonly string[]).includes(e.key)));
  assert.equal(Object.keys(c.prep.steps.face!.face!.items).length, 13);
});

test("runner: a face step that fails keeps its partial set, and POST retry resumes from it", async (t) => {
  noNetwork(t);
  const dir = mkdtempSync(join(tmpdir(), "prep-meta-fail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new FileStore(dir);
  await store.putImage(imageRec(), fakePng(800, 1000, "upload"));
  await store.putCompanion(companion());
  const down = fakeMedia({ keyOf, fail: (tag) => (tag === "scene" ? null : new Error("meta 503")) });
  const d: PrepDeps = { metaKey: "k", elevenKey: null, ttsModel: "m", falKey: null, store, voices: DEVICE_VOICES, log: () => {}, media: down.media };
  const runner = new PrepRunner(d, { peter: new ModalPeterBaker(null), atlas: new MouthAtlasBaker() });
  await runner.run("u1");
  let c = (await store.getCompanion("u1"))!;
  assert.equal(c.prep.status, "failed");
  assert.equal(c.prep.steps.face?.status, "failed");
  assert.ok(c.prep.steps.face?.face?.ref, "scene boxes kept");
  assert.equal(down.calls.edits.filter((e) => e.key === "scene").length, 1, "scene made once across attempts");

  const up = fakeMedia({ keyOf });
  const r2 = new PrepRunner({ ...d, media: up.media }, { peter: new ModalPeterBaker(null), atlas: new MouthAtlasBaker() });
  await r2.retry("u1");
  await r2.run("u1");
  c = (await store.getCompanion("u1"))!;
  assert.equal(c.prep.status, "ready");
  assert.equal(up.calls.edits.length, 13);
});

test("routes (Meta-only): device voices, no previews, face images served per user, session lip none", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "prep-meta-routes-"));
  const store = new FileStore(dir);
  const { media } = fakeMedia({ keyOf });
  const d: PrepDeps = { metaKey: "", elevenKey: null, ttsModel: "m", falKey: null, store, voices: DEVICE_VOICES, log: () => {}, media };
  const runner = new PrepRunner(d, { peter: new ModalPeterBaker(null), atlas: new MouthAtlasBaker() });
  const routes = createPrepRoutes(d, runner);
  const http = createServer((req, res) => (routes.handles(req) ? void routes.handle(req, res) : (res.writeHead(404), res.end())));
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  t.after(() => {
    http.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (method: string, path: string, body?: unknown, user = "u1") =>
    fetch(base + path, { method, headers: { "x-genita-user": user, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  const v = (await (await call("GET", "/v1/companion/voices")).json()) as { voices: Array<Record<string, unknown>> };
  assert.equal(v.voices.length, 4);
  for (const x of v.voices) {
    assert.match(String(x.id), /^device:en-US:[fm]\d$/);
    assert.equal(x.locale, "en-US");
    assert.ok(["female", "male", "neutral"].includes(String(x.gender)));
    assert.equal(typeof x.style, "string");
    assert.equal(x.previewUrl, null);
  }
  assert.deepEqual(v.voices.map((x) => x.name), DEVICE_VOICES.map((x) => x.name), "Spark order kept (fallback = list order)");
  const pv = await call("GET", `/v1/companion/voices/${encodeURIComponent(DEVICE_VOICES[1].id)}/preview`);
  assert.equal(pv.status, 404);
  assert.equal(((await pv.json()) as { error: string }).error, "device_preview");

  await store.putImage(imageRec(), fakePng(800, 1000, "upload"));
  const created = await call("POST", "/v1/companion", { imageId: "img-u1", voiceId: DEVICE_VOICES[1].id });
  assert.equal(created.status, 201);
  await runner.run("u1");

  const prep = (await (await call("GET", "/v1/companion/prep")).json()) as Record<string, any>;
  assert.equal(prep.status, "ready");
  assert.equal(prep.face.version, 1);
  assert.equal(prep.face.visemes.O, "/v1/companion/face/O");

  const img = await call("GET", "/v1/companion/face/O");
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.equal(tagOf(Buffer.from(await img.arrayBuffer())), "O#1");
  assert.equal((await call("GET", "/v1/companion/face/neutral")).status, 200);
  assert.equal((await call("GET", "/v1/companion/face/O", undefined, "u2")).status, 404, "another user has no companion");
  assert.equal((await call("GET", "/v1/companion/face/nope")).status, 404);
  assert.equal((await call("GET", "/v1/companion/face/..%2Fcompanions%2Fu1")).status, 404);

  const comp = (await (await call("POST", "/v1/companion/prefs", { depth: "quick", answers: { help: "Be there", relationship: "Close companion", presence: ["Calm"] } })).json()) as Record<string, any>;
  assert.equal(comp.session.lip, "none");
  assert.equal(comp.session.voiceId, DEVICE_VOICES[1].id);
});

test("createPrep: flags come from env; off by default (no FAL_KEY read, device voices, no Peter)", async (t) => {
  const { createPrep } = await import("../src/prep/index.ts");
  const dir = mkdtempSync(join(tmpdir(), "prep-meta-index-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = { metaKey: "k", elevenKey: "e", ttsModel: "m" } as unknown as import("../src/config.ts").Config;
  const off = createPrep(config, () => {}, { FAL_KEY: "fal", GENITA_PETER_PREPARE_URL: "http://p" }, new FileStore(dir));
  assert.equal(off.deps.kling, false);
  assert.equal(off.deps.falKey, null);
  assert.equal(off.deps.elevenKey, null);
  assert.equal(off.deps.voices, DEVICE_VOICES);
  const on = createPrep(config, () => {}, { FAL_KEY: "fal", GENITA_KLING: "1", GENITA_SERVER_TTS: "1", GENITA_PETER: "1" }, new FileStore(dir));
  assert.equal(on.deps.kling, true);
  assert.equal(on.deps.falKey, "fal");
  assert.equal(on.deps.elevenKey, "e");
  assert.ok(on.deps.voices[0].id && !on.deps.voices[0].id.startsWith("device:"));
});

test("runner (codex P1): companion deleted mid face step → stops, and the face images it wrote are removed", async (t) => {
  noNetwork(t);
  const dir = mkdtempSync(join(tmpdir(), "prep-meta-del-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new FileStore(dir);
  await store.putImage(imageRec(), fakePng(800, 1000, "upload"));
  await store.putCompanion(companion());
  const { media, calls } = fakeMedia({ keyOf, delayMs: 5 });
  // DELETE /me: rows go after the 3rd face image is written
  let puts = 0;
  const put = store.putAsset.bind(store);
  store.putAsset = async (u, c, n, b) => {
    await put(u, c, n, b);
    if (n !== "neutral" && ++puts === 3) {
      await store.patchCompanion("u1", (x) => x); // let queued writes land, then the row goes
      rmSync(join(dir, "companions", "u1.json"));
    }
  };
  const d: PrepDeps = { metaKey: "k", elevenKey: null, ttsModel: "m", falKey: null, store, voices: DEVICE_VOICES, log: () => {}, media };
  const runner = new PrepRunner(d, { peter: new ModalPeterBaker(null), atlas: new MouthAtlasBaker() });
  await runner.run("u1");
  assert.equal(await store.getCompanion("u1"), null);
  assert.ok(calls.edits.length < 14, `stopped early (${calls.edits.length} edits)`);
  for (const k of ["neutral", ...FACE_KEYS]) assert.equal(await store.getAsset("u1", "c1", k), null, `${k} removed`);
});

test("runner.cancel stops a face step without marking it failed", async (t) => {
  noNetwork(t);
  const dir = mkdtempSync(join(tmpdir(), "prep-meta-cancel-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new FileStore(dir);
  await store.putImage(imageRec(), fakePng(800, 1000, "upload"));
  await store.putCompanion(companion());
  const { media, calls } = fakeMedia({ keyOf, delayMs: 20 });
  const d: PrepDeps = { metaKey: "k", elevenKey: null, ttsModel: "m", falKey: null, store, voices: DEVICE_VOICES, log: () => {}, media };
  const runner = new PrepRunner(d, { peter: new ModalPeterBaker(null), atlas: new MouthAtlasBaker() });
  const p = runner.run("u1");
  await new Promise((r) => setTimeout(r, 30));
  runner.cancel("u1");
  await p;
  assert.equal(runner.isRunning("u1"), false);
  assert.ok(calls.edits.length < 14);
  assert.notEqual((await store.getCompanion("u1"))?.prep.status, "failed");
});

test("runner.forgetUser (account deleted): cancels, waits for the run, removes every face image of the user", async (t) => {
  noNetwork(t);
  const dir = mkdtempSync(join(tmpdir(), "prep-meta-forget-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new FileStore(dir);
  await store.putImage(imageRec(), fakePng(800, 1000, "upload"));
  await store.putCompanion(companion());
  const { media } = fakeMedia({ keyOf, delayMs: 10 });
  const d: PrepDeps = { metaKey: "k", elevenKey: null, ttsModel: "m", falKey: null, store, voices: DEVICE_VOICES, log: () => {}, media };
  const runner = new PrepRunner(d, { peter: new ModalPeterBaker(null), atlas: new MouthAtlasBaker() });
  // a run that already finished (the blob/row delete window) and one still going
  await runner.run("u1");
  assert.ok(await store.getAsset("u1", "c1", "A"));
  await store.patchCompanion("u1", (x) => ({ ...x, prep: newPrepState() }));
  const p = runner.run("u1");
  await new Promise((r) => setTimeout(r, 15));
  await runner.forgetUser("u1");
  assert.equal(runner.isRunning("u1"), false);
  await p;
  for (const k of ["neutral", ...FACE_KEYS]) assert.equal(await store.getAsset("u1", "c1", k), null, `${k} removed`);
});
