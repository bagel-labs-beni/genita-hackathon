/**
 * EC2 instance-role credentials (IMDSv2), so the deployed server needs no
 * long-lived AWS keys. Used by blobStoreFromEnv when GENITA_S3_BUCKET is set
 * and AWS_ACCESS_KEY_ID is not. Credentials are refreshed in the background
 * well before they expire (role creds live ~6 h); `current()` is sync so
 * presigned URLs stay sync.
 */
import type { Credentials } from "./sigv4.ts";

const IMDS = "http://169.254.169.254";

export class ImdsCredentials {
  private creds: Credentials | null = null;
  private expires = 0;
  private timer: NodeJS.Timeout | null = null;
  private f: typeof fetch;
  private base: string;
  readonly ready: Promise<void>;
  constructor(opts: { fetch?: typeof fetch; base?: string } = {}) {
    this.f = opts.fetch ?? fetch;
    this.base = opts.base ?? IMDS;
    // never rejects: a failed first load is retried by the timer, S3 calls fail meanwhile
    this.ready = this.refresh().catch((e) => console.error("[imds] first load failed:", (e as Error).message));
    this.timer = setInterval(() => {
      if (Date.now() > this.expires - 15 * 60_000) this.refresh().catch((e) => console.error("[imds] refresh failed:", (e as Error).message));
    }, 60_000);
    this.timer.unref();
  }

  async refresh(): Promise<void> {
    const t = await this.f(`${this.base}/latest/api/token`, { method: "PUT", headers: { "x-aws-ec2-metadata-token-ttl-seconds": "21600" }, signal: AbortSignal.timeout(2000) });
    if (!t.ok) throw new Error(`imds token ${t.status}`);
    const token = await t.text();
    const h = { "x-aws-ec2-metadata-token": token };
    const r = await this.f(`${this.base}/latest/meta-data/iam/security-credentials/`, { headers: h, signal: AbortSignal.timeout(2000) });
    if (!r.ok) throw new Error(`imds role ${r.status}`);
    const role = (await r.text()).split("\n")[0].trim();
    const c = await this.f(`${this.base}/latest/meta-data/iam/security-credentials/${encodeURIComponent(role)}`, { headers: h, signal: AbortSignal.timeout(2000) });
    if (!c.ok) throw new Error(`imds creds ${c.status}`);
    const j = (await c.json()) as { AccessKeyId: string; SecretAccessKey: string; Token: string; Expiration: string };
    this.creds = { accessKeyId: j.AccessKeyId, secretAccessKey: j.SecretAccessKey, sessionToken: j.Token };
    this.expires = Date.parse(j.Expiration) || Date.now() + 3600_000;
  }

  current(): Credentials {
    if (!this.creds) throw new Error("instance credentials not loaded yet");
    return this.creds;
  }

  close() {
    if (this.timer) clearInterval(this.timer);
  }
}
