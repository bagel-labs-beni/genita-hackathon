/** AU-16 (IM-02 step 1): a cancelled import (I03 Cancel → the request closes) is never saved over the next one. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "../src/prep/store.ts";
import { importStyle, type PrepDeps } from "../src/prep/pipeline.ts";

const f = (text: string) => ({ text, label: "explicit", scope: "any" });
const RAW = { sections: { tendencies: [f("Compares two options.")], communication: [], response: [], help: [], support: [], interests: [], likes: [], boundaries: [], approach: [] }, rules: [], to_confirm: [] };
// real content over the 200-char minimum (spaces are trimmed by checkPaste — Codex)
const PASTE = "1. Thinking style\n- Compares two options before deciding, then picks fast. [Observed]\n2. Communication\n- Short, direct answers with a joke now and then. [Explicit]\n3. Interests\n- Korean food, film photography and long walks on Sundays. [Memory]\n";

test("AU-16: an import whose request went away stores nothing", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "import-cancel-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const store = new FileStore(dir);
  const ac = new AbortController();
  const d = { metaKey: "", store, voices: [], log: () => {}, spark: (async () => { ac.abort(); return RAW; }) as unknown as PrepDeps["spark"] } as unknown as PrepDeps;
  await assert.rejects(importStyle(d, "u1", PASTE, undefined, ac.signal), { code: "import_cancelled" });
  assert.equal(await store.getStyle("u1"), null, "the cancelled import saved nothing");
  // the same import without a cancel is stored
  const d2 = { ...d, spark: (async () => RAW) as unknown as PrepDeps["spark"] } as PrepDeps;
  await importStyle(d2, "u1", PASTE);
  assert.ok(await store.getStyle("u1"));
});

test("AU-16 (Codex P1): cancelled while the story is being written — nothing saved, no late story", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "import-cancel2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const store = new FileStore(dir);
  const ac = new AbortController();
  let n = 0;
  const personalize = { generation: () => 0, storyFromText: async () => { await new Promise((r) => setTimeout(r, 30)); ac.abort(); return null; }, withStory: (c: unknown) => c, trackLate: () => { n++; }, replaceStyle: async () => { n += 10; return ""; } };
  const d = { metaKey: "", store, voices: [], log: () => {}, personalize, spark: (async () => RAW) as unknown as PrepDeps["spark"] } as unknown as PrepDeps;
  await assert.rejects(importStyle(d, "u1", PASTE, undefined, ac.signal), { code: "import_cancelled" });
  assert.equal(n, 0, "no late story tracked, no card saved");
  assert.equal(await store.getStyle("u1"), null);
});

test("AU-16 (Codex r2): a cancel while the import waits for the profile lock still saves nothing", async (t) => {
  const { Personalize } = await import("../src/personalize/service.ts");
  const dir = mkdtempSync(join(tmpdir(), "import-cancel3-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const store = new FileStore(dir);
  const personalize = new Personalize({ store, json: (async () => null) as never });
  // another write holds the user's lock while the import reaches replaceStyle
  let release!: () => void;
  const ac = new AbortController();
  const blocker = (personalize as unknown as { serial: (u: string, f: () => Promise<unknown>) => Promise<unknown> }).serial("u1", () => new Promise<void>((r) => (release = r)));
  const d = { metaKey: "", store, voices: [], log: () => {}, personalize, spark: (async () => RAW) as unknown as PrepDeps["spark"] } as unknown as PrepDeps;
  const job = importStyle(d, "u1", PASTE, undefined, ac.signal);
  await new Promise((r) => setTimeout(r, 1700)); // past the story grace, now waiting for the lock
  ac.abort();
  release();
  await blocker;
  await assert.rejects(job, { code: "import_cancelled" });
  assert.equal(await store.getStyle("u1"), null);
});
