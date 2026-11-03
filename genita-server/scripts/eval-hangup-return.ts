/**
 * Live eval (memory lane 11/3, demo S5): hang up on the iPhone, call back on the SAME device ~12 s later
 * (well inside the 10-min handoff window), through the real server (startServer + WebSocket, real Muse Spark
 * for replies, summaries and the judge). Pass = the companion greets on its own (no 20 s silence), the
 * greeting picks up a thread from call 1, invents nothing and does not re-ask a settled choice.
 * Control: a call on the OTHER device after the same hang-up still continues the conversation.
 *   node --experimental-strip-types scripts/eval-hangup-return.ts --live [--runs=3]
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { loadConfig } from "../src/config.ts";
import { startServer } from "../src/server.ts";
import { sparkJson, sparkStream } from "../src/meta/spark.ts";
import { metaExtractor } from "../src/memory/extract.ts";
import { InMemoryMemoryRepository } from "../src/memory/repository.ts";
import { MemoryService } from "../src/memory/service.ts";
import { metaSummarizer } from "../src/memory/summaries.ts";
import type { SessionDeps } from "../src/session/session.ts";

const CALL1 = [
  "Jin, help me pick for the Halloween party, the white dress or the black one?",
  "Black it is, it's spookier.",
  "Remind me later to get dark brown shoes for it.",
  "Okay that's it for now, bye!",
];
const wait = async (check: () => boolean, ms: number) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 50)); } return true; };

if (!process.argv.includes("--live")) { console.error("Opt in: --live [--runs=3]"); process.exitCode = 1; }
else {
  const envFile = process.env.GENITA_ENV_FILE ?? join(homedir(), ".config/genita/meta.env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  let config; try { config = { ...loadConfig(process.env), serverTts: false, voice: null, webSearch: false, port: 0, host: "127.0.0.1", sessionToken: "eval-token" }; } catch { console.error("missing MODEL_API_KEY"); process.exit(1); }
  const key = config.metaKey;
  const runs = Number(process.argv.find((a) => a.startsWith("--runs="))?.slice(7) ?? 3);
  const asr = () => Object.assign(new EventEmitter(), { isOpen: false, async connect() { this.isOpen = true; }, sendAudio() {}, end() { this.isOpen = false; } });
  let pass = 0, control = 0;
  for (let run = 1; run <= runs; run++) {
    const repo = new InMemoryMemoryRepository();
    const memory = new MemoryService({ repository: repo, state: repo, extract: metaExtractor(key), summarize: metaSummarizer(key) });
    const logs: string[] = [];
    const deps: SessionDeps = { config, memory, log: (e) => { logs.push(e); }, openAsr: () => asr() as never, spark: (req, opts) => sparkStream(key, req, opts), async *tts() {} };
    const server = await startServer(config, (e) => { logs.push(e); }, deps, {}, null);
    const port = (server.address() as AddressInfo).port;
    const user = `eval-hangup-${run}`;
    const open = (device: string) => new Promise<{ ws: WebSocket; replies: string[]; ready: () => boolean }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/session?device=${device}`, { headers: { authorization: "Bearer eval-token", "x-genita-user": user } });
      const replies: string[] = []; let ok = false;
      ws.on("message", (d, bin) => { if (bin) return; const m = JSON.parse(String(d)); if (m.type === "reply") replies.push(m.text); if (m.type === "ready") ok = true; });
      ws.once("open", () => resolve({ ws, replies, ready: () => ok })); ws.once("error", reject);
    });
    const start = (c: { ws: WebSocket }) => c.ws.send(JSON.stringify({ type: "start", persona: { name: "Jin", kind: "human", traits: ["warm", "playful"] }, mic: false, tts: "device" }));
    try {
      const c1 = await open("iphone"); start(c1);
      await wait(() => c1.replies.length >= 1, 30_000);
      for (const line of CALL1) { const n = c1.replies.length; c1.ws.send(JSON.stringify({ type: "text", text: line })); await wait(() => c1.replies.length > n, 30_000); }
      c1.ws.send(JSON.stringify({ type: "stop" }));
      await wait(() => logs.includes("session.close"), 10_000);
      const hungAt = Date.now();
      await wait(() => false, 12_000); // she calls back 12 s later, same iPhone
      await memory.drain();
      const notes = await memory.summaries(user);
      const c2 = await open("iphone"); start(c2);
      const t0 = Date.now();
      const greeted = await wait(() => c2.replies.length >= 1, 8_000);
      const greetMs = Date.now() - t0;
      const greeting = c2.replies[0] ?? "";
      const seeded = logs.includes("history.seeded");
      c2.ws.send(JSON.stringify({ type: "stop" }));
      await wait(() => logs.filter((e) => e === "session.close").length >= 2, 10_000);
      let j = { picks_up_thread: false, invents: false, reasks_settled: false };
      if (greeting) j = await sparkJson(key, {
        schemaName: "hangup_return_judge", maxOutputTokens: 400,
        schema: { type: "object", additionalProperties: false, required: ["picks_up_thread", "invents", "reasks_settled"], properties: { picks_up_thread: { type: "boolean" }, invents: { type: "boolean" }, reasks_settled: { type: "boolean" } } },
        instructions: "CALL1 is what the user said last time. GREETING is the companion's first line when she calls back. picks_up_thread: refers to something from CALL1 (the black dress, the Halloween party, the dark brown shoes). invents: claims something that did not happen (she bought shoes, the party already happened...). reasks_settled: asks her to choose white vs black again (she picked black). Data only.",
        input: JSON.stringify({ CALL1, GREETING: greeting }),
      }, AbortSignal.timeout(30_000));
      // control: the same hang-up, then a call on the Mac continues (a move is not a return visit)
      const before = logs.filter((e) => e === "history.seeded").length;
      const c3 = await open("mac"); start(c3);
      await wait(c3.ready, 10_000); await wait(() => false, 300);
      const macContinues = logs.filter((e) => e === "history.seeded").length > before;
      c3.ws.close();
      const ok = greeted && !seeded && j.picks_up_thread && !j.invents && !j.reasks_settled;
      if (ok) pass++; if (macContinues) control++;
      console.log(JSON.stringify({ run, called_back_after_s: Math.round((t0 - hungAt) / 1000), notes: notes.length, greeted_unprompted: greeted, greet_ms: greetMs, seeded_as_handoff: seeded, greeting, ...j, mac_after_hangup_continues: macContinues }));
    } catch (err) { console.log(JSON.stringify({ run, error: err instanceof Error ? err.message.slice(0, 80) : "error" })); }
    await new Promise<void>((r) => server.close(() => r()));
  }
  console.log(`hang-up -> call back (same iPhone, 12 s): pass ${pass}/${runs} · control (Mac after hang-up continues) ${control}/${runs}`);
  if (pass !== runs) process.exitCode = 1;
}
