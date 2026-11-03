/**
 * Names at call start (audit 11/4):
 * - AU-42: the Mac never sends start.user.name, so the server fills it from the account's name
 *   (a name the app sent always wins). Greeting opener, prompt line and name guards then work on the Mac.
 * - AU-53: a voice rename is saved on the stored companion; a device with a cached older persona name
 *   starts with the stored name, and `companion.named` tells the app so its labels follow.
 * Both lookups are bounded: a slow or failing store never holds `ready`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session, type ClientSink, type SessionDeps } from "../src/session/session.ts";
import type { Config } from "../src/config.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";

const config: Config = {
  metaKey: "x",
  serverTts: false,
  host: "127.0.0.1",
  port: 0,
  sessionToken: null,
  defaultVoiceId: "voice",
  webSearch: false,
  asrLanguages: ["English"],
  bargeInMinMs: 400,
  bargeInMinWords: 2,
  maxSessions: 4,
  maxSessionMs: 60_000,
  sparkFirstTokenTimeoutMs: 8000,
  sparkHedge: 1,
  speculate: false,
  speculateStableMs: 250,
};

class FakeClient implements ClientSink {
  json: Record<string, unknown>[] = [];
  sendJson(m: Record<string, unknown>) { this.json.push(m); }
  sendBinary() {}
  close() {}
  of(type: string) { return this.json.filter((m) => m.type === type); }
  async waitFor(pred: (m: Record<string, unknown>) => boolean, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) {
      const hit = this.json.find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timeout; got ${this.json.map((m) => m.type).join(",")}`);
      await new Promise((r) => setTimeout(r, 2));
    }
  }
}

function setup(deps: Partial<SessionDeps> = {}) {
  const asr = Object.assign(new EventEmitter(), { isOpen: false, async connect() { this.isOpen = true; }, sendAudio() {}, end() { this.isOpen = false; } });
  const client = new FakeClient();
  const sparkCalls: SparkRequest[] = [];
  const session = new Session("n1", client, {
    config,
    openAsr: () => asr,
    async *spark(req): AsyncGenerator<SparkStreamEvent> {
      sparkCalls.push(req);
      yield { type: "text", delta: "<happy> Good to hear you." };
      yield { type: "done", responseId: "r", text: "", status: "completed" };
    },
    async *tts() {},
    ...deps,
  });
  return { client, session, sparkCalls };
}

const persona = { name: "Jin", kind: "human", traits: ["warm"] };
const prompt = (r: SparkRequest) => JSON.stringify(r);

test("AU-42: no start.user.name (the Mac) → the account's name is the user's name in the prompt", async (t) => {
  const { client, session, sparkCalls } = setup({ accountName: async () => "Summer" });
  t.after(() => session.close());
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false, user: { timeZone: "Asia/Seoul" } }));
  await session.onClientText(JSON.stringify({ type: "text", text: "hi" }));
  await client.waitFor((m) => m.type === "reply");
  assert.match(prompt(sparkCalls[0]), /The user's name is Summer/);
});

test("AU-42: a name the app sent wins over the account's name", async (t) => {
  const { client, session, sparkCalls } = setup({ accountName: async () => "Summer Lee" });
  t.after(() => session.close());
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false, user: { name: "Sum" } }));
  await session.onClientText(JSON.stringify({ type: "text", text: "hi" }));
  await client.waitFor((m) => m.type === "reply");
  assert.match(prompt(sparkCalls[0]), /The user's name is Sum\b/);
  assert.doesNotMatch(prompt(sparkCalls[0]), /Summer Lee/);
});

test("AU-53: the stored companion name wins over a device's cached persona name, and the app is told", async (t) => {
  const { client, session, sparkCalls } = setup({ companionName: async () => "Max" });
  t.after(() => session.close());
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  const named = client.of("companion.named");
  assert.deepEqual(named, [{ type: "companion.named", name: "Max" }]);
  assert.ok(client.json.indexOf(named[0]) > client.json.indexOf(client.of("ready")[0]), "after ready");
  await session.onClientText(JSON.stringify({ type: "text", text: "what's your name?" }));
  await client.waitFor((m) => m.type === "reply");
  assert.match(prompt(sparkCalls[0]), /Max/);
  assert.doesNotMatch(prompt(sparkCalls[0]), /\bJin\b/);
});

test("AU-53: the same name sends nothing extra", async (t) => {
  const { client, session } = setup({ companionName: async () => "Jin" });
  t.after(() => session.close());
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  assert.equal(client.of("ready").length, 1);
  assert.equal(client.of("companion.named").length, 0);
});

test("names: no row, a store error or a slow store keeps the app's names and never holds ready", async () => {
  const slow = () => new Promise<string>((r) => setTimeout(() => r("Late"), 5_000));
  for (const lookup of [async () => null, async () => { throw new Error("db down"); }, slow]) {
    const { client, session, sparkCalls } = setup({ companionName: lookup, accountName: lookup });
    const t0 = Date.now();
    await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
    assert.ok(Date.now() - t0 < 2_500, "ready is never held past the wait");
    assert.equal(client.of("ready").length, 1);
    assert.equal(client.of("companion.named").length, 0);
    await session.onClientText(JSON.stringify({ type: "text", text: "hi" }));
    await client.waitFor((m) => m.type === "reply");
    assert.doesNotMatch(prompt(sparkCalls[0]), /The user's name is/);
    assert.doesNotMatch(prompt(sparkCalls[0]), /Late/);
    session.close();
  }
});
