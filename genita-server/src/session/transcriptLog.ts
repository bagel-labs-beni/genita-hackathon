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

/**
 * No secrets in the log (Codex r1 P1): anything that reads like a key, token, password or card number is masked
 * before the line is logged — a long letters+digits run, known key prefixes, a run of 12+ digits, and the word after
 * "password / passcode / pin / 비밀번호 / 비번".
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/((?:\b(?:password|passcode|passwd|pin(?:\s*code)?)\b|비밀번호|비번|암호)\s*(?:is|was|:|=|는|은)?\s*)(\S+)/giu, "$1[redacted]")
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|xox[abp]|AKIA|AIza|eyJ)[A-Za-z0-9_\-.]{8,}/g, "[redacted]")
    .replace(/\b(?=[A-Za-z0-9_\-]*\d)(?=[A-Za-z0-9_\-]*[A-Za-z])[A-Za-z0-9_\-]{20,}\b/g, "[redacted]")
    .replace(/\d(?:[ \-]?\d){11,}/g, "[redacted]");
}

export function clipTranscript(text: string | null | undefined): string | null {
  if (!text) return null;
  const clean = redactSecrets(text);
  return clean.length > TRANSCRIPT_MAX_CHARS ? `${clean.slice(0, TRANSCRIPT_MAX_CHARS)}…` : clean;
}
