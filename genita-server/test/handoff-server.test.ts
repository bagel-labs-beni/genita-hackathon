/**
 * F6-L7 end to end on the real server: /v1/presence (ownership, peer, move) + /v1/session
 * gating (audio only to the owner, the old device's reply cancelled with reason "handoff")
 * + the HTTP claim/release routes. Vendors are faked; the sockets and the server are real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { startServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import type { SessionDeps } from "../src/session/session.ts";
import type { SparkStreamEvent } from "../src/meta/spark.ts";
import type { TtsChunk } from "../src/tts/types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEV = "dev-token-handoff";
const MIN_SEEN_GAP = 210; // proximity.ts MIN_SEEN_INTERVAL_MS + margin

class FakeAsr extends EventEmitter {
  isOpen = false;
  audio = 0;
  async connect() {
    this.isOpen = true;
  }
  sendAudio(pcm: Buffer) {
    this.audio += pcm.length;
  }
  end() {
    this.isOpen = false;
  }
}

async function boot(t: import("node:test").TestContext) {
  const config = { ...loadConfig({ MODEL_API_KEY: "m", GENITA_VOICE_URL: "http://voice.invalid", GENITA_VOICE_TOKEN: "t" }) /* #157: the gate is about audio frames */, port: 0, sessionToken: DEV };
  const asrs: FakeAsr[] = [];
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const log = (event: string, data: Record<string, unknown>) => events.push({ event, data });
  const deps: SessionDeps = {
    config,
    openAsr: () => {
      const a = new FakeAsr();
      asrs.push(a);
      return a;
    },
    async *spark(_req, { signal }): AsyncGenerator<SparkStreamEvent> {
      const text = "One. Two. Three. Four.";
      for (const piece of text.match(/.{1,4}/gs) ?? []) {
        if (signal?.aborted) return;
        await sleep(1);
        yield { type: "text", delta: piece };
      }
      yield { type: "done", responseId: "r", text, status: "completed" };
    },
    async *tts(req): AsyncGenerator<TtsChunk> {
      for (let i = 0; i < 6; i++) {
        await sleep(25);
        if (req.signal?.aborted) return;
        yield { audio: Buffer.alloc(960), alignment: { chars: ["a"], startsSec: [0], endsSec: [0.02] }, model: req.model };
      }
    },
    log,
  };
  const server = await startServer(config, log, deps, {}, null);
  const base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => new Promise((r) => server.close(r)));
  return { base, asrs, events };
}

