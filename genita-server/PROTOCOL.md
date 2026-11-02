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
| 11/2 | F8-L1 interpretation: new events `interpret.pair` and `interpret.bubble` (two-language bubbles with speaker side); new app message `hold`; `start` and `mode` take optional `interpret {source, other, app}`; Mac call mode sends app→server binary frames with a `GA` header (kind `3` mic, `4` call sound); `mode.changed.by` can be `model` (voice switch). In interpret mode speech no longer cancels Genita (only `barge_in` does). Additive: a chat-only app sees nothing new. |

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
  "interpret": { "source": "face" }          // only read when mode is "interpret"
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

`audio` timing (all ms on the reply's own audio timeline, 0 = first sample of the reply):

```json
{ "type": "audio", "utteranceId": 3, "seq": 41, "sentence": 0,
  "offsetMs": 0, "durationMs": 380, "sampleRate": 24000, "model": "eleven_v4_turbo",
  "words": [{ "w": "That's", "s": 80, "e": 310 }],
  "mouth": [{ "t": 80, "v": "A" }, { "t": 140, "v": "L" }, { "t": 310, "v": "X" }] }
```

- `words`: always sent (captions/karaoke). A word can rarely split across two chunks.
- `mouth`: only when `lip.active` is `atlas`. Visemes: `X` rest, `A` open, `E` wide, `O` round, `U` small round, `M` closed (m/b/p), `F` lip-teeth, `L` tongue, `S` small open. Apply each cue at its time against the audio clock. F4-L20 will swap these for legacy-engine atlas cell ids (`{f, cell}`); the field position stays.

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
| Mac call (`source: call`, Korean as call sound, English held mic) | 10/10 | 10/10 | 10/10 | 1.68 s | 1.33 s | 9/10 |

Reference: 11/1 T7 (DIARIZATION) 3.9 s, T7b (ENDPOINTING + first sentence + v4 turbo) 2.2 s, both "file end". Target ≤ 2.5 s.
*Turn 9 ("It is on the second floor, next to the elevator.") was cut by ASR endpointing at the comma pause, so its
first half was translated before the clip ended (0.26 s); the second half became its own bubble.

