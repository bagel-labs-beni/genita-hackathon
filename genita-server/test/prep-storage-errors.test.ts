import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { FileStore, type CompanionRecord } from "../src/prep/store.ts";
import { MAX_PREP_ATTEMPTS, PrepRunner, newPrepState } from "../src/prep/runner.ts";
import { createPrepRoutes } from "../src/prep/routes.ts";
import { interpretCheck } from "../src/prep/classify.ts";
import { DEVICE_VOICES } from "../src/prep/voices.ts";
import { FACE_CONCURRENCY, FACE_KEYS, faceEditPrompt } from "../src/prep/face.ts";
import { SCENE_PROMPT } from "../src/prep/prompts.ts";
import { fakeMedia, fakePng } from "./helpers/fakeMedia.ts";

const keyOf = (p: string) => p === SCENE_PROMPT.human ? "scene" : FACE_KEYS.find((k) => faceEditPrompt(k, "human", false) === p) ?? "x";

async function stopped(runner: PrepRunner) {
  for (let i = 0; i < 200 && runner.isRunning("u1"); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(runner.isRunning("u1"), false, "a storage outage must stop, without a hot retry loop");
  await new Promise((r) => setImmediate(r)); // allow unhandledRejection to fire
}

for (const fault of ["source read", "scene read", "scene write", "face write", "step save", "cap save"] as const) {
  test(`prep storage: ${fault} stops without marking failed or losing saved assets`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "prep-pass-storage-"));
    const store = new FileStore(dir);
    const { media, calls } = fakeMedia({ keyOf });
    const logs: string[] = [];
    const runner = new PrepRunner({ metaKey: "fake", store, voices: [], media, log: (event) => { logs.push(event); } });
    const unhandled = (err: unknown) => assert.fail(`unhandled prep rejection: ${String(err)}`);
    process.once("unhandledRejection", unhandled);
    t.after(async () => {
      runner.cancel("u1");
      await stopped(runner);
      process.removeListener("unhandledRejection", unhandled);
      rmSync(dir, { recursive: true, force: true });
    });
    const prep = newPrepState();
    const reuse = fault === "scene read" || fault === "face write";
    if (reuse) prep.steps.scene = { status: "done", attempts: 1, url: "/v1/companion/face/neutral" };
    if (fault === "cap save") prep.attempts = MAX_PREP_ATTEMPTS;
    await store.putCompanion({ id: "c1", userId: "u1", imageId: "img1", type: "human", voiceId: "v", name: "Mira", createdAt: new Date().toISOString(), prep });
    const savedScene = fakePng(1000, 2000, "scene");
    if (reuse) await store.putAsset("u1", "c1", "neutral", savedScene);
    const get = store.getCompanion.bind(store);
    let before: CompanionRecord | null = null;
    let failures = 0;
    const fail = async () => {
      failures++;
      before = await get("u1");
      throw new Error("DB_CONNECTION_RESET");
    };
    if (fault === "source read") t.mock.method(store, "getImage", fail);
    else if (fault === "scene read") t.mock.method(store, "getAsset", fail);
    else if (fault === "scene write" || fault === "face write") t.mock.method(store, "putAsset", fail);
    else {
      const patch = store.patchCompanion.bind(store);
      let patches = 0;
      t.mock.method(store, "patchCompanion", async (...args: Parameters<typeof patch>) => {
        if (++patches === (fault === "cap save" ? 1 : 2)) return fail();
        return patch(...args);
      });
    }
    if (fault === "scene write") {
      // The source is only needed in this case; other cases fail before it is read.
      t.mock.method(store, "getImage", async () => ({ bytes: fakePng(800, 1000, "upload"), rec: { mime: "image/png" } }));
    }
    await assert.doesNotReject(runner.run("u1"));
    await stopped(runner);
    // Already in-flight face writes may fail together; no new pass may start.
    if (fault === "face write") assert.ok(failures >= 1 && failures <= FACE_CONCURRENCY);
    else assert.equal(failures, 1, "stop on the first storage failure");
    assert.deepEqual(await get("u1"), before);
    assert.equal(logs.filter((x) => x === "prep.store_error").length, 1);
    assert.ok(!logs.includes("prep.failed"));
    assert.ok(!logs.includes("prep.attempt_failed"));
    t.mock.restoreAll();
    if (reuse) assert.deepEqual(await store.getAsset("u1", "c1", "neutral"), savedScene);
    // A retry with recovered storage must reuse the saved scene and finish.
    if (reuse) {
      await runner.retry("u1");
      await runner.run("u1");
      assert.equal((await get("u1"))?.prep.status, "ready");
      assert.equal(calls.edits.filter((x) => x.key === "scene").length, 0);
    }
  });
}

