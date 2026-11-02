import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { presign, signHeaders } from "../src/storage/sigv4.ts";
import { FsBlobStore, S3BlobStore, checkKey } from "../src/storage/blob.ts";

// AWS docs: "Signature Calculations for the Authorization Header" / "Query String Auth" examples
const creds = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const now = new Date("2013-05-24T00:00:00Z");

test("sigv4 matches the AWS GET Object example", () => {
  const h = signHeaders({
    method: "GET",
    host: "examplebucket.s3.amazonaws.com",
    path: "/test.txt",
    headers: { range: "bytes=0-9" },
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    region: "us-east-1",
    creds,
    now,
  });
  assert.equal(
    h.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
});

test("presigned URL matches the AWS query-string example", () => {
  const url = presign({ method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", region: "us-east-1", creds, now, expiresSec: 86400 });
  assert.match(url, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
});

test("blob keys reject traversal", () => {
  for (const k of ["../x", "users/../a", "/abs", "a//b", ""]) assert.throws(() => checkKey(k), k);
  assert.equal(checkKey("users/5f0c/images/abc"), "users/5f0c/images/abc");
});

test("file blob store: put/get/list/deletePrefix", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blobs-"));
  try {
    const s = new FsBlobStore(dir);
    await s.put("users/u1/images/a", Buffer.from("A"), "image/jpeg");
    await s.put("users/u1/memories/m.jpg", Buffer.from("M"), "image/jpeg");
    await s.put("users/u2/images/b", Buffer.from("B"), "image/jpeg");
    assert.equal((await s.get("users/u1/images/a"))?.toString(), "A");
    assert.equal(await s.get("users/u1/nope"), null);
    assert.deepEqual(await s.list("users/u1/"), ["users/u1/images/a", "users/u1/memories/m.jpg"]);
    assert.equal(await s.deletePrefix("users/u1/"), 2);
    assert.deepEqual(await s.list("users/u1/"), []);
    assert.deepEqual(await s.list("users/u2/"), ["users/u2/images/b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S3 blob store speaks S3 (path-style endpoint, list pagination, deletes)", async () => {
  const objects = new Map<string, Buffer>();
  const calls: string[] = [];
  const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const h = init?.headers as Record<string, string>;
    assert.match(h.authorization, /^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request/);
    calls.push(`${init?.method} ${u.pathname}${u.search}`);
    const key = decodeURIComponent(u.pathname.replace(/^\/genita-media\/?/, ""));
    if (init?.method === "PUT") {
      objects.set(key, Buffer.from(init.body as Uint8Array));
      return new Response(null, { status: 200 });
    }
    if (init?.method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (u.searchParams.get("list-type") === "2") {
      const keys = [...objects.keys()].filter((k) => k.startsWith(u.searchParams.get("prefix")!)).sort();
      const start = Number(u.searchParams.get("continuation-token") ?? 0);
      const page = keys.slice(start, start + 2);
      const more = start + 2 < keys.length;
      const xml = `<ListBucketResult>${page.map((k) => `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key></Contents>`).join("")}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ""}</ListBucketResult>`;
      return new Response(xml, { status: 200 });
    }
    const v = objects.get(key);
    return v ? new Response(new Uint8Array(v)) : new Response("<Error/>", { status: 404 });
  }) as typeof fetch;

  const s = new S3BlobStore({ bucket: "genita-media", region: "auto", endpoint: "https://acct.r2.example.com", creds: { accessKeyId: "AK", secretAccessKey: "SK" }, fetch: fakeFetch });
  for (const n of ["a", "b", "c"]) await s.put(`users/u1/images/${n}`, Buffer.from(n), "image/jpeg");
  await s.put("users/u2/images/z", Buffer.from("z"), "image/jpeg");
  assert.equal((await s.get("users/u1/images/b"))?.toString(), "b");
  assert.equal(await s.get("users/u1/images/none"), null);
  assert.equal(await s.deletePrefix("users/u1/"), 3);
  assert.deepEqual([...objects.keys()], ["users/u2/images/z"]);
  assert.ok(calls.some((c) => c.startsWith("GET /genita-media?continuation-token=2")), "followed the continuation token");
  assert.match(s.signedUrl("users/u2/images/z"), /^https:\/\/acct\.r2\.example\.com\/genita-media\/users\/u2\/images\/z\?X-Amz-Algorithm=AWS4-HMAC-SHA256&/);
});
