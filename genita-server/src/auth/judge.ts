/**
 * Judge access (D41): a code → a session for a dedicated demo account, no Apple ID.
 *
 *   GENITA_JUDGE_CODES   comma list of `label=code` (or just `code`). One demo account per entry
 *                        (users row provider "dev", sub `judge:<label>`, which the shared-token
 *                        x-genita-user header can never name). Unset/empty = Judge access off (404).
 *                        Set from SSM on the server; codes are never in the repo or the apps.
 *
 * Threat line: callers are the iOS/macOS apps (A02-J) and anyone on the internet who can reach
 * /auth/judge. Auth: the code itself, compared in constant time against every configured code
 * (no early exit). Limits: 5 wrong tries per 10 minutes per IP, then 429 until the window ends.
 * Exposes: only a session for the demo account that code belongs to.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const JUDGE_MAX_FAILS = 5;
export const JUDGE_WINDOW_MS = 10 * 60_000;
export const JUDGE_CODE_MAX = 128;

export type JudgeEntry = { label: string; digest: Buffer };

const digest = (s: string) => createHash("sha256").update(s).digest();

/** `label=code,label2=code2` or bare codes. Labels are [A-Za-z0-9_-]{1,32}; a bare code gets a label from its hash. */
export function parseJudgeCodes(raw: string | undefined): JudgeEntry[] {
  const out: JudgeEntry[] = [];
  for (const part of (raw ?? "").split(",")) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf("=");
    const label = eq > 0 ? s.slice(0, eq).trim() : "";
    const code = (eq > 0 ? s.slice(eq + 1) : s).trim();
    if (!code || code.length > JUDGE_CODE_MAX) continue;
    const l = /^[A-Za-z0-9_-]{1,32}$/.test(label) ? label : `j${digest(code).toString("hex").slice(0, 8)}`;
    if (!out.some((e) => e.label === l)) out.push({ label: l, digest: digest(code) });
  }
  return out;
}

export class JudgeAccess {
  private readonly entries: JudgeEntry[];
  private readonly fails = new Map<string, { n: number; reset: number }>();
  private readonly now: () => number;
  constructor(raw: string | undefined, now: () => number = Date.now) {
    this.now = now;
    this.entries = parseJudgeCodes(raw);
  }

  get enabled() {
    return this.entries.length > 0;
  }

  /** True when this IP already used its tries in the current window. */
  limited(ip: string): boolean {
    const h = this.fails.get(ip);
    return !!h && h.reset > this.now() && h.n >= JUDGE_MAX_FAILS;
  }

  /** Constant-time check against every configured code. Returns the label, or null (and counts the failure). */
  check(ip: string, code: string): string | null {
    const d = digest(code.slice(0, JUDGE_CODE_MAX));
    let hit: string | null = null;
    for (const e of this.entries) if (timingSafeEqual(d, e.digest) && hit === null) hit = e.label;
    if (hit) return hit;
    const t = this.now();
    const h = this.fails.get(ip);
    if (!h || h.reset <= t) {
      if (this.fails.size > 10_000) this.fails.clear();
      this.fails.set(ip, { n: 1, reset: t + JUDGE_WINDOW_MS });
    } else h.n++;
    return null;
  }
}
