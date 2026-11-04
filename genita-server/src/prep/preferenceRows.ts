/**
 * The six "Your preferences" rows (I04 / Settings → About you) from every source, not the import alone (Chelsea 11/4,
 * TF 331: after a ChatGPT import only 2 of 6 rows had a line, the rest said "Not enough information yet").
 *
 * Per row, in this order, up to 3 lines:
 *   1. the import's own row (toStyleCard display; a corrected card keeps its corrections)
 *   2. the import's other sections that speak to the row (thinking → Communication style, support → How Genita can
 *      help, approach → Response preferences) — only when the row is still empty
 *   3. the SUM insight report (R1) observations of the row's category, minus the ones the user took back
 *   4. the P answers (help, relationship, presence, challenge, pace, reach out, never) and the D01 depth
 * One slot is kept for 3–4 when they have a line: the survey beats the import (PRD F2b, the import prompt's last
 * line), so it always shows. Once the P flow is done (prefs saved) every row has at least one line.
 *
 * Read-only view: the stored card's `display` is never rewritten (corrections, HISY topics and toConfirm still see
 * what the import itself found). Pure — no I/O.
 */
import { isDislike, type DisplayItem, type DisplayRow, type StyleCard } from "./importProfile.ts";
import type { Depth, SetupAnswers } from "./personaCard.ts";
import type { InsightCategory, StoredInsights } from "../insights/profile.ts";

export type SavedPrefs = { depth: Depth; answers: SetupAnswers } | null | undefined;

type RowKey = "communication" | "response" | "help" | "interests" | "likes" | "boundaries";
const ROWS: Array<{ key: RowKey; title: string }> = [
  { key: "communication", title: "Communication style" },
  { key: "response", title: "Response preferences" },
  { key: "help", title: "How Genita can help" },
  { key: "interests", title: "Interests" },
  { key: "likes", title: "Likes & dislikes" },
  { key: "boundaries", title: "Boundaries" },
];
const ROW_MAX = 3;

/** import sections that may fill an empty row (never a row the import already filled) */
const IMPORT_FALLBACK: Partial<Record<RowKey, Array<keyof StyleCard["sections"]>>> = {
  communication: ["tendencies"],
  response: ["approach"],
  help: ["support"],
};

/** R1 insight categories per row */
const INSIGHT_ROW: Record<InsightCategory, RowKey> = {
  talk: "communication",
  humor: "communication",
  think: "communication",
  rhythm: "response",
  help: "help",
  interest: "interests",
  taste: "likes",
  boundary: "boundaries",
};

// P answer wording: about the user (the card rows describe them), from the Figma option subtitles
const HELP_LINE: Record<SetupAnswers["help"], string> = {
  "Think with me": "Thinking things through together: ideas, decisions and clarity.",
  "Keep me moving": "Keeping them moving: plans, focus and follow-through.",
  "Be there": "Being there: conversation and emotional support.",
  "Work beside me": "Working beside them: research, writing and admin.",
};
/** what the help pick says about what they are into, when nothing else does */
const HELP_INTEREST: Record<SetupAnswers["help"], string> = {
  "Think with me": "Talking through ideas and decisions.",
  "Keep me moving": "Plans, goals and getting things done.",
  "Be there": "Everyday life and how the day is going.",
  "Work beside me": "Research, writing and work in progress.",
};
const RELATIONSHIP_LINE: Record<SetupAnswers["relationship"], string> = {
  "Close companion": "A close companion: personal and emotionally present.",
  "Trusted partner": "A trusted partner: warm, capable and candid.",
  "Creative co-pilot": "A creative co-pilot: fast, surprising and playful.",
  "Quiet operator": "A quiet operator: brief, calm and mostly invisible.",
};
const RELATIONSHIP_REPLY: Record<SetupAnswers["relationship"], string> = {
  "Close companion": "Replies that feel personal and present.",
  "Trusted partner": "Replies that are warm, capable and candid.",
  "Creative co-pilot": "Replies that are quick, surprising and playful.",
  "Quiet operator": "Brief, calm replies that stay out of the way.",
};
/** 1 = Gentle … 5 = Direct */
const CHALLENGE_LINE = [
  "Gentle encouragement over pushback.",
  "Concerns raised softly, only when they matter.",
  "Support, with honesty when something looks off.",
  "Plain disagreement and why, said kindly.",
  "The blunt take first, no sugar-coating.",
];
/** 1 = Reflective … 5 = Quick */
const PACE_LINE = [
  "Slow, reflective conversations with room to think.",
  "An unhurried pace.",
  "An even conversational pace.",
  "Brisk replies that get to the point.",
  "Quick, punchy replies.",
];
/** 1 = Only when asked … 5 = Anticipate */
const REACH_LINE = [
  "Speak up only when asked.",
  "Rarely reach out first.",
  "Sometimes offer a next step.",
  "Often reach out with what comes next.",
  "Reach out first and anticipate what is needed.",
];
const NEVER_LINE: Record<NonNullable<SetupAnswers["never"]>[number], string> = {
  "Message anyone for me": "Never message anyone on their behalf.",
  "Use sensitive memories": "Leave sensitive memories alone unless they bring them up.",
  "Interrupt focus time": "Don't interrupt their focus time.",
  "Mirror my mood": "Stay steady instead of mirroring their mood.",
};
const DEPTH_LINE: Record<Depth, string> = {
  quick: "Likes to get going quickly and fill in the rest by talking.",
  right: "Wants it to feel right without a long setup.",
  deep: "Took the full setup: wants things tuned closely.",
};
/** Boundaries when the depth never asked (Quick / Make it feel right): what Genita does for everyone, said plainly */
const BOUNDARY_DEFAULT = "No messages or actions without their approval.";

