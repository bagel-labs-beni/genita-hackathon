/** Genita scene prompts for Meta image edits. */
export type CompanionKind = "human" | "animal" | "character";

/** Keys retained in legacy prep status responses. */
export const PREP_EMOTIONS = ["neutral", "happy", "warm"] as const;
export type PrepEmotion = (typeof PREP_EMOTIONS)[number];

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
