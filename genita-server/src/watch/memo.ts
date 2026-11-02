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
export type MemoVerdict = { memo: string; moment: Moment; reaction: string; speakers: { label: string; name: string }[] };

export const MEMO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["memo", "moment", "reaction", "speakers"],
  properties: {
    memo: { type: "string" },
    moment: { type: "string", enum: ["none", "funny", "surprising", "sweet"] },
    reaction: { type: "string" },
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
    `moment: funny, surprising or sweet only if something new here would make a friend watching react out loud right now; otherwise none (most of the time, and always for documents, code, menus or browsing).`,
    `reaction: if moment is not none, the 2 to 8 words ${m.companion.name} blurts out about that exact thing, casual English, no question. Otherwise empty.`,
    "speakers: for each voice label in the new lines, a short name from what you see (\"the chef\", \"the woman in green\") only if you are sure; skip the rest.",
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
    };
  } catch {
    return null;
  }
}

export type QuestionContext = { instructions: string; images: string[] };

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
  if (c.frames.length) out.push(`The attached images are the latest screen frames, oldest first. For "what did they say", use the lines heard.`);
  out.push("If the user asks about it, answer in one short sentence with only what you saw or heard; add nothing you didn't see.");
  return { instructions: out.join("\n"), images: c.frames };
}
