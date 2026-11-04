/**
 * Real-vendor check for the general web search card (finds/general.ts): one Spark web_search call per question,
 * prints card shape and time (never the key). Usage: MODEL_API_KEY=… npm run -s general:e2e  (or node … scripts/general-e2e.ts)
 */
import { metaVendors } from "../src/finds/vendors.ts";
import { runGeneral } from "../src/finds/general.ts";
import type { ServerEvent } from "../src/protocol.ts";

const key = process.env.MODEL_API_KEY;
if (!key) throw new Error("MODEL_API_KEY missing");
const questions = process.argv.slice(2).length ? process.argv.slice(2) : [
  "Who won the World Series last night?",
  "What's the best ramen place in Seoul?",
  "How do I get a red wine stain out of a carpet?",
  "What's the latest news on the Artemis mission?",
  "서울에서 제일 맛있는 라멘집 어디야?",
];
const vendors = metaVendors(key);
const ms: number[] = [];
for (const q of questions) {
  const events: ServerEvent[] = [];
  const t0 = performance.now();
  const r = await runGeneral({
    findId: "e2e", utteranceId: 1, kind: "answer", question: q, frames: [], memories: [], replyText: Promise.resolve(null),
    vendors, emit: (e) => events.push(e), signal: new AbortController().signal, now: () => performance.now(), log: () => {}, images: false,
    putImage: async () => "x",
  });
  const t = Math.round(performance.now() - t0);
  ms.push(t);
  const c = r.card;
  console.log(JSON.stringify({ q, ms: t, ok: !!c, title: c?.title, results: c?.sources.map((s) => s.domain), steps: c?.steps.map((s) => s.text.slice(0, 90)), failed: events.find((e) => e.type === "find.failed") ? true : undefined }));
}
ms.sort((a, b) => a - b);
console.log(JSON.stringify({ n: ms.length, p50: ms[Math.floor(ms.length / 2)], max: ms.at(-1), ok: ms.length }));
