/**
 * Proximity handoff: the iPhone advertises a server-issued token, the Mac reports it held close, the server moves
 * the conversation only for the same account's fresh token while the iPhone owns it in a live call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryOwnershipStore } from "../src/handoff/store.ts";
import { HandoffHub, type HandoffDevice } from "../src/handoff/hub.ts";
import { COOLDOWN_MS, MIN_SEEN_INTERVAL_MS, ProximityBook, TOKEN_TTL_MS, isToken, newToken } from "../src/handoff/proximity.ts";

type Msg = Record<string, any>;
const flush = () => new Promise((r) => setTimeout(r, 5));

function setup(opts: { liveCall?: boolean } = {}) {
  let now = 1_000_000;
  let live = opts.liveCall ?? true;
  const logs: { e: string; d: Record<string, unknown> }[] = [];
  const hub = new HandoffHub(new MemoryOwnershipStore(), (e, d) => logs.push({ e, d }), {
    handoverMs: 0,
    now: () => now,
    liveCall: () => live,
  });
  const open = (user: string, device: HandoffDevice) => {
    const got: Msg[] = [];
    const handle = hub.connect(user, { device, send: (m) => got.push(m) });
    return { got, handle, last: (type: string): any => [...got].reverse().find((m) => m.type === type) };
  };
  return {
    hub,
    logs,
    open,
    tick: (ms: number) => (now += ms),
    setLive: (v: boolean) => (live = v),
  };
}

/** iPhone owns the conversation (a call started there) and is armed; returns its token. */
async function armed(s: ReturnType<typeof setup>, user = "u1") {
  const phone = s.open(user, "iphone");
  const mac = s.open(user, "mac");
  await phone.handle.claim(null, "start");
  await phone.handle.proximityArm();
  const token = phone.last("proximity.token")?.token;
  return { phone, mac, token };
}

test("token: 8 Crockford base32 symbols from 40 random bits", () => {
  const t = newToken();
  assert.ok(isToken(t), t);
  assert.equal(newToken(Buffer.from([0, 0, 0, 0, 0])), "00000000");
  assert.equal(newToken(Buffer.from([255, 255, 255, 255, 255])), "ZZZZZZZZ");
  assert.equal(isToken("ABCDEFGI"), false, "I is not in the alphabet");
  assert.equal(isToken("abcdefgh"), false);
  assert.equal(isToken("ABCDEFG"), false);
  assert.equal(isToken(12345678), false);
});

test("book: re-arm within 5 s keeps the token, later rotates and keeps one previous, expiry, revoke", () => {
  const book = new ProximityBook();
  const conn = {};
  const a = book.issue("u", conn, 3, 0);
  assert.equal(book.issue("u", conn, 3, 1000).token, a.token, "re-arm too soon → same token");
  const b = book.issue("u", conn, 3, 30_000);
  assert.notEqual(b.token, a.token);
  assert.equal((book.find("u", a.token, 30_001) as any).token, a.token, "previous still valid until it expires");
  const c = book.issue("u", conn, 3, 59_000);
  assert.equal(book.find("u", a.token, 59_001), "unknown_token", "only two live tokens");
  assert.equal(book.find("u", c.token, 59_000 + TOKEN_TTL_MS), "expired");
  assert.equal(book.find("other", c.token, 59_001), "unknown_token", "another account never matches");
  book.revoke("u", conn);
  assert.equal(book.find("u", c.token, 59_001), "unknown_token");
});

test("proximity: the same account's Mac sees the token → the conversation moves to the Mac with trigger proximity", async () => {
  const s = setup();
  const { phone, mac, token } = await armed(s);
  assert.ok(isToken(token), "the iPhone got a token");
  assert.equal(phone.last("proximity.token").expiresIn, TOKEN_TTL_MS / 1000);
  s.tick(500);
  await mac.handle.proximitySeen(token);
  await flush();
  assert.deepEqual(mac.last("proximity.result"), { type: "proximity.result", accepted: true, reason: "ok" });
  const own = phone.last("ownership");
  assert.equal(own.owner, "mac");
  assert.equal(own.trigger, "proximity");
  assert.equal((await s.hub.current("u1")).owner, "mac");
  assert.ok(s.logs.some((l) => l.e === "handoff.committed" && l.d.trigger === "proximity"));
  assert.ok(!JSON.stringify(s.logs).includes(token), "tokens are never logged");
});

