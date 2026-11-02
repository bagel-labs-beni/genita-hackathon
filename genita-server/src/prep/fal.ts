/**
 * fal.ai client: CDN upload + queue (submit / status / result).
 * Shapes follow the 11/1 test suite lib.py (fal_upload, fal_run).
 * The queue request id is what makes prep resumable: the runner stores it
 * and, after a restart, polls the same request instead of paying again.
 */
export const FAL_QUEUE = "https://queue.fal.run";
const FAL_STORAGE = "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3";

export class FalError extends Error {
  readonly status: number | null;
  constructor(status: number | null, detail: string) {
    super(`fal ${status ?? "network"}: ${detail.slice(0, 300)}`);
    this.name = "FalError";
    this.status = status;
  }
}

const auth = (key: string) => ({ authorization: `Key ${key}` });

async function falFetch<T>(key: string, url: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(url, { ...init, headers: { ...auth(key), ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });
  if (!r.ok) throw new FalError(r.status, await r.text().catch(() => ""));
  return (await r.json()) as T;
}

/** Uploads bytes to fal's CDN and returns a public URL fal models can read. */
export async function falUpload(key: string, bytes: Buffer, mime: string, fileName: string, signal?: AbortSignal): Promise<string> {
  const i = await falFetch<{ upload_url: string; file_url: string }>(key, FAL_STORAGE, {
    method: "POST",
    body: JSON.stringify({ content_type: mime, file_name: fileName }),
    signal,
  });
  const put = await fetch(i.upload_url, { method: "PUT", headers: { "content-type": mime }, body: new Uint8Array(bytes), signal });
  if (!put.ok) throw new FalError(put.status, await put.text().catch(() => ""));
  return i.file_url;
}

export type FalRequest = { model: string; requestId: string; statusUrl: string; responseUrl: string };

export async function falSubmit(key: string, model: string, input: unknown, signal?: AbortSignal): Promise<FalRequest> {
  const s = await falFetch<{ request_id: string; status_url: string; response_url: string }>(key, `${FAL_QUEUE}/${model}`, {
    method: "POST",
    body: JSON.stringify(input),
    signal,
  });
  return { model, requestId: s.request_id, statusUrl: s.status_url, responseUrl: s.response_url };
}

export type FalStatus = "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | string;

export async function falStatus(key: string, req: FalRequest, signal?: AbortSignal): Promise<FalStatus> {
  return (await falFetch<{ status: FalStatus }>(key, req.statusUrl, { signal })).status;
}

export async function falResult<T>(key: string, req: FalRequest, signal?: AbortSignal): Promise<T> {
  return falFetch<T>(key, req.responseUrl, { signal });
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), rej(signal.reason)), { once: true });
  });

/**
 * Polls until COMPLETED and returns the result. A failed job surfaces as an
 * error from the response URL (fal answers 4xx/5xx there), not as a status.
 */
export async function falWait<T>(
  key: string,
  req: FalRequest,
  opts: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal; onStatus?: (s: FalStatus) => void } = {},
): Promise<T> {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? 25 * 60_000;
  for (;;) {
    const st = await falStatus(key, req, opts.signal);
    opts.onStatus?.(st);
    if (st === "COMPLETED") return falResult<T>(key, req, opts.signal);
    if (st !== "IN_QUEUE" && st !== "IN_PROGRESS") return falResult<T>(key, req, opts.signal);
    if (Date.now() - t0 > timeoutMs) throw new FalError(null, `${req.model} timed out after ${Math.round(timeoutMs / 1000)}s`);
    await sleep(opts.pollMs ?? 8000, opts.signal);
  }
}
