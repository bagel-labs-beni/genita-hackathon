import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeUpdates } from "../src/personalize/merge.ts";
import { Personalize, type JsonFn } from "../src/personalize/service.ts";
import { toStyleCard } from "../src/prep/importProfile.ts";

const OLDER = "2026-11-03T01:00:00.000Z";
const MIDDLE = "2026-11-03T01:30:00.000Z";
const LATEST = "2026-11-03T02:00:00.000Z";
const FRESH = "2026-11-03T03:00:00.000Z";
const finding = (text: string, at?: string) => ({ text, label: "explicit" as const, scope: "any", ...(at ? { at } : {}) });
const profile = () => toStyleCard({
  sections: {
    tendencies: [], communication: [], response: [], help: [], support: [], boundaries: [], approach: [],
    likes: [finding("Dislikes cilantro.", LATEST)], interests: [finding("Enjoys jazz.")],
  },
  rules: [], to_confirm: [],
}, "import");

for (const asOf of [OLDER, undefined]) {
  test(`#368: an older duplicate preserves the newest finding (${asOf ? "asOf" : "fallback at"})`, () => {
    const card = profile();
    const result = mergeUpdates(card, [{
      field: "likes", text: "dislikes cilantro!", replaces: [], label: "observed", ...(asOf ? { asOf } : {}),
    }], asOf ? FRESH : OLDER);
    assert.deepEqual(result.card, card);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.staleCards, []);
  });
}

for (const asOf of [LATEST, FRESH]) {
  test(`#368: equal/newer duplicates stay deduplicated and keep explicit evidence (${asOf})`, () => {
    const card = profile();
    const result = mergeUpdates(card, [{ field: "likes", text: "Dislikes cilantro.", replaces: [], label: "observed", asOf }], FRESH);
    assert.equal(result.card.sections.likes.length, 1);
    assert.equal(result.card.sections.likes[0].at, asOf);
    assert.equal(result.card.sections.likes[0].label, "explicit");
    assert.deepEqual(result.card.sections.interests, card.sections.interests);
  });
}

for (const asOf of [OLDER, undefined]) {
  test(`#368 P2: an older explicit duplicate promotes evidence without lowering at (${asOf ? "asOf" : "fallback at"})`, () => {
    const card = profile();
    card.sections.likes[0].label = "observed";
    const result = mergeUpdates(card, [{
      field: "likes", text: "Dislikes cilantro.", replaces: [], label: "explicit", ...(asOf ? { asOf } : {}),
    }], asOf ? FRESH : OLDER);
    assert.deepEqual(result.card.sections.likes, [finding("Dislikes cilantro.", LATEST)]);
    assert.equal(result.applied.length, 1);
    assert.equal(result.applied[0].label, "explicit");
    assert.deepEqual(result.card.sections.interests, card.sections.interests);

    const observed = mergeUpdates(result.card, [{
      field: "likes", text: "Loves cilantro.", replaces: ["Dislikes cilantro."], label: "observed", asOf: FRESH,
    }], FRESH);
    assert.deepEqual(observed.card, result.card);
    assert.deepEqual(observed.applied, []);
  });
}

test("#368 P2: an older duplicate still cannot replace a newer different finding", () => {
  const card = profile();
  card.sections.likes[0].label = "observed";
  card.sections.likes.push(finding("Enjoys parsley.", FRESH));
  const result = mergeUpdates(card, [{
    field: "likes", text: "Dislikes cilantro.", replaces: ["Enjoys parsley."], label: "explicit", asOf: OLDER,
  }], FRESH);
  assert.deepEqual(result.card, card);
  assert.deepEqual(result.applied, []);
});

for (const asOf of [LATEST, undefined]) {
  for (const label of ["explicit", "observed"] as const) {
    test(`#368 review: a delayed duplicate still replaces older lines (${label}, ${asOf ? "asOf" : "fallback at"})`, () => {
      const card = profile();
      const jazz = { ...finding("Loves jazz.", FRESH), label, scope: "music" };
      card.sections.likes = [jazz, finding("Loves rock.", OLDER)];
      const result = mergeUpdates(card, [{
        field: "likes", text: "loves jazz!", replaces: ["Loves rock."], label: "explicit", ...(asOf ? { asOf } : {}),
      }], LATEST);

      assert.deepEqual(result.card.sections.likes, [{ ...jazz, label: "explicit" }]);
      assert.deepEqual(result.card.removed, [{ field: "likes", text: "Loves rock.", at: LATEST }]);
      assert.equal(result.applied.length, 1);
      assert.deepEqual(result.applied[0].removed, ["Loves rock."]);
      assert.deepEqual(result.staleCards, ["taste"]);
      assert.deepEqual(result.card.sections.interests, card.sections.interests);

      const stale = mergeUpdates(result.card, [{
        field: "likes", text: "Loves rock.", replaces: [], label: "explicit", asOf: MIDDLE,
      }], FRESH);
      assert.deepEqual(stale.card, result.card);
      assert.deepEqual(stale.applied, []);
    });
  }
}