for (const entry of ["create", "retry", "resume", "direct"] as const) {
  for (const operation of ["getCompanion", "patchCompanion"] as const) {
    test(`prep storage: ${entry} handles initial ${operation} failure and resumes after recovery`, async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "prep-storage-"));
      const store = new FileStore(dir);
      const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
      const { media } = fakeMedia({ keyOf });
      const deps = { metaKey: "fake", store, voices: DEVICE_VOICES, media, log: (event: string, data: Record<string, unknown>) => { logs.push({ event, data }); } };
      const runner = new PrepRunner(deps);
      const routes = createPrepRoutes(deps, runner);
      const http = createServer((req, res) => {
        if (req.url === "/healthz") { res.writeHead(200); res.end("ok"); }
        else void routes.handle(req, res, "u1");
      });
      const unhandled = (err: unknown) => assert.fail(`unhandled prep rejection: ${String(err)}`);
      process.once("unhandledRejection", unhandled);
      t.after(async () => {
        runner.cancel("u1");
        await stopped(runner);
        process.removeListener("unhandledRejection", unhandled);
        await new Promise<void>((resolve, reject) => http.close((err) => err ? reject(err) : resolve()));
        rmSync(dir, { recursive: true, force: true });
      });
      await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
      const realFetch = globalThis.fetch;
      t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        assert.ok(url.startsWith(base + "/"), "test must not call external services");
        return realFetch(input, init);
      });
      const post = (path: string, body?: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
      await store.putImage({
        id: "img1", userId: "u1", mime: "image/png", bytes: 10,
        check: interpretCheck({ subject: "person", face_count: 1, front_facing: true, face_covered: false, sharp: true, well_lit: true, text_on_image: false }),
        headBox: null, rightsAck: true, createdAt: new Date().toISOString(), ms: { check: 1, sam: 1 },
      }, fakePng(800, 1000, "upload"));
      if (entry !== "create") await store.putCompanion({ id: "c1", userId: "u1", imageId: "img1", type: "human", voiceId: DEVICE_VOICES[0].id, name: "Mira", createdAt: new Date().toISOString(), prep: newPrepState() });

      let armed = entry === "direct";
      let failures = 0;
      let before: CompanionRecord | null = null;
      const get = store.getCompanion.bind(store);
      const original = store[operation].bind(store);
      t.mock.method(store, operation, async (...args: Parameters<typeof original>) => {
        if (armed) {
          armed = false;
          failures++;
          before = await get("u1");
          throw new Error("DB_CONNECTION_RESET:" + "x".repeat(250));
        }
        return (original as (...args: Parameters<typeof original>) => ReturnType<typeof original>)(...args);
      });
      if (entry === "create") {
        const put = store.putCompanion.bind(store);
        t.mock.method(store, "putCompanion", async (c: CompanionRecord) => { await put(c); armed = true; });
        const response = await post("/v1/companion", { imageId: "img1", voiceId: DEVICE_VOICES[0].id });
        assert.equal(response.status, 201);
        await response.arrayBuffer();
      } else if (entry === "retry") {
        // Arm only after retry's foreground reset; the background run then fails.
        const patch = store.patchCompanion.bind(store);
        let reset = true;
        t.mock.method(store, "patchCompanion", async (...args: Parameters<typeof patch>) => {
          const result = await patch(...args);
          if (reset) { reset = false; armed = true; }
          return result;
        });
        const response = await post("/v1/companion/prep/retry");
        assert.equal(response.status, 202);
        await response.arrayBuffer();
      } else if (entry === "resume") {
        const list = store.listCompanions.bind(store);
        t.mock.method(store, "listCompanions", async () => { const rows = await list(); armed = true; return rows; });
        assert.equal(await runner.resumeAll(), 1);
      } else {
        await assert.doesNotReject(runner.run("u1"));
      }
      await stopped(runner);
      assert.equal(failures, 1);
      assert.deepEqual(await get("u1"), before, "failed reads/writes must leave persisted prep unchanged");
      const errors = logs.filter((x) => x.event === "prep.store_error");
      assert.equal(errors.length, 1);
      assert.match(String(errors[0].data.message), /DB_CONNECTION_RESET/);
      assert.ok(String(errors[0].data.message).length <= 200);
      if (operation === "patchCompanion") assert.equal(errors[0].data.companion, before!.id);
      assert.equal((await fetch(base + "/healthz")).status, 200);
      assert.equal((await fetch(base + "/v1/import/prompt")).status, 200);

      // Remove injection hooks before recovery, preserving the same saved state.
      t.mock.restoreAll();
      if (entry === "create" || entry === "direct") {
        const response = await post("/v1/companion/prep/retry");
        assert.equal(response.status, 202);
        await response.arrayBuffer();
      } else assert.equal(await runner.resumeAll(), 1);
      await runner.run("u1");
      assert.equal((await get("u1"))?.prep.status, "ready");
    });
  }
}
