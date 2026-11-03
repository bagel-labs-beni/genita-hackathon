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

function setup(p: Partial<SessionPersonalize> & { slowCorrectionMs?: number; reply?: string; longReply?: boolean } = {}) {
  const asr = Object.assign(new EventEmitter(), { isOpen: false, async connect() { this.isOpen = true; }, sendAudio() {}, end() { this.isOpen = false; } });
  const client = new Client();
  const sparkCalls: SparkRequest[] = [];
  const log: Array<{ ev: string; at: number }> = [];
  const ended: Array<{ turns: Array<{ role: string; text: string }>; asked: string | null }> = [];
  const asks: Array<string | null> = [];
  const personalize: SessionPersonalize = {
    async startCall() {
      return { profile: "How the user wants to be treated:\n- Taste: Dislikes cilantro.", ask: "Within your first few replies, when it fits, ask one casual question to learn about: Weekend rhythm.", askItem: "Weekend rhythm", askTopic: { item: "Weekend rhythm", topic: "Weekend rhythm", sub: "Busy or slow?" }, taste: [{ text: "Dislikes cilantro.", label: "explicit" }] };
    },
    async voiceCorrection(_u, line, _last, _sig, asked) {
      log.push({ ev: "correction.start", at: Date.now() });
      asks.push(asked?.topic ?? null);
      if (p.slowCorrectionMs) await sleep(p.slowCorrectionMs);
      if (asked && /sleep in/i.test(line)) return { events: [{ text: "Noted: slow weekends", fields: ["interests"] }], applied: [{ field: "interests", text: "Slow weekends.", label: "explicit", removed: [] }], answered: true, profile: "x", taste: [] };
      if (!/don't like mushrooms/i.test(line)) return null;
      return { events: [{ text: "Updated: no mushrooms", fields: ["likes"] }], applied: [{ field: "likes", text: "Avoids mushrooms.", label: "explicit", removed: [] }], answered: false, profile: "How the user wants to be treated:\n- Taste: Avoids mushrooms.\n- Taste: Dislikes cilantro.", taste: [{ text: "Avoids mushrooms.", label: "explicit" }] };
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
    async *spark(req, opts): AsyncGenerator<SparkStreamEvent> {
      sparkCalls.push(req);
      log.push({ ev: "reply", at: Date.now() });
      if (p.longReply) {
        // a long reply: the first sentence is out, the rest takes a while (the user talks over it)
        yield { type: "text", delta: "<happy> So there are a few ways to look at this one. Let me walk you through all of them slowly. " };
        await sleep(400);
        if (opts?.signal?.aborted) return;
        yield { type: "text", delta: "First, think about the timing. Second, the cost." };
      } else yield { type: "text", delta: p.reply ?? "<happy> Sure thing." };
      yield { type: "done", responseId: "r", text: "", status: "completed" };
    },
    async *tts() {},
    userId: "u1",
    personalize,
  };
  const session = new Session("s1", client, deps);
  return { client, session, sparkCalls, log, ended, asks };
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

test("GK-1: a reply that asks the planned question → profile.asking; the next line is checked for the answer → Noted chip; the ask line stops", async () => {
  const s = setup({ reply: "<curious> Sure thing. Are your weekends busy, or slow?" });
  await s.session.onClientText(JSON.stringify({ type: "start", persona }));
  await say(s, "Hi there, long week.", 1);
  const asking = await s.client.waitFor((m) => m.type === "profile.asking");
  assert.deepEqual(asking, { type: "profile.asking", topic: "Weekend rhythm" });
  await say(s, "Mostly I sleep in.", 2);
  const noted = await s.client.waitFor((m) => m.type === "profile.updated");
  assert.deepEqual(noted, { type: "profile.updated", text: "Noted: slow weekends", fields: ["interests"] });
  assert.deepEqual(s.asks, ["Weekend rhythm"], "small talk never reaches the side-call; the line after the question does");
  assert.doesNotMatch(s.sparkCalls[1].instructions!, /learn about: Weekend rhythm/, "asked once; the line stops riding along");
  assert.equal(s.client.json.filter((m) => m.type === "profile.asking").length, 1);
  s.session.close();
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
  assert.deepEqual(card.reasons?.map((r) => r.text), ["Your taste: Korean comfort food", "Your taste: no cilantro"]);
  session.close();
});

test("Codex #7/#8: a slow profile store never holds up ready; an empty stored profile clears the app's stale copy", async () => {
  const slow = setup({ async startCall() { await sleep(5000); return null; } });
  const t0 = Date.now();
  await slow.session.onClientText(JSON.stringify({ type: "start", persona }));
  assert.ok(slow.client.json.some((m) => m.type === "ready"));
  assert.ok(Date.now() - t0 < 2500, `ready after ${Date.now() - t0} ms`);
  slow.session.close();

  const empty = setup({ async startCall() { return { profile: "", taste: [] }; } });
  await empty.session.onClientText(JSON.stringify({ type: "start", persona, user: { profile: "- Taste: Loves cilantro." } }));
  await say(empty, "Hi.", 1);
  assert.doesNotMatch(empty.sparkCalls[0].instructions!, /Loves cilantro/);
  empty.session.close();
});

test("security #4: small talk doesn't use up the per-call correction budget", async () => {
  const s = setup();
  await s.session.onClientText(JSON.stringify({ type: "start", persona }));
  for (let i = 1; i <= 13; i++) await say(s, `Turn ${i}, just chatting.`, i);
  await say(s, "Actually I don't like mushrooms anymore.", 14);
  await s.client.waitFor((m) => m.type === "profile.updated");
  s.session.close();
});

test("Knows-Me: the local time rides every turn; call 1's nod only the greeting (legacy prompt; v1 opens with its own first_known line)", async (t) => {
  const prev = process.env.GENITA_CONVO_V1;
  process.env.GENITA_CONVO_V1 = "0";
  t.after(() => { if (prev === undefined) delete process.env.GENITA_CONVO_V1; else process.env.GENITA_CONVO_V1 = prev; });
  const s = setup({ async startCall() { return { profile: "- Taste: Clean, minimal.", nod: "NOD-LINE", taste: [] }; } });
  await s.session.onClientText(JSON.stringify({ type: "start", persona, user: { timeZone: "Asia/Seoul" }, greetAfterMs: 0 }));
  await s.client.waitFor(() => s.client.json.filter((m) => m.type === "reply").length === 1);
  await sleep(30);
  await say(s, "Hi.", 2);
  assert.match(s.sparkCalls[0].instructions!, /NOD-LINE/);
  assert.doesNotMatch(s.sparkCalls[1].instructions!, /NOD-LINE/);
  for (const c of s.sparkCalls) assert.match(c.instructions!, /for the user\. Use it only for timing/);
  s.session.close();
});

test("S1: two long replies cut off → Updated: shorter replies, the next reply says it once; one cut is nothing", async () => {
  let noted = 0;
  const s = setup({ longReply: true, async noteShorter() { noted++; return { text: "Updated: shorter replies", fields: ["response"], profile: "- Short replies." }; } });
  await s.session.onClientText(JSON.stringify({ type: "start", persona }));
  const cut = async (i: number) => {
    await s.session.onClientText(JSON.stringify({ type: "text", text: `Question ${i}, tell me.` }));
    await s.client.waitFor(() => s.client.json.filter((m) => m.type === "reply.delta").length >= i);
    await sleep(60);
  };
  await cut(1);
  await cut(2); // typing over reply 1 = cut 1
  assert.equal(noted, 0);
  await cut(3); // cut 2
  const ev = await s.client.waitFor((m) => m.type === "profile.updated");
  assert.deepEqual(ev, { type: "profile.updated", text: "Updated: shorter replies", fields: ["response"] });
  assert.equal(noted, 1);
  assert.match(s.sparkCalls[2].instructions!, /cut you off twice/);
  await sleep(500);
  await say(s, "Ok.", s.client.json.filter((m) => m.type === "reply").length + 1);
  assert.doesNotMatch(s.sparkCalls.at(-1)!.instructions!, /cut you off twice/, "said once");
  s.session.close();
});

test("Codex round 6: short replies cut off don't count; 'forget' can empty the taste lines; long-answer profile skips S1", async () => {
  let noted = 0;
  const s = setup({ async noteShorter() { noted++; return { text: "Updated: shorter replies", fields: ["response"], profile: "x" }; } });
  await s.session.onClientText(JSON.stringify({ type: "start", persona }));
  for (let i = 1; i <= 3; i++) { await s.session.onClientText(JSON.stringify({ type: "text", text: `Hey ${i} there.` })); await sleep(5); }
  await sleep(100);
  assert.equal(noted, 0, "'Sure thing.' is not a long reply");
  s.session.close();

  const l = setup({ longReply: true, async startCall() { return { profile: "- Response: Long, detailed answers please.", taste: [] }; }, async noteShorter() { noted++; return null; } });
  await l.session.onClientText(JSON.stringify({ type: "start", persona }));
  for (let i = 1; i <= 3; i++) {
    await l.session.onClientText(JSON.stringify({ type: "text", text: `Question ${i}, tell me.` }));
    await l.client.waitFor(() => l.client.json.filter((m) => m.type === "reply.delta").length >= i);
    await sleep(60);
  }
  assert.ok(!l.sparkCalls.some((c) => /cut you off twice/.test(c.instructions!)));
  l.session.close();
});

test("Knows-Me × v1: no second personal mention — the nod stays out, the local time still rides", async () => {
  const s = setup({ async startCall() { return { profile: "- Taste: Clean, minimal.", nod: "NOD-LINE", taste: [] }; } });
  await s.session.onClientText(JSON.stringify({ type: "start", persona, user: { timeZone: "Asia/Seoul" }, greetAfterMs: 0 }));
  await s.client.waitFor(() => s.client.json.filter((m) => m.type === "reply").length === 1);
  assert.doesNotMatch(s.sparkCalls[0].instructions!, /NOD-LINE/);
  assert.match(s.sparkCalls[0].instructions!, /for the user\. Use it only for timing/);
  s.session.close();
});
