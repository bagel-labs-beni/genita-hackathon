# Genita realtime session protocol (v1)

One WebSocket per call. The app streams mic audio up; the server streams the
companion's voice, captions and state down. Ticket: F0-L3 (#3).

**Types (F0-L4, #4):** TypeScript `genita-server/src/protocol.ts`, Swift
`shared/GenitaKit/Sources/GenitaKit/Protocol.swift` (package `shared/GenitaKit`,
`ServerEvent` / `ClientMessage` / `AudioFrameHeader`). Both decode the same samples in
`shared/protocol-samples/{server,client}/*.json`; the server's own session tests also
check every event it emits against the spec. Unknown server event types decode to
`ServerEvent.unknown(type:)` — ignore them, never drop the socket.

## Changelog

Breaking changes are marked **BREAKING**; anything else is additive and safe to ignore.

| date | change |
|---|---|
| 11/2 | v1 published. |
| 11/2 | F0-L4: TS + Swift types and shared samples. Added optional `turn.metrics.speculative` (`hit`/`miss`/`none`). No breaking change. |
| 11/2 | F10 Finds (F5-L3, F5-L8, F10-L3~L6): new events `find.started`, `find.progress`, `find.items`, `observe.boxes`, `find.created`, `find.image`, `find.failed`; new client messages `find.confirm`, `find.stop`; optional `text.findId`, `start.user.id`, `start.user.timeZone`; REST `/v1/finds`. A turn may now get one server-initiated reply after it (the card's line; an ordinary `state`/`reply.delta`/`audio`/`reply` sequence with a new `utteranceId`). Additive. |
| 11/2 | F4-L17 Peter bridge: new event `lip.changed`; binary kind `2` = Peter mouth crop (layout below); `ready.lip.reason` can be `peter_connecting`. Additive — but an app that asked for `peter` should now read `lip.changed` instead of assuming `ready.lip` is final. |
| 11/2 | F1-L5: the bearer can be the user's session JWT (from `POST /auth/apple` or `/auth/exchange`); the shared `GENITA_SESSION_TOKEN` keeps working as a dev fallback. Auth failures now complete the upgrade and close with `4401` (was HTTP 401 before the upgrade); a signed-in user without AI-data consent gets `4403`. Clients that treated any failed connect as "can't connect" keep working; to route correctly, map 4401 → sign in (A02), 4403 → consent (CS01). |
| 11/2 | F8-L1 interpretation: new events `interpret.pair` and `interpret.bubble` (two-language bubbles with speaker side); new app message `hold`; `start` and `mode` take optional `interpret {source, other, app}`; Mac call mode sends app→server binary frames with a `GA` header (kind `3` mic, `4` call sound); `mode.changed.by` can be `model` (voice switch). In interpret mode speech no longer cancels Genita (only `barge_in` does). Additive: a chat-only app sees nothing new. |
| 11/2 | F7/F9: optional server memory, Spark `recall`/`remember`, automatic greeting after `ready`, and authenticated REST memory/settings/Us-photo routes. No new WebSocket fields/events; legacy sessions without the memory dependency retain their behavior. |
| 11/3 | F2-L26 naming + D21 first-call wait: new event `companion.named {name}` (the user renamed the companion by voice, already saved — update every {name} label); optional `start.greetAfterMs` (0–3000; the app sends 2000 on the first call after onboarding: the server waits that long for the user to speak or type first, then greets). REST `POST /v1/companion/name/suggest`, `PATCH /v1/companion {name}` (PREP_API.md). Additive: an app that ignores both sees no change. |
| 11/2 | F5 watch together: second socket `/v1/watch?session=<sessionId>` (section below). On the call socket nothing new except that the companion may now speak first while a screen is shared (normal `state`/`speaking`/`audio`/`reply` events) and `speaking.emotion` can be `laugh` (play the laugh clip, F4-L13). Additive. |

```
wss://<host>/v1/session
Authorization: Bearer <session JWT>     (or ?token=… ; dev fallback: GENITA_SESSION_TOKEN)
```

With neither accounts (`DATABASE_URL`) nor `GENITA_SESSION_TOKEN` the server only binds to loopback (local dev).
Rejections at upgrade: `503` server full. Auth is checked after the upgrade and closes with `4401` (no/bad/expired/revoked token → sign in again) or `4403` (signed in, no AI-data consent yet → CS01).
Server close codes: `1000` normal / `stop`, `4000` idle 120 s, `4001` max call length (30 min default), `4401` unauthorized or account deleted mid-call, `4403` consent required.

## Frames

| Direction | Frame | Content |
|---|---|---|
| app → server | text | JSON control message (below) |
| app → server | binary | mic PCM **s16le, mono, 24 kHz**, any size; 80 ms (3,840 B) frames recommended. Send in real time, echo-cancelled (F4-L10). Mac call interpretation only: prefix each frame with the 8-byte header below, kind `3` = mic, kind `4` = the call's sound (seq 0). |
| server → app | text | JSON event (below) |
| server → app | binary | TTS audio: 8-byte header + PCM **s16le, mono, 24 kHz** |

Binary header (server → app):

| bytes | field |
|---|---|
| 0–1 | ASCII `GA` |
| 2 | kind: `1` = TTS PCM, `2` = Peter mouth crop |
| 3 | reserved (0) |
| 4–7 | uint32 LE: kind 1 → `seq` of the `audio` JSON event sent just before it; kind 2 → `utteranceId` |

Kind 2 payload (Peter): `frame` uint32 LE, then a 256 px face-crop JPEG. Frame `k` belongs to
the utterance's audio at `k × 40 ms` (25 fps). Crops arrive ~0.6–0.9 s after that utterance's
first audio (A10G, T9) and keep coming a little after its last audio frame; composite them over
the base video with `lip.changed.peter.pasteDy` (F4-L18). Crops for a cancelled utterance are
never sent.

Every binary audio frame is preceded by its `audio` JSON event with the same
`seq` (WebSocket keeps order). Audio arrives faster than real time; the app
queues and plays it, and flushes the queue on `utterance.cancelled`.

## App → server messages

| type | fields | meaning |
|---|---|---|
| `start` | see below | must be first. Server answers `ready`. |
| `audio_start` | — | mic on (default after `start` unless `mic:false`) |
| `audio_stop` | — | mic off; server pads 0.8 s silence so a cut sentence still ends |
| `text` | `text`, optional `frames` | typed message (S08). Cancels any reply in progress, starts a new one. |
| `frames` | `images: [jpeg]` (≤2) | camera frames for the **next** user turn (voice or text), valid 15 s. Base64 JPEG or `data:image/jpeg;base64,…`, each < 1.5 MB. Two frames measured 2.1 s first token vs 6.5 s for a video upload. |
| `barge_in` | — | user tapped to interrupt; cancels immediately |
| `playback_done` | `utteranceId` | app finished playing the reply; ends `speaking` earlier than the server's estimate |
| `mode` | `mode: "chat" \| "interpret"`, optional `interpret {source?, other?, app?}` | interpret = Genita interprets between the user and someone else (F8, see below). `source`: `face` (default, iPhone between two people) or `call` (Mac FaceTime/Zoom). `other`: fix the other language instead of detecting it. `app`: shown back in `interpret.pair`. |
| `hold` | `on: boolean` | F8 "Hold to talk / Hold to reply": while held, the mic is the user ("me") whatever the language; in `call` mode the mic is only listened to while held. |
| `ping` | `t` | server answers `pong {t}` |
| `stop` | — | end the call |
| `find.confirm` | `findId`, `itemId`, `yes` | the user answered "맞아?" on a maybe ingredient (IC-3): yes → have, no → buy (or gone if no recipe needs it) |
| `find.stop` | `findId` | Stop on the searching sheet; answered with `find.failed {reason:"stopped"}` |

`text` may carry `findId` ("Ask about this" chip): that card becomes the context of the reply.
`start.user` may carry `id` (stable per install until login; owner of saved Finds) and `timeZone` (IANA, for "7:12 PM" in cards).

`start`:

```json
{
  "type": "start",
  "persona": {
    "name": "Mina",
    "kind": "human",                       // human | animal | character
    "traits": ["warm", "dry humor"],
    "speakingStyle": "short, playful",
    "backstory": "Pastry chef in Seoul.",
    "voice": { "id": "7PbNGDB5sJCFnOZuMPNL" }
  },
  "user": { "name": "Chelsea", "profile": "<imported profile text>" },
  "memories": ["Her sister Jiwoo visits next week."],
  "history": [{ "role": "user", "text": "…" }, { "role": "assistant", "text": "…" }],
  "mode": "chat",
  "language": "English",
  "voiceId": "optional override",
  "lip": { "mode": "peter", "fallback": "none" },   // or just "atlas"
  "bargeIn": { "minMs": 400, "minWords": 2 },
  "mic": true,
  "interpret": { "source": "face" },         // only read when mode is "interpret"
  "greetAfterMs": 2000                       // D21, optional: first call after onboarding only
}
```

Only `persona.name` is required. Without the memory dependency the app still sends
persona, profile, memories and recent history itself. With server memory enabled,
`start.memories` and `start.history` are ignored so stale app snapshots cannot
restore forgotten memories. The server uses its authenticated user identity and
retains new conversation history only for this call. New calls receive an ordinary
greeting, or one qualifying past episode (seen crops first after six hours).
Greetings use the existing `reply.delta`/audio/`reply` pipeline and opener guard;
there is no synthetic user `transcript` event.

**`greetAfterMs` (D21, first call after onboarding).** Number of ms, clamped to 0–3000; the app
sends `2000`. The server does not greet right after `ready`: it waits up to that long. If the user
starts speaking (`speech.start`) or sends `text` inside the window, there is no greeting — the
companion just answers them ("Hey, what should I call you?" → "You can call me Jin…"). If nobody
does, it greets as usual. This also works without server memory (plain greeting). Not in interpret
mode. Without `greetAfterMs` nothing changes (with memory: greet right after `ready`; without: no greeting).

## Companion name (F2-L26)

`persona.name` is the companion's name; the instructions say "You are {name}", so "What's your name?"
is answered with it. During a chat-mode call the user can rename it by voice or text: "Call yourself
Max", "Your name is Max now", "I'll call you Max", "Can I call you Max?" (English, detected on the
server without a model call; questions like "What should I call you?" are not renames; never during
interpretation). The server then uses the new name from that turn's reply on (the reply briefly takes
the name), saves it to the user's companion (same as `PATCH /v1/companion {name}`), and sends
`companion.named {name}` before that reply's audio. Update every {name} label (S07, S09-T, PREP-1).