test("proximity: a fresh account (nobody claimed yet) moves too — the calling iPhone holds it", async () => {
  const s = setup();
  const phone = s.open("u1", "iphone");
  const mac = s.open("u1", "mac");
  await phone.handle.proximityArm();
  const token = phone.last("proximity.token")?.token;
  assert.ok(isToken(token));
  await mac.handle.proximitySeen(token);
  assert.equal(mac.last("proximity.result").accepted, true);
  assert.equal((await s.hub.current("u1")).owner, "mac");
});

test("proximity: a stranger's token or an expired token moves nothing", async () => {
  const s = setup();
  const mine = await armed(s, "u1");
  const theirs = await armed(s, "u2");
  // u1's Mac hears u2's iPhone
  await mine.mac.handle.proximitySeen(theirs.token);
  assert.equal(mine.mac.last("proximity.result").reason, "unknown_token");
  assert.equal((await s.hub.current("u1")).owner, "iphone");
  assert.equal((await s.hub.current("u2")).owner, "iphone");
  // expired
  s.tick(TOKEN_TTL_MS + 1);
  await mine.mac.handle.proximitySeen(mine.token);
  assert.equal(mine.mac.last("proximity.result").reason, "expired");
  assert.equal((await s.hub.current("u1")).owner, "iphone");
});

test("proximity: only while the iPhone owns it, in a live call, with its socket open and in front", async () => {
  const s = setup();
  {
    const { mac, token } = await armed(s, "a");
    s.setLive(false);
    await mac.handle.proximitySeen(token);
    assert.equal(mac.last("proximity.result").reason, "not_in_call");
    s.setLive(true);
  }
  {
    const { phone, mac, token } = await armed(s, "b");
    phone.handle.setActive(false);
    s.tick(MIN_SEEN_INTERVAL_MS);
    await mac.handle.proximitySeen(token);
    assert.equal(mac.last("proximity.result").reason, "unknown_token", "locking the iPhone drops its tokens");
    phone.handle.setActive(true);
    phone.handle.proximityDisarm();
    s.tick(MIN_SEEN_INTERVAL_MS);
    await mac.handle.proximitySeen(token);
    assert.equal(mac.last("proximity.result").reason, "unknown_token", "disarmed");
  }
  {
    const { phone, mac, token } = await armed(s, "c");
    phone.handle.close();
    await mac.handle.proximitySeen(token);
    assert.equal(mac.last("proximity.result").reason, "unknown_token", "iPhone socket closed");
  }
  {
    // the owner changed since the token was issued (a button move and back): the old token is stale
    const { phone, mac, token } = await armed(s, "d");
    await mac.handle.claim(null, "button");
    await phone.handle.claim(null, "continue");
    s.tick(MIN_SEEN_INTERVAL_MS);
    await mac.handle.proximitySeen(token);
    assert.equal(mac.last("proximity.result").reason, "not_owner");
    assert.equal((await s.hub.current("d")).owner, "iphone");
  }
});

test("proximity: arm is refused when the iPhone doesn't own the conversation or no call is live", async () => {
  const s = setup();
  const phone = s.open("u1", "iphone");
  const mac = s.open("u1", "mac");
  await mac.handle.claim(null, "start");
  await phone.handle.proximityArm();
  assert.deepEqual(phone.last("proximity.unavailable"), { type: "proximity.unavailable", reason: "not_owner" });
  assert.equal(phone.last("proximity.token"), undefined);
  await phone.handle.claim(null, "continue");
  s.setLive(false);
  await phone.handle.proximityArm();
  assert.equal(phone.last("proximity.unavailable").reason, "not_in_call");
  // a Mac can't arm, an iPhone can't report
  await mac.handle.proximityArm();
  assert.equal(mac.last("error").code, "bad_message");
  await phone.handle.proximitySeen("ABCDEFGH");
  assert.equal(phone.last("error").code, "bad_message");
});

