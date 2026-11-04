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

test("D95 r4: a short forget notifies volatile consumers before the session correction gates", async () => {
  let notified = 0;
  const s = setup({ notifyForget() { notified++; } });
  await s.session.onClientText(JSON.stringify({ type: "start", persona }));
  await say(s, "Forget it.", 1);
  assert.equal(notified, 1, "the Session path cannot skip a short forget before its correction filter");
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
  // fail closed (lead 11/4, AU-92): the app's copy may hold what they asked to forget
  assert.doesNotMatch(s.sparkCalls[0].instructions!, /Loves cilantro/, "never the app's copy when the store fails");
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
  for (const c of s.sparkCalls) assert.match(c.instructions!, /for the user\. Use it only (?:for timing|when they bring up timing)/);
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
  // silent adaptation (main 11/3 P0): shorter, never a line about the interruptions
  assert.match(s.sparkCalls[2].instructions!, /one short sentence\. Never mention that they interrupted you/);
  assert.doesNotMatch(s.sparkCalls[2].instructions!, /cut me off/);
  await sleep(500);
  await say(s, "Ok.", s.client.json.filter((m) => m.type === "reply").length + 1);
  assert.doesNotMatch(s.sparkCalls.at(-1)!.instructions!, /Never mention that they interrupted you/, "the one-shot line is sent once");
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
  assert.ok(!l.sparkCalls.some((c) => /Never mention that they interrupted you/.test(c.instructions!)));
  l.session.close();
});

test("Knows-Me × v1: no second personal mention — the nod stays out, the local time still rides", async () => {
  const s = setup({ async startCall() { return { profile: "- Taste: Clean, minimal.", nod: "NOD-LINE", taste: [] }; } });
  await s.session.onClientText(JSON.stringify({ type: "start", persona, user: { timeZone: "Asia/Seoul" }, greetAfterMs: 0 }));
  await s.client.waitFor(() => s.client.json.filter((m) => m.type === "reply").length === 1);
  assert.doesNotMatch(s.sparkCalls[0].instructions!, /NOD-LINE/);
  assert.match(s.sparkCalls[0].instructions!, /for the user\. Use it only (?:for timing|when they bring up timing)/);
  s.session.close();
});

// ---------- P1 11/3 (demo S4): no getting-to-know-you question on a handoff or while watching together ----------
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "../src/prep/store.ts";
import { Personalize } from "../src/personalize/service.ts";
import { toStyleCard } from "../src/prep/importProfile.ts";

const f1 = (text: string) => ({ text, label: "explicit" as const, scope: "any" });
function realPersonalize(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "p1-handoff-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new FileStore(dir);
  const p = new Personalize({ store, json: (async () => ({ updates: [], answered: { field: "", text: "", chip: "" } })) as never });
  return { store, p };
}
const RAW = {
  sections: { tendencies: [], communication: [f1("Warm and direct.")], response: [f1("Short answers first.")], help: [], support: [], interests: [], likes: [f1("Style: Clean, minimal clothes.")], boundaries: [], approach: [] },
  rules: [],
  to_confirm: ["Reminder frequency", "Favorite shows", "Weekend rhythm"],
};
async function call(p: Personalize, start: Record<string, unknown>) {
  const client = new Client();
  const calls: SparkRequest[] = [];
  const asr = Object.assign(new EventEmitter(), { isOpen: false, async connect() { this.isOpen = true; }, sendAudio() {}, end() { this.isOpen = false; } });
  const session = new Session("h", client, {
    config,
    openAsr: () => asr,
    async *spark(req) { calls.push(req); yield { type: "text", delta: "<happy> Sure." }; yield { type: "done", responseId: "r", text: "", status: "completed" }; },
    async *tts() {},
    userId: "u1",
    personalize: p,
  });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false, ...start }));
  for (let i = 1; i <= 3; i++) {
    await session.onClientText(JSON.stringify({ type: "text", text: `Turn ${i}, hello.` }));
    await client.waitFor(() => client.json.filter((m) => m.type === "reply").length === i);
    await sleep(20);
  }
  return { session, calls, asks: calls.filter((c) => /ask one casual question to learn about/.test(c.instructions!)).length };
}