type Client = { ws: WebSocket; json: Record<string, any>[]; bin: { at: number; buf: Buffer }[]; send: (m: object) => void; waitFor: (pred: (m: Record<string, any>) => boolean, ms?: number) => Promise<Record<string, any>> };
function open(base: string, path: string, user = "chel"): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}${path}`, { headers: { authorization: `Bearer ${DEV}`, "x-genita-user": user } });
    const c: Client = {
      ws,
      json: [],
      bin: [],
      send: (m) => ws.send(JSON.stringify(m)),
      waitFor: (pred, ms = 3000) =>
        new Promise((res, rej) => {
          const t0 = Date.now();
          const tick = () => {
            const hit = c.json.find(pred);
            if (hit) return res(hit);
            if (Date.now() - t0 > ms) return rej(new Error(`timeout on ${path}; got ${c.json.map((m) => m.type).join(",")}`));
            setTimeout(tick, 3);
          };
          tick();
        }),
    };
    ws.on("message", (data, isBinary) => {
      const buf = Buffer.from(data as Buffer);
      if (isBinary) c.bin.push({ at: c.json.length, buf });
      else c.json.push(JSON.parse(buf.toString("utf8")));
    });
    ws.on("open", () => resolve(c));
    ws.on("error", reject);
  });
}

test("button move without local pairing: presence relays move.request, the Mac claims, the iPhone call goes quiet", async (t) => {
  const { base, events } = await boot(t);
  const phonePresence = await open(base, "/v1/presence?device=iphone");
  const phoneCall = await open(base, "/v1/session?device=iphone");
  phoneCall.send({ type: "start", persona: { name: "Jin" } });
  await phoneCall.waitFor((m) => m.type === "ready");
  await phoneCall.waitFor((m) => m.type === "ownership" && m.owner === "iphone");

  // no Mac yet → the button fails at once (MV-E)
  phonePresence.send({ type: "move.request", to: "mac" });
  assert.equal((await phonePresence.waitFor((m) => m.type === "move.failed")).reason, "peer_offline");

  const macPresence = await open(base, "/v1/presence?device=mac");
  macPresence.send({ type: "hello", owner: "phone", epoch: 0 }); // the Mac app opens: not a claim
  await macPresence.waitFor((m) => m.type === "ownership" && m.owner === "iphone");
  await phonePresence.waitFor((m) => m.type === "peer" && m.device === "mac" && m.online);

  // the iPhone is mid-reply when the move happens
  phoneCall.send({ type: "text", text: "tell me something" });
  await phoneCall.waitFor((m) => m.type === "audio");
  phonePresence.send({ type: "move.request", to: "mac" });
  const relayed = await macPresence.waitFor((m) => m.type === "move.request");
  assert.equal(relayed.from, "iphone");
  macPresence.send({ type: "claim", trigger: "button" });
  const result = await macPresence.waitFor((m) => m.type === "claim.result");
  assert.deepEqual([result.accepted, result.owner, result.epoch], [true, "mac", 2]);
  const cancelled = await phoneCall.waitFor((m) => m.type === "utterance.cancelled");
  assert.equal(cancelled.reason, "client", "the existing reason, so every app build flushes its queue");
  const moved = phoneCall.json.findIndex((m) => m.type === "ownership" && m.owner === "mac");
  assert.ok(moved >= 0, "the call socket hears the move");
  assert.ok(phoneCall.json.findIndex((m) => m.type === "utterance.cancelled") < moved, "the old device is stopped before the move is announced");
  await sleep(250);
  assert.equal(phoneCall.bin.filter((b) => b.at > moved).length, 0, "no iPhone audio after the move");
  assert.equal(phoneCall.json.slice(moved).filter((m) => m.type === "audio").length, 0);
  assert.equal((await phonePresence.waitFor((m) => m.type === "ownership" && m.owner === "mac")).trigger, "button");

  // the Mac's own call now gets the sound
  const macCall = await open(base, "/v1/session?device=mac");
  macCall.send({ type: "start", persona: { name: "Jin" } });
  await macCall.waitFor((m) => m.type === "ownership" && m.owner === "mac");
  macCall.send({ type: "text", text: "hi" });
  await macCall.waitFor((m) => m.type === "reply");
  assert.ok(macCall.bin.length > 0, "the owner plays");
  // the iPhone (not owner) types too: the reply text comes, the sound does not
  const before = phoneCall.bin.length;
  phoneCall.send({ type: "text", text: "still there?" });
  await phoneCall.waitFor((m) => m.type === "reply" && m.text);
  assert.equal(phoneCall.bin.length, before, "a non-owner never gets audio frames");
  assert.ok(events.some((e) => e.event === "handoff.committed" && e.data.to === "mac" && e.data.trigger === "button"));
  for (const c of [phonePresence, phoneCall, macPresence, macCall]) c.ws.close();
});

test("lock keeps the owner, the other device sees peer inactive; HTTP claim and tie rule", async (t) => {
  const { base } = await boot(t);
  const phone = await open(base, "/v1/presence?device=iphone", "u2");
  const mac = await open(base, "/v1/presence?device=mac", "u2");
  phone.send({ type: "claim", trigger: "start" });
  await mac.waitFor((m) => m.type === "ownership" && m.owner === "iphone");
  phone.send({ type: "presence", active: false }); // locked
  await mac.waitFor((m) => m.type === "peer" && m.device === "iphone" && m.active === false);
  mac.send({ type: "move.request", to: "iphone" });
  assert.equal((await mac.waitFor((m) => m.type === "move.failed")).reason, "peer_inactive");
  phone.ws.close();
  await mac.waitFor((m) => m.type === "peer" && m.device === "iphone" && m.online === false);

  const http = (method: string, path: string, body?: object) =>
    fetch(`http://${base}${path}`, { method, headers: { authorization: `Bearer ${DEV}`, "x-genita-user": "u2", "content-type": "application/json" }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, any> }));
  const now = await http("GET", "/v1/handoff");
  assert.deepEqual([now.status, now.json.owner, now.json.epoch], [200, "iphone", 1], "a dropped iPhone socket keeps the owner");
  const tie = await http("POST", "/v1/handoff/claim", { device: "mac", epoch: 1 });
  assert.deepEqual([tie.json.accepted, tie.json.owner, tie.json.epoch], [true, "mac", 1], "same epoch, different owner → Mac");
  const stale = await http("POST", "/v1/handoff/claim", { device: "iphone", epoch: 1 });
  assert.deepEqual([stale.json.accepted, stale.json.owner], [false, "mac"]);
  assert.equal((await http("POST", "/v1/handoff/claim", { device: "tablet" })).status, 400);
  assert.equal((await http("POST", "/v1/handoff/claim", { device: "mac", epoch: 2 ** 40 })).status, 400);
  const rel = await http("POST", "/v1/handoff/release", { device: "mac" });
  assert.deepEqual([rel.json.accepted, rel.json.owner, rel.json.epoch], [true, null, 2]);
  await mac.waitFor((m) => m.type === "ownership" && m.owner === null);
  const noAuth = await fetch(`http://${base}/v1/handoff`);
  assert.equal(noAuth.status, 401);
  mac.ws.close();
});