test("proximity: 10 s cooldown after a move, and a Mac reports at most one token per 200 ms", async () => {
  const s = setup();
  const { phone, mac, token } = await armed(s);
  await mac.handle.proximitySeen(token);
  assert.equal(mac.last("proximity.result").accepted, true);
  // back to the iPhone by tap, arm again, bring it close again at once
  await phone.handle.claim(null, "continue");
  s.tick(MIN_SEEN_INTERVAL_MS);
  await phone.handle.proximityArm();
  const again = phone.last("proximity.token").token;
  assert.notEqual(again, token, "the spent token is not reissued");
  await mac.handle.proximitySeen(again);
  assert.equal(mac.last("proximity.result").reason, "cooldown");
  assert.equal((await s.hub.current("u1")).owner, "iphone");
  await mac.handle.proximitySeen(again);
  assert.equal(mac.last("proximity.result").reason, "rate_limited");
  s.tick(COOLDOWN_MS);
  await mac.handle.proximitySeen(again);
  assert.equal(mac.last("proximity.result").accepted, true, "after the cooldown it moves");
  assert.equal((await s.hub.current("u1")).owner, "mac");
});

test("proximity: a tap, a lock or a disarm that lands while the report waits wins over it (re-checked before the write)", async () => {
  const s = setup();
  {
    const { phone, mac, token } = await armed(s, "a");
    const pending = mac.handle.proximitySeen(token);
    phone.handle.proximityDisarm();
    await pending;
    assert.equal(mac.last("proximity.result").reason, "unknown_token");
    assert.equal((await s.hub.current("a")).owner, "iphone");
  }
  {
    const { phone, mac, token } = await armed(s, "b");
    // a move away and back is still in flight (queued, not written) when the report arrives
    void mac.handle.claim(null, "button");
    void phone.handle.claim(null, "continue");
    const pending = mac.handle.proximitySeen(token);
    await pending;
    await flush();
    assert.equal(mac.last("proximity.result").reason, "not_owner", "a newer claim moved the epoch first");
    assert.equal((await s.hub.current("b")).owner, "iphone", "the iPhone's own tap is the last word");
  }
});

test("proximity: a locked Mac never takes the call", async () => {
  const s = setup();
  const { mac, token } = await armed(s);
  mac.handle.setActive(false);
  await mac.handle.proximitySeen(token);
  assert.equal(mac.last("proximity.result").reason, "mac_inactive");
  assert.equal((await s.hub.current("u1")).owner, "iphone");
});

test("proximity: the report limit is per account, not per socket", async () => {
  const s = setup();
  const { mac, token } = await armed(s);
  const mac2 = s.open("u1", "mac");
  await mac2.handle.proximitySeen("ABCDEFGH");
  await mac.handle.proximitySeen(token);
  assert.equal(mac.last("proximity.result").reason, "rate_limited", "a second Mac socket doesn't reset the limit");
  assert.equal((await s.hub.current("u1")).owner, "iphone");
});

test("proximity: the Mac hears when its iPhone is armed (it scans and asks for Bluetooth only then)", async () => {
  const s = setup();
  const { phone, mac } = await armed(s);
  assert.equal(mac.last("proximity.peer").armed, true);
  const late = s.open("u1", "mac");
  assert.equal(late.last("proximity.peer").armed, true, "a Mac that opens later learns it at once");
  phone.handle.proximityDisarm();
  assert.equal(mac.last("proximity.peer").armed, false);
  await phone.handle.proximityArm();
  assert.equal(mac.last("proximity.peer").armed, true);
  phone.handle.close();
  assert.equal(mac.last("proximity.peer").armed, false, "iPhone gone");
  const other = s.open("u2", "mac");
  assert.equal(other.last("proximity.peer").armed, false, "another account's Mac never hears this one");
});

test("proximity: garbage tokens are a bad_message, never a lookup", async () => {
  const s = setup();
  const { mac } = await armed(s);
  await mac.handle.proximitySeen("not-a-token" as string);
  assert.equal(mac.last("error").code, "bad_message");
  assert.equal(mac.last("proximity.result"), undefined);
});
