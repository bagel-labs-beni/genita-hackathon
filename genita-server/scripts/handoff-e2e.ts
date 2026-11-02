/**
 * F6-L7 acceptance script: two devices, 10 round trips, simultaneous sound must be 0.
 *
 *   npm run handoff:e2e -- [--url ws://127.0.0.1:8787] [--token <dev token or JWT>] [--trips 10]
 *
 * Opens what each app opens — /v1/presence and /v1/session?device=… for an "iphone" and a "mac" —
 * and moves the conversation back and forth with Move to Mac / Move to iPhone (move.request → the
 * other device claims) while the current owner is mid-reply (real Spark + TTS on the server).
 * Counts, per device, audio frames received while that device was not the owner (after it heard the
 * move) and frames that overlap in time across devices. Prints one JSON line; exit 1 on any overlap.
 */
import WebSocket from "ws";

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const base = arg("url", "ws://127.0.0.1:8787").replace(/\/+$/, "");
const token = arg("token", process.env.GENITA_SESSION_TOKEN ?? "");
const trips = Number(arg("trips", "10"));
const user = `handoff-e2e-${Date.now()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Dev = "iphone" | "mac";

function open(path: string) {
  const ws = new WebSocket(base + path, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "x-genita-user": user } });
  const json: Record<string, any>[] = [];
  const frames: number[] = [];
  ws.on("message", (d, bin) => (bin ? frames.push(Date.now()) : json.push(JSON.parse(String(d)))));
  return {
    ws,
    json,
    frames,
    send: (m: object) => ws.send(JSON.stringify(m)),
    ready: new Promise<void>((r, j) => (ws.on("open", () => r()), ws.on("error", j))),
    wait: async (pred: (m: Record<string, any>) => boolean, from = 0, ms = 20000) => {
      const t0 = Date.now();
      for (;;) {
        const hit = json.slice(from).find(pred);
        if (hit) return hit;
        if (Date.now() - t0 > ms) throw new Error(`timeout; last ${json.slice(-3).map((m) => m.type)}`);
        await sleep(5);
      }
    },
  };
}

const dev = {} as Record<Dev, { presence: ReturnType<typeof open>; call: ReturnType<typeof open>; owner: [number, number][] }>;
for (const d of ["iphone", "mac"] as Dev[]) {
  dev[d] = { presence: open(`/v1/presence?device=${d}`), call: open(`/v1/session?device=${d}`), owner: [] };
  await dev[d].presence.ready;
  await dev[d].call.ready;
  dev[d].presence.send({ type: "hello", owner: "iphone", epoch: 0, active: true });
}
dev.iphone.call.send({ type: "start", persona: { name: "Jin" }, mic: false });
await dev.iphone.call.wait((m) => m.type === "ownership" && m.owner === "iphone");
dev.mac.call.send({ type: "start", persona: { name: "Jin" }, mic: false });
await dev.mac.call.wait((m) => m.type === "ready");
// the device answers move.request by claiming, like the apps do
for (const d of ["iphone", "mac"] as Dev[]) {
  dev[d].presence.ws.on("message", (raw, bin) => {
    if (bin) return;
    const m = JSON.parse(String(raw));
    if (m.type === "move.request") dev[d].presence.send({ type: "claim", trigger: "move" });
  });
}

let owner = "iphone" as Dev;
const moves: number[] = [];
const ownedSince: Record<Dev, number> = { iphone: Date.now(), mac: 0 };
for (let i = 0; i < trips * 2; i++) {
  const from: Dev = owner;
  const to: Dev = from === "iphone" ? "mac" : "iphone";
  // mid-reply; a vendor hiccup (no audio for a reply) is retried once, it is not what this measures
  let spoke = false;
  for (let attempt = 0; attempt < 2 && !spoke; attempt++) {
    const mark = dev[from].call.json.length;
    dev[from].call.send({ type: "text", text: i % 2 ? "Tell me a short story about a cat." : "Describe your morning in three sentences." });
    const first = await dev[from].call.wait((m) => m.type === "audio" || m.type === "reply" || m.type === "error", mark, 30000);
    spoke = first.type === "audio";
  }
  if (!spoke) throw new Error(`no audio from ${from} twice`);
  const t0 = Date.now();
  const toMark = dev[from].call.json.length;
  dev[from].presence.send({ type: "move.request", to });
  await dev[to].presence.wait((m) => m.type === "ownership" && m.owner === to, 0, 10000).catch(() => null);
  const heard = await dev[from].call.wait((m) => m.type === "ownership" && m.owner === to, toMark, 10000);
  moves.push(Date.now() - t0);
  const heardAt = Date.now();
  dev[from].owner.push([ownedSince[from], heardAt]);
  ownedSince[to] = heardAt;
  owner = to;
  void heard;
}
await sleep(800); // let anything stale arrive
dev[owner].owner.push([ownedSince[owner], Date.now()]);
// frames a device received outside its own ownership intervals (after it heard the move away)
const notOwnerFrames: Record<Dev, number> = { iphone: 0, mac: 0 };
for (const d of ["iphone", "mac"] as Dev[]) notOwnerFrames[d] = dev[d].call.frames.filter((t) => !dev[d].owner.some(([a, b]) => t >= a && t <= b)).length;
// overlap: a frame on one device while the other device was the owner and also received a frame within 50 ms
const all = (["iphone", "mac"] as Dev[]).flatMap((d) => dev[d].call.frames.map((t) => ({ d, t })));
let overlap = 0;
for (const a of all) for (const b of all) if (a.d === "iphone" && b.d === "mac" && Math.abs(a.t - b.t) < 50) overlap++;
const sorted = [...moves].sort((a, b) => a - b);
const out = { trips, moves: moves.length, moveMs: { p50: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) }, framesToNonOwner: notOwnerFrames, overlappingFrames: overlap };
console.log(JSON.stringify(out));
for (const d of ["iphone", "mac"] as Dev[]) {
  dev[d].call.send({ type: "stop" });
  dev[d].presence.ws.close();
}
await sleep(200);
process.exit(notOwnerFrames.iphone + notOwnerFrames.mac + overlap === 0 ? 0 : 1);
