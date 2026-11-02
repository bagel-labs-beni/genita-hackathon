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
| 11/2 | F4-L17 Peter bridge: new event `lip.changed`; binary kind `2` = Peter mouth crop (layout below); `ready.lip.reason` can be `peter_connecting`. Additive — but an app that asked for `peter` should now read `lip.changed` instead of assuming `ready.lip` is final. |
| 11/2 | F5 watch together: second socket `/v1/watch?session=<sessionId>` (section below). On the call socket nothing new except that the companion may now speak first while a screen is shared (normal `state`/`speaking`/`audio`/`reply` events) and `speaking.emotion` can be `laugh` (play the laugh clip, F4-L13). Additive. |

```
wss://<host>/v1/session
Authorization: Bearer <GENITA_SESSION_TOKEN>     (or ?token=… ; replaced by the user JWT in F1-L5)
```

Without `GENITA_SESSION_TOKEN` the server only binds to loopback (local dev).
Rejections happen at upgrade: `401` bad token, `503` server full.
Server close codes: `1000` normal / `stop`, `4000` idle 120 s, `4001` max call length (30 min default).

## Frames

| Direction | Frame | Content |
|---|---|---|
| app → server | text | JSON control message (below) |
| app → server | binary | mic PCM **s16le, mono, 24 kHz**, any size; 80 ms (3,840 B) frames recommended. Send in real time, echo-cancelled (F4-L10). |
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
| `mode` | `mode: "chat" \| "interpret"` | interpret = translate every turn (Korean → English for the user, English → Korean for the other person) |
| `ping` | `t` | server answers `pong {t}` |
| `stop` | — | end the call |

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
  "mic": true
}
```

Only `persona.name` is required. Until login/DB land (F1, F4-L12) the app sends
persona, profile, memories and recent history itself; the server stores nothing.

## Server → app events

| type | fields | meaning |
|---|---|---|
| `ready` | `protocol`, `sessionId`, `mode`, `audio {in,out,frameHeaderBytes}`, `lip {requested, active, reason}`, `voiceId`, `bargeIn` | session is live |
| `state` | `state: listening \| thinking \| speaking \| interrupted` | `interrupted` is momentary, always followed by `listening` |
| `speech.start` / `speech.end` | `turnId` | ASR heard the user start / stop |
| `transcript` | `text`, `final`, `turnId?`, `source?: voice \| text` | partials are cumulative; `final:true` is the user's turn |
| `interpret.detected` | `from`, `to` | a Korean turn in chat mode is being interpreted (F8) |
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

`404` at upgrade = no such call. Closes `4409` when a newer watch socket replaces it,
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

## Reserved names (not emitted yet)

Owned by later tickets; listed so nobody reuses them for something else. Shapes are
decided in those tickets and will be added here as additive changes.

`mouth {f, cell}` (F4-L20 atlas cells) ·
`camera`, `frame`, `observe.boxes` (F5) · `find.*` (Finds) · `claim`, `ownership {owner, epoch}` (handoff) ·
`interpret.*` beyond `interpret.detected` (F8) · `prep.progress` (F2-L3).

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
