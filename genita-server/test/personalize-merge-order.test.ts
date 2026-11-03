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
