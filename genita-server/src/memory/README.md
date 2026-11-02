# Genita memory lane — F7-L1/L2/L5/L6, F9-L1, F5-L17

> **Hackathon build (D40, 11/2):** Us photo and seen memory are cut. `createMemory` turns them on only with `GENITA_US_PHOTOS=1` / `GENITA_SEEN_MEMORY=1`; otherwise `POST /v1/us-photos` answers 404 `feature_off` and `rememberSeen` saves nothing. General memory and the revisit greeting stay on.

Implementation is in this folder; shared edits are the session hooks, Spark
function-call parsing, route registration and additive PROTOCOL documentation.
No database migrations, app changes, deployment, push or PR are part of this lane.

## Runtime and privacy boundary

- Four **completed user/assistant pairs** schedule extraction; call close flushes
  the remaining 1–3. New turns only, no imported history/camera bytes. Work runs
  asynchronously, one extraction at a time per call. Failure is swallowed and
  the next batch can proceed. No network await for extraction on the reply path.
- `memoryExtract` uses the existing `sparkJson`/Muse Spark 1.3 client. The schema
  separates `fact`/`episode`, sensitivity and whether an episode supports a follow-up.
  Model policy plus a conservative local filter reject sensitive storage. Explicit
  `remember` additionally uses a structured safety classification in production.
- `recall(query)` returns at most three token-overlap matches, ranked by overlap
  then recency, with `last_used_at`. It does not provide vector/semantic search.
  Tools execute above the Spark hedge, once per winning call. Speculative Spark
  still runs early; its tool effects wait for the matching accepted final
  transcript, so a partial transcript cannot invoke a durable write.
  Interpretation neither reads memory nor exposes tools/extracts translated turns.
- Forget increments a persisted revision, clears a call's pending extraction and
  cancels active replies/history. Completed stale upserts are blocked by persistent
  normalized-text hash tombstones. Changed *new* statements can create new memories;
  this is not semantic erasure of unrelated/rephrased facts across all future speech.
- Metadata (last user-message time, last three opening words, settings, UTC daily
  photo quota/opener guard) is separate from the memory-table interface. No original
  conversation transcript is retained between calls.
- An episode opener requires the configured gap from the last user message, a
  different source call and `follow_up=true`; a seen crop >=6h old takes priority.
  One opener per UTC day; no eligible episode means an ordinary greeting. The
  existing code opener guard applies to generated speech/captions, including greetings.

The routes are for the authenticated Genita app. Shared bearer auth is a **single
local user** until F1. Inject `startServer(config,log,deps,resolveUser)` with verified
JWT identity for multiple accounts. Neither body/query identity nor app memory
snapshots are trusted. JSON is capped, photo requests reserve a per-user quota
before calling the vendor, and no keys/raw vendor errors are returned or logged by
this module. A forged `companion_face`, `scene_image`, `room` or `user_face` field is
rejected by the photo route.

## Persistence / Postgres adapter

`MemoryRepository` is exactly `put(userId,memory):Promise<boolean>`,
`list(userId):Promise<Memory[]>`, `delete(userId,id?):Promise<void>`.
`put` upserts by `memoryId(text)` and preserves the creation timestamp; false means
a deletion tombstone blocked it. `delete` must preserve tombstones durably, and
`list` must exclude them. User isolation belongs in every adapter operation.
`CallStateRepository.getState/putState` is a separate session/settings/quota boundary.

`InMemoryMemoryRepository` and `JsonMemoryRepository` implement both. JSON uses a
serial queue, 0600 files and atomic rename; corruption fails closed. Set
`GENITA_MEMORY_FILE=./.memory/memories.json` to persist; otherwise it is in-memory.
The file adapter is **single-process/single-owner**. Postgres must add transactional
locking across workers for state/quota and Forget revision checks (the service's
in-process locks are insufficient for a multi-worker deployment).

## Trusted vision integration (F5 lane)

The runtime returned by `createMemory(key,log)` includes `memory` and `crops`.
Call the following only from a trusted server vision adapter, after actually
discussing the object and inspecting the crop for sensitive content:

