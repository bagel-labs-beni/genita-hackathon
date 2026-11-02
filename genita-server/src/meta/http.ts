export const META_BASE = "https://api.meta.ai/v1";

/** A vendor call failed. Carries status and a short vendor message, never the key. */
export class UpstreamError extends Error {
  readonly vendor: "meta" | "voice";
  readonly status: number | null;
  constructor(vendor: "meta" | "voice", status: number | null, detail: string) {
    super(`${vendor} ${status ?? "network"}: ${detail.slice(0, 300)}`);
    this.name = "UpstreamError";
    this.vendor = vendor;
    this.status = status;
  }
}

export function metaHeaders(key: string, json = true): Record<string, string> {
  return { authorization: `Bearer ${key}`, ...(json ? { "content-type": "application/json" } : {}) };
}

export async function metaJson<T>(key: string, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const r = await fetch(META_BASE + path, { method: "POST", headers: metaHeaders(key), body: JSON.stringify(body), signal });
  if (!r.ok) throw new UpstreamError("meta", r.status, await r.text().catch(() => ""));
  return (await r.json()) as T;
}

export async function metaForm<T>(key: string, path: string, form: FormData, signal?: AbortSignal): Promise<T> {
  const r = await fetch(META_BASE + path, { method: "POST", headers: metaHeaders(key, false), body: form, signal });
  if (!r.ok) throw new UpstreamError("meta", r.status, await r.text().catch(() => ""));
  return (await r.json()) as T;
}
