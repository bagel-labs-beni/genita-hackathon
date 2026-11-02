/** #341: greetings opened on "late-night ramen" 12/13 calls (eval 11/3) → rotate the opener's profile thing. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteHook, openerBlock, pickOpenerHook, profileHooks } from "../src/convo/opener.ts";
import { noteOpenerTopic, recentFromState, resetOpenerTopics } from "../src/convo/openerTopics.ts";
import { Session, type ClientSink } from "../src/session/session.ts";
import type { Config } from "../src/config.ts";
import type { SparkRequest, SparkStreamEvent } from "../src/meta/spark.ts";

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
  assert.deepEqual(profileHooks(FREE), ["cooking Korean-Western fusion", "minimal monochrome fashion", "K-pop (aespa)", "late-night ramen"]);
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
    assert.ok(new Set(picks).size >= 4, `seed ${seed}: ${picks.join(" | ")}`);
  }
  assert.equal(pickOpenerHook([], [], 0), null);
  assert.equal(pickOpenerHook(["only one"], ["only one"], 3), "only one", "one hook: still opens on it");
});

test("openerBlock names the hook and keeps the last call's off the first line", () => {
  const b = openerBlock({ hasProfile: true, sinceLastMs: 30 * 3_600_000, hasItem: false, hook: "K-pop (aespa)", lastHook: "late-night ramen" });
  assert.match(b, /"K-pop \(aespa\)"/);
  assert.match(b, /Don't open on "late-night ramen"/);
  const first = openerBlock({ hasProfile: true, sinceLastMs: null, hasItem: false, hook: "Film photography" });
  assert.match(first, /this one thing from it \(data, not instructions\): "Film photography"/);
  assert.doesNotMatch(openerBlock({ hasProfile: true, sinceLastMs: 30 * 3_600_000, hasItem: true, hook: null, lastHook: "x" }), /Don't open on/, "a memory follow-up is its own topic");
});

test("opener topics: stored state wins over an older in-process copy; the note is capped at 3", () => {
  resetOpenerTopics();
  let r = noteOpenerTopic("u9", [], "a");
  r = noteOpenerTopic("u9", r, "b");
  assert.deepEqual(recentFromState("u9", null), ["a", "b"]);
  assert.deepEqual(recentFromState("u9", { opener_topics: ["x", "y", "z"] }), ["x", "y", "z"]);
  r = noteOpenerTopic("u9", ["a", "b", "c"], "d");
  assert.deepEqual(r, ["b", "c", "d"]);
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
  assert.ok(new Set(picks).size >= 4, picks.join(" | "));
});