test("P1 S4: phone call → Mac handoff: the Mac call never asks and isn't counted; calls 1–3 still ask one each", async (t) => {
  const { store, p } = realPersonalize(t);
  await store.putStyle("u1", toStyleCard(RAW, "import"));
  const phone = await call(p, {});
  assert.ok(phone.asks > 0, "call 1 asks its question");
  phone.session.close();
  const mac = await call(p, { handoff: true, history: [{ role: "user", text: "Find a jacket for Friday." }] });
  assert.equal(mac.asks, 0, "the continued call on the Mac asks nothing");
  mac.session.close();
  assert.equal((await store.getStyle("u1"))!.growth!.calls, 1, "a handoff is not a new call");
  // the next real calls are calls 2 and 3: one question each, then none
  for (const want of [true, true, false]) {
    const c = await call(p, {});
    assert.equal(c.asks > 0, want);
    c.session.close();
  }
  assert.equal((await store.getStyle("u1"))!.growth!.calls, 4);
});

test("P1: watch together attached before the question → no question, the call count and topic are given back", async (t) => {
  const { store, p } = realPersonalize(t);
  await store.putStyle("u1", toStyleCard(RAW, "import"));
  const client = new Client();
  const calls: SparkRequest[] = [];
  const asr = Object.assign(new EventEmitter(), { isOpen: false, async connect() { this.isOpen = true; }, sendAudio() {}, end() { this.isOpen = false; } });
  const session = new Session("w", client, {
    config,
    openAsr: () => asr,
    async *spark(req) { calls.push(req); yield { type: "text", delta: "<happy> Ha." }; yield { type: "done", responseId: "r", text: "", status: "completed" }; },
    async *tts() {},
    userId: "u1",
    personalize: p,
  });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  assert.ok(session.attachWatch({ send() {}, sendJson() {}, close() {} } as never));
  await session.onClientText(JSON.stringify({ type: "text", text: "This show is wild." }));
  await client.waitFor(() => client.json.some((m) => m.type === "reply"));
  assert.doesNotMatch(calls[0].instructions!, /ask one casual question to learn about/);
  await sleep(30);
  const g = (await store.getStyle("u1"))!.growth!;
  assert.equal(g.calls, 0);
  assert.ok(!g.asked.some((a) => a.item === "Reminder frequency"), "the topic is free for the next call");
  session.close();
});

test("Codex P1 #1: a handoff the server sees (other device) is a continuation even with memory off and no start.handoff", async (t) => {
  const { store, p } = realPersonalize(t);
  await store.putStyle("u1", toStyleCard(RAW, "import"));
  const client = new Client();
  const calls: SparkRequest[] = [];
  const asr = Object.assign(new EventEmitter(), { isOpen: false, async connect() { this.isOpen = true; }, sendAudio() {}, end() { this.isOpen = false; } });
  const session = new Session("m", client, {
    config,
    openAsr: () => asr,
    async *spark(req) { calls.push(req); yield { type: "text", delta: "<happy> Sure." }; yield { type: "done", responseId: "r", text: "", status: "completed" }; },
    async *tts() {},
    userId: "u1",
    personalize: p,
    continuesCall: () => true,
  });
  await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await session.onClientText(JSON.stringify({ type: "text", text: "Find a jacket for Friday." }));
  await client.waitFor(() => client.json.some((m) => m.type === "reply"));
  assert.doesNotMatch(calls[0].instructions!, /ask one casual question to learn about/);
  assert.equal((await store.getStyle("u1"))!.growth?.calls ?? 0, 0);
  session.close();
});

