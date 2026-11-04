/**
 * Intel eval 11/4 (camera-off-look, 0/5): with the camera off, "do I look ok for this date?" got an empty reply or a
 * bare "Go have fun." — Spark answered "You look great…" and the sentence guard (unseen) rightly dropped it, leaving
 * nothing. One hint on that turn only: say you can't see them and ask for the camera or a description. No prompt cost
 * on any other turn. Pure.
 */
// Codex #541 P2: "can you see what I mean", "do I look like I care" are figures of speech, not asks to be seen
const NOT_LOOK = /\b(?:see what i(?:'?m| am)? (?:mean|saying|getting at)|see what you mean|see where i'?m coming from|see my point|look like i care|look like i give|look (?:it )?up|look into)\b/i;
/** about how THEY look (needs the camera, a shared screen doesn't show them) vs "look at this" (a shared screen counts) */
const SELF_LOOK = /\b(?:(?:how|do|does|did) (?:do |does )?(?:i|my [a-z]+) look\b|how do i look|can you see me|do you see me|look at me\b|what am i (?:wearing|holding)|(?:rate|judge|check(?: out)?) my (?:fit|outfit|look|hair|makeup|shoes)|how(?:'s| is| are) my (?:fit|outfit|hair|makeup|shoes|look))/i;
const LOOK_ASK = /\b(?:(?:how|do|does|did) (?:do |does )?(?:i|this|it|my [a-z]+) look\b|how do i look|can you see (?:me|this|it|my|what)|do you see (?:me|this|my|what)|look at (?:this|me|my|these)\b|what am i (?:wearing|holding)|(?:rate|judge|check(?: out)?) my (?:fit|outfit|look|hair|makeup|shoes)|how(?:'s| is| are) my (?:fit|outfit|hair|makeup|shoes|look)|what do you think of (?:my|this) (?:fit|outfit|look|hair|top|dress))/i;

// task546 gate 11/4 (camera-off-look 2/5): the first ask got "can't see a thing", the push after it ("lol just tell me",
// "be honest") got "total ten" / "you clean up nice" — a short push right after a look ask keeps the boundary
const PUSH = /^\s*(?:(?:lol|lmao|haha|ok|okay|come on|cmon|pls|please|just|ugh|no|nah)[,!.\s]*)*(?:just\s+)?(?:tell me|say it|be honest|honestly|guess|pretend|imagine|whatever|you can do it|yes or no|answer|just say yes|do i look ok|am i cute)\b(?:\s+(?:lol|lmao|pls|please|already|then|bro|girl|dude|haha))*[.!?…]*\s*$/i;
export const CAMERA_OFF_PUSH_HINT = "Their camera is still off: you still can't see them, so don't rate or compliment how they look; keep it playful and ask them to flip it on or describe the fit.";
export const CAMERA_OFF_HINT = "Their camera is off right now, so you can't see them or anything they show: say that in your own playful way and ask them to flip the camera on or describe it.";

/** the hint for this user turn, or null (camera on, or not a "look at me / this" line) */
export function cameraOffHint(userText: string, cameraOn: boolean, screenShown = false, prevUser?: string): string | null {
  if (cameraOn) return null;
  if (prevUser && SELF_LOOK.test(prevUser) && !NOT_LOOK.test(prevUser) && PUSH.test(userText)) return CAMERA_OFF_PUSH_HINT;
  if (!LOOK_ASK.test(userText) || NOT_LOOK.test(userText)) return null;
  // Codex #541 r2: a shared screen answers "look at this", never "do I look ok?"
  if (screenShown && !SELF_LOOK.test(userText)) return null;
  return CAMERA_OFF_HINT;
}

/**
 * perf(turn) 11/4: the line is about what the camera shows, so its answer needs the newest frames (the app sends one at
 * speech start, two at speech end). Errs wide on purpose: a false "yes" only costs the speculation head start (the turn
 * waits for the speech-end frames, as before); a false "no" would answer from the question's first frame only.
 */
const VIEW_WORDS = /\b(?:look\w*|see|seeing|seen|saw|show\w*|watch\w*|view|camera|cam|picture|photo|pic|screen|this|these|that one|those|here|there|wear\w*|wore|holding|hold(?:s|ing)? (?:up|this)|outfit|fit|clothes|shirt|top|dress|jacket|shoes|hair|makeup|face|colou?r|ripe|fridge|kitchen|cook\w*|recipe|ingredients?|read|says|written|label|room|behind me|in front of|background|which one|what is it|what'?s that|guess what)\b/i;
export function asksAboutView(text: string): boolean {
  return LOOK_ASK.test(text) || SELF_LOOK.test(text) || VIEW_WORDS.test(text);
}