## Memory, privacy and Us-photo REST (F7/F9/F5-L17)

All routes require the same bearer token as the session. Before F1/JWT integration,
one token means **one local user**, not multiple accounts. The server's injected
`resolveUser(req)` must verify JWTs to support multiple users; caller-supplied
`userId`, `start.user.id` and `X-User-ID` never select an account.

| method | path | result |
|---|---|---|
| GET | `/v1/memories` | `{memories:[{id,text,kind,created_at,updated_at,last_used_at,follow_up,source_session_id,image_ref?}]}`; timestamps are epoch milliseconds |
| DELETE | `/v1/memories/:id` | `204`, idempotent Forget; `/me/memories/:id` is an alias |
| DELETE | `/v1/memories` | `204`, Forget all; optional `?id=mem_…` deletes just that item |
| GET / PATCH | `/v1/memory-settings` | `{rememberSeen:boolean,photosOfUs:boolean}`; PATCH accepts either/both boolean fields; switching off prevents new items |
| POST | `/v1/us-photos` | `{scene_id,companion_id,scene_description,scene_ended:true,card_closed:true}` → `{status:"ready",mime,image_base64}` or a non-ready status |

Us-photo inputs contain no image bytes/URLs. `resolveCompanionFace(userId,id)` must
resolve the user's approved **companion** reference from prep/storage; until it is
wired the route returns `503 companion_storage_unavailable`. Unknown companions
return `404`. The edit sends that reference and scene text only, one image at a time.
It reserves at most three attempts per UTC day, deduplicates scene IDs, and discards
face-check failures. Finds should save only a `ready` result after the card closes.

