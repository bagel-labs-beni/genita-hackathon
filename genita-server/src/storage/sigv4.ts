/**
 * AWS Signature Version 4 for S3-compatible storage (AWS S3, R2, MinIO, …),
 * header signing and presigned URLs. Kept dependency-free on purpose; checked
 * against the AWS documentation example in test/sigv4.test.ts.
 */
import { createHash, createHmac } from "node:crypto";

export type Credentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

export const sha256Hex = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const hmac = (k: string | Buffer, s: string) => createHmac("sha256", k).update(s).digest();

/** RFC 3986 encoding as S3 wants it; `/` kept for paths. */
export function uriEncode(s: string, keepSlash = false): string {
  return [...Buffer.from(s, "utf8")]
    .map((b) => {
      const c = String.fromCharCode(b);
      if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === "/")) return c;
      return "%" + b.toString(16).toUpperCase().padStart(2, "0");
    })
    .join("");
}

export const amzDate = (d: Date) => d.toISOString().replace(/[:-]|\.\d{3}/g, "");

function signingKey(secret: string, date: string, region: string, service: string) {
  return hmac(hmac(hmac(hmac("AWS4" + secret, date), region), service), "aws4_request");
}

export function canonicalQuery(q: Record<string, string>) {
  return Object.keys(q)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(q[k])}`)
    .join("&");
}

export type SignInput = {
  method: string;
  host: string;
  /** already-encoded path, e.g. /bucket/users/a.jpg */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  payloadHash: string;
  region: string;
  service?: string;
  creds: Credentials;
  now?: Date;
};

/** Returns the headers to send (incl. authorization, x-amz-date, x-amz-content-sha256). */
export function signHeaders(i: SignInput): Record<string, string> {
  const service = i.service ?? "s3";
  const t = amzDate(i.now ?? new Date());
  const date = t.slice(0, 8);
  const headers: Record<string, string> = { ...(i.headers ?? {}), host: i.host, "x-amz-date": t, "x-amz-content-sha256": i.payloadHash };
  if (i.creds.sessionToken) headers["x-amz-security-token"] = i.creds.sessionToken;
  const names = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  const canonical = [i.method, i.path, canonicalQuery(i.query ?? {}), names.map((n) => `${n}:${lower[n]}\n`).join(""), names.join(";"), i.payloadHash].join("\n");
  const scope = `${date}/${i.region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", t, scope, sha256Hex(canonical)].join("\n");
  const sig = createHmac("sha256", signingKey(i.creds.secretAccessKey, date, i.region, service)).update(toSign).digest("hex");
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${i.creds.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}` };
}

/** Presigned GET/PUT URL (UNSIGNED-PAYLOAD, host header only). */
export function presign(i: Omit<SignInput, "payloadHash" | "headers"> & { protocol?: string; expiresSec: number }): string {
  const service = i.service ?? "s3";
  const t = amzDate(i.now ?? new Date());
  const date = t.slice(0, 8);
  const scope = `${date}/${i.region}/${service}/aws4_request`;
  const q: Record<string, string> = {
    ...(i.query ?? {}),
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${i.creds.accessKeyId}/${scope}`,
    "X-Amz-Date": t,
    "X-Amz-Expires": String(i.expiresSec),
    "X-Amz-SignedHeaders": "host",
  };
  if (i.creds.sessionToken) q["X-Amz-Security-Token"] = i.creds.sessionToken;
  const canonical = [i.method, i.path, canonicalQuery(q), `host:${i.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", t, scope, sha256Hex(canonical)].join("\n");
  const sig = createHmac("sha256", signingKey(i.creds.secretAccessKey, date, i.region, service)).update(toSign).digest("hex");
  return `${i.protocol ?? "https:"}//${i.host}${i.path}?${canonicalQuery(q)}&X-Amz-Signature=${sig}`;
}
