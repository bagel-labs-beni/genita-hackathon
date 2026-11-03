/**
 * #341 opener rotation eval: one user's 5 consecutive calls (greeting only). Each greeting's primary topic is
 * the profile topic it mentions first; pass = ≥ 4 distinct primary topics across the 5 and never the same topic
 * twice in a row. Baseline 11/3: 12/13 greetings opened on "late-night ramen".
 *
 *   npm run eval:convo -- --openers --root <genita-server> [--label x] [--n 3]
 */
import type { SparkRequest } from "../../src/meta/spark.ts";
import { stripMarkup } from "./metrics.ts";
import { SUMMER_PROFILE, type Scenario } from "./scenarios.ts";
import type { EvalAdapter, EvalCtx } from "./run.ts";

/** Summer's profile topics → words that mean the greeting opened on it */
export const SUMMER_TOPICS: Record<string, RegExp> = {
  ramen: /\b(?:ramen|noodles?)\b/i,
  cooking: /\b(?:fusion|cook\w*|kimchi|recipe|kitchen|carbonara|gochujang|stir[- ]fry|tacos?|bulgogi)\b/i,
  fashion: /\b(?:monochrome|all[- ]black|black[- ]on[- ]black|outfits?|fits?|fashion|wardrobe|wear\w*|grey|gray)\b/i,
  kpop: /\b(?:aespa|k-?pop|comeback|playlist|track|stan|karina|winter|giselle|ningning)\b/i,
};

/** the topic mentioned first in the text, or null */
export function primaryTopic(text: string, topics: Record<string, RegExp> = SUMMER_TOPICS): string | null {
  let best: { t: string; at: number } | null = null;
  for (const [t, re] of Object.entries(topics)) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.at)) best = { t, at: m.index };
  }
  return best?.t ?? null;
}

export function scoreSeries(primaries: (string | null)[]): { distinct: number; repeatsInARow: number; pass: boolean } {
  const named = primaries.filter((p): p is string => !!p);
  const distinct = new Set(named).size;
  let repeatsInARow = 0;
  for (let i = 1; i < primaries.length; i++) if (primaries[i] && primaries[i] === primaries[i - 1]) repeatsInARow++;
  return { distinct, repeatsInARow, pass: distinct >= 4 && repeatsInARow === 0 };
}

const MIRA = { name: "Mira", kind: "human" as const, traits: ["dry", "playful", "opinionated", "warm underneath"], speakingStyle: "casual, quick, teasing, short sentences" };

export type SeriesResult = { run: number; greetings: string[]; primaries: (string | null)[]; distinct: number; repeatsInARow: number; pass: boolean };

export async function runOpenerSeries(adapter: EvalAdapter, call: (req: SparkRequest) => Promise<string>, runs: number, calls = 5): Promise<SeriesResult[]> {
  const out: SeriesResult[] = [];
  for (let r = 0; r < runs; r++) {
    const greetings: string[] = [];
    for (let i = 0; i < calls; i++) {
      // a returning user a day later each time, no memory item: the profile is what the greeting has
      const scenario = { id: `opener-series-${r}`, title: "opener rotation", persona: MIRA, user: { name: "Summer", profile: SUMMER_PROFILE }, callNumber: i + 2, gapHours: 26, turns: [{ kind: "greet" }], expect: {} } as unknown as Scenario;
      const ctx = { scenario, history: [], turn: { kind: "greet" }, series: { id: `opener-series-${r}`, index: i } } as EvalCtx & { series: { id: string; index: number } };
      const req = adapter.request(ctx);
      if (!req) { greetings.push(""); continue; }
      const raw = await call(req);
      greetings.push(stripMarkup(adapter.post ? adapter.post(raw, ctx) : raw));
    }
    const primaries = greetings.map((g) => primaryTopic(g));
    out.push({ run: r, greetings, primaries, ...scoreSeries(primaries) });
  }
  return out;
}

export function seriesMd(label: string, results: SeriesResult[]): string {
  const lines = [`# Opener rotation: ${label}`, "", "| run | primary topics (5 calls) | distinct | same twice in a row | pass |", "|---|---|---|---|---|"];
  for (const r of results) lines.push(`| ${r.run + 1} | ${r.primaries.map((p) => p ?? "—").join(" → ")} | ${r.distinct} | ${r.repeatsInARow} | ${r.pass ? "yes" : "no"} |`);
  const pass = results.filter((r) => r.pass).length;
  const ramen = results.flatMap((r) => r.primaries).filter((p) => p === "ramen").length;
  const total = results.length * (results[0]?.greetings.length ?? 0);
  lines.push("", `pass ${pass}/${results.length} · mean distinct ${(results.reduce((a, r) => a + r.distinct, 0) / Math.max(1, results.length)).toFixed(2)} · ramen-first ${ramen}/${total}`, "");
  for (const r of results) { lines.push(`## run ${r.run + 1}`); r.greetings.forEach((g, i) => lines.push(`${i + 1}. [${r.primaries[i] ?? "—"}] ${g}`)); lines.push(""); }
  return lines.join("\n");
}
