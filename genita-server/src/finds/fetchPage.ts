/**
 * F7 product search: read a product page the search already opened, for three
 * facts the model is not trusted with — is it one product (not a category or
 * search page), its price, and its picture (og:image). No AI here.
 *
 * Threat (#119): the URL comes from Spark's tool trace, i.e. from the open web.
 * So: https only, port 443, every resolved address must be public (checked in
 * the socket's own DNS lookup, so a rebinding answer cannot slip in between),
 * at most 3 redirects (each re-checked), 4 s per request, HTML capped at
 * 768 KB, images at 2 MB and only JPEG/PNG/WebP bytes. Nothing is executed and
 * no cookies are kept.
 */
import { request } from "node:https";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";

export const PAGE_MAX_BYTES = 768 * 1024;
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 4000;
const MAX_REDIRECTS = 3;
const UA = "Mozilla/5.0 (compatible; GenitaFinds/1.0; +https://bagel-labs-beni.github.io/genita-legal/)";

/** true for loopback, private, link-local (incl. 169.254.169.254), CGNAT, multicast, reserved, ULA, mapped private. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return true;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe[89ab]|ff)/.test(s) || s.startsWith("64:ff9b:") || s.startsWith("2001:db8");
  }
  return true;
}

/** DNS lookup that refuses non-public answers (used by the socket itself). */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...(options as object), all: true }, (err, addresses) => {
    if (err) return (callback as (e: Error | null, a: string, f: number) => void)(err, "", 0);
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (!list.length || bad) {
      const e = Object.assign(new Error(`blocked address for ${hostname}`), { code: "EBLOCKED" });
      return (callback as (e: Error | null, a: string, f: number) => void)(e, "", 0);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    (callback as (e: null, a: string, f: number) => void)(null, list[0].address, list[0].family);
  });
};

/** Only plain public https URLs on the default port, no credentials, no IP literals. */
export function allowedUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host.includes(".") || isIP(host) || /\.(local|internal|localhost)$/i.test(host)) return null;
  return u;
}

export type Fetched = { status: number; url: string; contentType: string; body: Buffer };

/** GET with the guards above. Resolves null on any refusal, error, timeout or over-size body. */
export function safeGet(raw: string, opts: { maxBytes: number; accept: string; signal?: AbortSignal; lookup?: LookupFunction }, hops = 0): Promise<Fetched | null> {
  const u = allowedUrl(raw);
  if (!u || hops > MAX_REDIRECTS || opts.signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: Fetched | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const req = request(
      u,
      { method: "GET", lookup: opts.lookup ?? publicOnlyLookup, headers: { "user-agent": UA, accept: opts.accept, "accept-language": "en-US,en;q=0.8" }, signal: opts.signal },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          let next: string;
          try {
            next = new URL(res.headers.location, u).toString();
          } catch {
            return finish(null);
          }
          return void safeGet(next, opts, hops + 1).then(finish);
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > opts.maxBytes) {
            // HTML: the head (og:image, price, JSON-LD) is enough — keep what fits
            if (opts.accept.startsWith("text/html")) {
              chunks.push(c.subarray(0, Math.max(0, c.length - (size - opts.maxBytes))));
              req.destroy();
              return finish({ status, url: u.toString(), contentType: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks) });
            }
            req.destroy();
            return finish(null);
          }
          chunks.push(c);
        });
        res.on("end", () => finish({ status, url: u.toString(), contentType: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks) }));
        res.on("error", () => finish(null));
      },
    );
    const timer = setTimeout(() => (req.destroy(), finish(null)), TIMEOUT_MS);
    req.on("error", () => finish(null));
    req.end();
  });
}

export type PageFacts = {
  /** "product" = the page says it is one product (og:type product, JSON-LD Product, product:price);
   *  "list" = a category / search / collection page; "unknown" = could not tell (or not fetched) */
  kind: "product" | "list" | "unknown";
  title?: string;
  image?: string;
  price?: string;
};

function meta(html: string, key: string): string | undefined {
  const re = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${key.replace(/[:.]/g, "\\$&")}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  const v = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  return v ? decodeEntities(v).trim() : undefined;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x2F;/gi, "/");
}

const CURRENCY: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", KRW: "₩", JPY: "¥", CAD: "CA$", AUD: "A$" };

