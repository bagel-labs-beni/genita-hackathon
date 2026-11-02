/**
 * Blob storage for user media (companion photos, seen-memory crops) and
 * shared caches (voice previews). Keys:
 *   users/<userId>/…   everything a user owns — DELETE /me removes the prefix
 *   cache/…            not personal data
 *
 * Env (S3-compatible, any provider):
 *   GENITA_S3_BUCKET            enables S3; unset = files under GENITA_DATA_DIR/blobs
 *   GENITA_S3_REGION            default us-east-1
 *   GENITA_S3_ENDPOINT          e.g. https://<acct>.r2.cloudflarestorage.com (path-style); unset = AWS virtual-host
 *   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN, or GENITA_S3_CREDS=imds (EC2 instance role)
 */
import { mkdir, readFile, readdir, rm, writeFile, rename } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { ImdsCredentials } from "./imds.ts";
import { canonicalQuery, presign, sha256Hex, signHeaders, uriEncode, type Credentials } from "./sigv4.ts";

export interface BlobStore {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  list(prefix: string): Promise<string[]>;
  /** deletes every object under prefix, returns how many */
  deletePrefix(prefix: string): Promise<number>;
  /** short-lived GET URL for the app, or null when the store has no public URLs (file store) */
  signedUrl(key: string, expiresSec?: number): string | null;
  readonly kind: "fs" | "s3";
}

export function checkKey(key: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_\-./]{0,400}$/.test(key) || key.includes("..") || key.includes("//")) throw new Error("bad blob key");
  return key;
}

export class FsBlobStore implements BlobStore {
  readonly kind = "fs" as const;
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  async put(key: string, bytes: Buffer, _contentType?: string) {
    const p = join(this.dir, checkKey(key));
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, p);
  }
  async get(key: string) {
    try {
      return await readFile(join(this.dir, checkKey(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async list(prefix: string) {
    const root = join(this.dir, checkKey(prefix.replace(/\/+$/, "")));
    const out: string[] = [];
    const walk = async (d: string) => {
      let ents;
      try {
        ents = await readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else out.push(relative(this.dir, p));
      }
    };
    await walk(root);
    return out.sort();
  }
  async deletePrefix(prefix: string) {
    const keys = await this.list(prefix);
    await rm(join(this.dir, checkKey(prefix.replace(/\/+$/, ""))), { recursive: true, force: true });
    return keys.length;
  }
  signedUrl() {
    return null;
  }
}

export type S3Options = { bucket: string; region: string; endpoint?: string; creds: Credentials | (() => Credentials); ready?: Promise<void>; fetch?: typeof fetch };

const xmlText = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export class S3BlobStore implements BlobStore {
  readonly kind = "s3" as const;
  private o: S3Options;
  private host: string;
  private protocol: string;
  private base: string; // path prefix: "" (virtual-host) or "/bucket" (path-style)
  private f: typeof fetch;
  constructor(o: S3Options) {
    this.o = o;
    this.f = o.fetch ?? fetch;
    if (o.endpoint) {
      const u = new URL(o.endpoint);
      this.host = u.host;
      this.protocol = u.protocol;
      this.base = `/${uriEncode(o.bucket)}`;
    } else {
      this.host = `${o.bucket}.s3.${o.region}.amazonaws.com`;
      this.protocol = "https:";
      this.base = "";
    }
  }

  private creds(): Credentials {
    return typeof this.o.creds === "function" ? this.o.creds() : this.o.creds;
  }

  private async req(method: string, key: string | null, opts: { query?: Record<string, string>; body?: Buffer; contentType?: string } = {}) {
    if (this.o.ready) await this.o.ready;
    const path = key === null ? this.base || "/" : `${this.base}/${uriEncode(checkKey(key), true)}`;
    const payloadHash = sha256Hex(opts.body ?? "");
    const headers = signHeaders({
      method,
      host: this.host,
      path,
      query: opts.query,
      headers: opts.contentType ? { "content-type": opts.contentType } : {},
      payloadHash,
      region: this.o.region,
      creds: this.creds(),
    });
    delete headers.host; // fetch sets it
    const qs = opts.query ? "?" + canonicalQuery(opts.query) : "";
    return this.f(`${this.protocol}//${this.host}${path}${qs}`, { method, headers, body: opts.body ? new Uint8Array(opts.body) : undefined, signal: AbortSignal.timeout(30_000) });
  }

  async put(key: string, bytes: Buffer, contentType: string) {
    const r = await this.req("PUT", key, { body: bytes, contentType });
    if (!r.ok) throw new Error(`s3 put ${r.status}`);
  }
  async get(key: string) {
    const r = await this.req("GET", key);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`s3 get ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  async list(prefix: string) {
    const keys: string[] = [];
    let token: string | null = null;
    do {
      const query: Record<string, string> = { "list-type": "2", prefix: checkKey(prefix) };
      if (token) query["continuation-token"] = token;
      const r = await this.req("GET", null, { query });
      if (!r.ok) throw new Error(`s3 list ${r.status}`);
      const xml = await r.text();
      for (const m of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) keys.push(xmlText(m[1]));
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xmlText(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "") || null : null;
    } while (token);
    return keys;
  }
  async deletePrefix(prefix: string) {
    const keys = await this.list(prefix);
    for (const k of keys) {
      const r = await this.req("DELETE", k);
      if (!r.ok && r.status !== 404) throw new Error(`s3 delete ${r.status}`);
    }
    return keys.length;
  }
  signedUrl(key: string, expiresSec = 600) {
    return presign({ method: "GET", host: this.host, protocol: this.protocol, path: `${this.base}/${uriEncode(checkKey(key), true)}`, region: this.o.region, creds: this.creds(), expiresSec });
  }
}

export function blobStoreFromEnv(env: NodeJS.ProcessEnv, fallbackDir: string): BlobStore {
  if (!env.GENITA_S3_BUCKET) return new FsBlobStore(fallbackDir);
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    // On EC2 (GENITA_S3_CREDS=imds): instance-role credentials, refreshed in the background.
    if (env.GENITA_S3_CREDS !== "imds") throw new Error("GENITA_S3_BUCKET is set but AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not (or set GENITA_S3_CREDS=imds on EC2)");
    const imds = new ImdsCredentials();
    return new S3BlobStore({ bucket: env.GENITA_S3_BUCKET, region: env.GENITA_S3_REGION || "us-east-1", creds: () => imds.current(), ready: imds.ready });
  }
  return new S3BlobStore({
    bucket: env.GENITA_S3_BUCKET,
    region: env.GENITA_S3_REGION || "us-east-1",
    endpoint: env.GENITA_S3_ENDPOINT || undefined,
    creds: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN || undefined },
  });
}