test("Codex P1 #2: a reply already asking the question when watch together attaches drops that sentence", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = setup({ async unplanCall() {} });
  // a slow reply that asks the planned question ("Weekend rhythm" / "Busy or slow?")
  (s.session as unknown as { deps: SessionDeps }).deps.spark = async function* () {
    await gate;
    yield { type: "text", delta: "<happy> Fun. Are your weekends busy, or slow?" };
    yield { type: "done", responseId: "r", text: "", status: "completed" };
  };
  await s.session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await s.session.onClientText(JSON.stringify({ type: "text", text: "Let's watch something." }));
  await sleep(20);
  assert.ok(s.session.attachWatch({ send() {}, sendJson() {}, close() {} } as never));
  release();
  const reply = await s.client.waitFor((m) => m.type === "reply");
  assert.equal(reply.text, "Fun.");
  assert.ok(!s.client.json.some((m) => m.type === "profile.asking"));
  s.session.close();
});

// #387 Codex round 2 follow-ups: the question is judged as a whole sentence, and a queued one is not said.
const voiceCfg = { url: "https://v", token: "t", speakers: { human: 3, animal: 5, character: 9 }, speed: 1, timeoutMs: 500, model: "seamless" as const };

test("#387 follow-up: server voice splits the question at its comma — watch together still drops the whole sentence", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = setup({ async unplanCall() {} });
  const deps = (s.session as unknown as { deps: SessionDeps }).deps;
  const said: string[] = [];
  deps.config = { ...deps.config, serverTts: true, voice: voiceCfg };
  deps.tts = async function* (req) { said.push(req.text); yield { audio: Buffer.alloc(4800), alignment: null, model: "seamless-m4t-v2" }; };
  // eager first clause: "Weekends for you," goes out on its own; "are they packed or lazy?" shares no topic word
  deps.spark = async function* () {
    await gate;
    yield { type: "text", delta: "<happy> Weekends for you, are they packed or lazy? Either way, I'm in." };
    yield { type: "done", responseId: "r", text: "", status: "completed" };
  };
  await s.session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await s.session.onClientText(JSON.stringify({ type: "text", text: "Let's watch something." }));
  await sleep(20);
  assert.ok(s.session.attachWatch({ send() {}, sendJson() {}, close() {} } as never));
  release();
  const reply = await s.client.waitFor((m) => m.type === "reply");
  assert.equal(reply.text, "Either way, I'm in.");
  assert.ok(!said.some((t) => /Weekends for you|packed or lazy/.test(t)), `never voiced: ${JSON.stringify(said)}`);
  s.session.close();
});

test("#387 follow-up: a question already queued (TTS prefetch) when watch together attaches is not said", async () => {
  const s = setup({ async unplanCall() {} });
  const deps = (s.session as unknown as { deps: SessionDeps }).deps;
  const said: string[] = [];
  let attached = false;
  deps.config = { ...deps.config, serverTts: true, voice: voiceCfg };
  deps.tts = async function* (req) {
    said.push(req.text);
    // the first sentence is still being voiced when watch together attaches
    if (!attached) { await sleep(80); }
    yield { audio: Buffer.alloc(4800), alignment: null, model: "seamless-m4t-v2" };
  };
  deps.spark = async function* () {
    yield { type: "text", delta: "<happy> Fun one. Are your weekends busy or slow? " };
    yield { type: "done", responseId: "r", text: "", status: "completed" };
  };
  await s.session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await s.session.onClientText(JSON.stringify({ type: "text", text: "Let's watch something." }));
  await sleep(30);
  assert.ok(s.session.attachWatch({ send() {}, sendJson() {}, close() {} } as never));
  attached = true;
  const reply = await s.client.waitFor((m) => m.type === "reply");
  assert.equal(reply.text, "Fun one.");
  assert.ok(!said.some((t) => /weekends/i.test(t)), `never voiced: ${JSON.stringify(said)}`);
  s.session.close();
});

