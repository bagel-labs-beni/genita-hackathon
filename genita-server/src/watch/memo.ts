/**
 * Story memo (F5-L9) and the watch context added to a question. Pure: builds
 * Spark requests and parses replies; watch.ts does the I/O.
 *
 * Content-agnostic (Chelsea 10/31): the same prompt for a show, a game, a
 * document or a shopping page. Prompts stay short — every extra rule makes
 * Spark reason longer even at effort "minimal" (see prompt/persona.ts).
 */
import type { ContentPart, InputMessage, SparkRequest } from "../meta/spark.ts";
import type { Moment } from "./rules.ts";

export type MemoEntry = { at: number; text: string };
export type DialogueLine = { at: number; label: string | null; text: string };
export type MemoVerdict = { memo: string; moment: Moment; reaction: string; speakers: { label: string; name: string }[]; protectedVideo?: boolean; talkOver?: boolean };

export const MEMO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  // order matters: the verdict (protectedVideo, moment, reaction) streams first, so a reaction can start before the
  // memo text is written (watch.ts earlyVerdict)
  required: ["protectedVideo", "moment", "reaction", "talkOver", "memo", "speakers"],
  properties: {
    protectedVideo: { type: "boolean" },
    moment: { type: "string", enum: ["none", "funny", "surprising", "sweet"] },
    reaction: { type: "string" },
    talkOver: { type: "boolean" },
    memo: { type: "string" },
    speakers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "name"],
        properties: { label: { type: "string" }, name: { type: "string" } },
      },
    },
  },
} as const;

export function speakerTag(line: DialogueLine, names: Map<string, string>): string {
  if (!line.label) return "";
  const n = names.get(line.label);
  return n ? `${n} (voice ${line.label})` : `voice ${line.label}`;
}

function dialogueText(lines: DialogueLine[], names: Map<string, string>): string {
  return lines.map((l) => `- ${speakerTag(l, names) || "someone"}: "${l.text}"`).join("\n");
}

export type MemoInput = {
  companion: { name: string; traits: string[] };
  source: string | null;
  memo: MemoEntry[];
  lines: DialogueLine[];
  names: Map<string, string>;
  frames: string[];
  blank: boolean;
};

