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
import { interpretCheck } from "../src/prep/classify.ts";
import type { PrepDeps } from "../src/prep/pipeline.ts";

/** Routes with a real file store and no vendor keys: covers everything that does not call a model.  */
test("prep routes (clip compatibility): prompt, validation, one companion per user, prefs → persona", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "prep-routes-"));
  const store = new FileStore(dir);
  const d: PrepDeps = { metaKey: "", falKey: null, store, voices: DEFAULT_VOICES, log: () => {}, kling: true };
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
  assert.equal(created.json.name, "Mira"); // card name = companion name
  assert.equal(created.json.type, "human");
  assert.equal((await call("POST", "/v1/companion", { imageId: "img1", voiceId: DEFAULT_VOICES[1].id })).status, 409);
  await runner.run("u1"); // GENITA_KLING=1 without FAL_KEY → every attempt fails (the default Meta-only path is in prep-meta.test.ts)
  const prep = await call("GET", "/v1/companion/prep");
  assert.equal(prep.json.status, "failed");
  assert.equal(prep.json.progress.total, 5);

  assert.equal((await call("POST", "/v1/companion/prefs", { depth: "quick", answers: { help: "Be there" } })).json.error, "bad_prefs");
  // no Meta key → Spark fails → deterministic persona fallback still answers
  const prefs = await call("POST", "/v1/companion/prefs", { depth: "quick", answers: { help: "Be there", relationship: "Close companion", presence: ["Calm"] } });
  assert.equal(prefs.status, 200);
  assert.equal(prefs.json.persona.name, "Mira");
  assert.equal(prefs.json.summary.never, "Nothing off-limits yet.");
  assert.deepEqual(Object.keys(prefs.json.summary), ["why", "energy", "initiative", "never"]);
  assert.equal(prefs.json.session.voiceId, DEFAULT_VOICES[1].id);
  // Human face sets animate on the device.
  assert.equal(prefs.json.session.lip, "none");
  // persona survives a later prep write
  const after = await call("GET", "/v1/companion");
  assert.equal(after.json.persona.card.name, "Mira");
  assert.equal(after.json.prep.status, "failed");
});