test("QA 171: the Mac's presence hears peer.inCall true only between the iPhone call's start and its close", async (t) => {
  const { base } = await boot(t);
  const phonePresence = await open(base, "/v1/presence?device=iphone", "incall");
  const macPresence = await open(base, "/v1/presence?device=mac", "incall");
  assert.equal((await macPresence.waitFor((m) => m.type === "peer" && m.device === "iphone")).inCall, false, "app open, no call");
  const phoneCall = await open(base, "/v1/session?device=iphone", "incall");
  await sleep(50);
  assert.ok(!macPresence.json.some((m) => m.type === "peer" && m.inCall === true), "an open socket without start is not a call");
  phoneCall.send({ type: "start", persona: { name: "Jin" } });
  await phoneCall.waitFor((m) => m.type === "ready");
  await macPresence.waitFor((m) => m.type === "peer" && m.device === "iphone" && m.inCall === true);
  const seen = macPresence.json.length;
  phoneCall.ws.close();
  await macPresence.waitFor((m) => macPresence.json.indexOf(m) >= seen && m.type === "peer" && m.inCall === false);
  for (const c of [phonePresence, macPresence]) c.ws.close();
});

test("review P1: a presence message that is valid JSON but not an object is an error, not a crash", async (t) => {
  const { base } = await boot(t);
  const p = await open(base, "/v1/presence?device=mac", "z");
  for (const bad of ["null", "[]", "3", '"x"']) p.ws.send(bad);
  await p.waitFor((m) => m.type === "error");
  await sleep(50);
  assert.equal(p.json.filter((m) => m.type === "error").length, 4);
  const health = await fetch(`http://${base}/healthz`);
  assert.equal(health.status, 200, "the server is still up");
  p.ws.close();
});

test("review P2: a call without ?device= is never gated, even when the token names a device", async (t) => {
  const { base } = await boot(t);
  const owner = await open(base, "/v1/presence?device=iphone", "old");
  owner.send({ type: "claim" });
  await owner.waitFor((m) => m.type === "claim.result");
  const legacy = await open(base, "/v1/session", "old");
  legacy.send({ type: "start", persona: { name: "Jin" } });
  await legacy.waitFor((m) => m.type === "ready");
  legacy.send({ type: "text", text: "hi" });
  await legacy.waitFor((m) => m.type === "reply");
  assert.ok(legacy.bin.length > 0, "an old build keeps its sound");
  assert.equal(legacy.json.filter((m) => m.type === "ownership").length, 0);
  owner.ws.close();
  legacy.ws.close();
});

