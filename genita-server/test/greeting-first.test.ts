/**
 * Demo P0-3 (S1, 11/4): the first greeting always comes, and nothing goes out ahead of it.
 * A hold beat ("Mm.", "Yeah.") is for a user who is waiting on an answer. On a greeting nobody is waiting, so a
 * beat would be the first thing the user hears instead of the greeting (hold cap #664 must never touch it).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Session, type ClientSink } from "../src/session/session.ts";
import type { Config } from "../src/config.ts";
import type { PersonaCard } from "../src/prompt/persona.ts";
import type { SparkStreamEvent } from "../src/meta/spark.ts";

const v1 = process.env.GENITA_CONVO_V1 !== "0";
const BEAT = /^(?:Mm\.|Ooh\.|Yeah\.|Okay, so\.|Hmm\.|Mm-hm\.)$/;
const mina: PersonaCard = { name: "Mina", kind: "human", traits: ["warm"], speakingStyle: "short, playful" };
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

function withCap(t: { after: (fn: () => void) => void }, ms: string) {
  const prev = process.env.GENITA_HOLD_CAP_MS;
  process.env.GENITA_HOLD_CAP_MS = ms;
  t.after(() => { if (prev === undefined) delete process.env.GENITA_HOLD_CAP_MS; else process.env.GENITA_HOLD_CAP_MS = prev; });
}

test("P0-3: a greeting whose first sentence is slow (held line + 1.9 s tool) gets no hold beat ahead of it", { skip: !v1, timeout: 10_000 }, async (t) => {
  withCap(t, "300");
  const client = new Client();
  const session = new Session("g1", client, {
    config, openAsr: () => { throw new Error("no asr"); },
    async *spark(): AsyncGenerator<SparkStreamEvent> {
      yield { type: "text", delta: "<curious> I'll check what you told me last time. " };
      yield { type: "tool", name: "recall", status: "in_progress" };
      await new Promise((r) => setTimeout(r, 1900));
      yield { type: "tool", name: "recall", status: "completed" };
      yield { type: "text", delta: "<warm> Hey, Summer! Did the tomato soup happen?" };
      yield { type: "done", responseId: "r", text: "", status: "completed" };
    },
    async *tts() {},
  });
  t.after(() => session.close());
  await session.onClientText(JSON.stringify({ type: "start", persona: mina, user: { name: "Summer" }, mic: false, tts: "device", greetAfterMs: 0 }));
  const reply = await client.waitFor((m) => m.type === "reply", 6000);
  assert.match(String(reply.text), /Hey, Summer!/, "the greeting arrives");
  const says = client.json.filter((m) => m.type === "say").map((m) => String(m.text).trim());
  assert.ok(!says.some((s) => BEAT.test(s)), `no hold beat on a greeting (said: ${JSON.stringify(says)})`);
});

test("P0-3: a greeting whose Spark first token is slower than the hold cap gets no beat (first-sound cap skips greetings)", { skip: !v1, timeout: 10_000 }, async (t) => {
  withCap(t, "200");
  const client = new Client();
  const session = new Session("g2", client, {
    config, openAsr: () => { throw new Error("no asr"); },
    async *spark(): AsyncGenerator<SparkStreamEvent> {
      await new Promise((r) => setTimeout(r, 900));
      yield { type: "text", delta: "<warm> Hi, Summer! So did that black top make the cut?" };
      yield { type: "done", responseId: "r", text: "", status: "completed" };
    },
    async *tts() {},
  });
  t.after(() => session.close());
  await session.onClientText(JSON.stringify({ type: "start", persona: mina, user: { name: "Summer" }, mic: false, tts: "device", greetAfterMs: 0 }));
  const reply = await client.waitFor((m) => m.type === "reply", 6000);
  assert.match(String(reply.text), /Hi, Summer!/);
  const says = client.json.filter((m) => m.type === "say").map((m) => String(m.text).trim());
  assert.ok(!says.some((s) => BEAT.test(s)), `no hold beat on a greeting (said: ${JSON.stringify(says)})`);
});
