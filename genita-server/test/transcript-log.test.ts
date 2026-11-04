/**
 * Opt-in transcript log (Chelsea 11/4): `turn.text` {session, utteranceId, user, reply} only for the user ids listed in
 * GENITA_TRANSCRIPT_LOG_USERS; default empty = off; any other user never gets text in the log.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Session, type ClientSink } from "../src/session/session.ts";
import { transcriptLogOn, transcriptLogUsers, clipTranscript, TRANSCRIPT_MAX_CHARS } from "../src/session/transcriptLog.ts";
import type { Config } from "../src/config.ts";
import type { SparkStreamEvent } from "../src/meta/spark.ts";

process.env.GENITA_HOLD_CAP_MS = "0";
const config: Config = {
  metaKey: "x", serverTts: false, host: "127.0.0.1", port: 0, sessionToken: null, defaultVoiceId: "voice", webSearch: false,
  asrLanguages: ["English"], bargeInMinMs: 400, bargeInMinWords: 2, maxSessions: 4, maxSessionMs: 60_000,
  sparkFirstTokenTimeoutMs: 8000, sparkHedge: 1, speculate: false, speculateStableMs: 250,
};
const persona = { name: "Mina", kind: "human", traits: ["warm"] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Client implements ClientSink {
  json: Record<string, unknown>[] = [];
  sendJson(m: Record<string, unknown>) { this.json.push(m); }
  sendBinary() {}
  close() {}
  async waitFor(pred: (m: Record<string, unknown>) => boolean, ms = 4000) {
    const t0 = Date.now();
    for (;;) {
      const hit = this.json.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error(`timeout; got ${this.json.map((x) => x.type).join(",")}`);
      await sleep(2);
    }
  }
}

async function call(userId: string | undefined, users: string | undefined) {
  const saved = process.env.GENITA_TRANSCRIPT_LOG_USERS;
  if (users === undefined) delete process.env.GENITA_TRANSCRIPT_LOG_USERS;
  else process.env.GENITA_TRANSCRIPT_LOG_USERS = users;
  try {
    const client = new Client();
    const logs: { event: string; data: Record<string, unknown> }[] = [];
    const session = new Session("s-tx", client, {
      config, userId, openAsr: () => { throw new Error("no asr"); },
      log: (event, data) => { logs.push({ event, data }); },
      async *spark(): AsyncGenerator<SparkStreamEvent> {
        yield { type: "text", delta: "<warm> Purple tulips sound lovely." };
        yield { type: "done", responseId: "r", text: "", status: "completed" };
      },
      // device voice (serverTts false): the server voice is never asked
      async *tts(): AsyncGenerator<never> { throw new Error("no server voice in device mode"); },
    });
    await session.onClientText(JSON.stringify({ type: "start", persona, mic: false }));
    await session.onClientText(JSON.stringify({ type: "text", text: "my secret garden has purple tulips" }));
    await client.waitFor((m) => m.type === "reply" && m.final === true && /tulips/.test(String(m.text)));
    session.close();
    return logs;
  } finally {
    if (saved === undefined) delete process.env.GENITA_TRANSCRIPT_LOG_USERS;
    else process.env.GENITA_TRANSCRIPT_LOG_USERS = saved;
  }
}

test("listed user: turn.text carries session, utteranceId, the user's line and the reply", async () => {
  const logs = await call("u-chelsea", " u-other , u-chelsea ");
  const tx = logs.filter((l) => l.event === "turn.text" && l.data.user);
  assert.equal(tx.length, 1, JSON.stringify(logs.map((l) => l.event)));
  assert.equal(tx[0].data.session, "s-tx");
  assert.equal(typeof tx[0].data.utteranceId, "number");
  assert.equal(tx[0].data.user, "my secret garden has purple tulips");
  assert.match(String(tx[0].data.reply), /Purple tulips sound lovely\./);
});

test("unlisted user, default (env unset), empty env, and no user id: no turn.text and no text anywhere in the log", async () => {
  for (const [userId, users] of [["u-someone", "u-chelsea"], ["u-chelsea", undefined], ["u-chelsea", ""], [undefined, "u-chelsea"]] as const) {
    const logs = await call(userId, users);
    assert.equal(logs.filter((l) => l.event === "turn.text").length, 0, `${userId}/${users}`);
    assert.ok(!JSON.stringify(logs).includes("secret garden"), `user text leaked for ${userId}/${users}`);
    assert.ok(!JSON.stringify(logs).includes("Purple tulips"), `reply text leaked for ${userId}/${users}`);
  }
});

test("helpers: exact id match, trims, long text clipped", () => {
  assert.deepEqual([...transcriptLogUsers({ GENITA_TRANSCRIPT_LOG_USERS: "a, b,,c " })], ["a", "b", "c"]);
  assert.equal(transcriptLogOn("a", { GENITA_TRANSCRIPT_LOG_USERS: "ab" }), false);
  assert.equal(transcriptLogOn("", { GENITA_TRANSCRIPT_LOG_USERS: "," }), false);
  assert.equal(transcriptLogOn("a", {}), false);
  assert.equal(clipTranscript("x".repeat(TRANSCRIPT_MAX_CHARS + 50))!.length, TRANSCRIPT_MAX_CHARS + 1);
  assert.equal(clipTranscript(""), null);
});
