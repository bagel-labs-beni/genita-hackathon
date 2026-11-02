/**
 * D41 judge demo companion: a judge's first sign-in gets a ready "Jin" copied from the
 * reserved template (scripts/demo-template.ts), so the first call needs no prep wait.
 * Real server (startServer) + PGlite + file blobs; the template is written straight into the store.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { startServer, defaultDeps } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { createAccounts, type AccountsService } from "../src/auth/index.ts";
import { newPrepState } from "../src/prep/runner.ts";
import { DEFAULT_VOICES } from "../src/prep/voices.ts";
import { interpretCheck } from "../src/prep/classify.ts";
import { DEMO_NAME, DEMO_TEMPLATE_SUB, seedDemoCompanion } from "../src/prep/demo.ts";
import type { ImageRecord } from "../src/prep/store.ts";
import { testDb } from "./helpers/db.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const CHECK = interpretCheck({ subject: "person", face_count: 1, front_facing: true, face_covered: false, sharp: true, well_lit: true, text_on_image: false });

const image = (id: string, userId: string): ImageRecord => ({
  id,
  userId,
  mime: "image/jpeg",
  bytes: JPEG.length,
  check: CHECK,
  headBox: null,
  rightsAck: true,
  createdAt: "2026-11-02T00:00:00.000Z",
  ms: { check: 1, sam: 1 },
});

/** The template as `npm run demo:template` leaves it: ready prep, persona, face files under its companion. */
async function makeTemplate(a: AccountsService, files: Record<string, Buffer> = { "face/blink": Buffer.from("BLINK"), "face/A": Buffer.from("VISEME-A") }) {
  const { user } = await a.accounts.upsertUser({ provider: "dev", sub: DEMO_TEMPLATE_SUB, displayName: "Demo template" });
  await a.prepStore.putImage(image("tplimg", user.id), JPEG);
  const prep = { ...newPrepState(), status: "ready" as const, readyAt: "2026-11-02T00:01:00.000Z" };
  await a.prepStore.putCompanion({
    id: "tplcomp",
    userId: user.id,
    imageId: "tplimg",
    type: "human",
    voiceId: DEFAULT_VOICES[0].id,
    name: DEMO_NAME,
    createdAt: "2026-11-02T00:00:30.000Z",
    prep,
    prefs: { depth: "quick", answers: { help: "Think with me", relationship: "Close companion", presence: ["Warm"] }, updatedAt: "2026-11-02T00:01:00.000Z" },
    persona: { card: { name: DEMO_NAME }, rules: [], summary: { why: "a", energy: "b", initiative: "c", never: "d" }, depth: "quick" } as any,
  });
  for (const [k, v] of Object.entries(files)) await a.blobs.put(`users/${user.id}/companions/tplcomp/${k}`, v, "image/webp");
  return user.id;
}

async function boot(t: import("node:test").TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "genita-judge-demo-"));
  const env: NodeJS.ProcessEnv = { GENITA_DATA_DIR: dir, GENITA_JWT_SECRET: "j".repeat(40), GENITA_AUTH_RATE_PER_MIN: "1000", GENITA_JUDGE_CODES: "alpha=correct-horse-1,beta=battery-staple-2" };
  const config = { ...loadConfig({ MODEL_API_KEY: "m" }), port: 0 };
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const log = (event: string, data: Record<string, unknown>) => events.push({ event, data });
  const accounts = (await createAccounts(env, log, { loopback: true, db: await testDb() }))!;
  const server = await startServer(config, log, defaultDeps(config, log), env, accounts);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => setTimeout(r, 50));
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  const signIn = async (code = "correct-horse-1") => {
    const r = await call("POST", "/auth/judge", undefined, { code });
    assert.equal(r.status, 200);
    await call("POST", "/me/consent", r.body.token, {});
    return r.body as { token: string; user: { id: string } } & Record<string, any>;
  };
  return { accounts, call, signIn, events };
}

test("judge first sign-in: a ready demo Jin, copied into the judge's own files", async (t) => {
  const { accounts, call, signIn, events } = await boot(t);
  const tpl = await makeTemplate(accounts);
  const s = await signIn();
  assert.equal(s.hasCompanion, true, "the sign-in body already shows the companion");
  assert.equal(s.prepStatus, "ready");
  assert.equal(s.companionDemo, true);

  const me = await call("GET", "/me", s.token);
  assert.equal(me.body.companionDemo, true);
  const c = await call("GET", "/v1/companion", s.token);
  assert.equal(c.status, 200);
  assert.equal(c.body.demo, true);
  assert.equal(c.body.name, "Jin");
  assert.equal(c.body.prep.status, "ready");
  assert.notEqual(c.body.id, "tplcomp");
  assert.notEqual(c.body.imageId, "tplimg");
  assert.ok(c.body.session, "persona copied: the call can start right away");

  // the copies live under the judge, so DELETE /me can take them without touching the template
  const blobs = accounts.blobs;
  assert.equal((await blobs.get(`users/${s.user.id}/companions/${c.body.id}/face/blink`))?.toString(), "BLINK");
  assert.equal((await blobs.get(`users/${s.user.id}/companions/${c.body.id}/face/A`))?.toString(), "VISEME-A");
  assert.deepEqual([...(await accounts.prepStore.getImage(c.body.imageId))!.bytes], [...JPEG]);
  assert.equal((await accounts.prepStore.getImage(c.body.imageId))!.rec.userId, s.user.id);
  assert.equal((await accounts.prepStore.getCompanion(tpl))!.id, "tplcomp", "template untouched");
  assert.ok(events.some((e) => e.event === "demo.seeded" && e.data.files === 2 && typeof e.data.ms === "number"));
});

