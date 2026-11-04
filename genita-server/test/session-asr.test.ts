import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { Session, type ClientSink } from "../src/session/session.ts";
import { loadConfig } from "../src/config.ts";
import { checkServerEvent, encodeFrameHeader, CLIENT_FRAME_KIND_CALL } from "../src/protocol.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(id: string) {
  let now = 10_000;
  let failing = false;
  let factoryFailure = false;
  let attempts = 0;
  let pending: Promise<void> | null = null;
  const streams: FakeAsr[] = [];
  const events: Record<string, unknown>[] = [];
  let closed = false;
  class FakeAsr extends EventEmitter {
    isOpen = false;
    ended = false;
    audio = 0;
    async connect() {
      if (pending) await pending;
      if (failing) throw new Error("ECONNRESET_ASR_RECONNECT");
      this.isOpen = true;
      this.emit("status", "connected");
    }
    sendAudio(pcm: Buffer) { this.audio += pcm.length; }
    end() { this.ended = true; this.isOpen = false; }
    disconnect() { this.isOpen = false; this.emit("status", "closed"); }
    turn(text: string) {
      this.emit("event", { type: "speechStart", turnId: 1 });
      this.emit("event", { type: "speechEnd", turnId: 1 });
      this.emit("event", { type: "speechComplete", turnId: 1, text });
    }
  }
  const client: ClientSink = {
    sendJson(event) {
      assert.deepEqual(checkServerEvent(event), []);
      events.push(event);
    },
    sendBinary() {},
    close() { closed = true; },
  };
  const session = new Session(id, client, {
    config: loadConfig({ MODEL_API_KEY: "fake", GENITA_SPECULATE: "0" }),
    now: () => now,
    openAsr() {
      attempts++;
      if (factoryFailure) throw new Error("ASR_FACTORY_FAILED");
      const stream = new FakeAsr();
      streams.push(stream);
      return stream;
    },
    async *spark() {
      const text = "Still here.";
      yield { type: "text", delta: text };
      yield { type: "done", responseId: "test", text, status: "completed" };
    },
    async *tts() {},
  });
  return {
    session, streams, events,
    attempts: () => attempts,
    closed: () => closed,
    fail(factory = false) { failing = true; factoryFailure = factory; },
    recover() { failing = false; factoryFailure = false; },
    advance(ms: number) { now += ms; },
    block() {
      let release!: () => void;
      pending = new Promise<void>((resolve) => { release = resolve; });
      return () => { pending = null; release(); };
    },
  };
}

type Harness = ReturnType<typeof setup>;
const send = (h: Harness, msg: Record<string, unknown>) => h.session.onClientText(JSON.stringify(msg));
const errors = (h: Harness) => h.events.filter((e) => e.type === "error" && e.code === "asr_unavailable");
async function answered(h: Harness, text: string) {
  const before = h.events.filter((e) => e.type === "reply").length;
  await send(h, { type: "text", text });
  for (let i = 0; i < 20; i++) {
    await tick();
    const replies = h.events.filter((e) => e.type === "reply");
    if (replies.length > before) {
      assert.equal(replies.at(-1)!.text, "Still here.");
      await send(h, { type: "playback_done", utteranceId: replies.at(-1)!.utteranceId });
      return;
    }
  }
  assert.fail("text input must still be answered during the ASR outage");
}

