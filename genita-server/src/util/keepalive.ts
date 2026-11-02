/**
 * Keep vendor HTTPS connections open between turns (latency lane, 11/3).
 *
 * Node's fetch (undici) closes an idle socket after 4 s unless the server sends a Keep-Alive hint,
 * and neither api.meta.ai nor the voice service sends one. People speak every 5–20 s, so each turn's
 * hedged Spark lanes reconnected (DNS + TCP + TLS) right when the answer was needed.
 *
 * installKeepAlive swaps the process-wide fetch dispatcher for one with a longer idle timeout. It uses
 * undici's documented cross-copy global key (the one `undici.setGlobalDispatcher` writes), so it needs
 * no new dependency; if the runtime does not expose it, nothing changes.
 *
 * warmUp opens `n` sockets to a host ahead of use (call start, or a turn after a long quiet), so the
 * first turn's Spark lanes find them open. Fire and forget; failures are ignored.
 */
export const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

type AgentCtor = new (opts: { keepAliveTimeout: number; keepAliveMaxTimeout: number }) => object;
type Marked = { constructor?: AgentCtor; genitaKeepAliveMs?: number };

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
  if (typeof current?.constructor !== "function") return false;
  try {
    const agent = new current.constructor({ keepAliveTimeout: idleMs, keepAliveMaxTimeout: idleMs }) as Marked;
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