test("#387 follow-up: a held clause that turns out not to be the question is still said, in order", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = setup({ async unplanCall() {} });
  const deps = (s.session as unknown as { deps: SessionDeps }).deps;
  const said: string[] = [];
  deps.config = { ...deps.config, serverTts: true, voice: voiceCfg };
  deps.tts = async function* (req) { said.push(req.text); yield { audio: Buffer.alloc(4800), alignment: null, model: "seamless-m4t-v2" }; };
  deps.spark = async function* () {
    await gate;
    yield { type: "text", delta: "<happy> Weekends are for this, honestly. Good pick." };
    yield { type: "done", responseId: "r", text: "", status: "completed" };
  };
  await s.session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await s.session.onClientText(JSON.stringify({ type: "text", text: "Let's watch something." }));
  await sleep(20);
  assert.ok(s.session.attachWatch({ send() {}, sendJson() {}, close() {} } as never));
  release();
  const reply = await s.client.waitFor((m) => m.type === "reply");
  assert.equal(reply.text, "Weekends are for this, honestly. Good pick.");
  s.session.close();
});

test("#387 follow-up (Codex r1): a dropped question's queued first clause never swallows the next question", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = setup({ async unplanCall() {} });
  const deps = (s.session as unknown as { deps: SessionDeps }).deps;
  const said: string[] = [];
  deps.config = { ...deps.config, serverTts: true, voice: voiceCfg };
  deps.tts = async function* (req) { said.push(req.text); yield { audio: Buffer.alloc(4800), alignment: null, model: "seamless-m4t-v2" }; };
  deps.spark = async function* () {
    yield { type: "text", delta: "<happy> Weekends for you, " };
    await gate;
    yield { type: "text", delta: "are they packed or lazy? What should we watch first?" };
    yield { type: "done", responseId: "r", text: "", status: "completed" };
  };
  await s.session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await s.session.onClientText(JSON.stringify({ type: "text", text: "Let's watch something." }));
  await sleep(30);
  assert.ok(s.session.attachWatch({ send() {}, sendJson() {}, close() {} } as never));
  release();
  await s.client.waitFor((m) => m.type === "reply");
  assert.ok(!said.some((t) => /packed or lazy/.test(t)), `question rest not voiced: ${JSON.stringify(said)}`);
  assert.ok(said.some((t) => /What should we watch first\?/.test(t)), `the next question is said: ${JSON.stringify(said)}`);
  s.session.close();
});

test("#387 follow-up (Codex r1): a hold beat never releases or splits a held question", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = setup({ async unplanCall() {} });
  const deps = (s.session as unknown as { deps: SessionDeps }).deps;
  const said: string[] = [];
  deps.config = { ...deps.config, serverTts: true, voice: voiceCfg };
  deps.tts = async function* (req) { said.push(req.text); yield { audio: Buffer.alloc(4800), alignment: null, model: "seamless-m4t-v2" }; };
  deps.spark = async function* () {
    await gate;
    yield { type: "text", delta: "<happy> Weekends for you, " };
    await sleep(1_700); // longer than the 1.5 s hold beat
    yield { type: "text", delta: "are they packed or lazy? Either way, I'm in." };
    yield { type: "done", responseId: "r", text: "", status: "completed" };
  };
  await s.session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await s.session.onClientText(JSON.stringify({ type: "text", text: "Let's watch something." }));
  await sleep(20);
  assert.ok(s.session.attachWatch({ send() {}, sendJson() {}, close() {} } as never));
  release();
  const reply = await s.client.waitFor((m) => m.type === "reply", 5_000);
  assert.ok(!said.some((t) => /Weekends for you|packed or lazy/.test(t)), `never voiced: ${JSON.stringify(said)}`);
  assert.match(String(reply.text), /Either way, I'm in\.$/);
  s.session.close();
});

