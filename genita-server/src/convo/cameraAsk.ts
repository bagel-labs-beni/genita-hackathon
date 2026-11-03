/**
 * Intel eval 11/4 (camera-off-look, 0/5): with the camera off, "do I look ok for this date?" got an empty reply or a
 * bare "Go have fun." — Spark answered "You look great…" and the sentence guard (unseen) rightly dropped it, leaving
 * nothing. One hint on that turn only: say you can't see them and ask for the camera or a description. No prompt cost
 * on any other turn. Pure.
 */
// Codex #541 P2: "can you see what I mean", "do I look like I care" are figures of speech, not asks to be seen
const NOT_LOOK = /\b(?:see what i mean|see where i'?m coming from|see my point|look like i care|look like i give|look (?:it )?up|look into)\b/i;
const LOOK_ASK = /\b(?:(?:how|do|does|did) (?:do |does )?(?:i|this|it|my [a-z]+) look\b|how do i look|can you see (?:me|this|it|my|what)|do you see (?:me|this|my|what)|look at (?:this|me|my|these)\b|what am i (?:wearing|holding)|(?:rate|judge|check(?: out)?) my (?:fit|outfit|look|hair|makeup|shoes)|how(?:'s| is| are) my (?:fit|outfit|hair|makeup|shoes|look)|what do you think of (?:my|this) (?:fit|outfit|look|hair|top|dress))/i;

export const CAMERA_OFF_HINT = "Their camera is off right now, so you can't see them or anything they show: say that in your own playful way and ask them to flip the camera on or describe it.";

/** the hint for this user turn, or null (camera on, or not a "look at me / this" line) */
export function cameraOffHint(userText: string, cameraOn: boolean): string | null {
  return !cameraOn && LOOK_ASK.test(userText) && !NOT_LOOK.test(userText) ? CAMERA_OFF_HINT : null;
}
