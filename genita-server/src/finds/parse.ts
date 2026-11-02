/** Parsing Spark's plain-text answers for the finds pipeline. Pure. */

export type SeenLine = { name: string; count: number | null; look: string | null };

/**
 * One food per line: "name | count | where and how it looks". Spark answers
 * this format in 1.5–3.7 s on the 11/2 fridge photo; json_schema for the
 * same list took 2.7–12 s and once came back empty, so the first look is
 * plain lines, parsed as they stream.
 */
export function parseSeenLine(line: string): SeenLine | null {
  const raw = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
  if (!raw || raw.length > 200) return null;
  const parts = raw.split("|").map((p) => p.trim());
  const name = parts[0]?.replace(/[.*_`]/g, "").trim().toLowerCase();
  if (!name || name.length > 40 || /^(name|none|nothing|n\/a)$/.test(name)) return null;
  let count: number | null = null;
  let look: string | null = null;
  if (parts.length >= 3) {
    const n = Number.parseInt(parts[1], 10);
    count = Number.isFinite(n) && n > 0 && n < 100 ? n : null;
    look = parts.slice(2).join(" ").trim() || null;
  } else if (parts.length === 2) {
    const n = Number.parseInt(parts[1], 10);
    if (Number.isFinite(n) && /^\d+$/.test(parts[1])) count = n > 0 && n < 100 ? n : null;
    else look = parts[1] || null;
  }
  return { name, count, look: look ? look.slice(0, 80) : null };
}

/** Splits a growing stream into complete lines; `flush` returns the tail. */
export class LineSplitter {
  private buf = "";
  push(delta: string): string[] {
    this.buf += delta;
    const lines = this.buf.split(/\r?\n/);
    this.buf = lines.pop() ?? "";
    return lines.filter((l) => l.trim());
  }
  flush(): string[] {
    const tail = this.buf.trim();
    this.buf = "";
    return tail ? [tail] : [];
  }
}

/** The last parseable JSON object in a reply (Spark often says "I'll search…" before it). */
export function lastJsonObject<T = Record<string, unknown>>(text: string): T | null {
  const ends: number[] = [];
  for (let i = text.length - 1; i >= 0; i--) if (text[i] === "}") ends.push(i);
  for (const end of ends.slice(0, 3)) {
    let depth = 0;
    for (let i = end; i >= 0; i--) {
      const ch = text[i];
      if (ch === "}") depth++;
      else if (ch === "{") {
        depth--;
        if (depth === 0) {
          try {
            const v = JSON.parse(text.slice(i, end + 1));
            if (v && typeof v === "object" && !Array.isArray(v)) return v as T;
          } catch {
            /* keep looking further left */
          }
        }
      }
    }
  }
  return null;
}

export function isYes(text: string): boolean | null {
  const t = text.trim().toUpperCase();
  if (/^\W*YES\b/.test(t)) return true;
  if (/^\W*NO\b/.test(t)) return false;
  if (/\bYES\b/.test(t) && !/\bNO\b/.test(t)) return true;
  if (/\bNO\b/.test(t)) return false;
  return null;
}

export function str(v: unknown, max = 200): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export function strList(v: unknown, maxItems: number, maxLen = 120): string[] {
  return Array.isArray(v) ? v.map((x) => str(x, maxLen)).filter(Boolean).slice(0, maxItems) : [];
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/i;
export function findUrl(text: string): string | null {
  const m = text.match(URL_RE);
  return m ? m[0].replace(/[.,!?]+$/, "") : null;
}
