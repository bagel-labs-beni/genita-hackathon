/** Resolves with `fallback` when `p` takes longer than `ms` or fails (the work itself is not cancelled). */
export function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    // not unref'd: a short timer may be the only pending handle, and the result must arrive
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}
