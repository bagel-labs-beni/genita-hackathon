/**
 * SUM insight report → the call profile (start.user.profile, via styleProfileText).
 * Types only here, so prep/importProfile.ts can import it without a cycle.
 *
 * What the user didn't deny goes in as "what I noticed + how I'll use it", lightly (never quoted back as
 * analysis); a "not me" goes in as not true, with their own correction when they gave one.
 * GENITA_INSIGHTS_PROFILE=0 leaves the block out (rollback without a deploy of the app).
 */
export type InsightCategory = "talk" | "think" | "humor" | "taste" | "help" | "boundary" | "rhythm" | "interest";
export type InsightSource = "import" | "answer" | "chat";
export type InsightEvidence = { source: InsightSource; quote: string; source_label: string; /** the key phrase inside quote (drawn as a mark) */ highlight?: string };
export type InsightChip = { label: string; polarity: "like" | "dislike" };
export type Observation = {
  id: string;
  category: InsightCategory;
  /** "You …", ≤ 60–70 chars; the app puts "I think" in front of a medium one */
  claim: string;
  evidence: InsightEvidence[];
  confidence: "high" | "medium";
  score: number;
  surprise: number;
  /** "I'll …" */
  use_in_call: string;
  chips?: InsightChip[];
  verdict: null | "right" | "not_me";
  correction?: string;
};
/** `basis` = ids of the observations it comes from */
export type InsightType = { name: string; line: string; signature: string[]; basis: string[] };
export type InsightMix = { id: string; left: string; right: string; position: number; evidence: InsightEvidence };
/** `evidence`: the quote or pick it comes from (one of its trait's receipts) — every one has it */
export type InsightStrength = { text: string; basis: string; evidence: InsightEvidence };
export type InsightWatchout = { text: string; fix: string; basis: string; evidence: InsightEvidence };
export type InsightChain = { you_are: string; so_you: string; so_ill: string };
export type InsightSettings = { why: string; energy: string; initiative: string; never: string };
export type InsightReport = {
  version: 1;
  headline: string;
  /** the key traits (3–5), each with evidence */
  observations: Observation[];
  /** 춘식이 r02 (Chelsea 03:57: an MBTI / 사주 style "whoa, that's you", every part grounded in kept observations) */
  type: InsightType | null;
  /** 0–3 "Options ←•→ One answer" rows, only from the user's own picks */
  mix: InsightMix[];
  strengths: InsightStrength[];
  watchouts: InsightWatchout[];
  /** YOU ARE → SO YOU → SO I'LL */
  chain: InsightChain | null;
  /** share card: title has "{name}" for the app to fill; lines = type.signature */
  share: { title: string; lines: string[] } | null;
  learning: Array<{ id: string; label: string }>;
  usage: string;
  /** the old SUM four lines (collapsed on SUM, and Settings); null until the setup answers came in */
  settings: InsightSettings | null;
  at: string;
  from: "import" | "skip" | "answers" | "card";
  ms?: number;
};
export type DeniedInsight = { id: string; claim: string; category: InsightCategory; correction?: string; at: string };
/** stored in the style card (user_styles.style_json.insights) */
export type StoredInsights = InsightReport & { denied?: DeniedInsight[] };

const MAX_LINES = 4;
const safe = (s: string) => s.replace(/[<>\n\r]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);

export function insightProfileLines(card: { insights?: StoredInsights }, env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.GENITA_INSIGHTS_PROFILE === "0" || !card.insights) return [];
  const kept = (card.insights.observations ?? []).slice(0, MAX_LINES).map((o) => `- ${safe(o.claim)} → ${safe(o.use_in_call)}`);
  const no = (card.insights.denied ?? []).slice(-3).map((d) => `- Not true about them: "${safe(d.claim)}"${d.correction ? `. They said: "${safe(d.correction)}"` : ""}`);
  return [...kept, ...no];
}
