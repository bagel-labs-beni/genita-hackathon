// Replays a recorded genita-server session (PROTOCOL.md v1) so the call screen can be driven through
// its states on a simulator without vendor keys. No dependencies (Node ≥ 20).
//
//   node ios-app/Tools/call-replay/server.mjs [--port 8788] [--file session-r1.json] [--scale 1 | --pace 1]
//   --scale/--pace N stretches the timeline N× (UI tests that must catch short states on a slow CI simulator).
//
// start → handshake events (ready, state listening). audio_start → the recorded timeline at its original
// pace (speech, thinking, reply audio, barge-in, second reply). Audio is a quiet tone of the recorded
// length. Then: error spark_unavailable (S09-F) and, 4 s later, a dropped connection with upgrades refused
// for 8 s (S09-R), after which the next connection gets a fresh session.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, d) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : d; };
const port = Number(arg("--port", 8788));
// --scale 3 stretches the recorded timeline (UI tests on slow CI simulators need time to look).
const scale = Number(arg("--scale", arg("--pace", 1))) || 1; // --pace = same (interpret workflow)
const file = arg("--file", join(dirname(fileURLToPath(import.meta.url)), "session-r1.json"));
const rec = JSON.parse(readFileSync(file, "utf8"));
let refuseUntil = 0;
const log = (...a) => console.log(new Date().toISOString(), ...a);

function frame(opcode, payload) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(len), 2); return b; })();
  return Buffer.concat([head, payload]);
}

function tone(bytes, offset) {
  const pcm = Buffer.alloc(bytes);
  for (let i = 0; i + 1 < bytes; i += 2) pcm.writeInt16LE(Math.round(1200 * Math.sin(((offset + i / 2) * 2 * Math.PI * 220) / 24000)), i);
  return pcm;
}

function session(socket) {
  const timers = [];
  let buf = Buffer.alloc(0), started = false, replaying = false, closed = false, toneAt = 0;
  const sendJson = (o) => !closed && socket.write(frame(1, Buffer.from(JSON.stringify(o))));
  const sendBin = (b) => !closed && socket.write(frame(2, b));
  const close = () => { if (closed) return; closed = true; timers.forEach(clearTimeout); socket.destroy(); };
  const at = (ms, fn) => timers.push(setTimeout(fn, ms));

  function replay() {
    replaying = true;
    log("replay start");
    let end = 0;
    for (const item of rec.timeline) {
      end = Math.max(end, item.t * scale);
      at(item.t * scale, () => {
        if (item.event) sendJson(item.event);
        else { const head = Buffer.from(item.frame.header, "base64"); sendBin(Buffer.concat([head, tone(item.frame.pcmBytes, toneAt)])); toneAt += item.frame.pcmBytes / 2; }
      });
    }
    at(end + 2500, () => sendJson({ type: "error", code: "spark_unavailable", message: "The companion could not answer. Try again.", retryable: true }));
    at(end + 6500, () => { log("dropping the connection (S09-R)"); refuseUntil = Date.now() + 8000; close(); });
  }

  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const op = buf[0] & 15, masked = buf[1] & 128;
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      const data = Buffer.from(buf.subarray(off + (masked ? 4 : 0), need));
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(need);
      if (op === 8) return close();
      if (op === 9) { socket.write(frame(10, data)); continue; }
      if (op !== 1) continue; // mic audio and pongs are ignored
      let msg; try { msg = JSON.parse(data.toString("utf8")); } catch { continue; }
      log("←", msg.type, msg.type === "frames" ? `${msg.images?.length} images` : "");
      if (msg.type === "start" && !started) { started = true; rec.handshake.forEach(sendJson); }
      else if (msg.type === "audio_start" && !replaying) replay();
      else if (msg.type === "ping") sendJson({ type: "pong", t: msg.t ?? null });
      else if (msg.type === "stop") close();
    }
  });
  socket.on("close", () => { closed = true; timers.forEach(clearTimeout); });
  socket.on("error", () => close());
}

const http = createServer((req, res) => { res.writeHead(req.url === "/healthz" ? 200 : 404); res.end(req.url === "/healthz" ? '{"ok":true}' : ""); });
http.on("upgrade", (req, socket) => {
  if (!req.url.startsWith("/v1/session") || Date.now() < refuseUntil) { socket.end("HTTP/1.1 503 Busy\r\nConnection: close\r\n\r\n"); return; }
  const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  log("session open");
  session(socket);
});
http.listen(port, "127.0.0.1", () => log(`call replay on ws://127.0.0.1:${port}/v1/session (${rec.timeline.length} items)`));
