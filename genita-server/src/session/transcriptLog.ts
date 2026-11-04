/**
 * Opt-in transcript log (Chelsea 11/4): the server logs events only, never what was said. For the user ids listed in
 * GENITA_TRANSCRIPT_LOG_USERS (comma list, default empty = off) each finished turn also logs a `turn.text` event with
 * the user's line and the reply, so her own test calls can be read back from journald. Every other user: no text, ever.
 * Read on every turn, so a changed env takes effect on the next restart without code.
 */
export const TRANSCRIPT_MAX_CHARS = 2000;

export function transcriptLogUsers(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.GENITA_TRANSCRIPT_LOG_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}

/** only an authenticated user id that is listed exactly; no id (dev, smoke without an account) is never logged */
export function transcriptLogOn(userId: string | undefined | null, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!userId) return false;
  return transcriptLogUsers(env).has(userId);
}

export function clipTranscript(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.length > TRANSCRIPT_MAX_CHARS ? `${text.slice(0, TRANSCRIPT_MAX_CHARS)}…` : text;
}
