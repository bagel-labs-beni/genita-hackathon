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
  /**
   * AU-91 (11/4): the profile lines this observation was built from, linked when the report was saved (section + the
   * line's text then; `item` = one item of a list line). "That's not me" removes only these. Missing on reports saved
   * before → the older text matching (findingsBehind).
   */
  sources?: Array<{ section: string; text: string; item?: string }>;
  /** the profile lines Spark said it stood on (numbered input lines) — turned into `sources` when saved, not kept */
  basis?: string[];
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
  /** the setup answers are in (settings + mix) and Spark is rewriting the traits with them (the app shows "Adding your answers…") */
  refreshing?: boolean;
};
export type DeniedInsight = { id: string; claim: string; category: InsightCategory; correction?: string; at: string;
  /** the picks / list items it stood on (AU-91): a later report can't build on them again */
  picks?: string[]; items?: string[];
  /** per paste quote it stood on: quoteWords() hashes of its content words (never the words) */
  quotes?: string[][] };
/** stored in the style card (user_styles.style_json.insights) */
export type StoredInsights = InsightReport & { denied?: DeniedInsight[] };

const MAX_LINES = 4;
const safe = (s: string) => s.replace(/[<>\n\r]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);

const STOP = new Set("the and you your with for that this from into like likes love loves about very really our their them they just also".split(" "));
const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 4)));
/** a trait that rests on a line the user took out (marked "That's not me", corrected, still pending) */
function restsOn(o: Observation, gone: string[]): boolean {
  if (!gone.length) return false;
  const own = [o.claim, ...o.evidence.map((e) => e.quote), ...(o.chips ?? []).map((c) => c.label)].map(words);
  return gone.some((g) => {
    const gw = words(g);
    if (!gw.size) return false;
    return own.some((w) => {
      const hits = [...w].filter((x) => gw.has(x)).length;
      return hits > 0 && hits >= Math.min(2, w.size, gw.size);
    });
  });
}

export function insightProfileLines(card: { insights?: StoredInsights; removed?: Array<{ text: string }>; pendingCorrections?: Array<{ items: string[] }> }, env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.GENITA_INSIGHTS_PROFILE === "0" || !card.insights) return [];
  // lines the user took out — saved or still being applied — take the traits built on them out of the call (design-lane Codex P2)
  const gone = [...(card.removed ?? []).map((r) => r.text), ...(card.pendingCorrections ?? []).flatMap((p) => p.items)].slice(-40);
  const kept = (card.insights.observations ?? []).filter((o) => !restsOn(o, gone)).slice(0, MAX_LINES).map((o) => `- ${safe(o.claim)} → ${safe(o.use_in_call)}`);
  // what they took back is never quoted to the call (AU-91: "Not true about them: …" brought the topic back); their own
  // words of what IS right still go in, without the claim
  const said = (card.insights.denied ?? []).slice(-3).filter((d) => d.correction).map((d) => `- They told you: "${safe(d.correction!)}"`);
  return [...kept, ...said];
}
