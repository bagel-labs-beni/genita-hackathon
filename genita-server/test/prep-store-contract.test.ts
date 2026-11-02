/** The same PrepStore contract on the JSON-file store and the Postgres store. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore, type CompanionRecord, type ImageRecord, type PrepStore } from "../src/prep/store.ts";
import { PgPrepStore } from "../src/prep/pgStore.ts";
import { FsBlobStore } from "../src/storage/blob.ts";
import { Accounts } from "../src/auth/accounts.ts";
import { newPrepState } from "../src/prep/runner.ts";
import { testDb } from "./helpers/db.ts";

async function contract(store: PrepStore, userId: string) {
  assert.equal(await store.getStyle(userId), null);
  const card = { source: "import", itemCount: 2, items: [{ k: "tone", v: "warm" }] } as any;
  await store.putStyle(userId, card);
  assert.deepEqual(await store.getStyle(userId), card);

  const img: ImageRecord = {
    id: "img_a1",
    userId,
    mime: "image/jpeg",
    bytes: 4,
    check: { passed: true, type: "human", checks: { sharp: true }, reasons: [] } as any,
    headBox: { x1: 1, y1: 2, x2: 3, y2: 4 } as any,
    rightsAck: true,
    createdAt: "2026-11-02T00:00:00.000Z",
    ms: { check: 12, sam: 30 },
  };
  await store.putImage(img, Buffer.from([1, 2, 3, 4]));
  const got = await store.getImage("img_a1");
  assert.deepEqual(got?.rec, img);
  assert.deepEqual([...got!.bytes], [1, 2, 3, 4]);
  assert.equal(await store.getImage("missing"), null);

  assert.equal(await store.getCompanion(userId), null);
  const c: CompanionRecord = { id: "comp_a1", userId, imageId: "img_a1", type: "human", voiceId: "v1", name: "Jin", createdAt: "2026-11-02T00:00:01.000Z", prep: newPrepState() };
  await store.putCompanion(c);
  const back = (await store.getCompanion(userId))!;
  assert.equal(back.name, "Jin");
  assert.equal(back.prep.status, "running");
  assert.equal(back.prefs, undefined);

  // two writers at once (runner + prefs route) must both land
  await Promise.all([
    store.patchCompanion(userId, (x) => ({ ...x, prep: { ...x.prep, steps: { ...x.prep.steps, videos: { ...x.prep.steps.videos, happy: { status: "done", attempts: 1, url: "https://cdn/h.mp4" } } } } })),
    store.patchCompanion(userId, (x) => ({ ...x, prefs: { depth: "right", answers: { help: "Think with me" } as any, updatedAt: "2026-11-02T00:00:02.000Z" }, persona: { card: { name: "Jin" }, rules: [], summary: { why: "a", energy: "b", initiative: "c", never: "d" }, depth: "right" } as any })),
  ]);
  const both = (await store.getCompanion(userId))!;
  assert.equal(both.prep.steps.videos.happy.url, "https://cdn/h.mp4");
  assert.equal(both.prefs?.depth, "right");
  assert.equal((both.persona as any).card.name, "Jin");
  assert.equal(await store.patchCompanion("00000000-0000-0000-0000-000000000000", (x) => x), null);

  const list = await store.listCompanions();
  assert.deepEqual(list.map((x) => x.id), ["comp_a1"]);

  assert.equal(await store.getVoicePreview("v1", "p1"), null);
  await store.putVoicePreview("v1", "p1", Buffer.from("mp3"));
  assert.equal((await store.getVoicePreview("v1", "p1"))?.toString(), "mp3");
}

/** D41 judge demo companion: the flag round-trips, and the companion can be removed so the user can make their own. */
async function demoContract(store: PrepStore, userId: string) {
  assert.equal((await store.getCompanion(userId))!.demo, undefined);
  await store.patchCompanion(userId, (x) => ({ ...x, demo: true }));
  assert.equal((await store.getCompanion(userId))!.demo, true);
  // replace swaps only the expected demo companion, never a real one
  const cur = (await store.getCompanion(userId))!;
  const mine = { ...cur, id: "comp_own", demo: undefined, name: "Mine" };
  assert.equal(await store.replaceDemoCompanion("other_id", mine), false);
  assert.equal((await store.getCompanion(userId))!.id, cur.id);
  assert.equal(await store.replaceDemoCompanion(cur.id, mine), true);
  assert.equal((await store.getCompanion(userId))!.name, "Mine");
  assert.equal((await store.getCompanion(userId))!.demo, undefined);
  assert.ok(await store.getImage(cur.imageId), "a photo the new companion reuses is kept");
  assert.equal(await store.replaceDemoCompanion("comp_own", { ...mine, id: "comp_x" }), false, "a real companion is never replaced");
  assert.equal(await store.deleteCompanion(userId), true);
  assert.equal(await store.getCompanion(userId), null);
  await store.deleteImage(userId, cur.imageId);
  assert.equal(await store.getImage(cur.imageId), null);
  assert.equal(await store.deleteCompanion(userId), false);
  assert.deepEqual(await store.listCompanions(), []);
}