for (const answerText of ["I love jazz.", "i love jazz!"]) {
  test(`#368 review: a delayed voice answer stays Noted when a newer duplicate is stored (${answerText})`, { timeout: 5000 }, async () => {
    const card = profile();
    card.sections.tendencies = [finding("Compares two concrete options before deciding.")];
    card.toConfirm = ["Music", "Weekend plans"];
    const styles = new Map([["u1", card], ["u2", profile()]]);
    const untouched = structuredClone(styles.get("u2"));
    let finishAnalysis!: (value: unknown) => void;
    let ready!: () => void;
    const analysisStarted = new Promise<void>((resolve) => { ready = resolve; });
    let now = OLDER;
    const p = new Personalize({
      store: {
        getStyle: async (id) => structuredClone(styles.get(id) ?? null),
        putStyle: async (id, stored) => { styles.set(id, structuredClone(stored)); },
        getCompanion: async () => null,
      },
      now: () => new Date(now),
      json: (async (req) => {
        assert.equal(req.schemaName, "profile_correction");
        if (now === MIDDLE) return new Promise<unknown>((resolve) => { finishAnalysis = resolve; ready(); });
        return { updates: [{ field: "interests", text: "I love jazz.", replaces: [], chip: "jazz" }] };
      }) as JsonFn,
    });
    const start = await p.startCall("u1");
    assert.equal(start!.askItem, "Music");
    now = MIDDLE;
    const delayed = p.voiceCorrection("u1", "Jazz is my favorite.", "What music do you like?", undefined, start!.askTopic);
    await analysisStarted;
    now = LATEST;
    assert.ok(await p.voiceCorrection("u1", "Actually I love jazz."));
    const corrected = structuredClone(styles.get("u1")!);

    now = FRESH;
    finishAnalysis({ updates: [], answered: { field: "interests", text: answerText, chip: "jazz" } });
    const result = await delayed;
    assert.equal(result!.answered, true);
    assert.deepEqual(result!.events, [{ text: "Noted: jazz", fields: ["interests"] }]);
    assert.deepEqual(styles.get("u1")!.sections, corrected.sections);
    assert.deepEqual(styles.get("u1")!.toConfirm, ["Weekend plans"]);
    assert.deepEqual(styles.get("u1")!.growth, { calls: 1, asked: [{ item: "Music", at: OLDER, answered: true }] });
    assert.deepEqual(styles.get("u2"), untouched);
  });
}

test("#368 P2: delayed explicit call evidence promotes a noteShorter observation", { timeout: 5000 }, async () => {
  const styles = new Map([["u1", profile()], ["u2", profile()]]);
  const untouched = structuredClone(styles.get("u2"));
  const short = "Short replies, one or two sentences.";
  let finishAnalysis!: (value: unknown) => void;
  let ready!: () => void;
  const analysisStarted = new Promise<void>((resolve) => { ready = resolve; });
  let now = LATEST;
  const p = new Personalize({
    store: {
      getStyle: async (id) => structuredClone(styles.get(id) ?? null),
      putStyle: async (id, card) => { styles.set(id, structuredClone(card)); },
      getCompanion: async () => null,
    },
    now: () => new Date(now),
    json: (async (req) => {
      assert.equal(req.schemaName, "call_profile_updates");
      if (now === FRESH) return { updates: [{ field: "response", text: "Long replies with detailed explanations.", replaces: [short], label: "observed", times: 2 }] };
      return new Promise<unknown>((resolve) => { finishAnalysis = resolve; ready(); });
    }) as JsonFn,
  });
  const turns = [{ role: "user" as const, text: "Please keep replies short." }, { role: "user" as const, text: "One or two sentences is enough." }];
  const delayed = p.endCall("u1", turns, null, OLDER);
  await analysisStarted;
  assert.ok(await p.noteShorter("u1"));
  assert.equal(styles.get("u1")!.sections.response[0].label, "observed");

  finishAnalysis({ updates: [{ field: "response", text: short, replaces: [], label: "explicit", times: 2 }] });
  assert.equal(await delayed, 1);
  assert.deepEqual(styles.get("u1")!.sections.response, [finding(short, LATEST)]);

  now = FRESH;
  assert.equal(await p.endCall("u1", turns, null, FRESH), 0);
  assert.deepEqual(styles.get("u1")!.sections.response, [finding(short, LATEST)]);
  assert.deepEqual(styles.get("u2"), untouched);
});