const lower = (s: string) => s.toLowerCase();
const presenceLine = (p: SetupAnswers["presence"]) =>
  p.length ? `A ${p.map(lower).join(" and ")} presence.` : "";

/** The P answers' lines per row (empty when the P flow wasn't finished). */
export function setupLines(prefs: SavedPrefs): Record<RowKey, string[]> {
  const out: Record<RowKey, string[]> = { communication: [], response: [], help: [], interests: [], likes: [], boundaries: [] };
  if (!prefs?.answers) return out;
  const a = prefs.answers;
  const at = <T>(list: T[], v: number | undefined) => (Number.isInteger(v) && v! >= 1 && v! <= list.length ? list[v! - 1] : undefined);
  const push = (k: RowKey, s: string | undefined) => { if (s) out[k].push(s); };
  push("communication", presenceLine(Array.isArray(a.presence) ? a.presence : []));
  push("communication", at(PACE_LINE, a.pace));
  push("response", at(CHALLENGE_LINE, a.challenge));
  push("response", RELATIONSHIP_REPLY[a.relationship]);
  push("help", HELP_LINE[a.help]);
  push("interests", HELP_INTEREST[a.help]);
  push("likes", RELATIONSHIP_LINE[a.relationship]);
  for (const n of Array.isArray(a.never) ? a.never : []) push("boundaries", NEVER_LINE[n]);
  push("boundaries", at(REACH_LINE, a.reachOut));
  if (!out.boundaries.length) push("boundaries", BOUNDARY_DEFAULT);
  if (prefs.depth && DEPTH_LINE[prefs.depth]) push("response", DEPTH_LINE[prefs.depth]);
  return out;
}

/** R1 observations per row, without the ones the user took back ("That's not me"). */
export function insightLines(insights: StoredInsights | undefined): Record<RowKey, string[]> {
  const out: Record<RowKey, string[]> = { communication: [], response: [], help: [], interests: [], likes: [], boundaries: [] };
  if (!insights) return out;
  const denied = new Set((insights.denied ?? []).map((d) => d.id));
  const deniedClaims = new Set((insights.denied ?? []).map((d) => lower(d.claim ?? "")));
  for (const o of insights.observations ?? []) {
    if (!o?.claim || o.verdict === "not_me" || denied.has(o.id) || deniedClaims.has(lower(o.claim))) continue;
    const k = INSIGHT_ROW[o.category];
    if (k) out[k].push(o.claim.replace(/\s+/g, " ").trim().slice(0, 160));
  }
  return out;
}

/**
 * The six rows from all sources. `card` may be null (no import, no N1–N3 yet): the rows then come from R1 / P alone.
 * Rows keep the import's keys and titles so the app's decoder and row order stay as they are.
 */
export function preferenceRows(card: StyleCard | null | undefined, prefs?: SavedPrefs): DisplayRow[] {
  const fromSetup = setupLines(prefs);
  const fromInsights = insightLines(card?.insights);
  const sections = card?.sections;
  const norm = (t: string) => lower(t).replace(/[.\s]+$/, "").trim();
  // lines the user took out (saved corrections and ones still being applied) never come back through a fallback or R1
  const gone = new Set([...(card?.removed ?? []).map((r) => r.text), ...(card?.pendingCorrections ?? []).flatMap((p) => p.items)].map(norm));
  const kept = (t: string) => !!t && !gone.has(norm(t));
  return ROWS.map(({ key, title }) => {
    const own = card?.display?.find((r) => r.key === key);
    const imported: DisplayItem[] = (own?.items ?? []).filter((i) => i?.text && !/^not enough information/i.test(i.text));
    if (!imported.length && sections) {
      for (const s of IMPORT_FALLBACK[key] ?? []) {
        const list = Array.isArray(sections[s]) ? sections[s] : [];
        for (const f of list) if (f?.text && kept(f.text)) imported.push({ text: f.text, label: s === "approach" ? "suggested" : f.label });
      }
    }
    const r1: DisplayItem[] = fromInsights[key].filter(kept).map((text) => ({ text, label: "observed" as const }));
    const answers: DisplayItem[] = fromSetup[key].map((text) => ({ text, label: "explicit" as const }));
    const seen = new Set<string>();
    const all = [...imported, ...r1, ...answers].filter((i) => {
      const k = norm(i.text);
      return k && !seen.has(k) && (seen.add(k), true);
    });
    let items = all.slice(0, ROW_MAX);
    // reserved slots (Codex P2): one for the P answers (the survey beats the import), and on Likes & dislikes one for
    // a dislike (toStyleCard's rule) — each takes the last slot not already reserved
    const reserve = (pick: DisplayItem | undefined, protect: Set<DisplayItem>) => {
      if (!pick || items.includes(pick)) return;
      for (let i = items.length - 1; i >= 0; i--) if (!protect.has(items[i])) { items = [...items.slice(0, i), ...items.slice(i + 1), pick]; return; }
    };
    const answer = all.find((i) => answers.some((a) => a.text === i.text));
    const dislike = key === "likes" ? all.find((i) => imported.includes(i) && isDislike(i.text)) : undefined;
    reserve(answer, new Set(dislike && items.includes(dislike) ? [dislike] : []));
    reserve(dislike, new Set(answer ? [answer] : []));
    return { key: own?.key ?? key, title: own?.title ?? title, items };
  });
}

/** The card as the app sees it: `display` (and `partial`) from all sources. The stored card is not changed. */
export function withPreferenceRows<T extends StyleCard>(card: T, prefs?: SavedPrefs): T {
  const display = preferenceRows(card, prefs);
  return { ...card, display, partial: display.some((r) => r.items.length === 0) };
}
