/**
 * Live recall eval (memory lane 11/3). Opt in: npm run eval:recall -- --live
 * 24 synthetic memories (6 targets + 18 distractors), 12 recall-tool queries, half of them phrased with
 * NO word in common with the right memory. Compares token overlap alone vs overlap + Muse Spark re-rank:
 * hit@3 and the re-rank's added latency (p50/p90, bounded by RERANK_BUDGET_MS). Keys never printed.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { InMemoryMemoryRepository } from "../src/memory/repository.ts";
import { MemoryService } from "../src/memory/service.ts";
import { metaReranker, RERANK_BUDGET_MS } from "../src/memory/rerank.ts";
import { metaKeyMaker } from "../src/memory/extract.ts";

const TARGETS = [
  "My cat Miso steals my running socks.",
  "I am training for a 10K race in December.",
  "I drink oat milk lattes every morning.",
  "I play the cello in a community orchestra.",
  "I am learning to bake sourdough bread.",
  "I want to visit Kyoto in the spring.",
];
const DISTRACTORS = [
  "I like rainy afternoons.", "I prefer window seats on planes.", "I collect vintage postcards.", "I watch sci-fi movies on Fridays.",
  "I like spicy ramen.", "I keep a bullet journal.", "I am repainting my bedroom green.", "I prefer tea over soda.",
  "I like jigsaw puzzles.", "I grow basil on my balcony.", "I listen to jazz while cooking.", "I am into board games.",
  "I like early morning walks.", "I prefer paper books.", "I like the color teal.", "I am learning chess openings.",
  "I like iced coffee in summer.", "I take photos of sunsets.",
];
const QUERIES: Array<[string, number, "overlap" | "paraphrase"]> = [
  ["how is Miso doing", 0, "overlap"], ["what pet do I have", 0, "paraphrase"],
  ["10K race plans", 1, "overlap"], ["what am I getting fit for this winter", 1, "paraphrase"],
  ["oat milk", 2, "overlap"], ["what do I usually order at the cafe", 2, "paraphrase"],
  ["cello practice", 3, "overlap"], ["which instrument do I play", 3, "paraphrase"],
  ["sourdough bread", 4, "overlap"], ["what am I trying to make in the kitchen", 4, "paraphrase"],
  ["Kyoto trip", 5, "overlap"], ["where in Japan do I want to travel", 5, "paraphrase"],
];

if (!process.argv.includes("--live")) {
  console.error("Opt in explicitly: npm run eval:recall -- --live"); process.exitCode = 1;
} else {
  const envFile = process.env.GENITA_ENV_FILE ?? join(homedir(), ".config/genita/meta.env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const key = process.env.MODEL_API_KEY;
  if (!key) { console.error("missing MODEL_API_KEY"); process.exit(1); }
  const logs: Array<{ ms: number; fallback: boolean }> = [];
  const make = (keys: boolean, rerank: boolean) => {
    const repo = new InMemoryMemoryRepository();
    return new MemoryService({ repository: repo, state: repo, extract: async () => [], ...(keys ? { keys: metaKeyMaker(key) } : {}), ...(rerank ? { rerank: metaReranker(key) } : {}),
      log: (e, d) => { if (e === "memory.reranked") logs.push({ ms: Number(d.ms), fallback: d.fallback === true }); } });
  };
  const modes = { overlap: make(false, false), keys: make(true, false), ...(process.argv.includes("--rerank") ? { rerank: make(true, true) } : {}) } as Record<string, MemoryService>;
  for (const m of Object.values(modes)) { for (const t of [...TARGETS, ...DISTRACTORS]) await m.remember("eval", t, "fact", "seed"); await m.drain(); }
  const score: Record<string, { overlap: number; paraphrase: number; ms: number[] }> = {};
  for (const name of Object.keys(modes)) score[name] = { overlap: 0, paraphrase: 0, ms: [] };
  for (const [q, target, kind] of QUERIES) {
    const row: Record<string, unknown> = { q, kind };
    for (const [name, m] of Object.entries(modes)) {
      const t0 = performance.now();
      const got = (await m.recall("eval", q, { rerank: name === "rerank" })).map((x) => x.text);
      score[name].ms.push(performance.now() - t0);
      const hit = got.includes(TARGETS[target]);
      if (hit) score[name][kind]++;
      row[name] = hit;
    }
    console.log(JSON.stringify(row));
  }
  const p = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]); };
  for (const [name, r] of Object.entries(score)) console.log(`${name}: hit@3 overlap-phrased ${r.overlap}/6 · paraphrased ${r.paraphrase}/6 · recall time p50 ${p(r.ms, 0.5)} ms p90 ${p(r.ms, 0.9)} ms`);
  if (logs.length) console.log(`rerank (budget ${RERANK_BUDGET_MS} ms): fallbacks ${logs.filter((l) => l.fallback).length}/${logs.length}`);
}