test("presence without a device closes with 4400; other users never see each other", async (t) => {
  const { base } = await boot(t);
  const bad = await open(base, "/v1/presence");
  const code = await new Promise<number>((r) => bad.ws.on("close", (c) => r(c)));
  assert.equal(code, 4400);
  const a = await open(base, "/v1/presence?device=mac", "alice");
  const b = await open(base, "/v1/presence?device=iphone", "bob");
  b.send({ type: "claim" });
  await b.waitFor((m) => m.type === "claim.result");
  await sleep(50);
  assert.equal(a.json.filter((m) => m.type === "peer").length, 0);
  assert.equal(a.json.filter((m) => m.type === "ownership" && m.owner === "iphone").length, 0);
  a.ws.close();
  b.ws.close();
});

test("proximity on the real server: an ungated iPhone call (today's apps) + presence arm → the Mac's proximity.seen moves it", async (t) => {
  const { base, events } = await boot(t);
  const phonePresence = await open(base, "/v1/presence?device=iphone", "prox");
  const macPresence = await open(base, "/v1/presence?device=mac", "prox");
  const stranger = await open(base, "/v1/presence?device=iphone", "someone-else");

  // a call socket that never sent `start` is not a call → no token
  const phoneCall = await open(base, "/v1/session", "prox");
  phonePresence.send({ type: "proximity.arm" });
  assert.equal((await phonePresence.waitFor((m) => m.type === "proximity.unavailable")).reason, "not_in_call");
  assert.equal((await macPresence.waitFor((m) => m.type === "proximity.peer")).armed, false, "the Mac learns the iPhone isn't advertising");

  phoneCall.send({ type: "start", persona: { name: "Jin" } });
  await phoneCall.waitFor((m) => m.type === "ready");
  phonePresence.send({ type: "proximity.arm" });
  const { token } = await phonePresence.waitFor((m) => m.type === "proximity.token");
  await macPresence.waitFor((m) => m.type === "proximity.peer" && m.armed === true);

  // another account's iPhone in a call, next to this Mac
  const strangerCall = await open(base, "/v1/session", "someone-else");
  strangerCall.send({ type: "start", persona: { name: "Jin" } });
  await strangerCall.waitFor((m) => m.type === "ready");
  stranger.send({ type: "proximity.arm" });
  const theirs = (await stranger.waitFor((m) => m.type === "proximity.token")).token;
  macPresence.send({ type: "proximity.seen", token: theirs });
  assert.equal((await macPresence.waitFor((m) => m.type === "proximity.result")).reason, "unknown_token");

  await sleep(MIN_SEEN_GAP);
  macPresence.send({ type: "proximity.seen", token });
  const ok = await macPresence.waitFor((m) => m.type === "proximity.result" && m.accepted);
  assert.equal(ok.reason, "ok");
  const moved = await phonePresence.waitFor((m) => m.type === "ownership" && m.owner === "mac");
  assert.equal(moved.trigger, "proximity");
  assert.equal((await macPresence.waitFor((m) => m.type === "claim.result")).accepted, true);
  assert.ok(events.some((e) => e.event === "handoff.committed" && e.data.trigger === "proximity"));
  assert.ok(!JSON.stringify(events).includes(token), "the token is never logged");
  for (const c of [phonePresence, macPresence, stranger, phoneCall, strangerCall]) c.ws.close();
});

test("MV-01 GATE-A: the apps' call URL (device + last known owner) opts into the gate; a claim made while presence was down wins at start", async (t) => {
  const { base } = await boot(t);
  // the Mac holds the conversation (epoch 1), as the apps' URL says
  const macCall = await open(base, "/v1/session?device=mac&owner=mac&epoch=1", "gate");
  macCall.send({ type: "start", persona: { name: "Jin" } });
  await macCall.waitFor((m) => m.type === "ownership" && m.owner === "mac");
  macCall.send({ type: "text", text: "hi" });
  await macCall.waitFor((m) => m.type === "reply");
  assert.ok(macCall.bin.length > 0, "the owner plays");

  // the iPhone tapped Continue here with presence down (its own epoch 2): its call carries that claim
  const phoneCall = await open(base, "/v1/session?device=iphone&owner=phone&epoch=2", "gate");
  phoneCall.send({ type: "start", persona: { name: "Jin" } });
  await phoneCall.waitFor((m) => m.type === "ownership" && m.owner === "iphone");
  const moved = macCall.json.findIndex((m) => m.type === "ownership" && m.owner === "iphone");
  assert.ok(moved >= 0, "the Mac's call hears the newer claim");
  phoneCall.send({ type: "text", text: "back on the phone" });
  await phoneCall.waitFor((m) => m.type === "reply" && m.text);
  assert.ok(phoneCall.bin.length > 0, "the iPhone plays: not stranded behind a stale server owner");

  // a stale claim (epoch 1) from a late Mac call changes nothing: that call stays silent
  const lateMac = await open(base, "/v1/session?device=mac&owner=mac&epoch=1", "gate");
  lateMac.send({ type: "start", persona: { name: "Jin" } });
  await lateMac.waitFor((m) => m.type === "ownership" && m.owner === "iphone");
  lateMac.send({ type: "text", text: "anyone?" });
  await lateMac.waitFor((m) => m.type === "reply" && m.text);
  assert.equal(lateMac.bin.length, 0, "a non-owner never gets audio frames (GATE-A)");
  for (const c of [macCall, phoneCall, lateMac]) c.ws.close();
});

