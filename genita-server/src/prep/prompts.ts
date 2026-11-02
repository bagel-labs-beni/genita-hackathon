/**
 * Genita companion preparation: image edits and quiet listening loops.
 * Each loop keeps the supplied appearance and framing stable so emotion clips
 * can alternate during a call. Prompt fields must fit the provider's limit.
 */
export type CompanionKind = "human" | "animal" | "character";

/** Available listening moods, selected by the session's emotion event. */
export const PREP_EMOTIONS = ["neutral", "happy", "warm"] as const;
export type PrepEmotion = (typeof PREP_EMOTIONS)[number];

/** Distinct directions for the three listening moods. */
const EMOTION_LINE: Record<PrepEmotion, string> = {
  neutral: "[emotion: attentive ease, relaxed lips and an approachable gaze]",
  happy: "[emotion: quiet delight, cheeks lift into a closed-lip smile and the eyes brighten with gentle amusement]",
  warm: "[emotion: tender reassurance, an affectionate look with a small, unhurried smile]",
};

const IDENTITY: Record<CompanionKind, string> = {
  human:
    "REAL HUMAN VIDEO: Use the photographed individual as the sole identity reference. Retain their age, skin detail, asymmetry and facial measurements. Add life to that face without retouching attractiveness, inventing features or changing its visual style.",
  animal:
    "REAL ANIMAL VIDEO: Bring the pictured animal to life while retaining its species, distinctive coat or plumage, age and anatomy. Its markings, muzzle and silhouette must remain recognizable; avoid cosmetic changes or human facial features.",
  character:
    "ANIMATED CHARACTER VIDEO: Work within the supplied character's original art style. Retain its palette, outlines, construction and silhouette. Animate that design without a style conversion, realistic skin or an upgraded appearance.",
};

const SUBJECT: Record<CompanionKind, string> = { human: "companion", animal: "animal companion", character: "drawn companion" };

const REALISM: Record<CompanionKind, string> = {
  human:
    "REALISM: Match the photograph's illumination, resolution and facial anatomy. Aim for a believable person attending a video conversation: tiny reactions, ordinary eyelid motion and quiet respiration, with no spoken response.",
  animal:
    "REALISM: Respect the species' anatomy and the photograph's light and detail. Convey a calm animal noticing the viewer through slight ear adjustments, occasional blinks and breathing; keep its own face rather than humanizing it.",
  character:
    "REALISM: Let the reference artwork determine how motion is drawn or rendered. Keep its contours, shading and colors consistent. Small blinks and a restrained breathing rhythm should suggest a character paying attention.",
};

/** Unwanted motion and anatomy for every quiet loop. */
export const SILENT_NEGATIVE =
  "articulating lips, open jaw, whispered words, speech animation, duplicate lip edges, phantom mouths in facial shading, warped features, altered identity, magnification, shrinking subject, wandering viewpoint, lens zoom, dolly travel, shifting crop, rotated view, moving scenery, depth parallax, flickering illumination, forward head travel, backward head travel";

export const KLING_PROMPT_MAX = 2500;

export function silentPrompt(emotion: PrepEmotion, kind: CompanionKind = "human"): string {
  const s = SUBJECT[kind];
  return [
    EMOTION_LINE[emotion],
    IDENTITY[kind],
    `SILENT MODE (CRITICAL): Show the ${s} listening throughout. Keep the lips resting together for the whole clip; forbid syllable formation, whispered dialogue and lip synchronization. There must be a single anatomical mouth. Beard edges, creases and shadows remain surface detail, never extra lips.`,
    "CAMERA (LOCKED, ZERO SCALE CHANGE): Freeze the viewpoint as if the camera were bolted in place. Fix lens angle, focal length, crop and subject distance. Never pan, tilt, rotate, zoom or recenter. Match the opening composition at the end: head and shoulders keep their pixel size and position. Animate within this fixed view only.",
    "BACKGROUND: Hold every surrounding object and light source still. Keep scenery frozen, without drifting textures, parallax or exposure changes; all signs of life belong to the companion.",
    `EXPRESSION: Communicate the requested mood through restrained facial detail on the ${s}. Prefer a small, believable response over theatrical acting, exaggerated reactions or performative poses.`,
    "EYES: Maintain comfortable attention toward the viewer, allowing brief blinks and small gaze shifts rather than staring or rolling the eyes.",
    `HEAD & BODY: Give the ${s} a faint breathing rhythm with minute posture and shoulder adjustments. Avoid rocking, broad gestures and nodding toward the lens. Keep these movements parallel to the image plane so depth and apparent head size stay constant.`,
    REALISM[kind],
  ].join("\n");
}

/** A ten-second, audio-free image animation request using only its first frame. */
export function klingSilentInput(startImageUrl: string, emotion: PrepEmotion, kind: CompanionKind) {
  return {
    start_image_url: startImageUrl,
    prompt: silentPrompt(emotion, kind),
    negative_prompt: SILENT_NEGATIVE,
    duration: "10",
    generate_audio: false,
  };
}

/** Portrait scene edits preserve identity while establishing a quiet call setting. */
export const SCENE_PROMPT: Record<CompanionKind, string> = {
  human:
    "Use the reference person's unaltered likeness, including facial asymmetry, complexion, age, hairstyle and individual features. Create a vertical 9:16 portrait resembling a phone call. Face the lens with eyes meeting the viewer; place the face above the image midpoint and include the upper chest. Keep lips at rest and expression calm. Set the person in a softly illuminated, everyday bedroom. Retain photographic texture without skin retouching, cosmetic enhancement or lettering.",
  animal:
    "Use the reference animal's species and recognizable appearance: its coat or feathers, eye color, head anatomy, age and unique markings. Arrange a vertical 9:16 call portrait with the animal facing the viewer, head above center and upper torso included. Keep its mouth at rest and posture comfortable in a softly illuminated domestic room. Preserve a photographic finish; add neither lettering nor human facial traits.",
  character:
    "Use the supplied character's established design and original art style, preserving outlines, palette, anatomy and proportions. Compose a vertical 9:16 call portrait: face above center, chest included, gaze toward the viewer. Give it a calm expression and resting, closed mouth. Depict a comfortable room with soft illumination using the artwork's own rendering style throughout. Omit captions and decorative lettering.",
};

export const SCENE_SIZE = "1024x1820";