Memory/setting responses have `Cache-Control: no-store`. JSON body limit is 2.1 MB.
Forget invalidates pending extraction and active replies, removes crop bytes and
keeps a content-hash tombstone so a stale upsert cannot restore the item. Crop
deletion/storage errors return `503`; retries can complete the deletion.
`GENITA_MEMORY_FILE=./.memory/memories.json` enables atomic local JSON persistence;
unset means in-memory only. `REVISIT_GAP_HOURS` defaults to `6` (seen crops always
require six hours), and revisit openers are limited to one per UTC day.

The trusted vision adapter supplies only a <=480px SAM crop plus a safe one-line
summary to `src/memory/`; original camera frames are never persisted. Its pixel
safety check must exclude faces/people, documents, money and addresses. Integration
contracts and offline/live checks: [`src/memory/README.md`](src/memory/README.md).

## Server → app events

| type | fields | meaning |
|---|---|---|
| `ready` | `protocol`, `sessionId`, `mode`, `audio {in,out,frameHeaderBytes}`, `lip {requested, active, reason}`, `voiceId`, `bargeIn` | session is live |
| `state` | `state: listening \| thinking \| speaking \| interrupted` | `interrupted` is momentary, always followed by `listening` |
| `speech.start` / `speech.end` | `turnId` | ASR heard the user start / stop |
| `transcript` | `text`, `final`, `turnId?`, `source?: voice \| text` | partials are cumulative; `final:true` is the user's turn |
| `interpret.detected` | `from`, `to` | chat mode only: a Korean turn is being passed on to the user instead of answered |
| `interpret.pair` | `user`, `other` (string or null), `source`, `by: auto \| client`, `app?` | interpret mode started (`other: null` = INT-1 "listening for the other language") or the other language was just detected (INT-2 bar "Korean ↔ English") |
| `interpret.bubble` | `bubbleId`, `speaker`, `via`, `status`, `original {lang, text}`, `translation? {lang, text}`, `utteranceId?`, `reason?` | one two-language bubble; sent again on every change — **upsert by `bubbleId`**. See below. |
| `tool` | `utteranceId`, `name`, `status` | e.g. `web_search` `searching` — show a hint if you like |
| `reply.delta` | `utteranceId`, `text` | caption text, one sentence at a time (append) |
| `speaking` | `on`, `utteranceId`, `emotion?` | `on:true` with the emotion when a sentence's audio starts (switch the face clip, F4-L13); `on:false` when done or cancelled |
| `audio` | `utteranceId`, `seq`, `sentence`, `offsetMs`, `durationMs`, `sampleRate`, `model`, `words`, `mouth?` | timing for the binary frame that follows |
| `reply` | `utteranceId`, `text`, `emotion`, `interpret`, `final:true` | full reply text (what was spoken) |
| `utterance.cancelled` | `utteranceId`, `reason: barge_in \| text \| client` | **stop playback now and drop queued audio** |
| `turn.metrics` | `model`, `ttsModel`, `speechEndToFirstAudioMs`, … | per-turn latency breakdown (server clock) |
| `asr.status` | `status: connected \| reconnecting` | speech recognition reconnecting (show a mic hint) |
| `mode.changed` | `mode`, `by` | |
| `lip.changed` | `lip {requested, active, reason}`, `peter? {bundleId, pasteDy, fps}` | Peter worker became ready (`active: "peter"`) or is unavailable (`reason: "peter_unavailable"`, back on the fallback) |
| `error` | `code`, `message`, `retryable` | see below |
| `pong` | `t` | |
| `find.started` | `findId`, `utteranceId`, `kind: recipe \| outfit \| link`, `title`, `detail` | open the sheet in "searching" (r03 #1) |
| `find.progress` | `findId`, `detail` | update the searching line ("Kimchi, eggs, tofu · recipes") |
| `find.items` | `findId`, `items`, `checking`, `subtitle?`, `status?` | full ingredient list each time; replace, don't merge. `checking:false` = all checks done |
| `observe.boxes` | `findId`, `frame`, `w`, `h`, `items[{label, box}]` | boxes to pop on the camera preview (CAM-H, 240 ms pop, 4 s) |
| `find.created` | `findId`, `card` | the card's text; pictures may still be `pending` |
| `find.image` | `findId`, `slot`, `status: ready \| failed`, `url?` | an illustration landed (or failed: show r03 #15, keep the text) |
| `find.failed` | `findId`, `reason: unclear \| search_failed \| error \| stopped`, `message` | `unclear` = IC-4 "show me again"; nothing was made up |
| `companion.named` | `name` | the user renamed the companion in the call ("Call yourself Max"); already saved. Update every {name} label |

`audio` timing (all ms on the reply's own audio timeline, 0 = first sample of the reply):

```json
{ "type": "audio", "utteranceId": 3, "seq": 41, "sentence": 0,
  "offsetMs": 0, "durationMs": 380, "sampleRate": 24000, "model": "eleven_v4_turbo",
  "words": [{ "w": "That's", "s": 80, "e": 310 }],
  "mouth": [{ "t": 80, "v": "A" }, { "t": 140, "v": "L" }, { "t": 310, "v": "X" }] }
```

- `words`: always sent (captions/karaoke). A word can rarely split across two chunks.
- `mouth`: only when `lip.active` is `atlas`. Visemes: `X` rest, `A` open, `E` wide, `O` round, `U` small round, `M` closed (m/b/p), `F` lip-teeth, `L` tongue, `S` small open. Apply each cue at its time against the audio clock. F4-L20 will swap these for legacy-engine atlas cell ids (`{f, cell}`); the field position stays.

## Watch together (F5, Mac screen share)

A second WebSocket per call, opened by the Mac only while it shares its screen.
Same auth as the call socket. Kept separate so ~100 KB frames never queue in
front of mic audio and the mic's binary format stays unchanged.

```
wss://<host>/v1/watch?session=<ready.sessionId>     Authorization: Bearer … (or &token=…)
```

`404` at upgrade = no such call, or a call of another user (same principal as `/v1/session`; it closes
`4401`/`4403` after the upgrade like the call socket). Closes `4409` when a newer watch socket replaces it,
`1000` when the call ends. Closing it (or `stop`) ends the share; nothing is kept but a
few minutes of 1–2 line story notes for this call. Watch traffic keeps a muted call
from hitting the 120 s idle close.

| Direction | Frame | Content |
|---|---|---|
| app → server | text | `start {source?}` first (source = shared app name, "Safari"), then `frame {image, blank?}`, `stop`, `ping {t}` |
| app → server | binary | the shared screen's **system audio**, PCM s16le mono 24 kHz, real time (ScreenCaptureKit `capturesAudio`, `excludesCurrentProcessAudio` so Genita's voice is never in it). Gaps are padded with silence on the server. |
| server → app | text | events below |

`frame.image`: base64 JPEG (or data URL), long side ≤ 1024 px, < 1.5 MB, sent **only when the
picture changed** (≤ 1 per second). `blank: true` when the frame is (almost) black — protected
windows capture black; the app decides (≥ 1 s of black).

| event | fields | meaning |
|---|---|---|
| `ready` | `protocol`, `sessionId` | socket attached to the call |
| `state` | `sharing`, `blank`, `source` | `blank:true` → MS-3 card. The companion also says once that the window shows up black. |
| `reaction` | `utteranceId`, `moment` (`funny`\|`surprising`\|`sweet`) | the companion is reacting first (MS-2 "Reacting" 1.5 s). Its voice arrives on the call socket as utterance `utteranceId`; `funny` speaks with `speaking.emotion: "laugh"`. |
| `speaker` | `on`, `label?`, `name?` | FT-SPK chip: who is talking in the video ("the chef", or `Voice A` when unsure). Only after two voices were heard; `on:false` after 3 s of quiet. Never the words. |
| `error` | `code`, `message` | `frame_too_large`, `asr_unavailable` (frames still work), `bad_message`, `unknown_type`, `not_started` |
| `pong` | `t` | |

Server side (genita-server/src/watch): the system audio gets its own Muse Transcribe session
(DIARIZATION), so the video never becomes a user turn; a user turn that repeats a line the
video just said (speakers, no earphones) is dropped. Every ~12 s, or 4 s after a new line,
Spark writes a 1–2 line memo from the new frames and lines and judges whether a friend would
react out loud. Reactions: only while sharing, ≥ 30 s apart, not in the first 6 s, never while
the user or companion talks or the video's dialogue is running. A question while sharing gets
the memo, the last 90 s of lines (with speaker names) and the newest 4 frames (≈ 6 s).

Measured 11/2 (`npm run watch-sim`, local server, real vendors; T5 clips played in real time, then asked as typed turns):
T5 set 38/50 correct (T5 video-file baseline 42/50; same judge re-run: 37 vs 42 strict, 39 vs 45 tone-tolerant — most misses are
where the generated video differs from its prompt, e.g. range hood vs "ceiling"); dialogue questions 7/7 on clips that have
dialogue; question → first audio p50 2.73 s (max 4.47 s; T5 was 3.4 s to text without voice); memo call p50 ≈ 3.2 s.
Reactions over a 250 s share: 3 (3.6 per 5 min), min gap 33 s, 0 rule violations, 2 with the laugh. Black screen: 5/5 answers
say it can't see, 0 claim to see something.

## Lip source (`start.lip`)

| mode | who | what the server sends |
|---|---|---|
| `peter` | humans | MuseTalk mouth crops (binary kind 2) from the Peter GPU worker. The worker cold-starts (~34 s), so `ready.lip` = `{requested:"peter", active:<fallback>, reason:"peter_connecting"}` and `lip.changed` follows with `active:"peter"` (or `reason:"peter_unavailable"`). Server without a worker configured: `reason:"peter_not_deployed"`. |
| `atlas` | animals, characters | `mouth` cues in each `audio` event; device composites its mouth atlas |
| `none` | anyone | audio + `words` only; app plays its speaking clip |

Default: `atlas` for animal/character personas, `none` for humans. Always read `ready.lip.active`.

`start.lip.avatarId` (optional, `peter` only): the companion's baked Peter cache, from `GET /v1/companion/prep` → `lips.peter.avatarId` (PREP_API.md). The server passes it in the worker HELLO, and `lip.changed.peter.bundleId` then equals `lips.peter.bundleId`. If it is omitted, the worker uses its demo avatar.

## Turn-taking and barge-in

- The server ends the user's turn on ASR endpointing (`speechComplete`), then thinks and speaks.
- While the companion is `thinking` or `speaking`, user speech cancels it once it is clearly speech:
  `bargeIn.minMs` (default 400 ms) of continued speech after ASR's speechStart, or `bargeIn.minWords`
  (default 2) words of partial transcript. A short backchannel ("yeah") that ends first is ignored —
  no cancel, no new reply. `minMs: 0` cancels on speechStart.
- `text` and `barge_in` cancel immediately.
- On cancel: `utterance.cancelled` → `speaking {on:false}` → `state interrupted` → `state listening`.
  The server sends no more audio for that utterance. The interrupting speech becomes the next turn.
- `speaking` lasts until the reply's audio should have finished playing (first audio + audio length + 250 ms)
  or `playback_done`, so barge-in keeps working while the app is still playing.

## Interpretation (F8)

Turn it on with `mode {mode:"interpret"}` (⋮ → Interpret a conversation), `start.mode`, or by voice: in chat mode
"Can you interpret for me?" switches (`mode.changed {by:"model"}`) and Genita says a one-line OK; "Stop interpreting"
switches back. Genita only passes on what was said — no answers, no advice; Korean output stays 존댓말.

**Who is talking (`speaker`).** The user's language is `start.language` (default English). Face to face (`source: face`),
the language of each utterance decides: the user's language = `me`, anything else = `them`. Muse Transcribe has no
language field, so the script decides (Hangul → Korean, kana → Japanese, Han → Chinese, Latin → the user's language).
The first non-user language heard becomes `other` (`interpret.pair`, `by:"auto"`). While `hold` is on the mic is `me`.
On the Mac (`source: call`) the call's sound (frame kind 4, its own ASR stream) is always `them` and the mic is `me`
only while held — otherwise it is replaced by silence.

**Bubble lifecycle.** `hearing` (original growing from partial transcripts; `speaker` can still change) →
`translating` (utterance ended; `translation.text` empty, `utteranceId` set) → `speaking` (its audio started;
`translation.text` grows sentence by sentence) → `done`. Other ends:

| status | reason | app |
|---|---|---|
| `unknown` | `language_unclear` | INT-6: show "Couldn't tell the language", nothing was spoken |
| `unknown` | `empty` | translation came back empty (also sent as `error spark_unavailable`) |
| `skipped` | `no_other_language` | the user spoke before the other language was known — nothing to translate into; hide it |
| `skipped` | `same_language` | call sound in the user's own language; hide it |
| `skipped` | `echo` | Genita heard her own translation through the speaker; hide it |
| `cancelled` | — | `barge_in` tap or leaving the mode |

**Audio.** A bubble's translation is a normal utterance: `reply.delta`, `speaking`, `audio` + binary frames, `reply
{interpret:true}`, `turn.metrics`, all with the bubble's `utteranceId`. Translations start as soon as an utterance
ends (in parallel) but their audio goes out strictly in order; new speech never cancels them. `barge_in` cancels the
one playing and the queued ones (`utterance.cancelled {reason:"client"}` for each). On the Mac, route by the bubble's
speaker: `them` → the translation is for the user → whisper in the user's headphones only; `me` → for the other
person → the speaker the call app's mic hears.

## Reserved names (not emitted yet)

Owned by later tickets; listed so nobody reuses them for something else. Shapes are
decided in those tickets and will be added here as additive changes.

`mouth {f, cell}` (F4-L20 atlas cells) ·
`camera`, `frame`, `observe.boxes` (F5) · `find.*` (Finds) · `claim`, `ownership {owner, epoch}` (handoff) ·
`interpret.*` beyond `interpret.detected` / `pair` / `bubble` (F8) · `prep.progress` (F2-L3).

## Finds (result cards, F10)

A user turn whose text has a link, or that has camera frames and asks about
cooking or clothes, gets a result card **after** the spoken answer (the answer
is the normal reply; the card never delays it). Sequence:

```
find.started → find.items (every name "checking", IC-1) → find.progress …
→ find.created (card text, pictures pending) → find.items / observe.boxes as checks land
→ find.items {checking:false} → find.image × n
```

Ingredient tiers (PRD 22): `have` = Spark re-check YES + SAM box for the name;
`maybe` = YES without a box ("맞아?"; `hint` may carry a look-alike box, e.g. the
kimchi jar), or the first look saw it and SAM boxes it but the re-check said NO;
`buy` = recipe only. Recipe names merge into what the camera saw ("onion" into
"green onions"). Boxes are 0..1 of `card.camera.frame` = the index of the frame
the app sent (the last one); the server never stores frames, so the app keeps
that frame with the card if it wants to show it later.

Card fields (`FindCard`): `id, kind, createdAt, eyebrow, title, subtitle,
status?, say?, hero?, camera?, items[], steps[{text, source?, image?}],
options[{label, frame, picked, box?}], why[], ask[], sources[{title,url,domain}],
how[], page?{url, opened}, saved?`. Image `url`s are server-relative
(`/v1/finds/<id>/images/<slot>`); fetch with the same bearer token.

When the card lands the companion says `card.say` as its own short reply — only
into silence, after the current reply, and not if the user starts talking first.

REST (same bearer token; owner = `X-Genita-User` header = `start.user.id`):

| method | path | |
|---|---|---|
| GET | `/v1/finds` | `{finds}` saved first, then newest |
| GET | `/v1/finds/:id` | `{find}` |
| DELETE | `/v1/finds/:id` | soft delete; `{ok, undo}` |
| POST | `/v1/finds/:id/restore` | undo a delete (24 h) |
| POST | `/v1/finds/:id/save` | `{saved: bool}` pin to top |
| GET | `/v1/finds/:id/images/:slot` | illustration bytes (`?token=` also accepted) |
| DELETE | `/v1/finds` | delete everything for this owner (account deletion) |

Server env: `GENITA_FINDS=0` off · `GENITA_FINDS_DIR` (default `./data/finds`) · `GENITA_FIND_IMAGES=0` no illustrations.

## Errors

| code | retryable | what the app does |
|---|---|---|
| `spark_unavailable` | yes | show the "couldn't answer" state (S09-F); nothing was made up |
| `tts_unavailable` | yes | show captions for this reply; the next reply tries voice again |
| `asr_unavailable` | yes | voice input down; offer text (S08) |
| `not_started`, `already_started`, `bad_persona`, `bad_message`, `unknown_type`, `frame_too_large` | no | client bug |

## Measured (11/2, local server, real vendors, `npm run smoke -- --turns=20`)

End of voice = last voiced 20 ms of the user's audio; "file end" = end of the audio file (the 11/1 T3 definition, 1.77 s then).

| setup | voice end → first audio p50 | file end → first audio p50 | range |
|---|---|---|---|
| baseline (lean prompt, no speculation, 1 Spark request) | 2.54 s / 2.69 s (2 runs) | 2.22 s / 2.43 s | 1.77–3.69 s |
| + speculation only | 2.19 s | 1.95 s | 1.54–3.34 s |
| + speculation + 2 hedged Spark requests (**default**) | **2.08 s** | **1.81 s** | 1.48–2.61 s |

- Speculation: a partial transcript ending in `. ? !` (or unchanged 250 ms) starts Spark while ASR is still closing the turn; 17–18 of 20 finals matched (hits).
- Hedging: 2 identical Spark requests, first text wins, the other is aborted. Mostly trims the tail (max 3.3 → 2.6 s); costs up to 2× Spark input tokens. `GENITA_SPARK_HEDGE=1` turns it off.
- Barge-in: ASR speechStart → `utterance.cancelled` ≈ 400 ms (= the 400 ms min-speech rule); user voice start → cancelled ≈ 620 ms; 0 audio frames after cancel.
- First words over 20 replies: most repeated = 3 (opener guard on).
- Peter (live A10G worker on Modal, `npm run smoke -- --turns=4 --lip=peter`): `lip.changed` 30.6 s after start (cold start); first mouth crop 350–684 ms after the reply's first TTS audio (p50 385 ms); crops arrive at 36–38 fps (faster than the 25 fps playback), max gap 200–320 ms (worker sends batches of 8); 102–113 crops per reply = audio length / 40 ms (±1); a barge-in stopped crops for that utterance (24 of 116).

### Interpretation (11/2, `npm run smoke:interpret`, real vendors, the T7 clips: 5 Korean + 5 English alternating)

| run | turns relayed | speaker right | no mixing | voice end → first audio p50 | file end → first audio p50 | speculation hit |
|---|---|---|---|---|---|---|
| face (`source: face`, by language) | 10/10 | 10/10 | 10/10 | 1.65 s (1.68 s without turn 9*) | 1.37 s (1.44 s*) | 8/10 |
| face, run 2 | 10/10 | 10/10 | 10/10 | 1.57 s (max 1.90 s) | 1.27 s | 10/10 |
| Mac call (`source: call`, Korean as call sound, English held mic) | 10/10 | 10/10 | 10/10 | 1.68 s | 1.33 s | 9/10 |

Reference: 11/1 T7 (DIARIZATION) 3.9 s, T7b (ENDPOINTING + first sentence + v4 turbo) 2.2 s, both "file end". Target ≤ 2.5 s.
*Turn 9 ("It is on the second floor, next to the elevator.") was cut by ASR endpointing at the comma pause, so its
first half was translated before the clip ended (0.26 s); the second half became its own bubble.

