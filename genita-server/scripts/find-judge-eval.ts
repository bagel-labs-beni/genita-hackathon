/**
 * Live accuracy + latency of the find judge (finds/judge.ts): 10 realistic turns (line + what the camera shows as
 * text), one real Spark call each, plus 3 calls with a real image attached for the image latency. Never prints keys.
 * Usage: MODEL_API_KEY=… node --experimental-strip-types scripts/find-judge-eval.ts
 */
import { readFileSync } from "node:fs";
import { metaVendors } from "../src/finds/vendors.ts";
import { sparkJudge, type JudgeKind } from "../src/finds/judge.ts";
import { assessLine } from "../src/finds/general.ts";

const key = process.env.MODEL_API_KEY;
if (!key) throw new Error("MODEL_API_KEY missing");
export const EVAL: Array<{ text: string; scene?: string; recent?: string[]; want: JudgeKind }> = [
  { text: "Where could I get these?", scene: "the user holds up a pair of white leather low-top sneakers", want: "product" },
  { text: "Any good spots for that around Hongdae?", recent: ["User: I'm craving ramen tonight.", "You: Ooh, ramen sounds perfect."], want: "general" },
  { text: "Any idea what kind of plant?", scene: "a potted plant with large split green leaves on a desk", want: "identify" },
  { text: "Anything quick I could cook tonight?", scene: "an open fridge with eggs, spinach, cheddar and half an onion", want: "recipe" },
  { text: "How about this one?", scene: "the user holds a blue striped shirt against their chest", want: "none" },
  { text: "Hey, good morning!", scene: "the user's face, smiling, in a kitchen", want: "none" },
  { text: "Is the Louvre open on Mondays?", want: "general" },
  { text: "Can you find a cheaper version of this lamp?", scene: "a brass arc floor lamp next to a sofa", want: "product" },
  { text: "Which goes better with my jeans, the black or the brown one?", scene: "the user holds a black leather jacket and a brown suede jacket", want: "outfit" },
  { text: "Ugh, today was so long.", scene: "the user lying on a couch", want: "none" },
];
const judge = sparkJudge(metaVendors(key));
const ms: number[] = [];
let right = 0;
for (const e of EVAL) {
  const t0 = performance.now();
  const r = await judge({ text: e.text, recent: e.recent ?? [], ...(e.scene ? { scene: e.scene } : {}) }, AbortSignal.timeout(10_000)).catch((err) => ({ kind: "none" as const, reason: `error ${String(err).slice(0, 60)}` }));
  const t = Math.round(performance.now() - t0);
  ms.push(t);
  if (r.kind === e.want) right++;
  console.log(JSON.stringify({ text: e.text, gate: assessLine(e.text), want: e.want, got: r.kind, ok: r.kind === e.want, ms: t, query: "query" in r ? r.query : undefined, reason: r.reason }));
}
const p = (a: number[], q: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))];
console.log(JSON.stringify({ n: EVAL.length, accuracy: `${right}/${EVAL.length}`, p50: p(ms, 0.5), p90: p(ms, 0.9), within1500: ms.filter((x) => x <= 1500).length }));
// image latency (a real frame attached)
const img = process.argv[2];
if (img) {
  const frame = `data:image/jpeg;base64,${readFileSync(img).toString("base64")}`;
  const im: number[] = [];
  for (const text of ["Do you like my new haircut?", "Where could I get these?", "Any idea what this is?"]) {
    const t0 = performance.now();
    const r = await judge({ text, recent: [], frame }, AbortSignal.timeout(10_000)).catch(() => ({ kind: "none" as const, reason: "error" }));
    im.push(Math.round(performance.now() - t0));
    console.log(JSON.stringify({ image: true, text, got: r.kind, ms: im.at(-1) }));
  }
  console.log(JSON.stringify({ image_n: im.length, image_p50: p(im, 0.5) }));
}
