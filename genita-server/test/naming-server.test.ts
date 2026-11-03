/**
 * F2-L26 wiring on the real server: a rename said in the call is saved to the
 * prep store (server.ts → renameCompanion), so GET /v1/companion and the next
 * call's start.persona carry it. Vendors are faked; no keys needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { loadConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";
import type { SessionDeps } from "../src/session/session.ts";
import { FileStore } from "../src/prep/store.ts";
import { newPrepState } from "../src/prep/runner.ts";

const config = { ...loadConfig({ MODEL_API_KEY: "fake-meta" }), port: 0, webSearch: false, speculate: false, sparkHedge: 1 };

test("server: 'Call yourself Max' in a call is saved — GET /v1/companion → session.persona.name is Max", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "naming-server-"));
  const store = new FileStore(dir);
  await store.putCompanion({
    id: "c1",
    userId: "demo",
    imageId: "img1",
    type: "human",
    voiceId: "v1",
    name: "Jin",
    createdAt: new Date().toISOString(),
    prep: { ...newPrepState(), status: "failed" },
    persona: { card: { name: "Jin", kind: "human", traits: ["warm"] }, rules: [], summary: { why: "", energy: "", initiative: "", never: "" }, depth: "quick" },
  });
  const asr = Object.assign(new EventEmitter(), { isOpen: false, async connect() { this.isOpen = true; }, sendAudio() {}, end() { this.isOpen = false; } });
  const deps: SessionDeps = {
    config,
    openAsr: () => asr,
    async *spark() {
      yield { type: "text", delta: "<happy> Max it is!" };
      yield { type: "done", responseId: "r", text: "", status: "completed" };
    },
    async *tts() {},
  };
  const server = await startServer(config, () => {}, deps, { GENITA_DATA_DIR: dir }, null);
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}`;

  const before = (await (await fetch(`${base}/v1/companion`)).json()) as { session: { persona: { name: string } } };
  assert.equal(before.session.persona.name, "Jin");

  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/v1/session`);
  const events: Array<Record<string, unknown>> = [];
  ws.on("message", (d, bin) => !bin && events.push(JSON.parse(d.toString())));
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "start", persona: before.session.persona, mic: false }));
  const until = async (pred: () => boolean) => {
    const end = Date.now() + 3000;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`timeout: ${events.map((e) => e.type).join(",")}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  await until(() => events.some((e) => e.type === "ready"));
  ws.send(JSON.stringify({ type: "text", text: "Call yourself Max" }));
  await until(() => events.some((e) => e.type === "reply"));
  assert.deepEqual(events.find((e) => e.type === "companion.named"), { type: "companion.named", name: "Max" });
  ws.close();

  // the save is fire-and-forget from the call; give it a moment
  let after = before;
  for (let i = 0; i < 40 && after.session.persona.name !== "Max"; i++) {
    await new Promise((r) => setTimeout(r, 25));
    after = (await (await fetch(`${base}/v1/companion`)).json()) as typeof before;
  }
  assert.equal(after.session.persona.name, "Max");
});
