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
import { isSensitiveDetail } from "./sensitive.ts";
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
  /** when the user said it (ISO). A line saved after this wins: the update can't remove or contradict it */
  asOf?: string;
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
  // the same thing: every content word of the shorter line is in the longer one ("spicy noodles" ≠ "spicy curry")
  const [small, big] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  for (const w of small) if (!big.has(w)) return false;
  return true;
}

function safe(text: string): boolean {
  return !!text && !looksLikeInjection(text) && !isSensitiveDetail(text) && redactSensitive(text) === text && !/\[(?:email|link|number|phone|secret)\]/.test(text);
}

/**
 * A shopping price range is a taste (Chelsea 11/3): it always lands in likes as one "Budget: …" line, never in
 * interests or elsewhere (QA K-test P3: "Interests: Prefers clothes usually under $100" next to the Taste line).
 */
const PRICE = /(?:[$€£₩¥]\s?\d|\d+\s?(?:dollars|bucks|usd|eur|euros|won|krw)\b)/i;
const SHOPPING = /\b(?:budget|spend\w*|price\w*|under|below|less than|max(?:imum)?|clothes|clothing|outfits?|shoes|shopping|buy\w*)\b/i;
export function asBudget(u: ProfileUpdate): ProfileUpdate {
  // a spending rule ("ask before buying anything over $100") is a boundary, not a taste (Codex P2)
  if (!u.text || !PRICE.test(u.text) || !SHOPPING.test(u.text) || u.field === "boundaries" || /\b(?:ask|before|approv\w*|confirm|permission|without)\b/i.test(u.text)) return u;
  if (u.field === "likes" && /^\s*budget:/i.test(u.text)) return u;
  const body = u.text.replace(/^\s*(?:budget|prefers?|likes?|usually|tends to)\s*:?\s*/i, "").replace(/^(?:clothes|clothing)\s+/i, "");
  return { ...u, field: "likes", text: `Budget: ${body[0].toLowerCase()}${body.slice(1)}` };
}

export function mergeUpdates(card: StyleCard, updates: ProfileUpdate[], at: string): { card: StyleCard; applied: AppliedUpdate[]; staleCards: StoryId[] } {
  const sections = Object.fromEntries(Object.entries(card.sections).map(([k, v]) => [k, (v as Finding[]).map((x) => ({ ...x }))])) as StyleCard["sections"];
  let toConfirm = [...(card.toConfirm ?? [])];
  const applied: AppliedUpdate[] = [];
  const stale = new Set<StoryId>();
  // what was removed and when: an older analysis can't bring it back (Codex round 2)
  // only removals from before this batch guard it: one correction's own replace must not block its own rewrite (Codex round 4)
  const priorTombs = [...(card.removed ?? [])];
  const tombs = [...priorTombs];
  for (const raw of updates) {
    const u = raw ? asBudget(raw) : raw;
    if (!u || !PROFILE_FIELDS.includes(u.field) || (u.label !== "explicit" && u.label !== "observed")) continue;
    // said before the current profile was imported: belongs to an older profile
    if (u.asOf && card.importedAt && card.importedAt > u.asOf) continue;
    const text = typeof u.text === "string" ? u.text.replace(/\s+/g, " ").trim().slice(0, 160) : "";
    const list = sections[u.field];
    const replaces = new Set((Array.isArray(u.replaces) ? u.replaces : []).filter((r) => typeof r === "string").map(norm));
    if (!text && u.label === "explicit" && replaces.size) {
      // removal only (profile screen: "That's fine with me" on a boundary)
      const removed: string[] = [];
      for (const key of PROFILE_FIELDS) {
        const l = sections[key];
        // a slow removal can't take out a line (re)saved after the user asked for it (Codex round 3)
        for (let i = l.length - 1; i >= 0; i--) if (replaces.has(norm(l[i].text)) && !(u.asOf && l[i].at && l[i].at! > u.asOf)) { removed.unshift(l.splice(i, 1)[0].text); for (const id of cardsForField(key)) stale.add(id); tombs.push({ text: removed[0], at: u.asOf ?? at, field: key }); }
      }
      if (removed.length) applied.push({ field: u.field, text: "", label: "explicit", removed, ...(u.chip ? { chip: u.chip } : {}) });
      continue;
    }
    if (!safe(text)) continue;
    const same = list.find((x) => norm(x.text) === norm(text));
    const removed: string[] = [];
    // an observed pattern can't touch what the user said
    const target = (x: Finding) => x !== same && (replaces.has(norm(x.text)) || contradicts(x.text, text));
    if (u.label === "observed" && list.some((x) => x.label === "explicit" && target(x))) continue;
    // newer wins by when it was said: a late call analysis can't undo a correction saved after that call started
    if (u.asOf && list.some((x) => target(x) && x.at && x.at > u.asOf!)) continue;
    // …nor bring back (or contradict) a line the user removed after it
    // (any wording: once the user removed something from a field, older analyses of that field are dropped — Codex round 3)
    if (u.asOf && text && priorTombs.some((t) => t.at > u.asOf! && (t.field === u.field || norm(t.text) === norm(text) || contradicts(t.text, text)))) continue;
    for (let i = list.length - 1; i >= 0; i--) if (target(list[i])) removed.unshift(list.splice(i, 1)[0].text);
    for (const r of removed) tombs.push({ text: r, at: u.asOf ?? at, field: u.field });
    if (same) list.splice(list.indexOf(same), 1);
    const label = same?.label === "explicit" ? "explicit" : u.label;
    // `at` = when the user said it (order of what they said, not of when Spark finished) — Codex round 4
    list.unshift({ text, label, scope: same?.scope ?? "any", at: u.asOf ?? at });
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
  if (card.importedAt) next.importedAt = card.importedAt;
  if (tombs.length) next.removed = tombs.slice(-40);
  if (card.story) next.story = { ...card.story, stale: [...new Set([...(card.story.stale ?? []), ...stale])] };
  next.updatedAt = at;
  return { card: next, applied, staleCards: [...stale] };
}