export function formatPrice(amount: unknown, currency: unknown): string | undefined {
  const n = typeof amount === "number" ? amount : Number.parseFloat(String(amount ?? "").replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return undefined;
  const cur = typeof currency === "string" ? currency.toUpperCase() : "";
  const sym = CURRENCY[cur];
  const num = Number.isInteger(n) || cur === "KRW" || cur === "JPY" ? Math.round(n).toLocaleString("en-US") : n.toFixed(2);
  return sym ? `${sym}${num}` : cur ? `${num} ${cur}` : undefined;
}

type LdNode = Record<string, unknown>;
function ldNodes(html: string): LdNode[] {
  const out: LdNode[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try {
      const v = JSON.parse(m[1].trim());
      const walk = (x: unknown) => {
        if (Array.isArray(x)) x.forEach(walk);
        else if (x && typeof x === "object") {
          out.push(x as LdNode);
          const g = (x as LdNode)["@graph"];
          if (g) walk(g);
        }
      };
      walk(v);
    } catch {
      /* broken JSON-LD is common; skip it */
    }
  }
  return out;
}

const typeOf = (n: LdNode) => [n["@type"]].flat().map((t) => String(t));

/** Pure: what a product page's HTML says about itself. */
export function readPageFacts(html: string, base: string): PageFacts {
  const facts: PageFacts = { kind: "unknown" };
  const abs = (v: string | undefined) => {
    if (!v) return undefined;
    try {
      const u = new URL(v, base);
      return u.protocol === "https:" ? u.toString() : undefined;
    } catch {
      return undefined;
    }
  };
  const nodes = ldNodes(html);
  const product = nodes.find((n) => typeOf(n).some((t) => /^(Product|ProductGroup|IndividualProduct)$/.test(t)));
  const list = nodes.some((n) => typeOf(n).some((t) => /^(ItemList|CollectionPage|SearchResultsPage|OfferCatalog)$/.test(t)));
  const ogType = meta(html, "og:type")?.toLowerCase();
  const metaPrice = meta(html, "product:price:amount") ?? meta(html, "og:price:amount");
  if (product || ogType === "product" || ogType === "og:product" || metaPrice) facts.kind = "product";
  else if (list) facts.kind = "list";
  facts.title = (typeof product?.name === "string" ? product.name : undefined) ?? meta(html, "og:title");
  const ldImage = product?.image;
  const firstImage = Array.isArray(ldImage) ? ldImage[0] : ldImage;
  const imageUrl = typeof firstImage === "string" ? firstImage : firstImage && typeof firstImage === "object" ? (firstImage as LdNode).url : undefined;
  facts.image = abs(meta(html, "og:image:secure_url") ?? meta(html, "og:image")) ?? abs(typeof imageUrl === "string" ? imageUrl : undefined);
  const offers = product?.offers;
  const offer = (Array.isArray(offers) ? offers[0] : offers) as LdNode | undefined;
  facts.price =
    formatPrice(metaPrice, meta(html, "product:price:currency") ?? meta(html, "og:price:currency")) ??
    (offer ? formatPrice(offer.price ?? offer.lowPrice, offer.priceCurrency) : undefined);
  if (facts.title) facts.title = decodeEntities(facts.title).replace(/\s+/g, " ").trim().slice(0, 120);
  return facts;
}

/** Image bytes we are willing to store (magic numbers, not the header's word). */
export function isImageBytes(b: Buffer): boolean {
  return (b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e) || b.toString("latin1", 8, 12) === "WEBP";
}

export async function fetchPageFacts(url: string, signal?: AbortSignal): Promise<PageFacts | null> {
  const r = await safeGet(url, { maxBytes: PAGE_MAX_BYTES, accept: "text/html,application/xhtml+xml", signal });
  if (!r || r.status !== 200 || !/html/i.test(r.contentType)) return null;
  return readPageFacts(r.body.toString("utf8"), r.url);
}

export async function fetchImage(url: string, signal?: AbortSignal): Promise<Buffer | null> {
  const r = await safeGet(url, { maxBytes: IMAGE_MAX_BYTES, accept: "image/jpeg,image/png,image/webp", signal });
  return r && r.status === 200 && r.body.length > 512 && isImageBytes(r.body) ? r.body : null;
}
