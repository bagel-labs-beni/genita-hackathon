/**
 * #343 (PRD 9A.9, DESIGN §3, §9): closeness by call count (call 1 already knows you, a bit giddy; 2–4 teasing and
 * callbacks; 5+ running jokes, freer disagreement, fewer questions) and the question rhythm (after a "?" reply the
 * next replies end on a statement; the rest grows with closeness; an unprompted line never stacks a second question).
 * Red on origin/main: call 1 has no line, only the very last reply is checked, initiative turns ignore the rhythm.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { closenessLine, cueRhythm, questionRest, turnHints } from "../src/convo/rhythm.ts";
import { initiativeBlock } from "../src/convo/initiative.ts";
import { Session, type ClientSink } from "../src/session/session.ts";
import type { PersonaCard } from "../src/prompt/persona.ts";
import type { Config } from "../src/config.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";

const v1 = process.env.GENITA_CONVO_V1 !== "0";
const STATEMENT = /End on a statement this time\./;

test("#343 closeness: one line per stage, call 1 included", () => {
  assert.match(closenessLine(1)!, /First call, but you already know them: a little giddy/);
  assert.equal(closenessLine(undefined), null, "unknown call count: no claim");
  assert.match(closenessLine(3)!, /teasing and callbacks/);
  assert.match(closenessLine(6)!, /running jokes and honest disagreement/);
  assert.match(closenessLine(6)!, /fewer questions/);
  assert.match(turnHints({ userText: "ok", callNumber: 1, remembers: false })!, /^This turn: First call, but you already know them/);
});

test("#343 question rhythm: the rest after a '?' reply is 2 replies, 3 once you're close", () => {
  assert.equal(questionRest(1), 2);
  assert.equal(questionRest(4), 2);
  assert.equal(questionRest(5), 3);
  assert.equal(questionRest(undefined), 2);
  const q = "<curious> Wait, white or black?";
  const s = "<happy> Black, easy.";
  assert.match(turnHints({ userText: "ok", callNumber: 2, remembers: false, recentReplies: [q, s] })!, STATEMENT, "one statement since the question is not enough");
  assert.doesNotMatch(turnHints({ userText: "ok", callNumber: 2, remembers: false, recentReplies: [q, s, s] }) ?? "", STATEMENT);
  assert.match(turnHints({ userText: "ok", callNumber: 6, remembers: false, recentReplies: [q, s, s] })!, STATEMENT, "close: a longer rest");
  assert.match(turnHints({ userText: "ok", remembers: false, lastReply: "White or black? —" })!, STATEMENT, "lastReply alone still works (cut-off reply)");
});

test("#343 worst case: a model that asks whenever it may still ends ≤ 1 in 3 replies on '?' (≤ 1 in 4 when close)", () => {
  for (const [call, max] of [[1, 1 / 3], [3, 1 / 3], [6, 1 / 4]] as const) {
    const replies: string[] = [];
    for (let i = 0; i < 24; i++) {
      const told = STATEMENT.test(turnHints({ userText: "ok", callNumber: call, remembers: false, recentReplies: replies.slice(-3) }) ?? "");
      replies.push(told ? "<happy> Fair." : "<curious> And then?");
    }
    const asked = replies.filter((r) => r.endsWith("?")).length / replies.length;
    assert.ok(asked <= max + 1e-9, `call ${call}: ${asked}`);
  }
});

test("#343 an unprompted line after an unanswered question ends on a statement (not the gentle tired check)", () => {
  const block = initiativeBlock("silence", []);
  assert.match(cueRhythm(block, "silence", ["<curious> So who won?"]), /Your last question is still open: don't ask another; end on a statement\.$/);
  assert.equal(cueRhythm(block, "silence", ["<happy> Fair."]), block);
  const tired = initiativeBlock("looks_tired", []);
  assert.equal(cueRhythm(tired, "looks_tired", ["<curious> So who won?"]), tired, "the tired check stays a soft question");
});

const config: Config = {
  metaKey: "x", serverTts: false, host: "127.0.0.1", port: 0, sessionToken: null, defaultVoiceId: "voice", webSearch: false,
  asrLanguages: ["English"], bargeInMinMs: 400, bargeInMinWords: 2, maxSessions: 4, maxSessionMs: 60_000,
  sparkFirstTokenTimeoutMs: 8000, sparkHedge: 1, speculate: false, speculateStableMs: 250,
};
const mina: PersonaCard = { name: "Mina", kind: "human", traits: ["warm", "dry humor"], speakingStyle: "short, playful" };

class Client implements ClientSink {
  json: Record<string, unknown>[] = [];
  sendJson(m: Record<string, unknown>) { this.json.push(m); }
  sendBinary() {}
  close() {}
  async waitFor(pred: (m: Record<string, unknown>) => boolean, ms = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = this.json.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error(`timeout: ${this.json.map((m) => m.type).join(",")}`);
  }
}

test("#343 session: call 1 user turns carry the giddy line; an initiative after the companion's unanswered '?' ends on a statement", { skip: !v1 }, async () => {
  const client = new Client();
  const calls: SparkRequest[] = [];
  let clock = 0;
  const replies = ["<happy> Ha, okay.", "<curious> Okay but who won the bet?", "<happy> Fair, the cat wins again."];
  const session = new Session("c1", client, {
    config,
    now: () => clock,
    openAsr: () => { throw new Error("no asr"); },
    async *spark(req): AsyncGenerator<SparkStreamEvent> {
      calls.push(req);
      const text = replies[Math.min(calls.length - 1, replies.length - 1)];
      yield { type: "text", delta: text };
      yield { type: "done", responseId: "r", text, status: "completed" };
    },
    async *tts() {},
    log: () => {},
    personalize: { startCall: async () => ({ taste: [], calls: 1 }), voiceCorrection: async () => null, endCall: async () => 0 } as never,
    userId: "u1",
  });
  await session.onClientText(JSON.stringify({ type: "start", persona: mina, mic: true, tts: "device" }));
  await session.onClientText(JSON.stringify({ type: "text", text: "hey" }));
  const first = await client.waitFor((m) => m.type === "reply");
  await session.onClientText(JSON.stringify({ type: "text", text: "lost a bet to my cat" }));
  await client.waitFor((m) => m.type === "reply" && m !== first);
  assert.match(calls[1].instructions!, /This turn: First call, but you already know them: a little giddy/);
  await session.onClientText(JSON.stringify({ type: "playback_done", utteranceId: 2 }));
  await client.waitFor((m) => m.type === "state" && m.state === "listening" && client.json.indexOf(m) > 2);
  clock += 14_000;
  await session.initiativeTick();
  await client.waitFor((m) => m.type === "reply" && client.json.filter((x) => x.type === "reply").length === 3);
  assert.match(calls[2].instructions!, /You speak first now[^\n]*Your last question is still open: don't ask another; end on a statement\./);
  session.close();
});