```ts
if ((await memory.settings(userId)).rememberSeen) {
  const crop = await crops.put(userId, croppedJpegBytes, {
    source: "sam-3.1", box: [nx1, ny1, nx2, ny2], safeObject: true,
  });
  const saved = await memory.rememberSeen(userId,
    { sessionId, discussedText: actualConversationText },
    { object: "kimchi", line: "I showed a kimchi tub.", crop });
  if (!saved) await crops.delete(userId, crop.image_ref);
}
```

The caller supplies already-cropped pixels, **never the original**. `crops.put`
checks PNG/JPEG header dimensions <=480px, stores only the crop and SAM provenance,
and returns an opaque user-owned ref. The storage reference/provenance must match
on save. Object text must occur in the actual discussed text; sensitive labels,
summaries and unsafe metadata are rejected, with a cap of three saves per call
(Forget does not refund it). Original photos, full-frame URLs and arbitrary client
crop refs have no public write endpoint. Pixel classification is the F5 adapter's
responsibility, not something SAM boxes or header checks can prove.

For persistent crop storage, `createMemory` uses `memory-assets/` next to the JSON
file; otherwise crops are in memory. Forget deletes both crop bytes and sidecar.
The storage owner must provide equivalent `verifyCrop`/`deleteCrop` hooks if using
a different blob backend.

## Us photo / prep and Finds integration

`UsPhotoService` accepts an approved companion face buffer and a **text** scene
description, never a user image or room frame. It calls the existing Muse Image
1.0 `/images/edits` adapter once and runs a strict Spark image comparison. An
uncertain/changed face returns only `face_mismatch`, never the generated bytes.
Three attempts per UTC day includes failed/uncertain generations; scene IDs are
idempotent within that day. A mid-generation opt-out also suppresses the output.

The public `POST /v1/us-photos` uses `companion_id`, not uploaded face bytes. The
prep/storage lane must inject `deps.resolveCompanionFace(userId,companionId)`; it
must return only that user's approved companion reference. Missing integration
returns 503; this lane deliberately cannot substitute camera/user photos. The
Finds owner saves a `ready` result only, after scene end and card close. Returned
bytes are not stored in memory records. Human face consistency approval remains
Chelsea's acceptance gate.

## Checks (from genita-server/)

```sh
npm test
npx tsc --noEmit
npm run eval:memory
```

`evals/memory/fixtures.json` contains five **synthetic** structured-output cases.
The offline eval checks labelled concept precision/recall, three retained facts,
grocery episode selection on a new call, and zero recall/openers after Forget,
including extraction replay. It measures the fixture pipeline, not live Spark
quality or whether a real spoken greeting follows instructions.

Live checks run only with explicit opt-in, loading keys from
`~/.config/genita/meta.env` (or `GENITA_ENV_FILE`) without printing them:

```sh
npm run check:memory -- --live
```

This runs five synthetic grocery extractions and real new-call greetings. Optional
photos for the fridge/drama/outfit scenarios use only an approved companion image:

```sh
npm run check:memory -- --live --photo-face=/path/to/approved-companion.png
```

Photos go to ignored `.memory-vendor/`; changed faces are not written. These checks
incur vendor calls. They are not part of `npm test` and were not run by default.

## Review handoff

Remaining external work: F1 JWT resolver, Postgres/state transactions, F5's real
crop/pixel-safety producer, prep companion-face resolver, Finds persistence/app
toggles, opt-in real vendor measurements and Chelsea's three-scene face review.
Unit tests prove local contracts; no live-vendor or human acceptance is claimed.

Git staging/commits in this managed session were blocked because `.git` points to
`../genita-read/.git/worktrees/genita-memory` outside the writable worktree.
`git fetch` was denied on `FETCH_HEAD`; `git add` was denied on `index.lock`.
The main session can commit these reviewable groups with its normal Git access:

1. `src/memory/{repository,extract,seen,crops,service,call,photos,routes,index}.ts`
   and `test/memory.test.ts` (module logic).
2. `src/meta/spark.ts`, `src/server.ts`, `src/session/session.ts`,
   `test/memory-integration.test.ts`, `PROTOCOL.md` (runtime hooks).
3. `evals/memory/`, `scripts/{eval-memory,check-memory}.ts`,
   `test/memory-eval.test.ts`, `package.json`, `.gitignore`, this README (eval/handoff).

Commit with your own Git identity.