/** 11/4 TestFlight 331: a stale stored owner "mac" (no Mac connected) and the iPhone app's own call URL saying owner=mac */
async function staleMacThenPhoneCall(base: string, user: string) {
  const mac = await open(base, "/v1/presence?device=mac", user);
  mac.send({ type: "claim", trigger: "proximity" });
  assert.equal((await mac.waitFor((m) => m.type === "claim.result")).owner, "mac");
  mac.ws.close();
  const phone = await open(base, "/v1/session?device=iphone&owner=mac&epoch=1", user);
  phone.send({ type: "start", persona: { name: "Jin" } });
  await phone.waitFor((m) => m.type === "ready");
  for (let i = 0; i < 20; i++) {
    phone.ws.send(Buffer.alloc(640), { binary: true }); // 20 ms of 16 kHz mic
    await sleep(10);
  }
  return phone;
}

test("GATE-A default: stale owner=mac + iPhone call ?device=iphone&owner=mac → the iPhone's mic never reaches the ASR and no audio goes out", async (t) => {
  const { base, asrs } = await boot(t);
  const phone = await staleMacThenPhoneCall(base, "stale-on");
  try {
  assert.equal(asrs.reduce((n, a) => n + a.audio, 0), 0, "mic dropped (server.ts gated.call.mayPlay() is false)");
  phone.send({ type: "text", text: "hello?" });
  await phone.waitFor((m) => m.type === "reply" && m.text);
  assert.equal(phone.bin.length, 0, "no sound either");
  } finally { phone.ws.close(); }
});

test("GENITA_AUDIO_GATE=0: the same stale owner=mac iPhone call is ungated — mic reaches the ASR, audio goes out; presence still hears ownership", async (t) => {
  const prev = process.env.GENITA_AUDIO_GATE;
  process.env.GENITA_AUDIO_GATE = "0";
  t.after(() => (prev === undefined ? delete process.env.GENITA_AUDIO_GATE : (process.env.GENITA_AUDIO_GATE = prev)));
  const { base, asrs, events } = await boot(t);
  const watcher = await open(base, "/v1/presence?device=iphone", "stale-off");
  await watcher.waitFor((m) => m.type === "ownership");
  const phone = await staleMacThenPhoneCall(base, "stale-off");
  try {
  assert.ok(asrs.reduce((n, a) => n + a.audio, 0) > 0, "mic reaches the session");
  phone.send({ type: "text", text: "hello?" });
  await phone.waitFor((m) => m.type === "reply");
  assert.ok(phone.bin.length > 0, "sound goes out like an older build's call");
  assert.equal(phone.json.filter((m) => m.type === "ownership").length, 0, "an ungated call isn't part of ownership, as with older builds");
  assert.ok(events.some((e) => e.event === "session.open" && e.data.gated === false), "the log says the call ran ungated");
  // presence and handoff still work: a claim from the iPhone's presence moves the owner and is announced
  watcher.send({ type: "claim", trigger: "button" });
  const r = await watcher.waitFor((m) => m.type === "claim.result");
  assert.deepEqual([r.accepted, r.owner], [true, "iphone"]);
  await watcher.waitFor((m) => m.type === "ownership" && m.owner === "iphone" && m.trigger === "button");
  } finally { phone.ws.close(); watcher.ws.close(); }
});