async function scenario(source: "mic" | "call", kind: string) {
  // Deliberately isolated from node:test: an unhandled rejection must fail this child.
  process.once("unhandledRejection", (reason) => {
    console.error("unhandledRejection", reason);
    process.exit(1);
  });
  const h = setup("affected");
  const other = setup("unaffected");
  const frame = source === "mic" ? Buffer.alloc(4800) : Buffer.concat([encodeFrameHeader(CLIENT_FRAME_KIND_CALL, 0), Buffer.alloc(4800)]);
  const frames = (count = 1) => { for (let i = 0; i < count; i++) h.session.onClientAudio(frame); };
  try {
    await send(other, { type: "start", persona: { name: "Other" } });
    if (kind === "initial") h.fail();
    await send(h, { type: "start", persona: { name: "Jin" }, ...(source === "call" ? { mic: false, mode: "interpret", interpret: { source: "call", other: "Korean" } } : {}) });
    await tick();
    if (kind !== "initial") {
      h.streams[0].disconnect();
      h.fail(kind === "factory");
      if (kind === "pending-close" || kind === "pending-leave") {
        const release = h.block();
        frames(50);
        assert.equal(h.attempts(), 2, "only one in-flight connection");
        assert.equal(h.streams[1].audio, 0, "frames during connect are dropped");
        if (kind === "pending-close") h.session.close();
        else await send(h, { type: "mode", mode: "chat" });
        release();
        await tick();
        assert.equal(errors(h).length, 0, "retired attempts do not report errors");
        assert.ok(h.streams[1].ended, "retired connection is disposed");
        return;
      }
      frames(50);
      await tick();
    }
    const firstAttempts = kind === "initial" ? 1 : 2;
    assert.equal(h.attempts(), firstAttempts);
    assert.equal(errors(h).length, 1);
    assert.equal(errors(h)[0].retryable, true);
    if (kind !== "factory") assert.ok(h.streams.at(-1)!.ended, "failed connection is disposed even without a closed event");
    assert.equal(h.streams.at(-1)!.audio, 0, "failed/connecting frames are dropped");
    for (let i = 0; i < 19; i++) { h.advance(100); frames(50); await tick(); }
    if (source === "mic") await send(h, { type: "audio_start" });
    assert.equal(h.attempts(), firstAttempts, "no reconnect before two seconds");
    await answered(h, "Can you still hear text?");
    await answered(other, "An unrelated call still works");
    other.streams[0].turn("Hello from another call");
    await tick();
    assert.ok(other.streams[0].isOpen);
    assert.equal(other.closed(), false);
    h.advance(100);
    frames(50);
    await tick();
    assert.equal(h.attempts(), firstAttempts + 1, "one retry at two seconds");
    assert.equal(errors(h).length, 1, "same failure burst only reports once");
    h.recover();
    h.advance(1999);
    frames();
    assert.equal(h.attempts(), firstAttempts + 1);
    h.advance(1);
    frames();
    await tick();
    frames();
    const recovered = h.streams.at(-1)!;
    assert.ok(recovered.isOpen);
    assert.equal(recovered.audio, 4800, "next frame after recovery reaches the replacement ASR");
    const before = h.events.filter((e) => e.type === "reply").length;
    recovered.turn(source === "mic" ? "Voice is back." : "이거 얼마예요?");
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(h.events.filter((e) => e.type === "reply").length, before + 1, "voice turns resume");
    recovered.disconnect();
    h.fail();
    frames();
    await tick();
    assert.equal(errors(h).length, 2, "a later failure burst reports again after recovery");
    assert.equal(h.closed(), false);
    console.log(`${source}/${kind}: process alive; text and voice recovered; reconnect <= 1/2s; errors deduplicated`);
  } finally {
    h.session.close();
    other.session.close();
  }
}

const child = process.argv.indexOf("--asr-scenario");
if (child >= 0) {
  await scenario(process.argv[child + 1] as "mic" | "call", process.argv[child + 2]);
} else {
  for (const source of ["mic", "call"] as const) {
    for (const kind of ["reconnect", "factory", "initial", "pending-close", ...(source === "call" ? ["pending-leave"] : [])]) {
      test(`${source} ASR ${kind}: connection failure stays inside the call`, () => {
        const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", import.meta.filename, "--asr-scenario", source, kind], { encoding: "utf8", timeout: 10_000 });
        assert.equal(result.status, 0, result.stdout + result.stderr + (result.error ?? ""));
      });
    }
  }
}
