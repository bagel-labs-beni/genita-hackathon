/**
 * Profile updates after the import: corrections (HISY sheet, said in a call),
 * answers to the first calls' questions, and patterns from a call.
 *
 * Rules (same evidence rules as prompt v3):
 *   - corrections and answers are `explicit`; a call pattern is `observed`
 *     (only when it repeated); nothing here is ever `suggested`.
 *   - newer wins: the new line goes first in its section; lines it names in
 *     `replaces` (must match a stored line) and lines that say the opposite
 *     about the same thing are removed.
 *   - an observed pattern never overrides or removes an explicit line.
 *   - the same injection/sensitive filters as the import; the six I04 rows,
 *     `partial` and the counts are rebuilt from the sections.
 *   - an answered still-to-confirm item leaves the list; for a skip user an
 *     I04 row that is no longer empty leaves it too.
 */
import { isDislike, looksLikeInjection, redactSensitive, toStyleCard, type Finding, type ImportRaw, type StyleCard } from "../prep/importProfile.ts";
import { cardsForField, type StoryId } from "./story.ts";

export const PROFILE_FIELDS = ["likes", "interests", "communication", "response", "help", "boundaries", "support", "tendencies"] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

export type ProfileUpdate = {
  field: ProfileField;
  text: string;
  /** stored lines this one replaces (exact text; anything else is ignored) */
  replaces: string[];
  label: "explicit" | "observed";
  /** a still-to-confirm item this answers */
  answers?: string;
  /** short "Updated: …" chip text (calls) */
  chip?: string;
};
export type AppliedUpdate = { field: ProfileField; text: string; label: "explicit" | "observed"; removed: string[]; chip?: string };

const SECTION_MAX = 12;
const STOP = new Set(
  "a an the and or but of to in on at for with from by as is are was were be been it its this that these those my me i you your very really so too more less much many any some no not now anymore any more just also than then them they their likes like loves love dislikes dislike prefers prefer hates hate avoids avoid wants want enjoys enjoy into fan food foods things stuff style".split(" "),
);
const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 2 && !STOP.has(w)));
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[.!]+$/, "").trim();

/** Opposite polarity about (mostly) the same thing: "Loves very spicy food." vs "Dislikes very spicy food now." */
export function contradicts(a: string, b: string): boolean {
  if (isDislike(a) === isDislike(b)) return false;
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size) >= 0.5;
}

function safe(text: string): boolean {
  return !!text && !looksLikeInjection(text) && redactSensitive(text) === text && !/\[(?:email|link|number|phone|secret)\]/.test(text);
}

export function mergeUpdates(card: StyleCard, updates: ProfileUpdate[], at: string): { card: StyleCard; applied: AppliedUpdate[]; staleCards: StoryId[] } {
  const sections = Object.fromEntries(Object.entries(card.sections).map(([k, v]) => [k, (v as Finding[]).map((x) => ({ ...x }))])) as StyleCard["sections"];
  let toConfirm = [...(card.toConfirm ?? [])];
  const applied: AppliedUpdate[] = [];
  const stale = new Set<StoryId>();
  for (const u of updates) {
    if (!u || !PROFILE_FIELDS.includes(u.field) || (u.label !== "explicit" && u.label !== "observed")) continue;
    const text = typeof u.text === "string" ? u.text.replace(/\s+/g, " ").trim().slice(0, 160) : "";
    if (!safe(text)) continue;
    const list = sections[u.field];
    const replaces = new Set((Array.isArray(u.replaces) ? u.replaces : []).filter((r) => typeof r === "string").map(norm));
    const same = list.find((x) => norm(x.text) === norm(text));
    const removed: string[] = [];
    // an observed pattern can't touch what the user said
    const target = (x: Finding) => x !== same && (replaces.has(norm(x.text)) || contradicts(x.text, text));
    if (u.label === "observed" && list.some((x) => x.label === "explicit" && target(x))) continue;
    for (let i = list.length - 1; i >= 0; i--) if (target(list[i])) removed.unshift(list.splice(i, 1)[0].text);
    if (same) list.splice(list.indexOf(same), 1);
    const label = same?.label === "explicit" ? "explicit" : u.label;
    list.unshift({ text, label, scope: same?.scope ?? "any", at });
    while (list.length > SECTION_MAX) {
      const drop = [...list].reverse().find((x) => x.label !== "explicit") ?? list[list.length - 1];
      list.splice(list.lastIndexOf(drop), 1);
    }
    if (u.answers) toConfirm = toConfirm.filter((t) => norm(t) !== norm(u.answers!));
    for (const id of cardsForField(u.field)) stale.add(id);
    applied.push({ field: u.field, text, label, removed, ...(u.chip ? { chip: u.chip } : {}) });
  }
  if (!applied.length) return { card, applied, staleCards: [] };
  const raw: ImportRaw = { sections, rules: card.rules ?? [], to_confirm: [] };
  const next = toStyleCard(raw, card.source);
  // toStyleCard reads at most 4 (the import's cap); keep the list as it is
  next.toConfirm = toConfirm;
  if (card.source === "skip") {
    const filled = new Set(next.display.filter((r) => r.items.length).map((r) => r.title.toLowerCase()));
    next.toConfirm = next.toConfirm.filter((t) => !filled.has(t.toLowerCase()));
  }
  next.dropped = card.dropped;
  if (card.growth) next.growth = card.growth;
  if (card.story) next.story = { ...card.story, stale: [...new Set([...(card.story.stale ?? []), ...stale])] };
  next.updatedAt = at;
  return { card: next, applied, staleCards: [...stale] };
}
