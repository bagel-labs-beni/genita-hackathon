/**
 * The Spark perceive step (PERC-1): one face crop → one strict JSON read. Pure: builds the request and
 * parses/sanitizes the reply; controller.ts does the I/O. The prompt asks for momentary, visible state only.
 */
import type { SparkRequest } from "../meta/spark.ts";
import { EXPRESSIONS, GAZES, type Expression, type Gaze, type PerceptionSample } from "./types.ts";

export const PERCEPTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["expression", "intensity", "gaze", "engagement", "notable", "confidence"],
  properties: {
    expression: { type: "string", enum: [...EXPRESSIONS] },
    intensity: { type: "number" },
    gaze: { type: "string", enum: [...GAZES] },
    engagement: { type: "number" },
    notable: { type: ["string", "null"] },
    confidence: { type: "number" },
  },
} as const;

const INSTRUCTIONS = [
  "You read one frame from the user's front camera during a live video call (usually their face, maybe more of the room), so a companion can react like a friend across the table.",
  "Describe only the momentary, visible expression and where the eyes point. Never describe appearance, clothing or body, and never guess identity, age, gender, ethnicity or health.",
  "expression: smile, laugh (open mouth, clearly laughing), neutral, frown (brows lowered and pulled together: annoyed, displeased or skeptical), surprised, confused (puzzled or unsure: brows knit or one brow raised, squint, head tilt), tired (heavy eyelids, yawning, drooping), sad (sorrowful: mouth corners down, glassy eyes), focused (concentrating, reading).",
  "A raised or uneven brow, a squint, a head tilt or a mouth pulled to one side is confused, not sad; use sad only for sorrow (downcast eyes, near tears).",
  "intensity: 0 to 1, how strong the expression is.",
  "gaze: at_screen (looking at the camera or the screen next to it; eyes a little lowered toward the screen is still at_screen), away (head or eyes turned to the side), down (clearly looking down at something below: a phone, desk or lap).",
  "engagement: 0 to 1, how much they seem to be paying attention to the call. The camera sits just above the screen: eyes on the screen (even a little lowered, reading or listening) is engaged; low is for looking off at something else, a phone, or drifting off.",
  "notable: a 1 to 4 word visible action (yawning, nodding, rubbing eyes, looking at phone) or null.",
  "confidence: 0 to 1 for the expression. No face visible: neutral with confidence 0.",
].join("\n");

export function buildPerceiveRequest(imageUrl: string): SparkRequest {
  return {
    instructions: INSTRUCTIONS,
    input: [{ role: "user", content: [{ type: "input_text", text: "The user's face now." }, { type: "input_image", image_url: imageUrl }] }],
    effort: "minimal",
    // reasoning counts toward the cap (watch/memo.ts: 300 ended "incomplete" with no text)
    maxOutputTokens: 1200,
    text: { format: { type: "json_schema", name: "face_read", schema: PERCEPTION_SCHEMA, strict: true } },
  };
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? clamp01(v) : null);

/**
 * Words that make a `notable` about who the user is or how they look rather than what they're doing.
 * Whole words; a trailing * means "starts with".
 */
const BANNED = [
  "hair*", "bald", "beard*", "mustache*", "moustache*", "shirt*", "dress*", "wear*", "cloth*", "outfit*", "jacket*", "hat",
  "hoodie*", "glasses", "makeup", "lipstick", "tattoo*", "pierc*", "jewel*", "earring*", "skin*", "complexion", "freckle*",
  "wrinkle*", "weight", "overweight", "underweight", "thin", "fat", "skinny", "slim", "body", "chest", "figure", "breast*",
  "pretty", "beautiful", "handsome", "ugly", "attractive", "cute", "hot", "sexy", "gorgeous", "age", "aged", "old", "older",
  "young*", "year*", "child*", "kid*", "teen*", "baby", "minor", "woman", "women", "man", "men", "girl*", "boy*", "male",
  "female", "lady", "guy", "gender*", "asian", "black", "white", "brown", "latin*", "hispanic", "african", "european",
  "indian", "arab*", "korean", "chinese", "japanese", "race", "racial", "ethnic*", "resembl*", "celebrit*", "famous",
  "sick*", "ill", "illness", "disease*", "depress*", "anxi*", "adhd", "autis*", "disorder*", "diagnos*", "pregnan*",
  "disab*", "injur*", "medic*", "symptom*", "drunk", "high",
];
const BANNED_RE = new RegExp(`\\b(?:${BANNED.map((w) => (w.endsWith("*") ? `${w.slice(0, -1)}\\w*` : `${w}\\b`)).join("|")})|\\blooks? like\\b`, "i");

/** Keep a short visible action; drop anything about appearance, body, identity, age, ethnicity or health. */
export function safeNotable(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  if (!t || t.split(" ").length > 8 || t.length > 60) return null;
  if (BANNED_RE.test(t)) return null;
  return t;
}

export function parseSample(raw: string): PerceptionSample | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const expression = EXPRESSIONS.find((x) => x === o.expression) as Expression | undefined;
  const gaze = GAZES.find((x) => x === o.gaze) as Gaze | undefined;
  const intensity = num(o.intensity);
  const engagement = num(o.engagement);
  const confidence = num(o.confidence);
  if (!expression || !gaze || intensity === null || engagement === null || confidence === null) return null;
  return { expression, intensity, gaze, engagement, notable: safeNotable(o.notable), confidence };
}
