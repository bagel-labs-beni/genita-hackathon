/**
 * Conversation engine v1 switches (DESIGN: ./genita-hackathon/conversation-engine/DESIGN.md).
 * Read per call so an env change on restart is the rollback; no config plumbing.
 *   GENITA_CONVO_V1=0      → the 11/2 prompt, greeting and faces (legacy), no sentence guard
 *   GENITA_INITIATIVE=0    → the companion never speaks first mid-call (silence / memory / camera cues)
 */
export function convoV1(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GENITA_CONVO_V1 !== "0";
}

export function initiativeOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return convoV1(env) && env.GENITA_INITIATIVE !== "0";
}