test("#387 follow-up (edge): the question was the reply's only sentence → a short reaction, never silence", async () => {
  // dropped while streaming (producer side)
  {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup({ async unplanCall() {} });
    const deps = (s.session as unknown as { deps: SessionDeps }).deps;
    let sparkCalls = 0;
    deps.spark = async function* () {
      sparkCalls++;
      await gate;
      yield { type: "text", delta: "<happy> Are your weekends busy or slow?" };
      yield { type: "done", responseId: "r", text: "", status: "completed" };
    };
    await s.session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
    await s.session.onClientText(JSON.stringify({ type: "text", text: "Let's watch something." }));
    await sleep(20);
    assert.ok(s.session.attachWatch({ send() {}, sendJson() {}, close() {} } as never));
    release();
    const reply = await s.client.waitFor((m) => m.type === "reply");
    assert.equal(reply.text, "Ooh, okay. Let's watch.");
    assert.equal(sparkCalls, 1, "no Spark retry for it");
    s.session.close();
  }
  // already queued and prefetched when watch attaches (consumer side), server voice
  {
    const s = setup({ async unplanCall() {} });
    const deps = (s.session as unknown as { deps: SessionDeps }).deps;
    const said: string[] = [];
    let attached = false;
    deps.config = { ...deps.config, serverTts: true, voice: voiceCfg };
    deps.tts = async function* (req) {
      said.push(req.text);
      if (!attached) await sleep(80);
      yield { audio: Buffer.alloc(4800), alignment: null, model: "seamless-m4t-v2" };
    };
    deps.spark = async function* () {
      yield { type: "text", delta: "<happy> Mm. Are your weekends busy or slow? " };
      yield { type: "done", responseId: "r", text: "", status: "completed" };
    };
    await s.session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
    await s.session.onClientText(JSON.stringify({ type: "text", text: "Let's watch something." }));
    await sleep(30);
    assert.ok(s.session.attachWatch({ send() {}, sendJson() {}, close() {} } as never));
    attached = true;
    const reply = await s.client.waitFor((m) => m.type === "reply");
    assert.equal(reply.text, "Mm.", "another real sentence was said, so the question just goes");
    assert.ok(!said.some((t) => /weekends/i.test(t)), JSON.stringify(said));
    s.session.close();
  }
});

test("QA post-deploy: a removed line stays out of memory notes, and the handed-off turns drop the forget request", async () => {
  const s = setup({ async startCall() { return { profile: "- Taste: Clean, minimal.", taste: [], removed: ["Likes leather accessories."] }; } });
  const avoid: string[][] = [];
  (s.session as unknown as { memoryCall: unknown }).memoryCall = null;
  await s.session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await say(s, "Actually, forget about the leather bag thing.", 1);
  await say(s, "Find me a jacket.", 2);
  const snap = s.session.historySnapshot();
  assert.ok(!snap.some((h) => /forget|leather/i.test(h.text)), JSON.stringify(snap));
  void avoid;
  s.session.close();
});

test("a 'forget that …' said while another correction check runs is not skipped: it runs right after", async () => {
  const lines: string[] = [];
  const s = setup({ slowCorrectionMs: 200, async voiceCorrection(_u, line) { lines.push(line); await sleep(200); return null; } });
  await s.session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await say(s, "Actually I don't like mushrooms anymore.", 1);
  await say(s, "Actually, forget that I like leather accessories.", 2);
  await sleep(500);
  assert.deepEqual(lines, ["Actually I don't like mushrooms anymore.", "Actually, forget that I like leather accessories."]);
  s.session.close();
});

test("Codex #401 r1 P1: watch together attaches while the question's TTS is still coming → its audio never goes out", async () => {
  let releaseTts!: () => void;
  const ttsGate = new Promise<void>((r) => (releaseTts = r));
  const s = setup({ async unplanCall() {} });
  const deps = (s.session as unknown as { deps: SessionDeps }).deps;
  deps.config = { ...deps.config, serverTts: true, voice: voiceCfg };
  let ttsStarted = false;
  deps.tts = async function* (req) {
    if (/weekends/i.test(req.text)) { ttsStarted = true; await ttsGate; }
    yield { audio: Buffer.alloc(4800), alignment: null, model: "seamless-m4t-v2" };
  };
  deps.spark = async function* () {
    yield { type: "text", delta: "<happy> Are your weekends busy or slow? " };
    yield { type: "done", responseId: "r", text: "", status: "completed" };
  };
  await s.session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await s.session.onClientText(JSON.stringify({ type: "text", text: "Hey, long week." }));
  const t0 = Date.now();
  while (!ttsStarted && Date.now() - t0 < 2000) await sleep(5);
  assert.ok(ttsStarted, "the question's TTS is in flight (askedAt already passed)");
  const audioBefore = s.client.json.filter((m) => m.type === "audio").length;
  assert.ok(s.session.attachWatch({ send() {}, sendJson() {}, close() {} } as never));
  releaseTts();
  const reply = await s.client.waitFor((m) => m.type === "reply");
  assert.doesNotMatch(String(reply.text), /weekends/i);
  assert.ok(String(reply.text).length > 0, "never silent: the short reaction takes its place");
  assert.equal(audioBefore, 0);
  s.session.close();
});

