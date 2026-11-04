/**
 * F6-L7 · conversation layer: who holds the sound (active_device) and the epoch order.
 * Rules (PRD F6, board "이동 동작 표"): the highest epoch wins; equal epochs with different
 * owners → the Mac wins; opening the app is never a claim; a lock or a dropped socket
 * keeps the owner; the server stops the current device before the new one gets sound.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimWins, asDevice, validEpoch, type Ownership } from "../src/handoff/rules.ts";
import { MemoryOwnershipStore, PgOwnershipStore, type OwnershipStore } from "../src/handoff/store.ts";
import { HandoffHub, type HandoffDevice } from "../src/handoff/hub.ts";
import { Accounts } from "../src/auth/accounts.ts";
import { testDb } from "./helpers/db.ts";

const o = (owner: Ownership["owner"], epoch: number): Ownership => ({ owner, epoch });

test("rules: the newest claim wins, a tie goes to the Mac, stale claims lose", () => {
  assert.equal(claimWins(o("iphone", 3), { owner: "mac", epoch: 4 }), true);
  assert.equal(claimWins(o("mac", 4), { owner: "iphone", epoch: 3 }), false, "older claim arriving late");
  assert.equal(claimWins(o("iphone", 4), { owner: "mac", epoch: 4 }), true, "tie → Mac");
  assert.equal(claimWins(o("mac", 4), { owner: "iphone", epoch: 4 }), false, "tie → Mac");
  assert.equal(claimWins(o("mac", 4), { owner: "mac", epoch: 4 }), false, "same claim twice is not a change");
  assert.equal(claimWins(o(null, 4), { owner: "iphone", epoch: 4 }), true, "a claim beats a release at the same epoch");
  assert.equal(asDevice("phone"), "iphone");
  assert.equal(asDevice("iphone"), "iphone");
  assert.equal(asDevice("mac"), "mac");
  assert.equal(asDevice("web"), null);
  assert.equal(validEpoch(3), 3);
  assert.equal(validEpoch(-1), null);
  assert.equal(validEpoch(1.5), null);
  assert.equal(validEpoch(2 ** 31), null, "fits the integer column");
  assert.equal(validEpoch("4"), null);
});

async function stores(): Promise<{ name: string; store: OwnershipStore; user: string; done: () => Promise<void> }[]> {
  const db = await testDb();
  const { user } = await new Accounts(db).upsertUser({ provider: "dev", sub: "handoff" });
  return [
    { name: "memory", store: new MemoryOwnershipStore(), user: "u1", done: async () => {} },
    { name: "postgres", store: new PgOwnershipStore(db), user: user.id, done: () => db.close() },
  ];
}

test("store: claim, tie, stale, release and the server-assigned epoch (memory and Postgres agree)", async () => {
  for (const { name, store, user, done } of await stores()) {
    try {
      const first = await store.load(user);
      assert.equal(first.owner, null, name);
      assert.equal(first.epoch, 0, name);
      assert.ok(first.conversationId, name);
      const a = await store.claim(user, "mac", null);
      assert.deepEqual([a.accepted, a.state.owner, a.state.epoch], [true, "mac", 1], name);
      const stale = await store.claim(user, "iphone", 1);
      assert.deepEqual([stale.accepted, stale.state.owner, stale.state.epoch], [false, "mac", 1], `${name}: tie → Mac`);
      const b = await store.claim(user, "iphone", 2);
      assert.deepEqual([b.accepted, b.state.owner, b.state.epoch], [true, "iphone", 2], name);
      const late = await store.claim(user, "mac", 1);
      assert.deepEqual([late.accepted, late.state.owner], [false, "iphone"], `${name}: stale`);
      const notOwner = await store.release(user, "mac", null);
      assert.equal(notOwner.accepted, false, `${name}: only the owner releases`);
      const rel = await store.release(user, "iphone", 2);
      assert.deepEqual([rel.accepted, rel.state.owner, rel.state.epoch], [true, null, 3], name);
      assert.equal((await store.load(user)).conversationId, first.conversationId, `${name}: same conversation row`);
    } finally {
      await done();
    }
  }
});

test("store: two devices claim at once from the same epoch → both orders end on the Mac", async () => {
  for (const { name, store, user, done } of await stores()) {
    try {
      for (let round = 0; round < 6; round++) {
        const base = (await store.load(user)).epoch;
        const claims = round % 2 ? [store.claim(user, "iphone", base + 1), store.claim(user, "mac", base + 1)] : [store.claim(user, "mac", base + 1), store.claim(user, "iphone", base + 1)];
        await Promise.all(claims);
        const s = await store.load(user);
        assert.deepEqual([s.owner, s.epoch], ["mac", base + 1], `${name} round ${round}`);
      }
    } finally {
      await done();
    }
  }
});

// ───────────────────────── hub ─────────────────────────

type Sent = Record<string, any>;
function device(hub: HandoffHub, user: string, d: HandoffDevice) {
  const got: Sent[] = [];
  const conn = hub.connect(user, { device: d, send: (m) => got.push(m) });
  return { conn, got, last: (type: string) => [...got].reverse().find((m) => m.type === type) };
}
function call(hub: HandoffHub, user: string, d: HandoffDevice, timeline: string[]) {
  const got: Sent[] = [];
  let stops = 0;
  const handle = hub.attachCall(user, d, {
    stop: () => {
      stops++;
      timeline.push(`${d}.stop`);
    },
    send: (m) => got.push(m),
  });
  return { handle, got, stops: () => stops };
}

test("hub: opening the app is never a claim; hello with an old epoch adopts the server's owner", async () => {
  const hub = new HandoffHub(new MemoryOwnershipStore());
  const mac = device(hub, "u", "mac");
  await mac.conn.claim(null, "button");
  const phone = device(hub, "u", "iphone");
  await phone.conn.hello({ owner: "iphone", epoch: 0 });
  assert.deepEqual(hub.ownership("u"), { owner: "mac", epoch: 1 });
  assert.deepEqual([phone.last("ownership")?.owner, phone.last("ownership")?.epoch], ["mac", 1]);
  await phone.conn.hello({});
  assert.equal(hub.ownership("u")?.owner, "mac", "a bare hello does not move anything");
});

test("hub: a tap made offline (newer epoch) is applied on reconnect; the other device is told", async () => {
  const hub = new HandoffHub(new MemoryOwnershipStore());
  const mac = device(hub, "u", "mac");
  await mac.conn.claim(null, "button"); // mac @1
  const phone = device(hub, "u", "iphone");
  await phone.conn.hello({ owner: "iphone", epoch: 2 }); // tapped Continue here while the server was away
  assert.deepEqual(hub.ownership("u"), { owner: "iphone", epoch: 2 });
  assert.equal(mac.last("ownership")?.owner, "iphone");
  assert.equal(mac.last("ownership")?.trigger, "sync");
});

test("hub: lock and disconnect keep the owner; the other device sees the peer state", async () => {
  const hub = new HandoffHub(new MemoryOwnershipStore());
  const phone = device(hub, "u", "iphone");
  const mac = device(hub, "u", "mac");
  await mac.conn.claim(null, "button");
  phone.conn.setActive(false); // iPhone locked
  assert.equal(hub.ownership("u")?.owner, "mac");
  assert.deepEqual(mac.last("peer"), { type: "peer", device: "iphone", online: true, active: false, inCall: false });
  phone.conn.close();
  assert.equal(hub.ownership("u")?.owner, "mac", "socket gone, Mac keeps talking");
  assert.deepEqual(mac.last("peer"), { type: "peer", device: "iphone", online: false, active: false, inCall: false });
  // and the other way: the owner iPhone locks → the Mac never takes it by itself
  const hub2 = new HandoffHub(new MemoryOwnershipStore());
  const p2 = device(hub2, "v", "iphone");
  const m2 = device(hub2, "v", "mac");
  await p2.conn.claim(null, "start");
  p2.conn.setActive(false);
  p2.conn.close();
  await m2.conn.hello({ owner: "mac", epoch: 0 });
  assert.equal(hub2.ownership("v")?.owner, "iphone");
});

test("hub: the Mac hears peer.inCall only while the iPhone has a started call (QA 171: no 'Talking' without a call)", () => {
  const hub = new HandoffHub(new MemoryOwnershipStore());
  const phone = device(hub, "u", "iphone");
  const mac = device(hub, "u", "mac");
  assert.equal(mac.last("peer")?.inCall, false, "app open, no call");
  const end = hub.callStarted("u", "iphone");
  assert.deepEqual(mac.last("peer"), { type: "peer", device: "iphone", online: true, active: true, inCall: true });
  assert.equal(phone.last("peer")?.inCall, false, "the iPhone's own call is not announced back to it");
  const second = hub.callStarted("u", "iphone"); // a reconnect overlaps the old socket
  const sent = mac.got.length;
  end();
  end(); // idempotent
  assert.equal(mac.got.length, sent, "still one call open: nothing changes");
  second();
  assert.equal(mac.last("peer")?.inCall, false, "last call closed");
  // a Mac that connects mid-call learns it at once
  const end2 = hub.callStarted("u", "iphone");
  const late = device(hub, "u", "mac");
  assert.equal(late.last("peer")?.inCall, true);
  end2();
});

test("hub: a Mac that connects mid-call hears inCall at once, even with the iPhone's presence socket closed (Codex P2 #480)", () => {
  const hub = new HandoffHub(new MemoryOwnershipStore());
  const end = hub.callStarted("u", "iphone"); // call socket up, presence socket dropped / reconnecting
  const mac = device(hub, "u", "mac");
  assert.deepEqual(mac.last("peer"), { type: "peer", device: "iphone", online: false, active: false, inCall: true });
  end();
  assert.equal(mac.last("peer")?.inCall, false);
  // two iPhone presence sockets: the joining Mac gets the iPhone's state once, not once per socket
  device(hub, "u", "iphone");
  device(hub, "u", "iphone");
  const mac2 = device(hub, "u", "mac");
  assert.equal(mac2.got.filter((m) => m.type === "peer").length, 1);
  // nothing open on the other side: no peer message at all (unchanged)
  const lone = device(hub, "solo", "mac");
  assert.equal(lone.last("peer"), undefined);
});

test("hub: move request is relayed to the other device; offline or locked target fails at once", async () => {
  const hub = new HandoffHub(new MemoryOwnershipStore());
  const phone = device(hub, "u", "iphone");
  await phone.conn.claim(null, "start");
  phone.conn.moveRequest("mac");
  assert.deepEqual(phone.last("move.failed"), { type: "move.failed", to: "mac", reason: "peer_offline" });
  const mac = device(hub, "u", "mac");
  phone.conn.moveRequest("mac");
  assert.deepEqual(mac.last("move.request"), { type: "move.request", from: "iphone" });
  await mac.conn.claim(null, "button");
  assert.equal(phone.last("ownership")?.owner, "mac");
  phone.conn.setActive(false);
  mac.conn.moveRequest("iphone");
  assert.deepEqual(mac.last("move.failed"), { type: "move.failed", to: "iphone", reason: "peer_inactive" });
});

test("hub: sound only on the owner; the old device is stopped before the new one may play", async () => {
  const hub = new HandoffHub(new MemoryOwnershipStore(), () => {}, { handoverMs: 0 }); // the lease has its own test
  const timeline: string[] = [];
  const phone = device(hub, "u", "iphone");
  const mac = device(hub, "u", "mac");
  const pc = call(hub, "u", "iphone", timeline);
  const mc = call(hub, "u", "mac", timeline);
  await pc.handle.started(); // first call on a fresh conversation takes it
  assert.deepEqual(hub.ownership("u"), { owner: "iphone", epoch: 1 });
  await mc.handle.started(); // a second device starting its call does not steal
  assert.equal(hub.ownership("u")?.owner, "iphone");
  assert.equal(pc.handle.mayPlay(), true);
  assert.equal(mc.handle.mayPlay(), false);

  let sampled: [boolean, boolean][] = [];
  const pending = mac.conn.claim(null, "button");
  sampled.push([pc.handle.mayPlay(), mc.handle.mayPlay()]); // while the claim is in flight
  timeline.push("claim.sent");
  await pending;
  sampled.push([pc.handle.mayPlay(), mc.handle.mayPlay()]);
  assert.deepEqual(sampled, [
    [false, false],
    [false, true],
  ]);
  assert.equal(pc.stops(), 1);
  assert.equal(mc.stops(), 0);
  assert.equal(timeline[0], "iphone.stop", "stopped before anything else happened");
  assert.equal(pc.got.at(-1)?.type, "ownership", "the call socket hears the move too");
  assert.equal(phone.last("claim.result"), undefined, "only the claimer gets claim.result");
  assert.deepEqual([mac.last("claim.result")?.accepted, mac.last("claim.result")?.epoch], [true, 2]);
  sampled = [];
  void phone;
});

test("hub: 10 round trips with racing taps never let two devices play at once (memory and Postgres)", async () => {
  for (const { name, store, user: u, done } of await stores()) {
  const hub = new HandoffHub(store);
  const timeline: string[] = [];
  const phone = device(hub, u, "iphone");
  const mac = device(hub, u, "mac");
  const pc = call(hub, u, "iphone", timeline);
  const mc = call(hub, u, "mac", timeline);
  await pc.handle.started();
  let both = 0;
  const probe = setInterval(() => {
    if (pc.handle.mayPlay() && mc.handle.mayPlay()) both++;
  }, 0);
  for (let i = 0; i < 10; i++) {
    await mac.conn.claim(null, "button");
    if (pc.handle.mayPlay() && mc.handle.mayPlay()) both++;
    await phone.conn.claim(null, "button");
    if (pc.handle.mayPlay() && mc.handle.mayPlay()) both++;
    // a race: both tap Continue here from the same epoch
    const e = hub.ownership(u)!.epoch;
    await Promise.all([phone.conn.claim(e + 1, "button"), mac.conn.claim(e + 1, "button")]);
    if (pc.handle.mayPlay() && mc.handle.mayPlay()) both++;
    assert.equal(hub.ownership(u)?.owner, "mac", `${name} race ${i} converges on the Mac`);
    assert.equal(phone.last("ownership")?.owner, "mac");
    assert.equal(mac.last("ownership")?.owner, "mac");
  }
  clearInterval(probe);
  assert.equal(both, 0, "two devices never had the sound at the same time");
  assert.equal(hub.ownership(u)?.epoch, 22, "start 1, first loop +3, then +2 a loop (the owner re-claiming is a no-op)");
  await done();
  }
});

test("hub: a reconnecting call or device re-reads the stored owner (server restart)", async () => {
  const store = new MemoryOwnershipStore();
  const hub = new HandoffHub(store);
  const mac = device(hub, "u", "mac");
  await mac.conn.claim(null, "button");
  const fresh = new HandoffHub(store); // new process, same database
  const phone = device(fresh, "u", "iphone");
  await phone.conn.hello({});
  assert.deepEqual([phone.last("ownership")?.owner, phone.last("ownership")?.epoch], ["mac", 1]);
  const pc = call(fresh, "u", "iphone", []);
  await pc.handle.started();
  assert.equal(pc.handle.mayPlay(), false, "the iPhone's call does not take it back");
});

test("hub: release leaves nobody holding the sound until the next start", async () => {
  const hub = new HandoffHub(new MemoryOwnershipStore());
  const phone = device(hub, "u", "iphone");
  const pc = call(hub, "u", "iphone", []);
  await pc.handle.started();
  await phone.conn.release(null);
  assert.deepEqual(hub.ownership("u"), { owner: null, epoch: 2 });
  assert.equal(pc.handle.mayPlay(), false);
  assert.equal(pc.stops(), 1);
  const mc = call(hub, "u", "mac", []);
  await mc.handle.started();
  assert.deepEqual(hub.ownership("u"), { owner: "mac", epoch: 3 });
});

// ───────────────────────── Codex review 11/2 ─────────────────────────

test("review P1: the new owner gets a short handover lease after the old device was stopped", async () => {
  const hub = new HandoffHub(new MemoryOwnershipStore(), () => {}, { handoverMs: 40 });
  const pc = call(hub, "u", "iphone", []);
  const mc = call(hub, "u", "mac", []);
  const mac = device(hub, "u", "mac");
  await pc.handle.started();
  await mac.conn.claim(null, "button");
  assert.deepEqual([pc.handle.mayPlay(), mc.handle.mayPlay()], [false, false], "nobody plays while the old device drains its queue");
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual([pc.handle.mayPlay(), mc.handle.mayPlay()], [false, true]);
});

test("review P2: a call start racing an explicit claim never takes the conversation back", async () => {
  const hub = new HandoffHub(new MemoryOwnershipStore());
  const mac = device(hub, "u", "mac");
  const pc = call(hub, "u", "iphone", []);
  await hub.current("u");
  await Promise.all([mac.conn.claim(null, "button"), pc.handle.started()]);
  assert.equal(hub.ownership("u")?.owner, "mac");
});

test("review P2: a stale release is rejected without cancelling the owner's reply", async () => {
  const hub = new HandoffHub(new MemoryOwnershipStore());
  const mac = device(hub, "u", "mac");
  const mc = call(hub, "u", "mac", []);
  await mac.conn.claim(3, "button");
  const out = await mac.conn.release(1);
  assert.equal(out.accepted, false);
  assert.equal(mc.stops(), 0, "the reply keeps going");
});

test("review P2: only ?device= opts a call into the gate; the token's device alone does not", async () => {
  const { gatedCallDevice } = await import("../src/handoff/routes.ts");
  assert.equal(gatedCallDevice("mac", new URL("ws://x/v1/session")), null, "signed-in older Mac build: not gated");
  assert.equal(gatedCallDevice("mac", new URL("ws://x/v1/session?device=mac")), "mac");
  assert.equal(gatedCallDevice("iphone", new URL("ws://x/v1/session?device=mac")), "iphone", "the token wins when both are present");
  assert.equal(gatedCallDevice("dev", new URL("ws://x/v1/session?device=phone")), "iphone");
});

test("hub: a device locking tells its calls (the Mac's share stops), unless another app of it is still active", () => {
  const hub = new HandoffHub(new MemoryOwnershipStore());
  const macA = device(hub, "u", "mac");
  const macB = device(hub, "u", "mac");
  const locked: HandoffDevice[] = [];
  hub.attachCall("u", "mac", { stop: () => {}, send: () => {}, inactive: () => locked.push("mac") });
  hub.attachCall("u", "iphone", { stop: () => {}, send: () => {}, inactive: () => locked.push("iphone") });
  macA.conn.setActive(false);
  assert.deepEqual(locked, [], "the other Mac is still active");
  macB.conn.setActive(false);
  assert.deepEqual(locked, ["mac"], "only the Mac's call hears it");
});
