/**
 * P2 (9A.7 greeting): before the user has said a word, the companion never acts like it already heard them —
 * their voice, a laugh, a sigh, the mood in how they sound. The 01:00 hotfix (931c3cf) caught "your voice …" and
 * "you sound …"; these are the phrasings that still got through ("I can already hear that grin", "so good to hear
 * you", "sounds like someone's hyped"). After they speak, reacting to how they sound is fine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { guardSentence, neverSpoken } from "../src/convo/guard.ts";
import { openerBlock } from "../src/convo/opener.ts";
import { Session, type ClientSink } from "../src/session/session.ts";
import type { PersonaCard } from "../src/prompt/persona.ts";
import type { Config } from "../src/config.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";

const v1 = process.env.GENITA_CONVO_V1 !== "0";
const greet = { camera: false, userText: "" };

test("greet-heard: pre-speech 'heard you' lines are dropped on a greeting (never spoken)", () => {
  for (const line of [
    "Ooh, I can already hear that grin.",
    "I can totally hear you smiling right now.",
    "So good to hear you!",
    "Nice hearing you again.",
    "Love hearing you this early.",
    "Sounds like someone's in a good mood.",
    "Sounds like somebody slept great.",
    "You're sounding extra chipper today.",
    "I heard that sigh, what's up?",
    "Heard you laugh just now.",
    "Okay, I can hear the excitement already.",
    "Your laugh is already making my night.",
    "Wow, the energy in your tone, love it.",
    "Mm, I hear a smile.",
  ]) {
    const cls = guardSentence(line, greet);
    assert.equal(cls, "unseen", line);
    assert.ok(neverSpoken(cls!), line);
  }
});

test("greet-heard: normal greetings and 'hear' idioms stay", () => {
  for (const line of [
    "Hey! Good to hear from you.",
    "Hear me out: ramen, but for breakfast.",
    "Did you hear about the new aespa drop?",
    "I heard the new Frank Ocean album finally has a date.",
    "That sounds like a plan.",
    "Can't wait to hear how the interview went.",
    "I want to hear everything about the trip.",
    "I'd love to hear you rant about it later.",
    "Okay, film photography: I need your hot take on Portra.",
    "That song sounds like summer.",
  ]) assert.equal(guardSentence(line, greet), null, line);
});

test("greet-heard: after the user speaks, reacting to how they sound is fine", () => {
  const spoke = { camera: false, userText: "haha okay okay, I'm so ready for tonight" };
  for (const line of ["I can already hear that grin.", "Sounds like someone's in a good mood.", "You're sounding extra chipper.", "Love hearing you this hyped."]) {
    assert.equal(guardSentence(line, spoke), null, line);
  }
});

test("greet-heard: every opener tells Spark they haven't said anything yet", () => {
  const H = 3_600_000;
  for (const o of [
    { hasProfile: true, sinceLastMs: null, hasItem: false },
    { hasProfile: false, sinceLastMs: null, hasItem: false },
    { hasProfile: true, sinceLastMs: 30 * H, hasItem: true },
    { hasProfile: true, sinceLastMs: 1 * H, hasItem: false },
    { hasProfile: true, sinceLastMs: 5 * H, hasItem: false },
    { hasProfile: true, sinceLastMs: 50 * H, hasItem: false },
    { hasProfile: true, sinceLastMs: undefined, hasItem: false },
  ]) {
    const b = openerBlock(o);
    assert.match(b, /haven't said anything yet/, JSON.stringify(o));
    assert.doesNotMatch(b, /\n/, "still one line");
  }
});

// ───────── session: the greeting turn really drops it before it is voiced ─────────

const mina: PersonaCard = { name: "Mina", kind: "human", traits: ["warm", "dry humor"], speakingStyle: "short, playful" };
const config: Config = {
  metaKey: "x", serverTts: false, host: "127.0.0.1", port: 0, sessionToken: null, defaultVoiceId: "voice", webSearch: false,
  asrLanguages: ["English"], bargeInMinMs: 400, bargeInMinWords: 2, maxSessions: 4, maxSessionMs: 60_000,
  sparkFirstTokenTimeoutMs: 8000, sparkHedge: 1, speculate: false, speculateStableMs: 250,
};
class Client implements ClientSink {
  json: Record<string, unknown>[] = [];
  sendJson(m: Record<string, unknown>) { this.json.push(m); }
  sendBinary() {}
  close() {}
  async waitFor(pred: (m: Record<string, unknown>) => boolean, ms = 2000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = this.json.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error(`timeout: ${this.json.map((m) => m.type).join(",")}`);
  }
}
function setup(replies: string[]) {
  const client = new Client();
  const calls: SparkRequest[] = [];
  const session = new Session("c1", client, {
    config,
    now: () => 0,
    openAsr: () => { throw new Error("no asr"); },
    async *spark(req): AsyncGenerator<SparkStreamEvent> {
      calls.push(req);
      const text = replies[Math.min(calls.length - 1, replies.length - 1)];
      yield { type: "text", delta: text };
      yield { type: "done", responseId: "r", text, status: "completed" };
    },
    async *tts() {},
    log: () => {},
  });
  return { client, session, calls };
}

test("session v1 greet-heard: 'I can already hear that grin' is not spoken on the greeting; the rest is", { skip: !v1 }, async () => {
  const { client, session, calls } = setup(["<excited> Ooh, I can already hear that grin. Okay, ramen tonight or are we being responsible?"]);
  await session.onClientText(JSON.stringify({ type: "start", persona: mina, mic: false, tts: "device", greetAfterMs: 0, user: { name: "Summer", profile: "Likes: ramen." } }));
  const reply = await client.waitFor((m) => m.type === "reply");
  assert.doesNotMatch(String(reply.text), /hear/i, String(reply.text));
  assert.match(String(reply.text), /ramen tonight/);
  assert.match(String(calls[0].instructions), /haven't said anything yet/, "the greeting prompt says so too");
  session.close();
});

test("Codex #495 P2: hearing still to come, or a recall of earlier in the call (initiative), is kept", () => {
  for (const line of ["Can't wait to hear you laugh at my terrible jokes.", "I'm dying to hear your take on the finale.", "Your laugh earlier is still cracking me up.", "That sigh before, was it the deck again?"]) {
    assert.equal(guardSentence(line, greet), null, line);
  }
  assert.equal(guardSentence("Your laugh is already making my night.", greet), "unseen", "a claim about right now is still dropped");
});
