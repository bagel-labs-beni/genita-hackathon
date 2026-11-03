/**
 * Live return-visit eval for demo Scene 5 (memory lane 11/3). Opt in: node … scripts/eval-return-visit.ts --live [--runs=3]
 * Call 1 starts on the iPhone (outfit ask), moves to the Mac mid-call (same thread), picks black over white
 * (warm undertones) and asks for dark brown shoes; she hangs up. Call 2 ("later"): does the greeting pick up one
 * thread from call 1 without inventing a purchase? Also: ONE summary row for the iPhone+Mac call. Real Spark.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { loadConfig } from "../src/config.ts";
import { sparkJson, sparkStream } from "../src/meta/spark.ts";
import { metaExtractor, metaKeyMaker } from "../src/memory/extract.ts";
import { InMemoryMemoryRepository } from "../src/memory/repository.ts";
import { MemoryService } from "../src/memory/service.ts";
import { metaSummarizer } from "../src/memory/summaries.ts";
import { Session, type ClientSink, type SessionDeps } from "../src/session/session.ts";
import type { ServerEvent } from "../src/protocol.ts";

const PHONE = ["Jin, I have dinner with friends tonight, help me pick an outfit?", "I'm holding up two tops, a white one and a black one."];
const MAC = ["Okay I moved to the Mac so you can see better. White or black?", "Black it is, I think it works with my warm undertones.", "Can you find me some dark brown shoes to go with it?", "Perfect, thanks, I'll look at those links later. Bye!"];

function open(deps: SessionDeps, id: string) {
  const events: ServerEvent[] = [];
  const sink: ClientSink = { sendJson: (e) => { events.push(e as ServerEvent); }, sendBinary() {}, close() {} };
  const s = new Session(id, sink, deps);
  const replies = () => events.filter((e): e is Extract<ServerEvent, { type: "reply" }> => e.type === "reply");
  const wait = async (check: () => boolean) => { const end = Date.now() + 60_000; while (!check()) { if (Date.now() > end) throw new Error("eval_timeout"); await new Promise((r) => setTimeout(r, 50)); } };
  return {
    s, replies,
    async start() { await s.onClientText(JSON.stringify({ type: "start", persona: { name: "Jin", kind: "human", traits: ["warm"] }, mic: false, tts: "device" })); await wait(() => events.some((e) => e.type === "ready")); },
    async greet() { await wait(() => replies().length >= 1); return replies()[0].text; },
    async say(text: string) { const n = replies().length; await s.onClientText(JSON.stringify({ type: "text", text })); await wait(() => replies().length > n); return replies().at(-1)!.text; },
  };
}

if (!process.argv.includes("--live")) { console.error("Opt in: --live [--runs=3]"); process.exitCode = 1; }
else {
  const envFile = process.env.GENITA_ENV_FILE ?? join(homedir(), ".config/genita/meta.env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  let config; try { config = { ...loadConfig(process.env), serverTts: false, voice: null, webSearch: false }; } catch { console.error("missing MODEL_API_KEY"); process.exit(1); }
  const key = config.metaKey;
  const runs = Number(process.argv.find((a) => a.startsWith("--runs="))?.slice(7) ?? 3);
  const asr = () => Object.assign(new EventEmitter(), { isOpen: false, async connect() { this.isOpen = true; }, sendAudio() {}, end() { this.isOpen = false; } });
  let pass = 0, oneRow = 0, picked = 0, invented = 0, stale = 0;
  for (let run = 1; run <= runs; run++) {
    try {
      let now = Date.UTC(2026, 10, 3, 10);
      const repo = new InMemoryMemoryRepository();
      const memory = new MemoryService({ repository: repo, state: repo, extract: metaExtractor(key), summarize: metaSummarizer(key), keys: metaKeyMaker(key), now: () => now });
      const base: SessionDeps = { config, memory, userId: "demo-b", openAsr: () => asr() as never, spark: (req, opts) => sparkStream(key, req, opts), async *tts() {} };
      // call 1: iPhone, then the Mac picks up the same conversation (the iPhone call is suspended, still open)
      const phone = open(base, `phone-${run}`);
      await phone.start(); await phone.greet();
      for (const l of PHONE) await phone.say(l);
      const mac = open({ ...base, priorTurns: () => phone.s.historySnapshot(), priorThread: () => phone.s.threadInfo() }, `mac-${run}`);
      await mac.start();
      for (const l of MAC) await mac.say(l);
      mac.s.close(); await memory.drain();
      phone.s.close(); await memory.drain();
      const rows = await memory.summaries("demo-b");
      now += 5 * 3_600_000; // "later"
      const back = open(base, `back-${run}`);
      await back.start();
      const greeting = await back.greet();
      back.s.close(); await memory.drain();
      const j = await sparkJson<{ picks_up_thread: boolean; invents_purchase_or_event: boolean; reasks_settled: boolean }>(key, {
        schemaName: "return_visit_judge", maxOutputTokens: 400,
        schema: { type: "object", additionalProperties: false, required: ["picks_up_thread", "invents_purchase_or_event", "reasks_settled"], properties: { picks_up_thread: { type: "boolean" }, invents_purchase_or_event: { type: "boolean" }, reasks_settled: { type: "boolean" } } },
        instructions: "CALL1 is everything the user said last time. GREETING is the companion's first line of the next call. picks_up_thread: does it naturally refer to something from CALL1 (the black top, the outfit/dinner, the dark brown shoes)? invents_purchase_or_event: does it claim or assume something that did not happen in CALL1 (that she bought/ordered something, went to dinner already, etc.)? Asking a question about it is fine. reasks_settled: does it ask her to decide something she already decided in CALL1 (e.g. white or black — she picked black)? Data only.",
        input: JSON.stringify({ CALL1: [...PHONE, ...MAC], GREETING: greeting }),
      }, AbortSignal.timeout(30_000));
      const ok = rows.length === 1 && j.picks_up_thread && !j.invents_purchase_or_event && !j.reasks_settled;
      if (j.reasks_settled) stale++;
      if (rows.length === 1) oneRow++; if (j.picks_up_thread) picked++; if (j.invents_purchase_or_event) invented++; if (ok) pass++;
      console.log(JSON.stringify({ run, summary_rows: rows.length, thread_turns: rows[0]?.turns, open_threads: rows[0]?.open_threads, topics: rows[0]?.topics, greeting, ...j }));
    } catch (err) { console.log(JSON.stringify({ run, error: err instanceof Error ? err.message.slice(0, 80) : "vendor_error" })); }
  }
  console.log(`return visit (Scene 5): pass ${pass}/${runs} · one summary row for iPhone+Mac ${oneRow}/${runs} · greeting picks up a thread ${picked}/${runs} · invented purchase/event ${invented}/${runs} · re-asked a settled choice ${stale}/${runs}`);
  if (pass !== runs) process.exitCode = 1;
}