test("PrepStore contract: FileStore", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prep-file-"));
  try {
    const store = new FileStore(dir);
    await contract(store, "user_1");
    await demoContract(store, "user_1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PrepStore contract: PgPrepStore (Postgres + blobs), emotions table follows the clips", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prep-pg-"));
  const db = await testDb();
  try {
    const { user } = await new Accounts(db).upsertUser({ provider: "dev", sub: "contract" });
    const store = new PgPrepStore(db, new FsBlobStore(dir));
    await contract(store, user.id);
    const em = await db.query("SELECT emotion, video_url FROM companion_emotions");
    assert.deepEqual(em.rows, [{ emotion: "happy", video_url: "https://cdn/h.mp4" }]);
    const job = await db.query("SELECT status, attempts FROM clip_jobs");
    assert.deepEqual(job.rows, [{ status: "running", attempts: 0 }]);
    await demoContract(store, user.id);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PgPrepStore.deleteCompanion: drops the companion's rows, its photo and its files, nothing else of the user", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prep-pg-del-"));
  const db = await testDb();
  try {
    const { user } = await new Accounts(db).upsertUser({ provider: "dev", sub: "del" });
    const blobs = new FsBlobStore(dir);
    const store = new PgPrepStore(db, blobs);
    const img = { id: "img_d1", userId: user.id, mime: "image/jpeg", bytes: 4, check: { passed: true, type: "human" } as any, headBox: null as any, rightsAck: true, createdAt: "2026-11-02T00:00:00.000Z", ms: {} } as ImageRecord;
    await store.putImage(img, Buffer.from([1, 2, 3, 4]));
    await store.putCompanion({ id: "comp_d1", userId: user.id, imageId: "img_d1", type: "human", voiceId: "v1", name: "Jin", createdAt: "2026-11-02T00:00:01.000Z", prep: newPrepState() });
    await blobs.put(`users/${user.id}/companions/comp_d1/face/blink`, Buffer.from("b"), "image/webp");
    await blobs.put(`users/${user.id}/memory/keep`, Buffer.from("m"), "application/octet-stream");
    assert.equal(await store.deleteCompanion(user.id), true);
    assert.equal(await store.getImage("img_d1"), null);
    assert.deepEqual(await blobs.list(`users/${user.id}/companions/`), []);
    assert.deepEqual(await blobs.list(`users/${user.id}/images/`), []);
    assert.deepEqual(await blobs.list(`users/${user.id}/memory/`), [`users/${user.id}/memory/keep`]);
    const left = await db.query("SELECT (SELECT count(*)::int FROM companions) AS c, (SELECT count(*)::int FROM clip_jobs) AS j, (SELECT count(*)::int FROM companion_images) AS i");
    assert.deepEqual(left.rows[0], { c: 0, j: 0, i: 0 });
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PgPrepStore: a photo whose DB row can't be written (account deleted mid-upload) leaves no blob", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prep-pg-orphan-"));
  const db = await testDb();
  try {
    const ghost = "00000000-0000-0000-0000-00000000dead"; // no users row → FK fails
    const store = new PgPrepStore(db, new FsBlobStore(dir));
    const img = { id: "img_orphan", userId: ghost, mime: "image/jpeg", bytes: 4, check: { passed: true } as any, headBox: null as any, rightsAck: true, createdAt: "2026-11-02T00:00:00.000Z", ms: {} } as ImageRecord;
    await assert.rejects(store.putImage(img, Buffer.from([1, 2, 3, 4])));
    assert.equal(existsSync(join(dir, "users", ghost, "images", "img_orphan")), false, "blob removed when the row fails");
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
