/**
 * Lane 개인화 in the call: the server's latest profile replaces the app's copy,
 * one still-to-confirm item is asked within the first turns, a correction said
 * in the call updates the profile and sends profile.updated (beside the reply,
 * never blocking it), and the call's turns go to the post-call growth.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session, type ClientSink, type SessionDeps, type SessionPersonalize } from "../src/session/session.ts";
import { loadConfig } from "../src/config.ts";
import { checkServerEvent } from "../src/protocol.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";

const config = { ...loadConfig({ MODEL_API_KEY: "x" }), serverTts: false, webSearch: false, speculate: false, sparkHedge: 1 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Client implements ClientSink {
  json: Record<string, unknown>[] = [];
  sendJson(m: Record<string, unknown>) {
    assert.deepEqual(checkServerEvent(m), [], JSON.stringify(m));
    this.json.push(m);
  }
  sendBinary() {}
  close() {}
  async waitFor(pred: (m: Record<string, unknown>) => boolean, ms = 2000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = this.json.find(pred);
      if (hit) return hit;
      await sleep(2);
    }
    throw new Error(`timeout; got ${this.json.map((m) => m.type).join(",")}`);
  }
}

function setup(p: Partial<SessionPersonalize> & { slowCorrectionMs?: number } = {}) {
  const asr = Object.assign(new EventEmitter(), { isOpen: false, async connect() { this.isOpen = true; }, sendAudio() {}, end() { this.isOpen = false; } });
  const client = new Client();
  const sparkCalls: SparkRequest[] = [];
  const log: Array<{ ev: string; at: number }> = [];
  const ended: Array<{ turns: Array<{ role: string; text: string }>; asked: string | null }> = [];
  const personalize: SessionPersonalize = {
    async startCall() {
      return { profile: "How the user wants to be treated:\n- Taste: Dislikes cilantro.", ask: "Within your first few replies, when it fits, ask one casual question to learn about: Weekend rhythm.", askItem: "Weekend rhythm", taste: [{ text: "Dislikes cilantro.", label: "explicit" }] };
    },
    async voiceCorrection(_u, line) {
      log.push({ ev: "correction.start", at: Date.now() });
      if (p.slowCorrectionMs) await sleep(p.slowCorrectionMs);
      if (!/don't like mushrooms/i.test(line)) return null;
      return { chip: "Updated: no mushrooms", applied: [{ field: "likes", text: "Avoids mushrooms.", label: "explicit", removed: [] }], profile: "How the user wants to be treated:\n- Taste: Avoids mushrooms.\n- Taste: Dislikes cilantro.", taste: [] };
    },
    async endCall(_u, turns, asked) {
      ended.push({ turns, asked });
      return 1;
    },
    ...p,
  };
  const deps: SessionDeps = {
    config,
    openAsr: () => asr,
    async *spark(req): AsyncGenerator<SparkStreamEvent> {
      sparkCalls.push(req);
      log.push({ ev: "reply", at: Date.now() });
      yield { type: "text", delta: "<happy> Sure thing." };
      yield { type: "done", responseId: "r", text: "", status: "completed" };
    },
    async *tts() {},
    userId: "u1",
    personalize,
  };
  const session = new Session("s1", client, deps);
  return { client, session, sparkCalls, log, ended };
}

const persona = { name: "Jin", kind: "human" };
const say = async (s: ReturnType<typeof setup>, text: string, n: number) => {
  await s.session.onClientText(JSON.stringify({ type: "text", text }));
  await s.client.waitFor(() => s.client.json.filter((m) => m.type === "reply").length === n);
  await sleep(20);
};

test("call start: the server's profile wins over the app's stale copy; the ask line rides the first 3 turns only", async () => {
  const s = setup();
  await s.session.onClientText(JSON.stringify({ type: "start", persona, user: { profile: "- Taste: Loves cilantro." } }));
  for (let i = 1; i <= 4; i++) await say(s, `Turn ${i}, hi there.`, i);
  assert.match(s.sparkCalls[0].instructions!, /Dislikes cilantro/);
  assert.doesNotMatch(s.sparkCalls[0].instructions!, /Loves cilantro/);
  assert.deepEqual(s.sparkCalls.map((c) => /learn about: Weekend rhythm/.test(c.instructions!)), [true, true, true, false]);
  s.session.close();
});

test("voice correction: profile.updated after the merge, the reply is not held up, later turns use the new profile", async () => {
  const s = setup({ slowCorrectionMs: 150 });
  await s.session.onClientText(JSON.stringify({ type: "start", persona }));
  await say(s, "Actually I don't like mushrooms anymore.", 1);
  const ev = await s.client.waitFor((m) => m.type === "profile.updated");
  assert.deepEqual(ev, { type: "profile.updated", text: "Updated: no mushrooms", fields: ["likes"] });
  // the reply started before the slow correction finished
  const reply = s.log.find((l) => l.ev === "reply")!;
  const corr = s.log.find((l) => l.ev === "correction.start")!;
  assert.ok(reply.at - corr.at < 100, "reply not blocked by the correction call");
  await say(s, "What's for dinner?", 2);
  assert.match(s.sparkCalls[1].instructions!, /Avoids mushrooms/);
  s.session.close();
});

test("no correction check while interpreting; the call's turns and the asked item go to endCall on close", async () => {
  const s = setup();
  await s.session.onClientText(JSON.stringify({ type: "start", persona }));
  await say(s, "I shoot film these days.", 1);
  await say(s, "Weekends I sleep in.", 2);
  s.session.close();
  await sleep(10);
  assert.equal(s.ended.length, 1);
  assert.equal(s.ended[0].asked, "Weekend rhythm");
  assert.deepEqual(s.ended[0].turns.filter((t) => t.role === "user").map((t) => t.text), ["I shoot film these days.", "Weekends I sleep in."]);

  const i = setup();
  await i.session.onClientText(JSON.stringify({ type: "start", persona, mode: "interpret" }));
  await i.session.onClientText(JSON.stringify({ type: "text", text: "Actually I don't like mushrooms anymore." }));
  await sleep(60);
  assert.ok(!i.log.some((l) => l.ev === "correction.start"));
  i.session.close();
});

test("a failing personalize dep never breaks the call", async () => {
  const s = setup({
    async startCall() { throw new Error("db down"); },
    async voiceCorrection() { throw new Error("spark down"); },
    async endCall() { throw new Error("spark down"); },
  });
  await s.session.onClientText(JSON.stringify({ type: "start", persona, user: { profile: "- Taste: Loves cilantro." } }));
  assert.ok(s.client.json.some((m) => m.type === "ready"));
  await say(s, "Actually I don't like mushrooms anymore.", 1);
  assert.match(s.sparkCalls[0].instructions!, /Loves cilantro/, "falls back to the app's profile");
  s.session.close();
  await sleep(10);
});

test("finds: a recipe card carries reason chips from the user's taste lines (E)", async () => {
  const { MemoryFindsStore } = await import("../src/finds/store.ts");
  const client = new Client();
  const asr = Object.assign(new EventEmitter(), { isOpen: false, async connect() { this.isOpen = true; }, sendAudio() {}, end() { this.isOpen = false; } });
  const vendors = {
    async spark(req: SparkRequest) {
      if (JSON.stringify(req.input).includes("clearly visible")) return { text: "YES", output: [] };
      return { text: '{"dish":"kimchi stew","minutes":20,"ingredients":[{"name":"kimchi","optional":false},{"name":"tofu","optional":false}],"steps":["Simmer it."],"sources":[],"ask":["Spicy?"],"say":"Kimchi stew it is."}', output: [] };
    },
    async *sparkStream() {
      yield { type: "text" as const, delta: "kimchi | - | red jar\n" };
      yield { type: "done" as const, responseId: null, text: "", status: "completed" };
    },
    async sam() { return []; },
    async image() { return Buffer.from([0xff, 0xd8]); },
  };
  const session = new Session("r1", client, {
    config,
    openAsr: () => asr,
    async *spark() { yield { type: "text", delta: "<happy> Let me look." }; yield { type: "done", responseId: "r", text: "", status: "completed" }; },
    async *tts() {},
    userId: "u1",
    finds: { vendors, store: new MemoryFindsStore(), images: false, imageBase: "/v1/finds" },
    personalize: {
      async startCall() {
        return { profile: "How the user wants to be treated:\n- Taste: Food: Korean comfort food, one-pot meals.\n- Taste: Dislikes cilantro.", taste: [{ text: "Food: Korean comfort food, one-pot meals.", label: "explicit" }, { text: "Dislikes cilantro.", label: "explicit" }] };
      },
      async voiceCorrection() { return null; },
      async endCall() { return 0; },
    },
  });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "What can I make with this?", frames: ["AAAA"] }));
  const created = await client.waitFor((m) => m.type === "find.created", 3000);
  const card = created.card as { reasons?: Array<{ text: string; source: string }> };
  assert.deepEqual(card.reasons?.map((r) => r.text), ["Your taste: Korean comfort food", "You said: no cilantro"]);
  session.close();
});
