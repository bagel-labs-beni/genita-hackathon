import { test } from "node:test";
import assert from "node:assert/strict";
import { Accounts, parseQaList } from "../src/auth/accounts.ts";
import { testDb } from "./helpers/db.ts";

test("QA photos: parseQaList splits ids and (lower-cased) emails, drops blanks", () => {
  const l = parseQaList(" 11111111-aaaa , QA+F@Example.com,, ");
  assert.deepEqual([...l.ids], ["11111111-aaaa"]);
  assert.deepEqual([...l.emails], ["qa+f@example.com"]);
  assert.equal(parseQaList(undefined).ids.size, 0);
});

test("QA photos: /me has no qaSamplePhotos key unless the account is listed (normal + judge accounts unchanged)", async () => {
  const db = await testDb();
  try {
    const plain = new Accounts(db);
    const { user: normal } = await plain.upsertUser({ provider: "apple", sub: "n1", email: "qa@example.com", emailVerified: true });
    // off (env unset): nobody gets it
    assert.equal("qaSamplePhotos" in (await plain.meView(normal.id))!, false);

    const { user: judge } = await plain.upsertUser({ provider: "dev", sub: "judge:j1" });
    const { user: unverified } = await plain.upsertUser({ provider: "apple", sub: "n2", email: "qa2@example.com", emailVerified: false });
    const { user: byId } = await plain.upsertUser({ provider: "email", sub: "f@x.com", email: "f@x.com", emailVerified: true });
    const qa = new Accounts(db, { qaSamplePhotos: `${byId.id},QA@example.com,qa2@example.com` });

    assert.equal((await qa.meView(byId.id))!.qaSamplePhotos, true, "listed by account id");
    assert.equal((await qa.meView(normal.id))!.qaSamplePhotos, true, "listed by verified email (case-insensitive)");
    assert.equal("qaSamplePhotos" in (await qa.meView(unverified.id))!, false, "unverified email never matches");
    assert.equal("qaSamplePhotos" in (await qa.meView(judge.id))!, false, "judge account not listed");
  } finally {
    await db.close();
  }
});

test("QA photos: a dev (judge / shared-token) row never matches by email", async () => {
  const db = await testDb();
  try {
    const plain = new Accounts(db);
    const { user: dev } = await plain.upsertUser({ provider: "dev", sub: "judge:j2", email: "qa@example.com", emailVerified: true });
    const qa = new Accounts(db, { qaSamplePhotos: "qa@example.com" });
    assert.equal("qaSamplePhotos" in (await qa.meView(dev.id))!, false);
  } finally {
    await db.close();
  }
});
