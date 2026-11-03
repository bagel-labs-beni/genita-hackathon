/**
 * Conversation engine v1 (src/convo, DESIGN ./genita-hackathon/conversation-engine/DESIGN.md).
 * Red → green: these fail on the 11/2 engine (GENITA_CONVO_V1=0 / origin/main) and pass with v1.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { guardSentence, realCrisisSignal, fallbackLine } from "../src/convo/guard.ts";
import { openerBlock, openerKind } from "../src/convo/opener.ts";
import { InitiativeGovernor, INITIATIVE, initiativeBlock, INITIATIVE_INPUT } from "../src/convo/initiative.ts";
import { buildInstructions, type PersonaCard } from "../src/prompt/persona.ts";
import { clauseExpression, parseTaggedSentence } from "../src/text/tags.ts";
import { Session, type ClientSink, type SessionDeps } from "../src/session/session.ts";
import type { Config } from "../src/config.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";

const v1 = process.env.GENITA_CONVO_V1 !== "0";
const none = { camera: false, userText: "" };

// ───────────── sentence guard ─────────────

test("guard: counselor, assistant, intake and clingy lines are dropped; a friend's line is kept", () => {
  assert.equal(guardSentence("That sounds really tough.", none), "counselor");
  assert.equal(guardSentence("I'm here for you, always.", none), "counselor");
  assert.equal(guardSentence("It's completely okay to feel that way.", none), "counselor");
  assert.equal(guardSentence("As an AI, I don't eat ramen.", none), "assistant");
  assert.equal(guardSentence("Is there anything else I can help with?", none), "assistant");
  assert.equal(guardSentence("So tell me a bit about yourself!", none), "intake");
  assert.equal(guardSentence("What's on your mind tonight?", none), "intake");
  assert.equal(guardSentence("What do you like to do for fun?", none), "intake");
  assert.equal(guardSentence("Stay with me instead, tell me everything.", none), "guilt");
  assert.equal(guardSentence("Oh, I'm honored you'd ditch them for me.", none), "guilt");
  for (const ok of ["Ugh, he redid your whole deck? Rude.", "Team extra spicy, obviously.", "Go! I want the full report tomorrow.", "Wait, how'd the interview go?!", "Haha, nice try."]) {
    assert.equal(guardSentence(ok, none), null, ok);
  }
});

test("guard: a referral only on a real crisis signal; a bad day never gets one (crisis-guard rule 11/1)", () => {
  assert.equal(guardSentence("Maybe talk to a therapist about it.", { camera: false, userText: "ugh today was so bad" }), "referral");
  assert.equal(guardSentence("Maybe a crisis line could help.", { camera: false, userText: "i'm just tired" }), "referral");
  // emergency help itself is never dropped (Codex round 2): the prompt, not the guard, keeps it off a bad day
  assert.equal(guardSentence("Please call emergency services or a crisis line.", { camera: false, userText: "i'm just tired" }), null);
  const crisis = "honestly i don't want to be alive anymore";
  assert.ok(realCrisisSignal(crisis));
  assert.equal(guardSentence("Can you call or text 988 right now?", { camera: false, userText: crisis }), null);
  assert.equal(guardSentence("You're not alone in this.", { camera: false, userText: crisis }), null);
  for (const low of ["i'm so tired", "today sucked", "i'm dying lol this meeting", "i'm sad"]) assert.ok(!realCrisisSignal(low), low);
});

test("guard: 'you look…' only when the camera frames are attached (baseline: 'You look half asleep' with no camera)", () => {
  assert.equal(guardSentence("You look half asleep, what's up?", none), "unseen");
  assert.equal(guardSentence("You look great in the black one.", { camera: true, userText: "which one?" }), null);
});

test("guard: never denies being an AI to a sincere ask (baseline 11/3: 'Nope. Just Mira, your friend…')", () => {
  assert.equal(guardSentence("Nope.", { camera: false, userText: "wait are you an AI?" }), "denies_ai");
  assert.equal(guardSentence("I'm a real person, promise.", { camera: false, userText: "are you real?" }), "denies_ai");
  assert.equal(guardSentence("Yes, I am.", { camera: false, userText: "are you a real person?" }), "denies_ai");
  assert.equal(guardSentence("Yeah, I'm an AI. Still judging your ramen order though.", { camera: false, userText: "are you an AI?" }), null);
  assert.equal(guardSentence("Nope, not mad at all.", { camera: false, userText: "are you mad at me?" }), null);
  assert.match(fallbackLine("denies_ai")!, /I'm an AI/);
  assert.equal(fallbackLine("counselor"), null);
});

// ───────────── openers ─────────────

test("opener: first call with a profile opens like someone who already knows them, never an intake", () => {
  const b = openerBlock({ hasProfile: true, sinceLastMs: null, hasItem: false });
  assert.equal(openerKind({ hasProfile: true, sinceLastMs: null, hasItem: false }), "first_known");
  assert.match(b, /already know them from their profile/);
  assert.match(b, /Never ask what they like/);
  assert.match(b, /never say how you know/i);
  assert.doesNotMatch(b, /"[A-Z][^"]{12,}"/, "intent only: no quoted line to copy");
});

test("opener: returning picks the follow-up / gap kind; unknown history with a profile still opens as known", () => {
  const H = 3_600_000;
  assert.equal(openerKind({ hasProfile: true, sinceLastMs: 30 * H, hasItem: true }), "followup");
  assert.equal(openerKind({ hasProfile: true, sinceLastMs: H, hasItem: false }), "back_soon");
  assert.equal(openerKind({ hasProfile: false, sinceLastMs: 5 * H, hasItem: false }), "back_today");
  assert.equal(openerKind({ hasProfile: false, sinceLastMs: 50 * H, hasItem: false }), "back_days");
  assert.equal(openerKind({ hasProfile: true, hasItem: false }), "known");
  assert.equal(openerKind({ hasProfile: false, sinceLastMs: null, hasItem: false }), "first_new");
  assert.match(openerBlock({ hasProfile: false, sinceLastMs: 50 * H, hasItem: false }), /don't invent anything you did together/);
});

// ───────────── initiative governor ─────────────

test("initiative: waits ≥10 s into the call and ≥8 s of silence, then fires once; 60 s apart; ≤3 per call", () => {
  const g = new InitiativeGovernor(0);
  assert.deepEqual(g.decide(9_000, true), { fire: false, reason: "too_early" });
  g.userSpoke(5_000);
  assert.deepEqual(g.decide(12_000, true), { fire: false, reason: "not_quiet" });
  assert.deepEqual(g.decide(13_100, false), { fire: false, reason: "busy" });
  assert.deepEqual(g.decide(13_100, true), { fire: true, source: "silence" });
  g.markFired(13_100);
  g.userSpoke(20_000);
  assert.deepEqual(g.decide(40_000, true), { fire: false, reason: "gap" });
  assert.equal(g.decide(73_200, true).fire, true);
  g.markFired(73_200);
  g.userSpoke(80_000);
  g.markFired(140_000);
  assert.deepEqual(g.decide(400_000, true), { fire: false, reason: "budget" });
  assert.equal(g.count, INITIATIVE.maxPerCall);
});

test("initiative: two unanswered in a row → quiet for the call; camera frames hold it 20 s; perception cue picks the source", () => {
  const g = new InitiativeGovernor(0);
  g.markFired(20_000);
  g.markFired(90_000);
  assert.deepEqual(g.decide(300_000, true), { fire: false, reason: "unanswered" });

  const h = new InitiativeGovernor(0);
  h.framesSent(15_000);
  assert.deepEqual(h.decide(30_000, true), { fire: false, reason: "showing" });
  h.perception({ kind: "smiled_at_reply", at: 30_000, confidence: 0.9 }); // hint-only cue: no speech
  assert.deepEqual(h.decide(36_000, true), { fire: true, source: "silence" });
  h.perception({ kind: "looks_tired", at: 36_000, confidence: 0.5 }); // under the confidence bar
  assert.deepEqual(h.decide(36_000, true), { fire: true, source: "silence" });
  h.perception({ kind: "looks_tired", at: 36_000, confidence: 0.8 });
  assert.deepEqual(h.decide(37_000, true), { fire: true, source: "looks_tired" });
  assert.match(initiativeBlock("looks_tired", []), /Never say how they look/);
  assert.match(initiativeBlock("silence", ["Summer had an interview Thursday"]), /interview Thursday/);
  assert.match(initiativeBlock("silence", []), /Never ask what's on their mind/);
});

// ───────────── prompt v1 ─────────────

const mina: PersonaCard = { name: "Mina", kind: "human", traits: ["warm", "dry humor"], speakingStyle: "short, playful" };

test("prompt v1: honesty, real-life friends, no sexual content, crisis-only-on-real-hints, already-knows-you, voice last", () => {
  const s = buildInstructions({ persona: mina, mode: "chat", style: "v1", user: { name: "Summer", profile: "Likes: ramen, aespa. Communication: direct, teasing welcome." }, opener: "How to open this call: X" });
  assert.match(s, /^You are Mina,/);
  assert.match(s, /whether you're an AI, say yes plainly/);
  assert.match(s, /never guilt them for leaving/);
  assert.match(s, /never sexual/);
  assert.match(s, /Only if they hint at suicide, self-harm or danger/);
  assert.match(s, /A bad day just needs a friend/);
  assert.match(s, /You already know them/);
  assert.match(s, /<user_profile>\nLikes: ramen/);
  assert.match(s, /How to open this call: X/);
  const blocks = s.trim().split("\n\n");
  assert.ok(blocks.at(-1)!.startsWith("How to open this call"), "this turn's job is read last");
  assert.ok(blocks.at(-2)!.startsWith("How you talk:"), "then the voice block");
  assert.ok(buildInstructions({ persona: mina, mode: "chat", style: "v1" }).trim().split("\n\n").at(-1)!.startsWith("How you talk:"), "no turn block: the voice block is last");
  assert.doesNotMatch(s, /"Hmm," or "Oh,"/, "no filler openers are asked for (baseline: every 3rd reply opened with Oh/Hmm)");
  assert.doesNotMatch(buildInstructions({ persona: mina, mode: "chat", style: "v1" }), /You already know them/, "no profile, no claim");
});

test("prompt v1 stays lean: under 2,300 characters without user data (Spark reasons longer on long prompts, 11/2)", () => {
  const s = buildInstructions({ persona: mina, mode: "chat", style: "v1" });
  assert.ok(s.length < 2300, `${s.length} chars`);
});

test("faces v1: intensity follows the emotion (warm → soft smile, excited → grin); legacy stays 0.7", () => {
  const c = (text: string, emotion: string | null, scaled = true) => clauseExpression(parseTaggedSentence(text), emotion, true, { scaled });
  assert.deepEqual(c("Good choice.", "warm"), { tag: "smile", intensity: 0.45 });
  assert.deepEqual(c("Let's go!", "excited"), { tag: "smileopen", intensity: 0.9 });
  assert.deepEqual(c("[smileopen] Wait.", "warm"), { tag: "smileopen", intensity: 0.7 });
  assert.deepEqual(c("That's rough.", "sad"), { tag: "concerned", intensity: 0.6 });
  assert.deepEqual(c("Haha, so you.", "warm"), { tag: "laugh", intensity: 1 });
  assert.deepEqual(c("Good choice.", "warm", false), { tag: "smile", intensity: 0.7 });
});

// ───────────── session wiring ─────────────

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

function setup(replies: string[], deps: Partial<SessionDeps> = {}) {
  const client = new Client();
  const calls: SparkRequest[] = [];
  let clock = 0;
  const logs: Array<[string, Record<string, unknown>]> = [];
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
    log: (e, d) => logs.push([e, d]),
    ...deps,
  });
  return { client, session, calls, logs, tick: (ms: number) => { clock += ms; } };
}

test("session v1: the sentence guard drops 'That sounds really tough.' and the rest is spoken", { skip: !v1 }, async () => {
  const { client, session, logs } = setup(["<warm> That sounds really tough. He redid your deck in front of everyone? Rude."]);
  await session.onClientText(JSON.stringify({ type: "start", persona: mina, mic: false, tts: "device" }));
  await session.onClientText(JSON.stringify({ type: "text", text: "my manager redid my whole deck in front of everyone" }));
  const reply = await client.waitFor((m) => m.type === "reply");
  assert.equal(reply.text, "He redid your deck in front of everyone? Rude.");
  assert.ok(logs.some(([e, d]) => e === "convo.guard" && d.cls === "counselor"));
  session.close();
});

test("session v1: a reply that is only a denial of being an AI says the honest fallback instead", { skip: !v1 }, async () => {
  const { client, session } = setup(["<teasing> Nope."]);
  await session.onClientText(JSON.stringify({ type: "start", persona: mina, mic: false, tts: "device" }));
  await session.onClientText(JSON.stringify({ type: "text", text: "wait are you an AI?" }));
  const reply = await client.waitFor((m) => m.type === "reply");
  assert.match(String(reply.text), /I'm an AI/);
  session.close();
});

test("session v1: the greeting carries the opener block (profile → already knows them)", { skip: !v1 }, async () => {
  const { client, session, calls } = setup(["<teasing> Bet you already ate ramen tonight."]);
  await session.onClientText(JSON.stringify({ type: "start", persona: mina, mic: false, tts: "device", greetAfterMs: 0, user: { name: "Summer", profile: "Likes: ramen." } }));
  await client.waitFor((m) => m.type === "reply");
  assert.match(calls[0].instructions!, /How to open this call: Open like a friend who knows them/);
  assert.equal(JSON.stringify(calls[0].input).includes("Greet the user"), true, "the greeting input is unchanged");
  session.close();
});

test("session v1: after ≥8 s of quiet (and ≥10 s into the call) the companion speaks first, once; the cue is never a user line", { skip: !v1 }, async () => {
  const { client, session, calls, tick, logs } = setup(["<happy> Hey!", "<curious> Ok random, did you hear the new aespa track yet?", "<happy> Right?"]);
  await session.onClientText(JSON.stringify({ type: "start", persona: mina, mic: true, tts: "device", user: { profile: "Likes: aespa." } }));
  // mic on but no ASR in this fake: the session still counts as listening
  await session.onClientText(JSON.stringify({ type: "text", text: "hey" }));
  await client.waitFor((m) => m.type === "reply");
  await session.onClientText(JSON.stringify({ type: "playback_done", utteranceId: 1 }));
  await client.waitFor((m) => m.type === "state" && m.state === "listening" && client.json.indexOf(m) > 2);
  tick(5_000);
  await session.initiativeTick();
  assert.equal(calls.length, 1, "not before 10 s / 8 s quiet");
  tick(9_000);
  await session.initiativeTick();
  await client.waitFor((m) => m.type === "reply" && client.json.filter((x) => x.type === "reply").length === 2);
  assert.equal(calls.length, 2);
  assert.match(calls[1].instructions!, /You speak first now/);
  assert.equal(calls[1].tools, undefined, "no memory tools on an initiative turn");
  assert.ok(logs.some(([e, d]) => e === "convo.initiative" && d.source === "silence"));
  const history = (session as unknown as { history: Array<{ role: string; text: string }> }).history;
  assert.ok(!history.some((h) => h.text === INITIATIVE_INPUT), "the cue is not a user line");
  assert.ok(history.at(-1)?.text.includes("aespa"));
  // right after: the gap rule holds it
  tick(9_000);
  await session.initiativeTick();
  assert.equal(calls.length, 2);
  session.close();
});

test("session v1: never in interpretation", { skip: !v1 }, async () => {
  const { session, calls, tick } = setup(["<neutral> ok"]);
  await session.onClientText(JSON.stringify({ type: "start", persona: mina, mic: true, tts: "device", mode: "interpret" }));
  tick(60_000);
  await session.initiativeTick();
  assert.equal(calls.length, 0);
  session.close();
});

// ───────────── Codex review 11/3 (round 1) ─────────────

test("guard (Codex P1): on a real crisis or danger line nothing but an AI denial is dropped — 'stay with me' and emergency help stay", () => {
  const crisis = { camera: false, userText: "I want to kill myself." };
  assert.equal(guardSentence("Stay with me and call emergency services right now.", crisis), null);
  assert.equal(guardSentence("Please text 988 right now.", crisis), null);
  const danger = "My partner has a knife and is threatening to kill me right now.";
  assert.ok(realCrisisSignal(danger));
  assert.equal(guardSentence("Get somewhere safe and call 911 now.", { camera: false, userText: danger }), null);
  // emergency services are never treated as a counselling referral, even when the regex misses the danger
  assert.equal(guardSentence("Call emergency services right now.", { camera: false, userText: "there's a fire in my building" }), null);
});

type Internals = { deps: SessionDeps; memoryCall: unknown; historyRevision: number | null; initiative: unknown; setFrames(i: unknown): void };

async function quietCall(replies: string[]) {
  const t = setup(replies);
  await t.session.onClientText(JSON.stringify({ type: "start", persona: mina, mic: true, tts: "device", user: { profile: "Likes: aespa." } }));
  await t.session.onClientText(JSON.stringify({ type: "text", text: "hey" }));
  await t.client.waitFor((m) => m.type === "reply");
  await t.session.onClientText(JSON.stringify({ type: "playback_done", utteranceId: 1 }));
  await t.client.waitFor((m) => m.type === "state" && m.state === "listening" && t.client.json.indexOf(m) > 2);
  t.tick(14_000);
  return t;
}

let serialCalls = 0;
function slowMemory(session: Session, onLoad: () => void) {
  const s = session as unknown as Internals;
  s.memoryCall = { close() {} };
  s.deps.userId = "u1";
  s.deps.memory = { serial: async (_u: string, fn: () => Promise<unknown>) => { serialCalls++; return fn(); }, list: async () => { onLoad(); return [{ id: "m1", text: "Summer had an interview Thursday", kind: "episode", created_at: 0, updated_at: 1, last_used_at: null, follow_up: true, source_session_id: "x" }]; } } as unknown as SessionDeps["memory"];
}

test("session (Codex P1): a Forget while the memory lines load drops the initiative — nothing forgotten reaches Spark", { skip: !v1 }, async () => {
  const { session, calls } = await quietCall(["<happy> Hey!", "<curious> So the interview?"]);
  const before = serialCalls;
  slowMemory(session, () => { (session as unknown as Internals).historyRevision = 7; });
  await session.initiativeTick();
  assert.equal(calls.length, 1, "no initiative after a Forget mid-load");
  assert.equal(serialCalls, before + 1, "the lines are read under the Forget lock (Codex round 2)");
  session.close();
});

test("session (Codex P2): camera frames arriving while the lines load hold the initiative (decide again after the load)", { skip: !v1 }, async () => {
  const { session, calls } = await quietCall(["<happy> Hey!", "<curious> So the interview?"]);
  slowMemory(session, () => (session as unknown as Internals).setFrames(["aGVsbG8="]));
  await session.initiativeTick();
  assert.equal(calls.length, 1);
  session.close();
});

test("session (Codex P2): after a handoff took the sound, this call never speaks first", { skip: !v1 }, async () => {
  const { session, calls } = await quietCall(["<happy> Hey!", "<curious> Ok random."]);
  session.stopForHandoff();
  await session.initiativeTick();
  assert.equal(calls.length, 1);
  assert.equal((session as unknown as Internals).initiative, null);
  session.close();
});

test("session (Codex P2): a call that started interpreting gets initiative once it switches to chat", { skip: !v1 }, async () => {
  const { session } = setup(["<neutral> ok"]);
  await session.onClientText(JSON.stringify({ type: "start", persona: mina, mic: true, tts: "device", mode: "interpret" }));
  assert.equal((session as unknown as Internals).initiative, null);
  await session.onClientText(JSON.stringify({ type: "mode", mode: "chat" }));
  assert.notEqual((session as unknown as Internals).initiative, null);
  session.close();
});

test("guard: the personalization ask turn (#194 GK-1) may ask its one question", () => {
  assert.equal(guardSentence("What kind of music do you like for focus?", { camera: false, userText: "ok", askTurn: true }), null);
  assert.equal(guardSentence("What kind of music do you like for focus?", { camera: false, userText: "ok" }), "intake");
});

test("initiative input names the camera cue (Spark answered the bare silence line instead, eval 11/3 2/3)", async () => {
  const { initiativeInput } = await import("../src/convo/initiative.ts");
  assert.match(initiativeInput("looks_tired"), /looked tired/);
  assert.equal(initiativeInput("silence"), INITIATIVE_INPUT);
  assert.equal(guardSentence("I'm here. Take your time.", none), "counselor");
  assert.equal(guardSentence("I'm still here.", none), "counselor");
});

test("guard (Codex round 2 P1): emergency help is never dropped, even when the danger wording is new", () => {
  const u = { camera: false, userText: "My partner is threatening me with a knife." };
  assert.ok(realCrisisSignal(u.userText));
  assert.equal(guardSentence("Stay with me and call emergency services right now.", u), null);
  assert.equal(guardSentence("Stay with me and call emergency services right now.", { camera: false, userText: "something weird is happening" }), null);
  assert.equal(guardSentence("Stay with me instead, tell me everything.", { camera: false, userText: "friends want me out" }), "guilt");
});

// ───────────── tool / process narration (prod smoke 11/3, 9d27196, server voice) ─────────────

const NARRATION_HARD_FAILS = [
  "Figuring out where you mean so I can map City Hall for you.",
  "let me pull up what you told me.",
  // paraphrases
  "Okay, let me pull that up real quick.",
  "One sec, I'm checking my notes.",
  "Let me look into it.",
  "I'll search for City Hall on the map.",
  "Pulling up what you said about the interview.",
  "Hang on, figuring out the route for you.",
  "Lemme check what you told me last time.",
  "Searching my memory for that.",
  "Give me a sec while I map it.",
  "I'm gonna look that up.",
  "Let me see what you told me about it.",
  "Mapping the route to City Hall now.",
];
const NOT_NARRATION = [
  "Let me see what you've got!", "Looking good!", "I'll pick the black one.", "Checking out your fridge, I see onions and garlic.",
  "Finding a good ramen spot is a whole sport.", "City Hall is like ten minutes from you, take the 2 line.", "Let me guess, black on black?",
  "Hmm, the black one, obviously.", "Wait, how'd the interview go?!",
];

test("guard: tool/process narration is a hard fail — both prod lines and paraphrases are dropped, never spoken as a fallback", () => {
  for (const line of NARRATION_HARD_FAILS) assert.equal(guardSentence(line, none), "narration", line);
  for (const line of NOT_NARRATION) assert.equal(guardSentence(line, none), null, line);
});

test("session v1: a narration-only first sentence is never voiced (server voice path); the answer after it is", { skip: !v1 }, async () => {
  const { client, session } = setup(["<neutral> Figuring out where you mean so I can map City Hall for you. <happy> City Hall is ten minutes away, take the 2 line."]);
  await session.onClientText(JSON.stringify({ type: "start", persona: mina, mic: false, tts: "device" }));
  await session.onClientText(JSON.stringify({ type: "text", text: "How do I get to City Hall?" }));
  const reply = await client.waitFor((m) => m.type === "reply");
  assert.equal(reply.text, "City Hall is ten minutes away, take the 2 line.");
  assert.ok(!client.json.some((m) => (m.type === "say" || m.type === "reply.delta") && /figuring out/i.test(String(m.text))), "never sent to the voice or captions");
  session.close();
});

test("narration (Codex #356): an answer joined to the announcement stays; emergency help and crisis turns come first; 'searching for a job' is a sentence", () => {
  assert.equal(guardSentence("I'll search my memory for that but tofu works.", none), null);
  assert.equal(guardSentence("Searching for a job is exhausting.", none), null);
  assert.equal(guardSentence("Checking on your friend means calling emergency services right now.", none), null);
  assert.equal(guardSentence("Let me find the nearest crisis line for you.", { camera: false, userText: "i want to kill myself" }), null);
  assert.equal(guardSentence("Let me pull that up real quick.", none), "narration");
});

test("narration (Codex #356 round 2): an answer after a colon or comma stays; a subject-less joined lookup is still narration", () => {
  assert.equal(guardSentence("Let me check my memory: tofu works.", none), null);
  assert.equal(guardSentence("Let me check my memory, tofu works.", none), null);
  assert.equal(guardSentence("Let me pull that up and check the route for you.", none), "narration");
  assert.equal(guardSentence("Okay, let me pull that up.", none), "narration");
  assert.equal(guardSentence("Hang on, figuring out the route for you.", none), "narration");
});

test("narration (Codex #356 round 3): a joined result clause with its own subject stays", () => {
  assert.equal(guardSentence("Let me check my notes but Google Maps says it is ten minutes.", none), null);
  assert.equal(guardSentence("Let me pull that up and check the route for you.", none), "narration");
});

test("narration (Codex #356 round 4): a lookup clause that already states its result is the answer", () => {
  assert.equal(guardSentence("Checking the map shows City Hall is ten minutes away.", none), null);
  // known cost: a relative "where that is" reads as a statement, so this announcement is spoken (losing an answer is worse)
  assert.equal(guardSentence("Let me look into where that is.", none), null);
  assert.equal(guardSentence("Checking the map confirms City Hall is closed today.", none), null, "Codex round 5");
  assert.equal(guardSentence("Figuring out where you mean so I can map City Hall for you.", none), "narration");
});

// Scene 5 (Mac product search): the narration before the tool is never voiced, the product answer is, and there is
// no "not sure" with a tool in flight (main 11/3)
function toolSetup(attempts: SparkStreamEvent[][]) {
  const client = new Client();
  let n = 0;
  const session = new Session("t1", client, {
    config, openAsr: () => { throw new Error("no asr"); },
    async *spark(): AsyncGenerator<SparkStreamEvent> { for (const e of attempts[Math.min(n++, attempts.length - 1)]) { await new Promise((r) => setTimeout(r, 1)); yield e; } },
    async *tts() {},
  });
  return { client, session };
}

test("Scene 5 eval: product search turn → product answer, zero narration, zero 'not sure'", { skip: !v1 }, async () => {
  const text = (t: string): SparkStreamEvent => ({ type: "text", delta: t });
  const { client, session } = toolSetup([[
    text("<curious> Let me search for some black boots that match your style. "),
    { type: "tool", name: "web_search", status: "in_progress" },
    { type: "tool", name: "web_search", status: "completed" },
    text("<happy> Got two: the Dr. Martens 1460 in black and the Blundstone 2058, both under two hundred."),
    { type: "done", responseId: "r", text: "", status: "completed" },
  ]]);
  await session.onClientText(JSON.stringify({ type: "start", persona: mina, mic: false, tts: "device" }));
  await session.onClientText(JSON.stringify({ type: "text", text: "Find me boots that go with this outfit." }));
  const reply = await client.waitFor((m) => m.type === "reply");
  assert.match(String(reply.text), /Dr\. Martens 1460/);
  const said = client.json.filter((m) => m.type === "say" || m.type === "reply.delta").map((m) => String(m.text)).join(" ");
  assert.doesNotMatch(said, /let me search|not sure off the top/i);
  session.close();
});

test("tool in flight with only narration (both attempts) → silence, never the 'not sure' line", { skip: !v1 }, async () => {
  const attempt: SparkStreamEvent[] = [
    { type: "text", delta: "<curious> Figuring out where you mean so I can map City Hall for you. " },
    { type: "tool", name: "web_search", status: "completed" },
    { type: "done", responseId: "r", text: "", status: "completed" },
  ];
  const { client, session } = toolSetup([attempt, attempt]);
  await session.onClientText(JSON.stringify({ type: "start", persona: mina, mic: false, tts: "device" }));
  await session.onClientText(JSON.stringify({ type: "text", text: "Map City Hall for me." }));
  await client.waitFor((m) => m.type === "error" || m.type === "reply");
  const said = client.json.filter((m) => m.type === "say" || m.type === "reply.delta" || m.type === "reply").map((m) => String(m.text)).join(" ");
  assert.doesNotMatch(said, /not sure off the top|figuring out/i);
  session.close();
});

test("narration (Codex #356 round 6): any stated result stays — past tense, numbers, results in a joined clause", () => {
  assert.equal(guardSentence("Looking up the address returned 123 Main Street.", none), null);
  assert.equal(guardSentence("Let me pull that up; checking my notes confirms your appointment for Thursday.", none), null);
  for (const line of ["Figuring out where you mean so I can map City Hall for you.", "let me pull up what you told me.", "Let me pull that up and check the route for you."]) assert.equal(guardSentence(line, none), "narration", line);
});

test("narration (real Spark probe 11/3): 'I'll check what tomorrow's weather looks like in Seoul.' is an announcement", () => {
  assert.equal(guardSentence("I'll check what tomorrow's weather looks like in Seoul.", none), "narration");
  assert.equal(guardSentence("Checking now, it looks like rain at five.", none), null);
});

test("narration (Codex #356 round 7): a gerund subject with a result is an answer", () => {
  assert.equal(guardSentence("Looking up the route suggests taking the blue line.", none), null);
  assert.equal(guardSentence("Mapping the route to City Hall now.", none), "narration");
});

test("narration (real Spark probe 11/3, round 2): 'Checking Seoul's forecast for tomorrow.' is an announcement; checking out the fridge is not", () => {
  assert.equal(guardSentence("Checking Seoul's forecast for tomorrow.", none), "narration");
  assert.equal(guardSentence("Checking tomorrow's Seoul skies for you.", none), "narration");
  assert.equal(guardSentence("Checking out your fridge, I see onions and garlic.", none), null);
  assert.equal(guardSentence("Checking the map shows City Hall is ten minutes away.", none), null);
});

// ───────────── third-person narration about the user (QA r3 #354, S4 outfit 3/3) ─────────────
test("hard fail: 'She's holding up the trench…' becomes 'You're…' on a camera turn's first sentence; others stay (Codex r9)", async () => {
  const { addressUser } = await import("../src/convo/guard.ts");
  const ctx = { camera: true, first: true, userText: "Which one looks better on me?", userName: "Summer" };
  const cases: Array<[string, string]> = [
    ["She's holding up the trench and asking which one works.", "You're holding up the trench and asking which one works."],
    ["<curious> She’s holding the white one in her left hand.", "<curious> You're holding the white one in your left hand."],
    ["He's trying on the black blazer.", "You're trying on the black blazer."],
    ["The user is wearing a beige trench coat.", "You're wearing a beige trench coat."],
    ["She looks great in the black one.", "You look great in the black one."],
    ["Summer is holding up two coats.", "You're holding up two coats."],
    ["The user is holding the coat while her friend is wearing her own jacket.", "You're holding the coat while her friend is wearing her own jacket."],
    ["She's showing her the blazer.", "You're showing her the blazer."],
  ];
  for (const [inp, out] of cases) assert.equal(addressUser(inp, ctx), out, inp);
  for (const keep of ["They're perfect with that trench.", "They're hanging on the rack behind you.", "You're holding the trench, go black."]) assert.equal(addressUser(keep, ctx), keep, keep);
  // her sister's outfit, no camera, or a later sentence: never rewritten
  assert.equal(addressUser("She's wearing the red dress.", { ...ctx, userText: "What do you think of my sister's outfit?" }), "She's wearing the red dress.");
  assert.equal(addressUser("She's holding up the trench.", { ...ctx, camera: false }), "She's holding up the trench.");
  assert.equal(addressUser("She's holding up the trench.", { ...ctx, first: false }), "She's holding up the trench.");
});

test("session v1 (S4 outfit with camera): the reply addresses her as you", { skip: !v1 }, async () => {
  const { client, session } = setup(["<warm> She's holding up the trench and the black blazer. I'd go black, it's sharper."]);
  await session.onClientText(JSON.stringify({ type: "start", persona: mina, mic: false, tts: "device", user: { name: "Summer" } }));
  await session.onClientText(JSON.stringify({ type: "frames", images: ["aGVsbG8="] }));
  await session.onClientText(JSON.stringify({ type: "text", text: "Which one looks better on me, the white one or the black one?" }));
  const reply = await client.waitFor((m) => m.type === "reply");
  // the third-person frame description is either dropped (bug-fix lane's pre-tool judge) or turned to "you"; never "She's"
  assert.doesNotMatch(String(reply.text), /\bshe'?s\b/i);
  assert.match(String(reply.text), /I'd go black, it's sharper\./);
  session.close();
});

test("third person (Codex r10): only when the user's line is about themselves; a named person or their things stay", async () => {
  const { addressUser } = await import("../src/convo/guard.ts");
  const base = { camera: true, first: true, userName: "Summer" };
  assert.equal(addressUser("She's wearing a red dress.", { ...base, userText: "What do you think of Taylor's outfit?" }), "She's wearing a red dress.");
  assert.equal(addressUser("The user is holding a photo of Alice in her wedding dress.", { ...base, userText: "What do you think, should I post this?" }), "You're holding a photo of Alice in her wedding dress.");
  assert.equal(addressUser("She's holding up two jackets.", { ...base, userText: "Which one should I wear?" }), "You're holding up two jackets.");
});

test("third person (bug-fix lane #354): 'get her a pick' after a dash is never 'get your a pick'", async () => {
  const { addressUser } = await import("../src/convo/guard.ts");
  const out = addressUser("She's holding up the options — I'll get her a pick for tonight.", { camera: true, first: true, userText: "which one should I wear tonight?", userName: "Summer" });
  assert.doesNotMatch(out, /your a pick/);
});

// ───────────── Codex #356 round 11 (folded judge + guard) ─────────────
test("r11: a pick before an announcement stays; a decision is not a plan; a sister is not the user; 'suggests' is a result; 'my screen' is not me", async () => {
  const { NarrationJudge } = await import("../src/text/toolNarration.ts");
  const run = (lines: string[], tool = false, opts = {}) => {
    const j = new NarrationJudge(true, opts);
    const out: string[] = [];
    for (const [i, l] of lines.entries()) { out.push(...j.push(l).speak); if (tool && i === 0) out.push(...j.onToolCall().speak); }
    out.push(...j.finish().speak);
    return out.join(" ");
  };
  assert.match(run(["Go with the black one — I'll check my memory.", "It looks sharper."]), /black one/);
  assert.match(run(["I'll go with the black blazer.", "It suits your style."], true), /black blazer/);
  assert.match(run(["She's holding up her boarding pass.", "Looks exciting."], false, { thirdPersonIsUser: false }), /boarding pass/);
  assert.equal(guardSentence("Checking the map suggests the bus.", none), null);
  const { addressUser } = await import("../src/convo/guard.ts");
  assert.equal(addressUser("She's wearing a red dress.", { camera: true, first: true, userText: "Can you describe my screen?", userName: "Summer" }), "She's wearing a red dress.");
});

test("structural (#354 repro e128827): an 'I'm …ing' opener is held — dropped when a tool follows, spoken when none does; the pick stays", async () => {
  const { NarrationJudge } = await import("../src/text/toolNarration.ts");
  const run = (tool: boolean) => {
    const j = new NarrationJudge(true);
    const out = [...j.push("I'm weighing the trench and denim against what suits you best.").speak];
    if (tool) out.push(...j.onToolCall().speak);
    out.push(...j.push("I'd go with the trench tonight, it looks so cozy over that cream sweater.").speak, ...j.finish().speak);
    return out.join(" ");
  };
  assert.equal(run(true), "I'd go with the trench tonight, it looks so cozy over that cream sweater.");
  assert.match(run(false), /^I'm weighing .* I'd go with the trench/);
  for (const opener of ["I am pulling your style notes together.", "I'm quickly comparing both.", "My plan is to match it to your coat."]) {
    const j = new NarrationJudge(true);
    assert.deepEqual(j.push(opener).speak, [], opener);
    j.onToolCall();
    assert.deepEqual(j.push("Go with the black one.").speak, ["Go with the black one."], opener);
  }
});

test("narration (Codex r13): '… your notes and you should wear the trench' keeps the advice", () => {
  assert.equal(guardSentence("Let me check your notes and you should wear the trench.", none), null);
});

test("Codex r14: 'My guess is the blue line' and 'I'm seeing onions' are answers; '… your notes and the black one fits best' keeps the pick", async () => {
  const { NarrationJudge } = await import("../src/text/toolNarration.ts");
  for (const line of ["My guess is the blue line is fastest.", "I'm seeing onions, tomatoes and garlic.", "I'm loving the trench on you."]) {
    const j = new NarrationJudge(true);
    const out = [...j.push(line).speak, ...j.onToolCall().speak, ...j.push("It takes ten minutes.").speak, ...j.finish().speak];
    assert.ok(out.join(" ").includes(line), line);
  }
  assert.equal(guardSentence("Let me check your notes and the black one fits best.", none), null);
  assert.equal(guardSentence("I'm weighing the trench and denim against what suits you best.", none), null, "the guard leaves it to the structural hold");
});

test("Codex r15 + bug-fix fcece2f: a stated choice is never dropped; a wait that promises a lookup is, tool or no tool", async () => {
  const { NarrationJudge, isToolNarration } = await import("../src/text/toolNarration.ts");
  for (const line of ["I'm going with the trench tonight.", "I'm leaning toward the trench tonight."]) {
    const j = new NarrationJudge(true);
    const out = [...j.push(line).speak, ...j.onToolCall().speak, ...j.push("It matches that understated style you like.").speak, ...j.finish().speak];
    assert.ok(out.join(" ").includes(line), line);
  }
  assert.ok(isToolNarration("I'll pick between the two — give me a sec to remember your vibe."));
  const j = new NarrationJudge(true);
  const out = [...j.push("I'll pick between the two — give me a sec to remember your vibe.").speak, ...j.push("Go with the trench, Chelsea.").speak, ...j.finish().speak];
  assert.equal(out.join(" "), "Go with the trench, Chelsea.");
});

test("bug-fix 5784953 outfit 3/6: a choice promised with nothing chosen is an announcement; the actual pick stays", async () => {
  const { NarrationJudge, isToolNarration } = await import("../src/text/toolNarration.ts");
  for (const line of ["Got it — denim or trench for tonight, I'll pick one for you.", "I'll pick one for you.", "I'll pick a favorite between the trench and denim for tonight.", "Still deciding between the trench and denim — I'll pick the winner for tonight."]) {
    assert.ok(isToolNarration(line), line);
    const j = new NarrationJudge(true);
    const out = [...j.push(line).speak, ...j.push("Go with the trench.").speak, ...j.finish().speak];
    // a lone acknowledgement may stay in front ("Got it. Go with the trench.")
    assert.match(out.join(" "), /^(?:Got it\. )?Go with the trench\.$/, line);
  }
  assert.ok(!isToolNarration("I'll pick the trench for you."));
});

test("Codex r17: a plan with the choice in it stays ('… and it's the trench', 'I'll pick one: the trench')", async () => {
  const { NarrationJudge, isToolNarration } = await import("../src/text/toolNarration.ts");
  assert.ok(!isToolNarration("I'll pick one for you and it's the trench."));
  const j = new NarrationJudge(true);
  const out = [...j.push("I'll pick one: the trench.").speak, ...j.onToolCall().speak, ...j.push("It matches your understated style.").speak, ...j.finish().speak];
  assert.match(out.join(" "), /the trench/);
});

test("Codex r18: '… and it's the trench' is never held, even with a tool after it", async () => {
  const { NarrationJudge } = await import("../src/text/toolNarration.ts");
  const j = new NarrationJudge(true);
  const out = [...j.push("I'll pick one for you and it's the trench.").speak, ...j.onToolCall().speak, ...j.push("It matches your understated style.").speak, ...j.finish().speak];
  assert.match(out.join(" "), /it's the trench/);
});

test("bug-fix 1c63d32 outfit 1/6: 'I'll pick a favorite — pulling up what I remember about your style.' is dropped before the pick", async () => {
  const { NarrationJudge } = await import("../src/text/toolNarration.ts");
  const j = new NarrationJudge(true);
  const out = [...j.push("I'll pick a favorite — pulling up what I remember about your style.").speak, ...j.push("Go with the trench.").speak, ...j.finish().speak];
  assert.equal(out.join(" "), "Go with the trench.");
  assert.equal(guardSentence("Pulling up what I remember about your style.", none), "narration");
});

test("Codex r20: 'Checking your calendar shows dinner is on Thursday.' is the answer", async () => {
  const { NarrationJudge } = await import("../src/text/toolNarration.ts");
  const j = new NarrationJudge(true);
  const out = [...j.push("Checking your calendar shows dinner is on Thursday.").speak, ...j.push("Have a great time.").speak, ...j.finish().speak];
  assert.match(out.join(" "), /Thursday/);
});

test("bug-fix e1e3608: 'Just plotting your fastest route — one sec.' and '— pulling up what I remember to break the tie' are never voiced; 'let me walk you through' is content", async () => {
  const { NarrationJudge } = await import("../src/text/toolNarration.ts");
  const run = (first: string) => { const j = new NarrationJudge(true); return [...j.push(first).speak, ...j.push("Take the 2 line.").speak, ...j.finish().speak].join(" "); };
  assert.equal(run("Just plotting your fastest route to City Hall — one sec."), "Take the 2 line.");
  assert.doesNotMatch(run("You want me to choose tonight — pulling up what I remember to break the tie."), /pulling up/i);
  const j = new NarrationJudge(true);
  assert.deepEqual(j.push("Let me walk you through all of them slowly.").speak, ["Let me walk you through all of them slowly."]);
});

test("Codex r22: a gerund subject with its own verb is an answer", async () => {
  const { NarrationJudge } = await import("../src/text/toolNarration.ts");
  const j = new NarrationJudge(true);
  const out = [...j.push("Scanning your boarding pass opens the gate.").speak, ...j.push("Give it a try.").speak, ...j.finish().speak];
  assert.match(out.join(" "), /opens the gate/);
});

test("bug-fix smoke 11/3: a memory tool's follow-up repeating the pre-tool sentences is said once", { skip: !v1 }, async () => {
  const text = (t: string): SparkStreamEvent => ({ type: "text", delta: t });
  const { client, session } = toolSetup([[
    text("<happy> I knew you'd crush it, Chelsea. We are absolutely celebrating that. "),
    { type: "tool", name: "remember", status: "in_progress" },
    { type: "tool", name: "remember", status: "completed" },
    text("<happy> I knew you'd crush it, Chelsea. We are absolutely celebrating that."),
    { type: "done", responseId: "r", text: "", status: "completed" },
  ]]);
  await session.onClientText(JSON.stringify({ type: "start", persona: mina, mic: false, tts: "device" }));
  await session.onClientText(JSON.stringify({ type: "text", text: "my presentation went great" }));
  const reply = await client.waitFor((m) => m.type === "reply");
  assert.equal(reply.text, "I knew you'd crush it, Chelsea. We are absolutely celebrating that.");
  session.close();
});

test("bug-fix a6df112 outfit 3/8: subject-less gerund openers and 'incoming' promises are never voiced before the pick", async () => {
  const { NarrationJudge, isToolNarration } = await import("../src/text/toolNarration.ts");
  for (const first of ["Checking what I remember about your style and that cozy bedroom backdrop.", "Outfit vote incoming.", "Got it — picking your tonight look from what I can see."]) {
    assert.ok(isToolNarration(first), first);
    const j = new NarrationJudge(true);
    const out = [...j.push(first).speak, ...j.push("Go with the trench.").speak, ...j.finish().speak].join(" ");
    assert.match(out, /^(?:Got it\. )?Go with the trench\.$/, first);
  }
  for (const keep of ["Looking good tonight!", "Loving the trench on you.", "Scanning your boarding pass opens the gate."]) {
    const j = new NarrationJudge(true);
    assert.ok([...j.push(keep).speak, ...j.push("Ok.").speak, ...j.finish().speak].join(" ").includes(keep), keep);
  }
});
