import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Session, type ClientSink } from "../src/session/session.ts";
import { loadConfig } from "../src/config.ts";
import { encodeFrameHeader, CLIENT_FRAME_KIND_CALL } from "../src/protocol.ts";

// Prod chat listens in English only (GENITA_ASR_LANGUAGES=English, Chelsea's decision); face-to-face interpretation
// must still hear Korean, so the mic ASR reopens with English + Korean in interpret mode and goes back for chat.

const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r)); };

function setup(asrLanguages?: string) {
  const opened: { languages: string[]; stream: FakeAsr }[] = [];
  let gate: Promise<void> | null = null;
  class FakeAsr extends EventEmitter {
    isOpen = false;
    ended = false;
    async connect() { if (gate) await gate; this.isOpen = true; this.emit("status", "connected"); }
    sendAudio() {}
    end() { this.ended = true; this.isOpen = false; }
  }
  const client: ClientSink = { sendJson() {}, sendBinary() {}, close() {} };
  const session = new Session("asr-lang", client, {
    config: loadConfig({ MODEL_API_KEY: "fake", GENITA_SPECULATE: "0", ...(asrLanguages ? { GENITA_ASR_LANGUAGES: asrLanguages } : {}) }),
    openAsr(languages) {
      const stream = new FakeAsr();
      opened.push({ languages, stream });
      return stream;
    },
    async *spark() { yield { type: "done", responseId: "t", text: "", status: "completed" }; },
    async *tts() {},
  });
  const send = (msg: Record<string, unknown>) => session.onClientText(JSON.stringify(msg));
  const hold = () => { let release!: () => void; gate = new Promise<void>((r) => { release = r; }); return () => { gate = null; release(); }; };
  return { session, opened, send, hold };
}

test("English-only chat: interpretation reopens the mic ASR with Korean, chat goes back to English", async () => {
  const h = setup("English");
  try {
    await h.send({ type: "start", persona: { name: "Jin" } });
    await tick();
    assert.deepEqual(h.opened.map((o) => o.languages), [["English"]], "chat uses the configured languages");

    await h.send({ type: "mode", mode: "interpret" });
    await tick();
    assert.equal(h.opened.length, 2);
    assert.ok(h.opened[0].stream.ended, "the English-only stream is closed");
    assert.deepEqual(h.opened[1].languages, ["English", "Korean"]);
    assert.ok(h.opened[1].stream.isOpen);

    await h.send({ type: "mode", mode: "chat" });
    await tick();
    assert.equal(h.opened.length, 3);
    assert.ok(h.opened[1].stream.ended);
    assert.deepEqual(h.opened[2].languages, ["English"], "chat is English-only again");
  } finally {
    h.session.close();
  }
});

test("a call that starts in interpretation listens in English and Korean", async () => {
  const h = setup("English");
  try {
    await h.send({ type: "start", persona: { name: "Jin" }, mode: "interpret" });
    await tick();
    assert.equal(h.opened.length, 1, "opened once in the right languages, no stream to replace (no lost first words)");
    assert.deepEqual(h.opened[0].languages, ["English", "Korean"]);
    assert.ok(h.opened[0].stream.isOpen);
  } finally {
    h.session.close();
  }
});

test("a mode switch while the mic ASR is still connecting retunes once it connects", async () => {
  const h = setup("English");
  try {
    await h.send({ type: "start", persona: { name: "Jin" }, mic: false });
    await tick();
    assert.equal(h.opened.length, 0);
    const release = h.hold(); // the next connect hangs until released
    const audioStart = h.send({ type: "audio_start" });
    await tick(1);
    assert.deepEqual(h.opened[0].languages, ["English"]);
    await h.send({ type: "mode", mode: "interpret" });
    assert.equal(h.opened.length, 1, "no second connection while one is in flight");
    release();
    await audioStart;
    await tick();
    const live = h.opened.filter((o) => !o.stream.ended);
    assert.equal(live.length, 1);
    assert.deepEqual(live[0].languages, ["English", "Korean"]);
  } finally {
    h.session.close();
  }
});

test("call-sound interpretation (Mac) listens in English and Korean too", async () => {
  const h = setup("English");
  try {
    await h.send({ type: "start", persona: { name: "Jin" }, mic: false, mode: "interpret", interpret: { source: "call", other: "Korean" } });
    await tick();
    h.session.onClientAudio(Buffer.concat([encodeFrameHeader(CLIENT_FRAME_KIND_CALL, 0), Buffer.alloc(4800)]));
    await tick();
    assert.ok(h.opened.length >= 1);
    for (const o of h.opened) assert.deepEqual(o.languages, ["English", "Korean"]);
  } finally {
    h.session.close();
  }
});

test("default config (English,Korean): switching modes keeps the same stream", async () => {
  const h = setup();
  try {
    await h.send({ type: "start", persona: { name: "Jin" } });
    await tick();
    await h.send({ type: "mode", mode: "interpret" });
    await tick();
    await h.send({ type: "mode", mode: "chat" });
    await tick();
    assert.equal(h.opened.length, 1);
    assert.deepEqual(h.opened[0].languages, ["English", "Korean"]);
    assert.equal(h.opened[0].stream.ended, false);
  } finally {
    h.session.close();
  }
});