test("Codex #401 r2 P1: the question's TTS fails after watch together attached → the device fallback doesn't say it either", async () => {
  let releaseTts!: () => void;
  const ttsGate = new Promise<void>((r) => (releaseTts = r));
  const s = setup({ async unplanCall() {} });
  const deps = (s.session as unknown as { deps: SessionDeps }).deps;
  deps.config = { ...deps.config, serverTts: true, voice: voiceCfg };
  let ttsStarted = false;
  deps.tts = async function* (req) {
    if (/weekends/i.test(req.text)) { ttsStarted = true; await ttsGate; throw new Error("voice 503"); }
    yield { audio: Buffer.alloc(4800), alignment: null, model: "seamless-m4t-v2" };
  };
  deps.spark = async function* () {
    yield { type: "text", delta: "<happy> Are your weekends busy or slow? " };
    yield { type: "done", responseId: "r", text: "", status: "completed" };
  };
  await s.session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
  await s.session.onClientText(JSON.stringify({ type: "text", text: "Hey, long week." }));
  const t0 = Date.now();
  while (!ttsStarted && Date.now() - t0 < 2000) await sleep(5);
  assert.ok(s.session.attachWatch({ send() {}, sendJson() {}, close() {} } as never));
  releaseTts();
  const reply = await s.client.waitFor((m) => m.type === "reply");
  assert.doesNotMatch(String(reply.text), /weekends/i);
  assert.ok(!s.client.json.some((m) => m.type === "say" && /weekends/i.test(String(m.text))));
  s.session.close();
});

test("AU-92 r4: a profile read that timed out lands later — applied (with Finds) unless 'Forget all of this' came in between", { timeout: 15_000 }, async () => {
  let gen = 0;
  const slow = (profile: string) => setup({
    async startCall() { await sleep(1700); return { profile, taste: [] }; },
    generation: () => gen,
  });
  // landed, same generation: applied
  const a = slow("How the user wants to be treated:\n- Taste: Late but fine.");
  await a.session.onClientText(JSON.stringify({ type: "start", persona, user: { profile: "- Taste: App copy." } }));
  await sleep(1900);
  await say(a, "Hi.", 1);
  assert.match(a.sparkCalls.at(-1)!.instructions!, /Late but fine/);
  a.session.close();
  // forgotten in between: the old read never lands
  const b = slow("How the user wants to be treated:\n- Taste: Old secret.");
  await b.session.onClientText(JSON.stringify({ type: "start", persona, user: { profile: "" } }));
  gen = 1;
  await sleep(1900);
  await say(b, "Hi.", 1);
  assert.doesNotMatch(b.sparkCalls.at(-1)!.instructions!, /Old secret/);
  b.session.close();
  await sleep(10);
});

test("AU-92 r6: an interpretation start still takes the server's profile, so a switch to chat never uses the app's old copy", { timeout: 15_000 }, async () => {
  const s = setup({ async startCall() { return { profile: "", taste: [] }; } });
  await s.session.onClientText(JSON.stringify({ type: "start", persona, mode: "interpret", user: { profile: "- Taste: Old secret." } }));
  await sleep(50);
  await s.session.onClientText(JSON.stringify({ type: "mode", mode: "chat" }));
  await sleep(50);
  await say(s, "Hi.", 1);
  assert.doesNotMatch(s.sparkCalls.at(-1)!.instructions!, /Old secret/);
  s.session.close();
  await sleep(10);
});
