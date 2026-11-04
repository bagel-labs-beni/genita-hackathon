/**
 * Hedged streaming request: start n identical streams, keep the one whose
 * first real output (isOutput) arrives first, abort the rest.
 *
 * Why: Muse Spark's first-token time varies a lot (11/2: 1.2–3.1 s for the
 * same prompt). Min of 2 concurrent requests cut p50 from 1.94 s to 1.54 s.
 * Cost: up to n× Spark input tokens per turn (losers are aborted early).
 *
 * Lanes that fail or end without output are skipped; if every lane fails the
 * first error is rethrown. A completed fallback lane (e.g. a function call)
 * waits only a short grace for real output; otherwise the first completed
 * lane is replayed so the caller can retry.
 */
export function hedged<E>(
  n: number,
  start: (signal: AbortSignal, lane: number) => AsyncIterable<E>,
  parent: AbortSignal,
  isOutput: (e: E, lane: number) => boolean,
  isFallbackOutput?: (e: E) => boolean,
): AsyncIterable<E> {
  if (n <= 1) return start(parent, 0);
  return race(n, start, parent, isOutput, isFallbackOutput);
}

type LaneResult = { i: number; kind: "output" | "done" | "error"; error?: unknown };
// A tag-only/stalled loser must not hold a completed tool call until Spark's
// upstream timeout. Allow a nearby text winner, then execute the fallback.
const FALLBACK_GRACE_MS = 400;

async function* race<E>(
  n: number,
  start: (signal: AbortSignal, lane: number) => AsyncIterable<E>,
  parent: AbortSignal,
  isOutput: (e: E, lane: number) => boolean,
  isFallbackOutput?: (e: E) => boolean,
): AsyncGenerator<E> {
  if (parent.aborted) throw parent.reason ?? new Error("aborted");
  const ctrls = Array.from({ length: n }, () => new AbortController());
  const abortAll = () => ctrls.forEach((c) => c.abort());
  parent.addEventListener("abort", abortAll, { once: true });
  const iters = ctrls.map((c, i) => start(AbortSignal.any([parent, c.signal]), i)[Symbol.asyncIterator]());
  const bufs: E[][] = iters.map(() => []);
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const pull = async (i: number): Promise<LaneResult> => {
    try {
      for (;;) {
        const r = await iters[i].next();
        if (r.done) return { i, kind: "done" };
        bufs[i].push(r.value);
        if (isOutput(r.value, i)) return { i, kind: "output" };
      }
    } catch (error) {
      return { i, kind: "error", error };
    }
  };

  try {
    const pending = new Map<number, Promise<LaneResult>>(iters.map((_, i) => [i, pull(i)]));
    let winner = -1;
    let firstError: unknown = null;
    let firstDone = -1;
    let fallback = -1;
    let grace: Promise<null> | undefined;
    while (pending.size) {
      const r = await Promise.race([...pending.values(), ...(grace ? [grace] : [])]);
      if (r === null) { winner = fallback; break; }
      pending.delete(r.i);
      if (r.kind === "output") {
        winner = r.i;
        break;
      }
      if (r.kind === "error" && firstError === null) firstError = r.error;
      if (r.kind === "done" && firstDone < 0) firstDone = r.i;
      if (r.kind === "done" && fallback < 0 && isFallbackOutput && bufs[r.i].some(isFallbackOutput)) {
        fallback = r.i;
        grace = new Promise<null>((resolve) => { graceTimer = setTimeout(() => resolve(null), FALLBACK_GRACE_MS); });
      }
    }
    clearTimeout(graceTimer);
    if (parent.aborted) throw parent.reason ?? new Error("aborted");
    if (winner < 0) {
      if (firstDone < 0) throw firstError ?? new Error("all hedged lanes failed");
      winner = fallback >= 0 ? fallback : firstDone;
    }
    ctrls.forEach((c, i) => i !== winner && c.abort());
    yield* bufs[winner];
    for (;;) {
      const r = await iters[winner].next();
      if (r.done) return;
      yield r.value;
    }
  } finally {
    clearTimeout(graceTimer);
    parent.removeEventListener("abort", abortAll);
    // Closing a consumer (including a cancelled speculation) must release all
    // lanes. Each iterator has its own close; a loser cannot close the winner.
    abortAll();
    for (const iter of iters) void iter.return?.().catch(() => {});
  }
}
