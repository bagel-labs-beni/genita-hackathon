/**
 * Generation prompts for companion prep (pure, unit-tested).
 *
 * Silent video: Dyno's approved prompt is peter-engine/generation-prompts/
 * silent.txt (Kling 3.0, 1080p, 10 s). It is 4,172 chars, but fal's Kling 3.0
 * endpoint caps `prompt` and `negative_prompt` at 2,500 each (OpenAPI schema,
 * checked 11/2). So the NEGATIVE block goes to `negative_prompt` verbatim and
 * the body below is the same sections and rules with the repetition removed
 * (the CAMERA block alone said "no zoom" nine ways). test/prep-prompts.test.ts
 * checks every section header survives and the length stays under the cap.
 */
export type CompanionKind = "human" | "animal" | "character";

/** Face clips the session switches between on `speaking.emotion` (F4-L13). */
export const PREP_EMOTIONS = ["neutral", "happy", "warm"] as const;
export type PrepEmotion = (typeof PREP_EMOTIONS)[number];

/** Header line per clip. neutral = Dyno's original "[emotion: friendly]". */
const EMOTION_LINE: Record<PrepEmotion, string> = {
  neutral: "[emotion: friendly]",
  happy: "[emotion: amused and happy, a warm closed-lip smile, smiling eyes, as if quietly laughing at something they just saw]",
  warm: "[emotion: tender and affectionate, a soft gaze and a faint gentle smile]",
};

const IDENTITY: Record<CompanionKind, string> = {
  human:
    "REAL HUMAN VIDEO. The uploaded image represents a real person. Animate the existing person only. Do NOT redesign, beautify, stylize, or reinterpret the face. Preserve the original facial identity, facial proportions, skin texture, facial asymmetry, age appearance and facial structure.",
  animal:
    "REAL ANIMAL VIDEO. The uploaded image shows a real animal. Animate the existing animal only. Do NOT redesign, beautify, stylize, or reinterpret it. Preserve its identity, markings, fur or feather texture, proportions, age appearance and head shape.",
  character:
    "ANIMATED CHARACTER VIDEO. The uploaded image shows an illustrated, 3D or stylized character. Animate the existing character only, in its original art style. Do NOT redesign, restyle, beautify, or make it photorealistic. Preserve its design, colors, line work, proportions and face shape.",
};

const SUBJECT: Record<CompanionKind, string> = { human: "person", animal: "animal", character: "character" };

const REALISM: Record<CompanionKind, string> = {
  human:
    "REALISM: Realistic human motion. Keep the original facial geometry, lighting and image quality. Preserve all facial details and identity. The result should resemble a real webcam or video-call frame where the person is quietly listening, thinking or waiting without speaking, with only subtle micro-expressions, natural blinking and realistic breathing.",
  animal:
    "REALISM: Realistic animal motion. Keep the original geometry, lighting and image quality. Preserve all details and identity. The result should resemble a real video-call frame where the animal quietly listens and waits, with natural blinking, tiny ear or head motion and realistic breathing.",
  character:
    "REALISM: Motion that fits the original art style. Keep the original geometry, lighting, colors and rendering. Preserve all details and identity. The result should resemble a video-call frame where the character quietly listens and waits, with natural blinking and gentle breathing.",
};

/** silent.txt NEGATIVE block, verbatim (385 chars). */
export const SILENT_NEGATIVE =
  "zoom in, zoom out, punch-in, push-in, pull-back, dolly, camera movement, camera drift, scale change, resizing frame, magnify, crop change, reframing, subject growing larger, subject shrinking, head moving toward camera, changing framing, parallax, background motion, mouth opening, lip-sync, speaking, talking, whispering, multiple mouths, extra mouth, face distortion, identity change";

export const KLING_PROMPT_MAX = 2500;

export function silentPrompt(emotion: PrepEmotion, kind: CompanionKind = "human"): string {
  const s = SUBJECT[kind];
  const S = s.charAt(0).toUpperCase() + s.slice(1);
  return [
    EMOTION_LINE[emotion],
    IDENTITY[kind],
    `SILENT MODE (CRITICAL): The ${s} does NOT speak. No speech, no speech articulation, no lip-sync, no silent talking, whispering or muttering, no mouth movements that resemble speech. The mouth remains naturally closed from the first frame to the final frame. The ${s} has ONE mouth only. Do NOT generate additional mouths or secondary lip structures. Do NOT reinterpret shadows, beard lines, nose shadows, chin contours, wrinkles or shading as mouth shapes.`,
    `CAMERA (LOCKED, ZERO SCALE CHANGE): Static locked-off tripod camera. No camera movement, zoom, dolly, push-in, pull-back, pan, tilt, roll, reframing, crop change or re-centering. Focal length, field of view and camera-to-subject distance are fixed. The subject's size in the frame is LOCKED: the head and shoulders occupy exactly the same proportion of the frame in every frame, with identical framing and scale at the first and final frame. Only the face and micro-motions animate; the frame itself is completely immobile.`,
    "BACKGROUND: Completely static. No background animation, moving objects, parallax or lighting changes. It should feel like a still photograph where only a subtle living presence exists.",
    `EXPRESSION: The ${s} expresses the emotion above without speaking. Natural, subtle emotional cues only. No exaggerated, influencer-style or cartoon-like facial acting.`,
    "EYES: Natural blinking, steady gaze, subtle eye movement.",
    `HEAD & BODY: Very small natural head micro-movements, tiny posture adjustments, subtle breathing, minimal shoulder movement. No swaying, large gestures or dramatic movement. ${S} head micro-movements must NOT move the head closer to or farther from the camera.`,
    REALISM[kind],
  ].join("\n");
}

/** fal-ai/kling-video/v3/pro/image-to-video input (Dyno: Kling 3.0, 1080p, 10 s, silent). */
export function klingSilentInput(startImageUrl: string, emotion: PrepEmotion, kind: CompanionKind) {
  return {
    start_image_url: startImageUrl,
    prompt: silentPrompt(emotion, kind),
    negative_prompt: SILENT_NEGATIVE,
    duration: "10",
    generate_audio: false,
  };
}

/**
 * Call-scene edit (F2-L21). The human prompt is the exact 11/1 T2 prompt
 * (Muse Image 9.2/10 identity over 9 people). Animal/character keep the same
 * framing rules but ask for the original species / art style.
 */
export const SCENE_PROMPT: Record<CompanionKind, string> = {
  human:
    "Keep this exact same person: identical face shape, eyes, nose, mouth, skin texture, age and hair. Recompose as a front-facing phone video call selfie: vertical 9:16, face centred in the upper middle, head and upper chest visible, looking directly into the camera, lips gently closed, relaxed neutral expression, sitting in a softly lit lived-in bedroom. Natural unretouched photo, no beautification, no text.",
  animal:
    "Keep this exact same animal: identical markings, fur or feathers, eye colour, face shape and age. Recompose as a front-facing phone video call selfie: vertical 9:16, head centred in the upper middle, head and upper chest visible, looking directly into the camera, mouth gently closed, relaxed, sitting in a softly lit lived-in room. Natural unretouched photo, no text.",
  character:
    "Keep this exact same character in its exact original art style: identical design, colours, line work, face shape and proportions. Recompose as a front-facing video call frame: vertical 9:16, face centred in the upper middle, head and upper chest visible, looking directly at the viewer, mouth gently closed, relaxed neutral expression, in a softly lit cosy room drawn in the same style. No text.",
};

export const SCENE_SIZE = "1024x1820";
