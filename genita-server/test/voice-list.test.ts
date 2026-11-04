import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { FileStore, type ImageRecord } from "../src/prep/store.ts";
import { createPrepRoutes } from "../src/prep/routes.ts";
import { PrepRunner } from "../src/prep/runner.ts";
import { DEFAULT_VOICES, voicesForKind } from "../src/prep/voices.ts";
import { resetVoiceProbe, type PrepDeps } from "../src/prep/pipeline.ts";
import { interpretCheck } from "../src/prep/classify.ts";
import type { VoiceConfig } from "../src/config.ts";

// 11/3 (Chelsea): four voices in total, 2 women + 2 men, the same four for every look (11/3 naturalness sweep)
test("voices: the same four for every look, two women and two men, names match the voice, Tara first", () => {
  for (const kind of ["human", "animal", "character", null] as const) {
    const list = voicesForKind(DEFAULT_VOICES, kind);
    assert.deepEqual(list.map((v) => v.name), ["Tara", "Leah", "Leo", "Dan"], `${kind}: names as in the Figma V04 frames`);
    assert.deepEqual(list.map((v) => v.id), ["72", "9", "19", "26"]);
  }
  assert.deepEqual(DEFAULT_VOICES.map((v) => v.gender), ["female", "female", "male", "male"]);
  for (const v of DEFAULT_VOICES) {
    assert.ok(Number(v.id) >= 0 && Number(v.id) < 200 && v.name.length >= 2 && v.name.length <= 5);
    assert.ok(v.blurb.endsWith(`(${v.gender})`) && v.tags.startsWith(`${v.gender},`), `${v.name}: card shows the measured gender`);
  }
  assert.equal(new Set(DEFAULT_VOICES.map((v) => v.id)).size, 4, "ids are unique");
  // GENITA_VOICES overrides show for every look
  assert.equal(voicesForKind([{ id: "a", name: "A", blurb: "", tags: "" }], "animal").length, 1);
});

test("GET /v1/companion/voices: list for the image's look, available follows the voice service", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "voice-list-"));
  const store = new FileStore(dir);
  let up = true;
  const svc: Server = createServer((req, res) => (req.url === "/healthz" && up ? (res.writeHead(200), res.end('{"ok":true}')) : (res.writeHead(503), res.end())));
  await new Promise<void>((r) => svc.listen(0, "127.0.0.1", r));
  const voice: VoiceConfig = { url: `http://127.0.0.1:${(svc.address() as AddressInfo).port}`, token: "t", speakers: { human: 72, animal: 16, character: 68 }, speed: 1, timeoutMs: 1000, model: "seamless" };
  const d: PrepDeps = { metaKey: "", store, voice, voices: DEFAULT_VOICES, log: () => {} };
  const routes = createPrepRoutes(d, new PrepRunner(d));
  const http = createServer((req, res) => (routes.handles(req) ? void routes.handle(req, res) : (res.writeHead(404), res.end())));
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  t.after(() => { http.close(); svc.close(); rmSync(dir, { recursive: true, force: true }); resetVoiceProbe(); });

  const rec: ImageRecord = {
    id: "img1", userId: "u1", mime: "image/jpeg", bytes: 3,
    check: interpretCheck({ subject: "animal", face_count: 1, front_facing: true, face_covered: false, sharp: true, well_lit: true, text_on_image: false }),
    headBox: null, rightsAck: true, createdAt: new Date().toISOString(), ms: { check: 1, sam: 1 },
  };
  await store.putImage(rec, Buffer.from([0xff, 0xd8, 0xff]));
  const get = async (q: string) => (await (await fetch(`${base}/v1/companion/voices${q}`, { headers: { "x-genita-user": "u1" } })).json()) as Record<string, any>;

  const a = await get("?imageId=img1");
  assert.equal(rec.check.type, "animal");
  assert.equal(a.suggested, "72", "an animal look gets the same four voices");
  assert.equal(a.available, true);
  assert.equal(a.voices[0].label, "Tara · warm");
  assert.equal(a.voices[0].gender, "female");
  assert.deepEqual(a.voices.map((v: { gender: string }) => v.gender), ["female", "female", "male", "male"]);
  assert.equal(a.voices[0].previewUrl, "/v1/companion/voices/72/preview");
  assert.equal(a.voices.length, 4);

  assert.equal((await get("")).suggested, "72", "no image → human list");

  up = false;
  resetVoiceProbe();
  const down = await get("?imageId=img1");
  assert.equal(down.available, false);
  assert.equal(down.voices.length, a.voices.length, "list still comes back so the app can show it greyed");

  // preview: not cached and the service is not configured → 503 voice_unavailable
  const noSvc: PrepDeps = { ...d, voice: null };
  const r2 = createPrepRoutes(noSvc, new PrepRunner(noSvc));
  const h2 = createServer((req, res) => void r2.handle(req, res));
  await new Promise<void>((r) => h2.listen(0, "127.0.0.1", r));
  t.after(() => h2.close());
  const p = await fetch(`http://127.0.0.1:${(h2.address() as AddressInfo).port}/v1/companion/voices/72/preview`, { headers: { "x-genita-user": "u1" } });
  assert.equal(p.status, 503);
  assert.equal(((await p.json()) as any).error, "voice_unavailable");
});
