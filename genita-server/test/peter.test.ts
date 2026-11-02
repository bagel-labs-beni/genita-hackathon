import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { PeterClient, TMC1_HEADER_BYTES, packTmc1, unpackTmc1 } from "../src/lips/peter.ts";

/** Minimal stand-in for musetalk_worker.py: HELLO/READY, TMC1 audio in, one crop per 640 samples out. */
function fakeWorker(token: string) {
  const wss = new WebSocketServer({ port: 0, perMessageDeflate: false });
  const log: { control: Record<string, unknown>[]; chunks: { pts: number; n: number }[]; samples: number; deflate: boolean[] } = { control: [], chunks: [], samples: 0, deflate: [] };
  const EPOCH = 7;
  wss.on("connection", (ws, req) => {
    log.deflate.push(!!req.headers["sec-websocket-extensions"]);
    let authed = false;
    let request = 0n;
    let emitted = 0;
    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        const m = JSON.parse(data.toString());
        log.control.push(m);
        if (!authed) {
          if (m.type !== "HELLO" || m.token !== token) return ws.close(4401);
          authed = true;
          return ws.send(JSON.stringify({ type: "READY", epoch: EPOCH, bundle_id: "079316aa99195c4d", fps: 25, sr: 16000, n_base: 250, paste_dy: -3 }));
        }
        if (m.type === "UTTER_BEGIN") (request = BigInt(m.request_id)), (emitted = 0), (log.samples = 0);
        if (m.type === "HEARTBEAT") ws.send(JSON.stringify({ type: "HEARTBEAT_ACK" }));
        return;
      }
      const h = unpackTmc1(data as Buffer);
      if (h.epoch !== EPOCH || h.requestId !== request) return;
      const n = ((data as Buffer).length - TMC1_HEADER_BYTES) / 2;
      log.chunks.push({ pts: Number(h.pts), n });
      log.samples += n;
      while ((emitted + 1) * 640 <= log.samples) {
        ws.send(Buffer.concat([packTmc1(2, EPOCH, request, BigInt(emitted), BigInt(emitted * 640)), Buffer.from([0xff, 0xd8, emitted])]));
        emitted++;
      }
    });
  });
  const port = () => (wss.address() as { port: number }).port;
  /** terminate open sockets too: wss.close() alone leaves them (and the test process) running */
  const stop = () => {
    for (const c of wss.clients) c.terminate();
    wss.close();
  };
  return { wss, log, stop, url: () => `ws://127.0.0.1:${port()}` };
}

test("TMC1 header packs and unpacks like struct '<IBIQQQ' (33 bytes)", () => {
  const b = packTmc1(1, 0xdeadbeef, 123456789012n, 5n, 3200n);
  assert.equal(b.length, 33);
  assert.equal(b.readUInt32LE(0), 0x544d4331);
  assert.deepEqual(unpackTmc1(b), { kind: 1, epoch: 0xdeadbeef, requestId: 123456789012n, frame: 5n, pts: 3200n });
});

test("bridge: HELLO → READY, 24 kHz TTS audio arrives at the worker as continuous 16 kHz TMC1, crops come back per request", async (t: TestContext) => {
  const w = fakeWorker("secret");
  await new Promise((r) => w.wss.once("listening", r));
  const peter = new PeterClient({ url: w.url(), token: "secret", heartbeatMs: 50 });
  // cleanup even when an assertion throws; otherwise the heartbeat timer keeps the run alive until CI's timeout
  t.after(() => {
    peter.close();
    w.stop();
  });
  const ready = await peter.connect();
  assert.deepEqual(ready, { epoch: 7, bundleId: "079316aa99195c4d", fps: 25, sampleRate: 16000, pasteDy: -3 });
  const crops: { requestId: number; frame: number; jpeg: Buffer }[] = [];
  peter.on("crop", (c) => crops.push(c));
  peter.begin(9);
  // 0.2 s of 24 kHz audio in uneven chunks = 3200 samples at 16 kHz = 5 frames
  const pcm = Buffer.alloc(4800 * 2, 1);
  for (const [a, b] of [[0, 1001], [1001, 6000], [6000, 9600]]) peter.audio24k(9, pcm.subarray(a, b));
  peter.end(9);
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(crops.map((c) => c.frame), [0, 1, 2, 3, 4]);
  assert.ok(crops.every((c) => c.requestId === 9 && c.jpeg[0] === 0xff));
  // pts is the running 16 kHz sample offset: no gaps
  let expect = 0;
  for (const [i, c] of w.log.chunks.entries()) {
    assert.equal(c.pts, expect, `chunk ${i}`);
    expect += c.n;
  }
  assert.ok(Math.abs(expect - 3200) <= 60, `~3200 samples at 16 kHz, got ${expect}`);
  assert.deepEqual(w.log.control.map((m) => m.type).filter((t) => t !== "HEARTBEAT"), ["HELLO", "UTTER_BEGIN", "UTTER_END"]);
  assert.ok(w.log.control.some((m) => m.type === "HEARTBEAT"), "keeps the worker alive while idle");
  assert.deepEqual(w.log.deflate, [false], "permessage-deflate off (Modal proxy closes 1002 otherwise)");
  peter.cancel(9);
  await new Promise((r) => setTimeout(r, 20));
  // the 50 ms heartbeat can land after CANCEL on a slow runner: check the last non-heartbeat message
  assert.equal(w.log.control.filter((m) => m.type !== "HEARTBEAT").at(-1)!.type, "CANCEL");
});

test("bridge: a wrong token rejects connect", async () => {
  const w = fakeWorker("secret");
  await new Promise((r) => w.wss.once("listening", r));
  await assert.rejects(new PeterClient({ url: w.url(), token: "nope" }).connect(), /closed|4401/);
  w.wss.close();
});