test("seed is idempotent: signing in again (or twice at once) keeps one demo companion", async (t) => {
  const { accounts, call, signIn } = await boot(t);
  await makeTemplate(accounts);
  const [a, b] = await Promise.all([signIn(), signIn()]);
  const first = (await call("GET", "/v1/companion", a.token)).body.id;
  assert.equal((await call("GET", "/v1/companion", b.token)).body.id, first);
  const again = await signIn();
  assert.equal((await call("GET", "/v1/companion", again.token)).body.id, first);
  const n = await accounts.db.query("SELECT count(*)::int AS n FROM companions WHERE user_id = $1", [a.user.id]);
  assert.equal(n.rows[0].n, 1);
  const imgs = await accounts.db.query("SELECT count(*)::int AS n FROM companion_images WHERE user_id = $1", [a.user.id]);
  assert.equal(imgs.rows[0].n, 1, "no orphan photo copies");
});

test("no template yet: the judge signs in like a new user (normal onboarding), the skip is logged", async (t) => {
  const { call, signIn, events } = await boot(t);
  const s = await signIn();
  assert.equal(s.hasCompanion, false);
  assert.equal(s.companionDemo, false);
  assert.equal((await call("GET", "/v1/companion", s.token)).status, 404);
  assert.ok(events.some((e) => e.event === "demo.skipped" && e.data.reason === "no_template"));
});

test("DELETE /me of a judge removes the copies, never the template's rows or files", async (t) => {
  const { accounts, call, signIn } = await boot(t);
  const tpl = await makeTemplate(accounts);
  const s = await signIn();
  const del = await call("DELETE", "/me", s.token);
  assert.equal(del.status, 200);
  assert.deepEqual(await accounts.blobs.list(`users/${s.user.id}/`), []);
  assert.equal((await accounts.blobs.get(`users/${tpl}/companions/tplcomp/face/blink`))?.toString(), "BLINK");
  assert.ok(await accounts.prepStore.getImage("tplimg"));
  assert.equal((await accounts.prepStore.getCompanion(tpl))?.prep.status, "ready");
});

test("a judge makes their own companion: POST /v1/companion replaces the demo one (once); a real one still 409s", async (t) => {
  const { accounts, call, signIn } = await boot(t);
  await makeTemplate(accounts);
  const s = await signIn();
  const demo = (await call("GET", "/v1/companion", s.token)).body;
  await accounts.prepStore.putImage(image("mine1", s.user.id), JPEG);

  // a bad request must not cost the judge the demo companion
  assert.equal((await call("POST", "/v1/companion", s.token, { imageId: "mine1", voiceId: "nope" })).body.error, "unknown_voice");
  assert.equal((await call("GET", "/v1/companion", s.token)).body.id, demo.id);

  const made = await call("POST", "/v1/companion", s.token, { imageId: "mine1", voiceId: DEFAULT_VOICES[1].id, name: "Mina" });
  assert.equal(made.status, 201);
  assert.equal(made.body.demo, false);
  assert.equal(made.body.name, "Mina");
  assert.notEqual(made.body.id, demo.id);
  assert.deepEqual(await accounts.blobs.list(`users/${s.user.id}/companions/${demo.id}/`), [], "demo copies dropped");
  assert.equal(await accounts.prepStore.getImage(demo.imageId), null);
  assert.equal((await call("GET", "/me", s.token)).body.companionDemo, false);

  await accounts.prepStore.putImage(image("mine2", s.user.id), JPEG);
  const again = await call("POST", "/v1/companion", s.token, { imageId: "mine2", voiceId: DEFAULT_VOICES[1].id });
  assert.equal(again.status, 409, "B7: one companion per user once it is their own");
  // signing in again does not bring the demo back
  const back = await signIn();
  assert.equal((await call("GET", "/v1/companion", back.token)).body.name, "Mina");
});

test("the template account can't be reached from outside: x-genita-user can't name it", async (t) => {
  const { accounts, call } = await boot(t);
  await makeTemplate(accounts);
  const r = await call("GET", "/v1/companion", undefined, undefined, { "x-genita-user": DEMO_TEMPLATE_SUB });
  assert.equal(r.status, 401);
  const plain = await call("GET", "/v1/companion", undefined, undefined, { "x-genita-user": "demo-template" });
  assert.equal(plain.status, 404, "a look-alike dev name is a different, empty user");
});

test("seed copy is bounded: a template with too many or too large files is skipped, nothing half-copied", async (t) => {
  const { accounts, events } = await boot(t);
  const files: Record<string, Buffer> = {};
  for (let i = 0; i < 5; i++) files[`face/k${i}`] = Buffer.alloc(10, i);
  await makeTemplate(accounts, files);
  const { user } = await accounts.accounts.upsertUser({ provider: "dev", sub: "judge:x" });
  const d = { store: accounts.prepStore, blobs: accounts.blobs, templateUserId: () => accounts.accounts.findUserId("dev", DEMO_TEMPLATE_SUB), log: (e: string, x: Record<string, unknown>) => events.push({ event: e, data: x }) };
  assert.equal((await seedDemoCompanion(d, user.id, { maxFiles: 4 })).reason, "template_too_big");
  assert.equal((await seedDemoCompanion(d, user.id, { maxBytes: 30 })).reason, "template_too_big");
  assert.deepEqual(await accounts.blobs.list(`users/${user.id}/`), []);
  assert.equal(await accounts.prepStore.getCompanion(user.id), null);
  const ok = await seedDemoCompanion(d, user.id);
  assert.equal(ok.seeded, true);
  assert.equal(ok.files, 5);
});
