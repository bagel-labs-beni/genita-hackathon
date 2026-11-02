/**
 * A fake appleid.apple.com: JWKS with a test RSA key, identity tokens signed
 * by it, and /auth/token + /auth/revoke that check the ES256 client secret.
 * Other URLs pass through to the real fetch (tests call the local server).
 */
import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { b64url, decode } from "../../src/auth/jwt.ts";

export const KID = "TESTKID1";

export function fakeApple() {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...(rsa.publicKey.export({ format: "jwk" }) as object), kid: KID, alg: "RS256", use: "sig" };
  const requests: { url: string; form: URLSearchParams }[] = [];
  let revokeStatus = 200;

  const idToken = (claims: Record<string, unknown>, o: { key?: KeyObject; alg?: string; kid?: string } = {}) => {
    const head = b64url(JSON.stringify({ alg: o.alg ?? "RS256", kid: o.kid ?? KID }));
    const body = b64url(JSON.stringify({ iss: "https://appleid.apple.com", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600, ...claims }));
    const sig = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), o.key ?? rsa.privateKey).toString("base64url");
    return `${head}.${body}.${sig}`;
  };
  const nonceHash = (raw: string) => createHash("sha256").update(raw).digest("hex");

  /** checks the client_secret Apple would check: ES256 by our key, iss=team, sub=client_id */
  const secretOk = (form: URLSearchParams) => {
    const t = decode(form.get("client_secret") ?? "");
    const okSig = verify("sha256", Buffer.from(t.signingInput), { key: ec.publicKey, dsaEncoding: "ieee-p1363" }, t.sig);
    return okSig && t.header.alg === "ES256" && t.header.kid === "KEY123" && t.claims.iss === "TEAM123" && t.claims.sub === form.get("client_id") && t.claims.aud === "https://appleid.apple.com";
  };

  const realFetch = globalThis.fetch;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://appleid.apple.com/")) return realFetch(input, init);
    const form = new URLSearchParams(init?.body ? String(init.body) : "");
    requests.push({ url, form });
    if (url.endsWith("/auth/keys")) return Response.json({ keys: [jwk] });
    if (url.endsWith("/auth/token")) {
      if (!secretOk(form) || form.get("code") === "bad") return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ id_token: "x.y.z", refresh_token: `rt-${form.get("client_id")}` });
    }
    if (url.endsWith("/auth/revoke")) return new Response(null, { status: secretOk(form) ? revokeStatus : 400 });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;

  return {
    idToken,
    nonceHash,
    attackerKey: attacker.privateKey,
    fetch: fetchImpl,
    requests,
    setRevokeStatus: (s: number) => (revokeStatus = s),
    env: { APPLE_TEAM_ID: "TEAM123", APPLE_KEY_ID: "KEY123", APPLE_PRIVATE_KEY: (ec.privateKey.export({ format: "pem", type: "pkcs8" }) as string).replace(/\n/g, "\\n") },
  };
}
