import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { startServer } from "../src/server.ts";
import type { Config } from "../src/config.ts";

const config: Config = {
  metaKey: "x", elevenKey: null, serverTts: false, kling: false, peter: false,
  host: "127.0.0.1", port: 0, sessionToken: "events-test-token", ttsModel: "m", ttsFallbackModel: "f",
  defaultVoiceId: "voice", webSearch: false, asrLanguages: ["English"], bargeInMinMs: 400,
  bargeInMinWords: 2, maxSessions: 4, maxSessionMs: 60_000, sparkFirstTokenTimeoutMs: 8000,
  sparkHedge: 1, speculate: false, speculateStableMs: 250,
};

test("POST /v1/events authenticates, uses each event's closed prop schema, drops unknown names, and rate limits", async (t) => {
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const server = await startServer(config, (event, data) => logs.push({ event, data }));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (body: unknown, token = config.sessionToken) => fetch(base + "/v1/events", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

  assert.equal((await post({ events: [
    { name: "setup.answered", props: { step: 3, email: "chelsea@example.com", depth: "wrong", companionId: "has spaces" } },
    { name: "camera.toggled", props: { on: true, facing: "front", extra: "free text" } },
    { name: "face.confirmed", props: { companionId: "companion_1", note: "private note" } },
  ] })).status, 204);
  assert.deepEqual(logs.find((x) => x.event === "setup.answered")?.data, { source: "app", userId: "demo", step: 3 });
  assert.deepEqual(logs.find((x) => x.event === "camera.toggled")?.data, { source: "app", userId: "demo", on: true, facing: "front" });
  assert.deepEqual(logs.find((x) => x.event === "face.confirmed")?.data, { source: "app", userId: "demo", companionId: "companion_1" });
  assert.equal((await post({ events: [{ name: "not.allowed", props: { body: "never logged" } }] })).status, 204);
  // server-owned events cannot be forged by an app
  assert.equal((await post({ events: [{ name: "turn.answered", props: { first_audio_ms: 1 } }, { name: "call.greeted" }] })).status, 204);
  assert.equal(logs.filter((x) => x.event === "not.allowed" || x.event === "turn.answered" || x.event === "call.greeted").length, 0);
  assert.equal(logs.find((x) => x.event === "events.unknown")?.data.count, 1);
  assert.equal((await post({ events: Array.from({ length: 21 }, () => ({ name: "app.reopened" })) })).status, 400);
  assert.equal((await post({ events: [{ name: "app.reopened" }] }, "")).status, 401);

  for (let i = 0; i < 5; i++) assert.equal((await post({ events: Array.from({ length: 20 }, () => ({ name: "app.reopened" })) })).status, 204);
  assert.equal((await post({ events: Array.from({ length: 14 }, () => ({ name: "app.reopened" })) })).status, 204);
  assert.equal((await post({ events: [{ name: "app.reopened" }] })).status, 429);
});
