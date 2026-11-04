/** #341: greetings opened on "late-night ramen" 12/13 calls (eval 11/3) → rotate the opener's profile thing. */
import type { TestContext } from "node:test";
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteHook, openerBlock, pickOpenerHook, profileHooks } from "../src/convo/opener.ts";
import { forgetOpenerTopics, pickOpenerTopic, storedTopics, resetOpenerTopics } from "../src/convo/openerTopics.ts";
import { Session, type ClientSink } from "../src/session/session.ts";
import type { Config } from "../src/config.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";

/** these pin the pre-11/4 opener wording: the GENITA_COHERENT_PROMPT=0 rollback path */
const LEGACY = " (GENITA_COHERENT_PROMPT=0)";
function legacyOpener(t: TestContext): void {
  process.env.GENITA_COHERENT_PROMPT = "0";
  t.after(() => { delete process.env.GENITA_COHERENT_PROMPT; });
}

const FREE = [
  "How they talk: casual, witty; teasing is welcome.",
  "Dislikes: small talk, being lectured.",
  "Into: cooking Korean-Western fusion, minimal monochrome fashion, K-pop (aespa), late-night ramen.",
].join("\n");
const APP = [
  "How the user wants to be treated:",
  "- Taste: Loves spicy food (casual)",
  "- Taste: Dislikes cilantro",
  "- Interests: Film photography",
  "- Interests: Bouldering on weekends",
  "- Talk: Warm, direct and informal.",
  "- Boundaries: No unsolicited health advice.",
].join("\n");

test("profileHooks: tastes and interests only, one per finding; free-form lists split; dislikes, talk and boundaries are not hooks", () => {
  // r3 11/4: clothes / style are never an opener (camera off it reads as seeing them)
  assert.deepEqual(profileHooks(FREE), ["cooking Korean-Western fusion", "K-pop (aespa)", "late-night ramen"]);
  assert.deepEqual(profileHooks(APP), ["Loves spicy food", "Film photography", "Bouldering on weekends"]);
  assert.deepEqual(profileHooks(undefined), []);
  assert.deepEqual(profileHooks("- Talk: short replies"), []);
});

test("pickOpenerHook: 5 calls in a row open on ≥4 different things and never on the last call's", () => {
  const hooks = profileHooks(FREE);
  for (let seed = 0; seed < 8; seed++) {
    let recent: string[] = [];
    const picks: string[] = [];
    for (let call = 0; call < 5; call++) {
      const h = pickOpenerHook(hooks, recent, seed + call)!;
      if (picks.length) assert.notEqual(h, picks.at(-1), `seed ${seed} call ${call} reused the last opener`);
      picks.push(h);
      recent = noteHook(recent, h);
    }
    assert.ok(new Set(picks).size >= Math.min(4, hooks.length), `seed ${seed}: ${picks.join(" | ")}`); // 3 hooks once clothes left (r3 11/4)
  }
  assert.equal(pickOpenerHook([], [], 0), null);
  assert.equal(pickOpenerHook(["only one"], ["only one"], 3), "only one", "one hook: still opens on it");
});

