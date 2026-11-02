import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { FileStore, type ImageRecord } from "../src/prep/store.ts";
import { createPrepRoutes } from "../src/prep/routes.ts";
import { PrepRunner, newPrepState } from "../src/prep/runner.ts";
import { savePrefs } from "../src/prep/pipeline.ts";
import { DEFAULT_VOICES } from "../src/prep/voices.ts";
import { interpretCheck } from "../src/prep/classify.ts";
import type { PrepDeps } from "../src/prep/pipeline.ts";

/** Routes with a real file store; upstream failures exercise the local fallback. */
test("prep routes: prompt, validation, one companion per user, prefs → persona", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "prep-routes-"));
  const store = new FileStore(dir);
  const d: PrepDeps = { metaKey: "", store, voices: DEFAULT_VOICES, log: () => {} };
  const runner = new PrepRunner(d);
  const routes = createPrepRoutes(d, runner);
  const http = createServer((req, res) => (routes.handles(req) ? void routes.handle(req, res) : (res.writeHead(404), res.end())));
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.startsWith(base + "/") ? realFetch(input, init) : Promise.resolve(new Response("stubbed upstream failure", { status: 503 }));
  });
  t.after(() => {
    http.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (method: string, path: string, body?: unknown, user = "u1") => {
    const r = await fetch(base + path, { method, headers: { "x-genita-user": user, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };

  const p = await call("GET", "/v1/import/prompt");
  assert.equal(p.status, 200);
  assert.match(p.json.prompt, /^Create an evidence-based personalization profile for Genita/);

  assert.equal((await call("POST", "/v1/import", { text: "short" })).json.error, "import_too_short");
  assert.equal((await call("GET", "/v1/import")).json.status, "none");
  assert.equal((await call("GET", "/v1/import/prompt", undefined, "bad user!")).status, 400);
  assert.equal((await call("GET", "/v1/companion")).status, 404);
  assert.equal((await call("POST", "/v1/companion", { imageId: "nope", voiceId: DEFAULT_VOICES[0].id })).json.error, "unknown_image");

  // a checked image, as checkImage would have stored it
  const rec: ImageRecord = {
    id: "img1",
    userId: "u1",
    mime: "image/jpeg",
    bytes: 3,
    check: interpretCheck({ subject: "person", face_count: 1, front_facing: true, face_covered: false, sharp: true, well_lit: true, text_on_image: false }),
    headBox: null,
    rightsAck: true,
    createdAt: new Date().toISOString(),
    ms: { check: 1, sam: 1 },
  };
  await store.putImage(rec, Buffer.from([0xff, 0xd8, 0xff]));
  assert.equal((await call("POST", "/v1/companion", { imageId: "img1", voiceId: "nope" })).json.error, "unknown_voice");
  assert.equal((await call("POST", "/v1/companion", { imageId: "img1", voiceId: DEFAULT_VOICES[1].id }, "u2")).json.error, "unknown_image"); // other user's image

  const created = await call("POST", "/v1/companion", { imageId: "img1", voiceId: DEFAULT_VOICES[1].id });
  assert.equal(created.status, 201);
  assert.equal(created.json.name, "Leah"); // card name = companion name
  assert.equal(created.json.type, "human");
  assert.equal((await call("POST", "/v1/companion", { imageId: "img1", voiceId: DEFAULT_VOICES[1].id })).status, 409);
  await runner.run("u1"); // fake input has no usable scene; route validation remains available
  const prep = await call("GET", "/v1/companion/prep");
  assert.equal(prep.json.status, "failed");
  assert.equal(prep.json.progress.total, 14);

  assert.equal((await call("POST", "/v1/companion/prefs", { depth: "quick", answers: { help: "Be there" } })).json.error, "bad_prefs");
  // no Meta key → Spark fails → deterministic persona fallback still answers
  const prefs = await call("POST", "/v1/companion/prefs", { depth: "quick", answers: { help: "Be there", relationship: "Close companion", presence: ["Calm"] } });
  assert.equal(prefs.status, 200);
  assert.equal(prefs.json.persona.name, "Leah");
  assert.equal(prefs.json.summary.never, "Nothing off-limits yet.");
  assert.deepEqual(Object.keys(prefs.json.summary), ["why", "energy", "initiative", "never"]);
  assert.equal(prefs.json.session.voiceId, DEFAULT_VOICES[1].id);
  // V04 save: PUT /v1/companion/voice changes the companion and the persona card, rejects ids outside the list
  assert.equal((await call("PUT", "/v1/companion/voice", { voiceId: "nope" })).json.error, "unknown_voice");
  assert.equal((await call("PUT", "/v1/companion/voice", { voiceId: DEFAULT_VOICES[2].id }, "nobody")).json.error, "no_companion");
  const picked = await call("PUT", "/v1/companion/voice", { voiceId: DEFAULT_VOICES[2].id });
  assert.equal(picked.status, 200);
  assert.equal(picked.json.voiceId, DEFAULT_VOICES[2].id);
  assert.equal((await call("GET", "/v1/companion")).json.session.voiceId, DEFAULT_VOICES[2].id);
  assert.equal(((await store.getCompanion("u1"))!.persona!.card as any).voice.id, DEFAULT_VOICES[2].id);
  // Human face sets animate on the device.
  assert.equal(prefs.json.session.lip, "none");
  // persona survives a later prep write
  const after = await call("GET", "/v1/companion");
  assert.equal(after.json.persona.card.name, "Leah");
  assert.equal(after.json.prep.status, "failed");
});

/** F2-L26 naming routes: suggest (Spark faked), PATCH validation, rename reaches the persona, rate limit. */
test("prep routes: name suggest + PATCH /v1/companion {name}", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "prep-naming-"));
  const store = new FileStore(dir);
  let sparkCalls = 0;
  const logs: string[] = [];
  const d: PrepDeps = {
    metaKey: "",
    store,
    voices: DEFAULT_VOICES,
    log: (event) => logs.push(event),
    spark: async () => {
      sparkCalls++;
      return { name: "Jin" } as never;
    },
  };
  const runner = new PrepRunner(d);
  const routes = createPrepRoutes(d, runner);
  const http = createServer((req, res) => (routes.handles(req) ? void routes.handle(req, res) : (res.writeHead(404), res.end())));
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  t.after(() => {
    http.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (method: string, path: string, body?: unknown, user = "u1") => {
    const r = await fetch(base + path, { method, headers: { "x-genita-user": user, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
  const rec: ImageRecord = {
    id: "img1",
    userId: "u1",
    mime: "image/jpeg",
    bytes: 3,
    check: interpretCheck({ subject: "person", face_count: 1, front_facing: true, face_covered: false, sharp: true, well_lit: true, text_on_image: false }),
    headBox: null,
    rightsAck: true,
    createdAt: new Date().toISOString(),
    ms: { check: 1, sam: 1 },
  };
  await store.putImage(rec, Buffer.from([0xff, 0xd8, 0xff]));

  // suggest works before a companion exists (NM01 comes before POST /v1/companion's prep finishes)
  const s = await call("POST", "/v1/companion/name/suggest", { imageId: "img1" });
  assert.equal(s.status, 200);
  assert.equal(s.json.name, "Jin");
  assert.equal(typeof s.json.ms, "number");
  assert.equal((await call("POST", "/v1/companion/name/suggest", { imageId: "img1" }, "u2")).status, 404, "someone else's image");
  assert.equal((await call("POST", "/v1/companion/name/suggest", {})).json.error, "unknown_image");

  // POST /v1/companion: the same 20-char rule
  assert.equal((await call("POST", "/v1/companion", { imageId: "img1", voiceId: DEFAULT_VOICES[0].id, name: "x".repeat(21) })).json.error, "bad_name");
  const created = await call("POST", "/v1/companion", { imageId: "img1", voiceId: DEFAULT_VOICES[0].id, name: "  Jin " });
  assert.equal(created.status, 201);
  assert.equal(created.json.name, "Jin");
  assert.equal(logs.filter((event) => event === "companion.named").length, 1, "one naming log on creation");
  assert.equal(logs.filter((event) => event === "companion.created").length, 1);

  // PATCH: empty / whitespace-only / 21+ chars / missing → 400 bad_name
  for (const name of ["", "   ", "x".repeat(21), undefined, 7]) {
    const r = await call("PATCH", "/v1/companion", name === undefined ? {} : { name });
    assert.equal(r.status, 400, JSON.stringify(name));
    assert.equal(r.json.error, "bad_name");
  }
  assert.equal((await call("PATCH", "/v1/companion", { name: "Max" }, "u3")).status, 404, "no companion");
  assert.equal(logs.filter((event) => event === "companion.named").length, 1, "failed renames do not log success");

  await call("POST", "/v1/companion/prefs", { depth: "quick", answers: { help: "Be there", relationship: "Close companion", presence: ["Calm"] } });
  const patched = await call("PATCH", "/v1/companion", { name: "  Max  " });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.name, "Max");
  assert.equal(logs.filter((event) => event === "companion.named").length, 2, "one additional naming log on app rename");
  const after = await call("GET", "/v1/companion");
  assert.equal(after.json.name, "Max");
  assert.equal(after.json.persona.card.name, "Max");
  assert.equal(after.json.session.persona.name, "Max", "the next call's start.persona carries the new name");

  // suggest is a Spark call: 10 per minute per user, then 429
  const before = sparkCalls;
  let limited = 0;
  for (let i = 0; i < 12; i++) if ((await call("POST", "/v1/companion/name/suggest", { imageId: "img1" })).status === 429) limited++;
  assert.ok(limited >= 2, `limited ${limited}`);
  assert.ok(sparkCalls - before <= 10);
  assert.equal((await call("POST", "/v1/companion/name/suggest", { imageId: "img1" }, "u2")).status, 404, "another user has their own budget");
});

test("prefs (Codex P2): a rename that lands while the persona is being written is not overwritten", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "prep-prefs-race-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new FileStore(dir);
  const d: PrepDeps = { metaKey: "", store, voices: DEFAULT_VOICES, log: () => {} };
  const stale = { id: "c1", userId: "u1", imageId: "img1", type: "human" as const, voiceId: DEFAULT_VOICES[0].id, name: "Jin", createdAt: new Date().toISOString(), prep: newPrepState() };
  await store.putCompanion({ ...stale, name: "Max" }); // PATCH landed after savePrefs read the record
  const next = await savePrefs(d, stale, "quick", { help: "Be there", relationship: "Close companion", presence: ["Calm"] });
  assert.equal(next.name, "Max");
  assert.equal(next.persona?.card.name, "Max");
});

test("POST /v1/import/skip: N1–N3 → style card, no vendor call, readable via GET /v1/import", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "prep-skip-"));
  const store = new FileStore(dir);
  const d: PrepDeps = { metaKey: "", store, voices: DEFAULT_VOICES, log: () => {} };
  const routes = createPrepRoutes(d, new PrepRunner(d));
  const http = createServer((req, res) => (routes.handles(req) ? void routes.handle(req, res) : (res.writeHead(404), res.end())));
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  t.after(() => {
    http.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (method: string, path: string, body?: unknown, user = "u1") => {
    const r = await fetch(base + path, { method, headers: { "x-genita-user": user, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };

  for (const bad of [{ interests: "Design" }, { interests: Array(9).fill("a") }, { avoid: ["x".repeat(61)] }, { replies: "nope" }, {}]) {
    const r = await call("POST", "/v1/import/skip", bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.json.error, "bad_skip");
  }
  assert.equal((await call("GET", "/v1/import")).json.status, "none"); // nothing stored by bad calls

  const ok = await call("POST", "/v1/import/skip", { interests: ["Design", "Food"], replies: "Talk it out", avoid: ["Unasked advice"] });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.status, "ready");
  assert.equal(ok.json.style.source, "skip");
  assert.equal(ok.json.style.display.length, 6);
  assert.equal(ok.json.style.partial, true);
  assert.deepEqual(ok.json.style.display.map((r: any) => r.items.length), [0, 1, 0, 2, 0, 1]);
  assert.match(ok.json.profile, /Interests: Design/);
  const got = await call("GET", "/v1/import");
  assert.equal(got.json.status, "ready");
  assert.equal(got.json.style.source, "skip");

  // only N2 answered
  const only = await call("POST", "/v1/import/skip", { replies: "Start with the answer" }, "u2");
  assert.equal(only.status, 200);
  assert.deepEqual(only.json.style.display.map((r: any) => r.items.length), [0, 1, 0, 0, 0, 0]);
  assert.equal(only.json.style.toConfirm.length, 4);
});
