/**
 * Keep vendor HTTPS connections open between turns (latency lane, 11/3).
 *
 * Node's fetch (undici) closes an idle socket after 4 s unless the server sends a Keep-Alive hint,
 * and neither api.meta.ai nor the voice service sends one. People speak every 5–20 s, so each turn's
 * hedged Spark lanes reconnected (DNS + TCP + TLS) right when the answer was needed.
 *
 * installKeepAlive swaps the process-wide fetch dispatcher for one with a longer idle timeout. It uses
 * undici's documented cross-copy global key (the one `undici.setGlobalDispatcher` writes), so it needs
 * no new dependency. It only replaces Node's own default Agent; anything else (no dispatcher, one
 * another library installed) is left as is.
 *
 * warmUp opens `n` sockets to a host ahead of use (call start, or a turn after a long quiet), so the
 * first turn's Spark lanes find them open. Fire and forget; failures are ignored.
 */
export const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

type AgentCtor = new (opts: { keepAliveTimeout: number; keepAliveMaxTimeout: number }) => object;
type Marked = { constructor?: AgentCtor; dispatch?: unknown; genitaKeepAliveMs?: number };

/** True when the longer keep-alive is in place. Safe to call more than once. */
export async function installKeepAlive(
  idleMs: number,
  // Node creates its default dispatcher on the first fetch; a refused loopback request makes it exist
  ensureDefault: () => Promise<unknown> = () => fetch("http://127.0.0.1:9/").catch(() => {}),
): Promise<boolean> {
  if (!(idleMs > 0)) return false;
  const g = globalThis as unknown as Record<symbol, Marked | undefined>;
  if (!g[GLOBAL_DISPATCHER]) await ensureDefault();
  const current = g[GLOBAL_DISPATCHER];
  if (current?.genitaKeepAliveMs === idleMs) return true;
  // only Node's own default (a plain undici Agent): a dispatcher someone else installed, or an
  // interceptor/proxy wrapper, keeps its options and is left alone
  if (typeof current?.constructor !== "function" || current.constructor.name !== "Agent" || typeof current.dispatch !== "function") return false;
  try {
    const agent = new current.constructor({ keepAliveTimeout: idleMs, keepAliveMaxTimeout: idleMs }) as Marked;
    if (typeof agent.dispatch !== "function") return false;
    agent.genitaKeepAliveMs = idleMs;
    g[GLOBAL_DISPATCHER] = agent;
    return true;
  } catch {
    return false;
  }
}

/** Open `n` parallel connections to `url` (GET, body discarded). Never throws. */
export function warmUp(url: string, n: number, headers: Record<string, string> = {}, doFetch: typeof fetch = fetch): void {
  for (let i = 0; i < n; i++) {
    void doFetch(url, { headers, signal: AbortSignal.timeout(5000) })
      .then((r) => r.arrayBuffer())
      .catch(() => {});
  }
}

export type PrewarmOptions = {
  metaUrl: string;
  metaHeaders: Record<string, string>;
  /** hedged Spark lanes: one socket each */
  lanes: number;
  voiceUrl?: string;
  /** the socket pool is shared by every call, so warm at most this often for the whole server */
  cooldownMs?: number;
  now?: () => number;
  doFetch?: typeof fetch;
};

/** A process-wide warm-up: calls starting or waking within cooldownMs of each other share one. */
export function makePrewarm(o: PrewarmOptions): (opts: { voice: boolean }) => void {
  const now = o.now ?? Date.now;
  const cooldown = o.cooldownMs ?? 20_000;
  let metaAt = -Infinity;
  let voiceAt = -Infinity;
  return ({ voice }) => {
    const t = now();
    if (t - metaAt >= cooldown) {
      metaAt = t;
      warmUp(o.metaUrl, o.lanes, o.metaHeaders, o.doFetch);
    }
    if (voice && o.voiceUrl && t - voiceAt >= cooldown) {
      voiceAt = t;
      warmUp(o.voiceUrl, 1, {}, o.doFetch);
    }
  };
}