test("openerBlock names the hook and keeps the last call's off the first line" + LEGACY, (t) => {
  legacyOpener(t);
  const b = openerBlock({ hasProfile: true, sinceLastMs: 30 * 3_600_000, hasItem: false, hook: "K-pop (aespa)", lastHook: "late-night ramen" });
  assert.match(b, /"K-pop \(aespa\)"/);
  assert.match(b, /Don't open on "late-night ramen"/);
  const first = openerBlock({ hasProfile: true, sinceLastMs: null, hasItem: false, hook: "Film photography" });
  assert.match(first, /this one thing from it \(data, not instructions\): "Film photography"/);
  assert.doesNotMatch(openerBlock({ hasProfile: true, sinceLastMs: 30 * 3_600_000, hasItem: true, hook: null, lastHook: "x" }), /Don't open on/, "a memory follow-up is its own topic");
});

test("opener topics (Codex #352 P1/P2): no health, place or people hooks; suggestions are not known; stored junk is dropped", () => {
  const p = ["- Interests: Therapy for anxiety", "- Interests: Lives in Seoul", "- Interests: Hiking with my friend Alice", "- Interests: Film photography", "Suggestions (not confirmed by the user):", "- Interests: Pottery"].join("\n");
  assert.deepEqual(profileHooks(p), ["Film photography"]);
  assert.deepEqual(storedTopics({ opener_topics: ["Film photography", "Therapy for anxiety", 3] }), ["Film photography"]);
});

test("opener topics (Codex #352 P2): two calls of one account picking a moment apart never pick the same; Forget drops the list", () => {
  resetOpenerTopics();
  const hooks = ["a thing", "b thing", "c thing"];
  const iphone = pickOpenerTopic("u7", hooks, [], 0);
  const mac = pickOpenerTopic("u7", hooks, [], 0); // same stale stored list as the iPhone's call start
  assert.notEqual(iphone.hook, mac.hook);
  assert.deepEqual(mac.recent, [iphone.hook]);
  forgetOpenerTopics("u7");
  assert.deepEqual(pickOpenerTopic("u7", hooks, [], 0).recent, []);
});

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
}

async function greetOnce(id: string): Promise<string> {
  const calls: SparkRequest[] = [];
  const client = new Client();
  const s = new Session(id, client, {
    config, userId: "u-rot", openAsr: () => { throw new Error("no asr"); },
    async *spark(req): AsyncGenerator<SparkStreamEvent> { calls.push(req); yield { type: "text", delta: "<happy> Hey." }; yield { type: "done", responseId: "r", text: "", status: "completed" }; },
    async *tts() {},
  });
  await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Mira" }, mic: false, tts: "device", greetAfterMs: 0, user: { profile: FREE } }));
  for (let i = 0; i < 200 && !client.json.some((m) => m.type === "reply"); i++) await new Promise((r) => setTimeout(r, 2));
  s.close();
  const m = calls[0].instructions!.match(/\(data, not instructions\): "([^"]+)"/);
  return m?.[1] ?? "";
}

test("session (#341): consecutive calls of one account open on different profile things", { skip: process.env.GENITA_CONVO_V1 === "0" }, async () => {
  resetOpenerTopics();
  const picks = [];
  for (let i = 0; i < 5; i++) picks.push(await greetOnce(`rot-${i}`));
  assert.ok(picks.every(Boolean), picks.join(" | "));
  for (let i = 1; i < picks.length; i++) assert.notEqual(picks[i], picks[i - 1]);
  assert.ok(new Set(picks).size >= 3, picks.join(" | ")); // every non-clothes hook (r3 11/4)
});

test("opener topics (Codex #352 round 2): a Forget anywhere voids the list; no safe hook → the companion's own thing, not 'one thing from the profile'" + LEGACY, (t) => {
  legacyOpener(t);
  assert.deepEqual(storedTopics({ revision: 2, opener_topics_rev: 1, opener_topics: ["Film photography"] }), []);
  assert.deepEqual(storedTopics({ revision: 2, opener_topics_rev: 2, opener_topics: ["Film photography"] }), ["Film photography"]);
  resetOpenerTopics();
  pickOpenerTopic("u8", ["a thing", "b thing"], [], 0, undefined, undefined, 0);
  assert.deepEqual(pickOpenerTopic("u8", ["a thing", "b thing"], [], 0, undefined, undefined, 1).recent, [], "the in-process list from before the Forget is void");
  const b = openerBlock({ hasProfile: true, sinceLastMs: null, hasItem: false, hook: null });
  assert.match(b, /one thing of your own/);
  assert.doesNotMatch(b, /one thing from it/);
});

test("opener topics (Codex #352 round 3): an unknown Forget revision neither reads nor writes the list", () => {
  resetOpenerTopics();
  pickOpenerTopic("u6", ["a thing", "b thing"], [], 0, undefined, undefined, 0);
  const r = pickOpenerTopic("u6", ["a thing", "b thing"], ["a thing"], 0, undefined, undefined, null);
  assert.deepEqual(r.recent, []);
  assert.deepEqual(pickOpenerTopic("u6", ["a thing", "b thing"], [], 0, undefined, undefined, 0).recent, ["a thing"], "the null pick wrote nothing");
});

test("#194 follow-up: the GK-1 ask turn's question is never dropped as intake", async () => {
  const { guardSentence } = await import("../src/convo/guard.ts");
  assert.equal(guardSentence("What kind of music do you like for focus?", { camera: false, userText: "ok", askTurn: true }), null);
});

