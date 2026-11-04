/**
 * Chelsea 11/5 (01:12): the companion's lines never contain em dashes (—) or en dashes (–).
 *   - " — " / "—" → ", ", or ". " when the next word starts with a capital ("the classic pick — I put" → "the classic
 *     pick. I put"); right after other punctuation the dash just goes; at the very end it becomes a period
 *   - "–" between numbers ("3–5", "2019 – 2020") → " to "
 * Companion output only (spoken text, captions, the reply, card say-lines). Never the user's transcript and never
 * interpretation output (a translation keeps the speaker's punctuation). Kill switch: GENITA_NO_DASH=0.
 * `DashScrubber` does the same on a stream: a dash (and the spaces around it) at the end of a chunk is held until
 * the next chunk shows what follows it, so a dash split across chunks is decided right.
 */
export function noDashOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GENITA_NO_DASH !== "0";
}

const DASH_RUN = /([^\s—–]?)(\s*)([—–]+)(\s*)(?=(.?))/gu;

/**
 * The text with every em/en dash replaced. `final` = nothing follows this text (a trailing dash becomes a period);
 * `before` = the text already sent before this piece (only its last character is read).
 */
export function scrubDashes(text: string, final = true, before = ""): string {
  if (!/[—–]/.test(text)) return text;
  const ctx = before.slice(-1);
  const out = text.replace(DASH_RUN, (_m, lead: string, _sp1: string, dashes: string, _sp2: string, next: string, offset: number, all: string) => {
    // the character before the dash run: `lead` when the regex took it, else whatever precedes the match
    const prev = lead || (offset > 0 ? all[offset - 1] : ctx);
    if (!prev || /\s/.test(prev)) return lead; // a leading dash (or one after a space already sent): dropped
    if (prev === ">" || prev === "]") return `${lead} `; // right after a tag ("<warm> — so"): dropped
    if (/\d/.test(prev) && /\d/.test(next)) return dashes.includes("–") ? `${lead} to ` : `${lead}-`;
    if (!next) return final && !/[.!?,;:…]/.test(prev) ? `${lead}.` : lead;
    if (/[.!?,;:…]/.test(prev)) return `${lead} `;
    if (/[.!?,;:…)\]]/.test(next)) return lead;
    return /\p{Lu}/u.test(next) ? `${lead}. ` : `${lead}, `;
  });
  return out.replace(/ {2,}/g, " ");
}

/** Streaming version: push each delta, flush at the end. Output joined == scrubDashes(whole input). */
export class DashScrubber {
  private held = "";
  private sent = "";

  push(delta: string): string {
    const text = this.held + delta;
    // hold a trailing dash run with the character before it (it decides the rule), or spaces after a word (a dash
    // may come next: "pick " | "— I put" must not become "pick , I put"). Spaces after punctuation ("Yes. ") go out
    // at once: the splitter needs them to end the sentence, and the stream may pause right there.
    const m = /[^\s—–]?[\s—–]*$/u.exec(text)?.[0] ?? "";
    const spaces = /\s+$/u.exec(text)?.[0] ?? "";
    const word = /[\p{L}\p{N}]$/u.test((this.sent + text).slice(0, (this.sent + text).length - spaces.length));
    const tail = /[—–]/.test(m) ? m : spaces && word ? spaces : "";
    this.held = tail;
    const ready = text.slice(0, text.length - tail.length);
    if (!ready) return "";
    const out = scrubDashes(ready, false, this.sent);
    this.sent = (this.sent + out).slice(-8);
    return out;
  }

  flush(): string {
    const t = this.held;
    this.held = "";
    if (!t) return "";
    const out = scrubDashes(t, true, this.sent);
    this.sent = (this.sent + out).slice(-8);
    return out;
  }
}