for (const answerText of ["I love jazz.", "i love jazz!"]) {
  test(`#368 P2: a delayed duplicate still completes the call's Music answer (${answerText})`, { timeout: 5000 }, async () => {
    const card = profile();
    card.sections.tendencies = [finding("Compares two concrete options before deciding.")];
    card.toConfirm = ["Music", "Weekend plans"];
    const styles = new Map([["u1", card], ["u2", profile()]]);
    const untouched = structuredClone(styles.get("u2"));
    let finishAnalysis!: (value: unknown) => void;
    let ready!: () => void;
    const analysisStarted = new Promise<void>((resolve) => { ready = resolve; });
    let now = OLDER;
    const p = new Personalize({
      store: {
        getStyle: async (id) => structuredClone(styles.get(id) ?? null),
        putStyle: async (id, card) => { styles.set(id, structuredClone(card)); },
        getCompanion: async () => null,
      },
      now: () => new Date(now),
      json: (async (req) => {
        if (req.schemaName === "call_profile_updates") {
          return new Promise<unknown>((resolve) => { finishAnalysis = resolve; ready(); });
        }
        assert.equal(req.schemaName, "profile_correction");
        return { updates: [{ field: "interests", text: "I love jazz.", replaces: [], chip: "jazz" }] };
      }) as JsonFn,
    });
    const start = await p.startCall("u1");
    assert.equal(start!.askItem, "Music");
    now = MIDDLE;
    const delayed = p.endCall("u1", [
      { role: "user", text: "I love jazz." }, { role: "user", text: "Jazz is my favorite music." },
    ], start!.askItem!, OLDER);
    await analysisStarted;
    now = LATEST;
    assert.ok(await p.voiceCorrection("u1", "Actually I love jazz."));
    const corrected = structuredClone(styles.get("u1")!);
    assert.deepEqual(corrected.sections.interests[0], finding("I love jazz.", LATEST));
    assert.ok(corrected.toConfirm.includes("Music"));
    assert.equal(corrected.growth!.asked[0].answered, undefined);

    now = FRESH;
    finishAnalysis({ updates: [], answered: { item: "Music", field: "interests", text: answerText } });
    const applied = await delayed;
    const stored = styles.get("u1")!;
    assert.deepEqual(stored.toConfirm, ["Weekend plans"]);
    assert.deepEqual(stored.growth, { calls: 1, asked: [{ item: "Music", at: OLDER, answered: true }] });
    assert.deepEqual(stored.sections, corrected.sections);
    assert.equal(stored.updatedAt, FRESH);
    assert.equal(applied, 1);
    assert.deepEqual(styles.get("u2"), untouched);
  });
}

// Real Personalize service + in-memory store; only the structured analysis is faked.
for (const duplicate of [false, true]) {
  test(`#368: delayed call analyses preserve a later voice correction (${duplicate ? "duplicate" : "control"})`, { timeout: 5000 }, async () => {
    const styles = new Map([["u1", profile()], ["u2", profile()]]);
    const untouched = structuredClone(styles.get("u2"));
    const pending: Array<(value: unknown) => void> = [];
    let ready!: () => void;
    const analysesStarted = new Promise<void>((resolve) => { ready = resolve; });
    let now = LATEST;
    let correction = "Dislikes cilantro.";
    const p = new Personalize({
      store: {
        getStyle: async (id) => structuredClone(styles.get(id) ?? null),
        putStyle: async (id, card) => { styles.set(id, structuredClone(card)); },
        getCompanion: async () => null,
      },
      now: () => new Date(now),
      json: (async (req) => {
        if (req.schemaName === "call_profile_updates") {
          return new Promise<unknown>((resolve) => {
            pending.push(resolve);
            if (pending.length === 2) ready();
          });
        }
        assert.equal(req.schemaName, "profile_correction");
        return { updates: [{ field: "likes", text: correction, replaces: [], chip: "cilantro" }] };
      }) as JsonFn,
    });
    const older = p.endCall("u1", [
      { role: "user", text: "I dislike cilantro." }, { role: "user", text: "Please leave cilantro out." },
    ], null, OLDER);
    const middle = p.endCall("u1", [
      { role: "user", text: "I love cilantro now." }, { role: "user", text: "Put cilantro in my meals." },
    ], null, MIDDLE);
    await analysesStarted;
    await p.voiceCorrection("u1", "Actually I dislike cilantro.");
    const corrected = structuredClone(styles.get("u1")!);
    assert.equal(corrected.sections.likes[0].at, LATEST);

    pending[0]({ updates: duplicate ? [{ field: "likes", text: "Dislikes cilantro.", replaces: [], label: "explicit", times: 2 }] : [] });
    const olderApplied = await older;
    const afterDuplicate = structuredClone(styles.get("u1")!);
    pending[1]({ updates: [{ field: "likes", text: "Loves cilantro.", replaces: ["Dislikes cilantro."], label: "explicit", times: 2 }] });
    const middleApplied = await middle;
    assert.deepEqual([afterDuplicate.sections.likes, styles.get("u1")!.sections.likes], [corrected.sections.likes, corrected.sections.likes]);
    assert.deepEqual([olderApplied, middleApplied], [0, 0]);

    now = FRESH;
    correction = "Loves cilantro.";
    await p.voiceCorrection("u1", "Actually I love cilantro now.");
    assert.deepEqual(styles.get("u1")!.sections.likes, [finding("Loves cilantro.", FRESH)]);
    assert.deepEqual(styles.get("u1")!.sections.interests, corrected.sections.interests);
    assert.deepEqual(styles.get("u2"), untouched);
  });
}