export function buildMemoRequest(m: MemoInput): SparkRequest {
  const who = m.companion.traits.length ? `${m.companion.name} (${m.companion.traits.slice(0, 4).join(", ")})` : m.companion.name;
  const instructions = [
    `You keep a running memo while ${who} watches the user's shared screen with them. It can be anything: a show, a game, a website, a document.`,
    "memo: one or two short lines on what is NEW in these frames and lines (who or what is on screen, what happened, what was said). Don't repeat the memo so far. If the frames are black, write \"Screen is black.\"",
    "The frames are a short sequence since the last memo (0.6–1 s apart), oldest first: read the motion across them — a dance move, a fall, a reveal, a cut to someone laughing or reacting — and any on-screen text (captions, a punchline).",
    `moment: funny, surprising or sweet only if something new here would make a friend watching react out loud right now; otherwise none (most of the time, and always for documents, code, menus or browsing). funny = a punchline, a fail, people on screen cracking up. surprising = a reveal, or something impressive: a dunk, a trick landed, a big dance move. sweet = a tender moment.`,
    `reaction: if moment is not none, the 2 to 8 words ${m.companion.name} blurts out about that exact thing, casual English, no question. Otherwise empty.`,
    "speakers: for each voice label in the new lines, a short name from what you see (\"the chef\", \"the woman in green\") only if you are sure; skip the rest.",
    "protectedVideo: true only if a video player's picture is solid black while the page or app around it shows (protected streaming like Netflix captures black); then memo says so, moment none.",
    "talkOver: true if the screen's sound is crowd noise, music, sports commentary or narration (fine to react over); false if people on screen are talking to each other.",
    "Never name a real person from their face.",
  ].join("\n");
  const parts: ContentPart[] = [];
  const text = [
    m.source ? `Shared: ${m.source}.` : "",
    m.memo.length ? `Memo so far:\n${m.memo.map((e) => `- ${e.text}`).join("\n")}` : "Memo so far: (start)",
    m.lines.length ? `New lines heard from the screen:\n${dialogueText(m.lines, m.names)}` : "No new lines heard.",
    m.blank ? "The new frames are black (the app could not capture them)." : `New frames, oldest first: ${m.frames.length}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  parts.push({ type: "input_text", text });
  if (!m.blank) for (const f of m.frames) parts.push({ type: "input_image", image_url: f });
  const input: InputMessage[] = [{ role: "user", content: parts }];
  return {
    instructions,
    input,
    effort: "minimal",
    // reasoning counts toward the cap: 300 ended "incomplete" with no text (11/2)
    maxOutputTokens: 2000,
    text: { format: { type: "json_schema", name: "watch_memo", schema: MEMO_SCHEMA, strict: true } },
  };
}

/**
 * The reaction part of a memo still streaming: moment + the finished reaction string (protectedVideo false).
 * null until both are complete, or when there is nothing to react to.
 */
// ───────────────────────── quick look (11/3: visual moments ≤5 s) ─────────────────────────

/** A motion spike's own tiny Spark call: is this react-worthy, right now? Short prompt, 3 frames, tiny JSON. */
export const QUICK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["react", "moment", "line", "talkOver"],
  properties: {
    react: { type: "boolean" },
    moment: { type: "string", enum: ["none", "funny", "surprising", "sweet"] },
    line: { type: "string" },
    talkOver: { type: "boolean" },
  },
} as const;

export type QuickVerdict = { moment: Exclude<Moment, "none">; line: string; talkOver: boolean };

export function buildQuickRequest(q: { companion: { name: string }; frames: string[]; heard: string[] }): SparkRequest {
  const instructions = [
    `${q.companion.name} watches a video with a friend. These frames are the last ~1 s, oldest first.`,
    "react: true only if something a friend would blurt about just happened here: a dunk, a trick landed, a fall, a big dance move, a reveal, a punchline, people cracking up.",
    "moment: funny, surprising or sweet (none if react is false). line: 2 to 6 casual words about exactly that, no question, no names.",
    "talkOver: true if the sound is crowd noise, music, sports commentary or narration; false if people on screen are talking to each other.",
  ].join("\n");
  const parts: ContentPart[] = [{ type: "input_text", text: q.heard.length ? `Heard just now: ${q.heard.map((h) => `"${h}"`).join(" ")}` : "Nothing heard just now." }];
  for (const f of q.frames) parts.push({ type: "input_image", image_url: f });
  return {
    instructions,
    input: [{ role: "user", content: parts }],
    effort: "minimal",
    maxOutputTokens: 600,
    text: { format: { type: "json_schema", name: "watch_quick", schema: QUICK_SCHEMA, strict: true } },
  };
}

export function parseQuick(raw: string): QuickVerdict | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    const moment = (["funny", "surprising", "sweet"] as const).find((x) => x === o.moment);
    const line = typeof o.line === "string" ? o.line.trim().slice(0, 80) : "";
    if (o.react !== true || !moment || !line) return null;
    return { moment, line, talkOver: o.talkOver === true };
  } catch {
    return null;
  }
}

export function earlyVerdict(raw: string): { moment: Exclude<Moment, "none">; reaction: string; talkOver: boolean } | null {
  if (/"protectedVideo"\s*:\s*true/.test(raw)) return null;
  if (!/"protectedVideo"\s*:\s*false/.test(raw)) return null;
  const m = raw.match(/"moment"\s*:\s*"(funny|surprising|sweet)"/);
  const r = raw.match(/"reaction"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const t = raw.match(/"talkOver"\s*:\s*(true|false)/);
  if (!m || !r || !t) return null;
  let reaction: string;
  try { reaction = JSON.parse(`"${r[1]}"`) as string; } catch { return null; }
  reaction = reaction.trim().slice(0, 120);
  return reaction ? { moment: m[1] as Exclude<Moment, "none">, reaction, talkOver: t[1] === "true" } : null;
}

export function parseMemoVerdict(raw: string): MemoVerdict | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    const moment = (["none", "funny", "surprising", "sweet"] as const).find((x) => x === o.moment) ?? "none";
    const speakers = Array.isArray(o.speakers)
      ? o.speakers
          .map((s) => s as Record<string, unknown>)
          .filter((s) => typeof s.label === "string" && typeof s.name === "string" && s.name.trim())
          .map((s) => ({ label: String(s.label).replace(/^voice\s+/i, "").trim().slice(0, 8), name: String(s.name).trim().slice(0, 40) }))
      : [];
    return {
      memo: typeof o.memo === "string" ? o.memo.trim().slice(0, 300) : "",
      moment,
      reaction: typeof o.reaction === "string" ? o.reaction.trim().slice(0, 120) : "",
      speakers,
      protectedVideo: o.protectedVideo === true,
      talkOver: o.talkOver === true,
    };
  } catch {
    return null;
  }
}

export type QuestionContext = { instructions: string; images: string[] };

/**
 * Realtime reactions to someone on screen (11/3, Chelsea: "Oh, it's Karina!" → "Karina's outfit is so pretty").
 * Policy: no face-based identity recognition of real people. The user's own naming is taken as given; the reply
 * is grounded only in what is visible right now (outfit, setting, action).
 */
export const NAMING_RULE =
  "If the user names someone on screen (\"oh, it's Karina!\"), react like a friend watching with them: use the name they gave and add one specific thing you can see on that person in the last image right now — what they're wearing, where they are, what they're doing. " +
  "Never say who anyone is from their face or looks, never confirm or deny it, and add no facts about a real person (group, age, news) that you didn't see or hear. " +
  "If they name someone and no person is visible in the last image, say you can't spot them right now.";

/**
 * Added to the companion's instructions when the user asks something while
 * sharing: the memo, the latest lines heard and the latest frames. A black
 * screen sends no frames and says so — never guess what can't be seen (MS-3).
 */
export function buildQuestionContext(c: {
  source: string | null;
  memo: MemoEntry[];
  lines: DialogueLine[];
  names: Map<string, string>;
  frames: string[];
  blank: boolean;
}): QuestionContext {
  const out = [`You and the user are watching their shared screen together${c.source ? ` (${c.source})` : ""}.`];
  if (c.memo.length) out.push(`What you've seen so far, oldest first:\n${c.memo.map((e) => `- ${e.text}`).join("\n")}`);
  if (c.lines.length) out.push(`Lines just heard from the screen, oldest first:\n${dialogueText(c.lines, c.names)}`);
  if (c.blank) {
    out.push("The shared screen shows up black to you right now (some apps block capture). You can't see it: say so and don't guess what's on it.");
    return { instructions: out.join("\n"), images: [] };
  }
  if (c.frames.length) out.push(`The attached images are the shared screen over the last second or two, oldest first; the last one is the screen right now. For "what did they say", use the lines heard.`);
  if (c.frames.length) out.push("If a video's picture is solid black there (protected streaming like Netflix shows black to screen capture), say you can't see that one and never guess what's in it.");
  out.push("If the user asks about it, answer in one short sentence with only what you saw or heard; add nothing you didn't see.");
  if (c.frames.length) out.push(NAMING_RULE);
  return { instructions: out.join("\n"), images: c.frames };
}
