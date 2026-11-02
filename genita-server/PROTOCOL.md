# Genita realtime session protocol (v1)

One WebSocket per call. The app streams mic audio up; the server streams the
companion's reply (as text for the device to speak, or as voice audio), captions and state down. Ticket: F0-L3 (#3).

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
| 11/2 | F1-L5: the bearer can be the user's session JWT (from `POST /auth/apple` or `/auth/exchange`); the shared `GENITA_SESSION_TOKEN` keeps working as a dev fallback. Auth failures now complete the upgrade and close with `4401` (was HTTP 401 before the upgrade); a signed-in user without AI-data consent gets `4403`. Clients that treated any failed connect as "can't connect" keep working; to route correctly, map 4401 → sign in (A02), 4403 → consent (CS01). |
| 11/2 | Metaface (lane L4) device voice mode: `start.tts` (`server` \| `device`), `ready.tts` (always sent), new event `say`. In device mode the server sends no `audio` events and no binary frames, and `ready.lip` is `{active:"none", reason:"device_tts"}`. Default is `device` unless the server runs server TTS (`GENITA_SERVER_TTS=1`). Additive — but an app that does not handle `say` hears nothing in device mode; it needs a server with `GENITA_SERVER_TTS=1` (there, an omitted `start.tts` means `server`). |
| 11/2 | L6 Meta voice service (SeamlessM4T v2 on our GPU, D3): with `GENITA_VOICE_URL` set the server runs server voice again — same `audio` events + binary kind 1 frames as before, `audio.model` = `seamless-m4t-v2`, `ready.voiceId` = `seamless:<speaker>`. If the voice service fails mid-reply the rest of that reply comes as `say` (after one `tts_unavailable`). Additive: apps that play server audio need no change; apps that handle `say` also get the fallback. See "Server voice (Meta voice service)". |

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
  "mic": true,
  "tts": "device"                          // server | device (see "Device voice mode")
}
```

Only `persona.name` is required. Until login/DB land (F1, F4-L12) the app sends
persona, profile, memories and recent history itself; the server stores nothing.

## Server → app events

| type | fields | meaning |
|---|---|---|
| `ready` | `protocol`, `sessionId`, `mode`, `audio {in,out,frameHeaderBytes}`, `lip {requested, active, reason}`, `voiceId`, `bargeIn`, `tts` | session is live; `tts` = the voice mode actually used (`server` \| `device`) |
| `state` | `state: listening \| thinking \| speaking \| interrupted` | `interrupted` is momentary, always followed by `listening` |
| `speech.start` / `speech.end` | `turnId` | ASR heard the user start / stop |
| `transcript` | `text`, `final`, `turnId?`, `source?: voice \| text` | partials are cumulative; `final:true` is the user's turn |
| `interpret.detected` | `from`, `to` | a Korean turn in chat mode is being interpreted (F8) |
| `tool` | `utteranceId`, `name`, `status` | e.g. `web_search` `searching` — show a hint if you like |
| `reply.delta` | `utteranceId`, `text` | caption text, one sentence at a time (append) |
| `speaking` | `on`, `utteranceId`, `emotion?` | `on:true` with the emotion when a sentence's audio (device mode: its `say`) starts and the emotion changed (switch the face, F4-L13); `on:false` when done or cancelled |
| `say` | `utteranceId`, `sentence`, `text`, `emotion`, `lang` | device mode only: one sentence for the app to speak, in order. `text` is plain (no tags); `lang` is a BCP-47 hint (`en-US`, `ko-KR`, …) |
| `audio` | `utteranceId`, `seq`, `sentence`, `offsetMs`, `durationMs`, `sampleRate`, `model`, `words`, `mouth?` | server mode only: timing for the binary frame that follows |
| `reply` | `utteranceId`, `text`, `emotion`, `interpret`, `final:true` | full reply text (what was spoken) |
| `utterance.cancelled` | `utteranceId`, `reason: barge_in \| text \| client` | **stop playback now and drop queued audio** |
| `turn.metrics` | `model`, `ttsModel`, `speechEndToFirstAudioMs`, … | per-turn latency breakdown (server clock). Device mode: `ttsModel:"device"`, "first audio" = first `say` sent, `audioMs` = the speaking estimate below |
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

## Device voice mode (`start.tts`)

| `start.tts` | server has server TTS (`GENITA_SERVER_TTS=1`) | server without it (default) |
|---|---|---|
| omitted | `server` | `device` |
| `"server"` | `server` | `device` (no vendor key; `ready.tts` tells the app) |
| `"device"` | `device` | `device` |

Always read `ready.tts`. In `device` mode:

- Each reply sentence arrives as `say {utteranceId, sentence, text, emotion, lang}` right after its
  `reply.delta` caption. Speak them in order on-device (AVSpeechSynthesizer) into the call's player,
  so the voice-processing echo cancellation still covers it.
- `text` has no `<emotion>` or `[audio]` tags. `lang`: `ko-KR` when the sentence is mostly Hangul,
  otherwise the reply language (`start.language`; interpretation: the target language) as BCP-47,
  `en-US` when unknown.
- No `audio` events and no binary frames. `ready.lip` = `{requested, active:"none", reason:"device_tts"}`;
  no mouth cues or Peter crops come from the server; the device makes its mouth from its own speech.
- `speaking {on:true, emotion}` is sent before the first `say` and whenever the emotion changes;
  `state speaking` goes out with the first `say`.
- `speaking {on:false}` + `state listening` come on `playback_done` (send it when the last buffer has
  played, after `reply`) or on the server's estimate: first `say` + 70 ms × characters + 1.5 s, at most 60 s.
- Barge-in is unchanged: on `utterance.cancelled`, stop synthesis and flush the player now. No `say`
  for that utterance follows the cancel.

```json
{ "type": "say", "utteranceId": 3, "sentence": 0, "text": "That's huge, congrats!", "emotion": "happy", "lang": "en-US" }
```

Threat line: who = the iOS/Mac app on the existing session socket · auth = unchanged (session token) ·
abuse = nothing new (the text is what `reply.delta` already carries; `start.tts` is an enum, anything
else = the default) · data = reply text only, already exposed.

## Server voice (Meta voice service)

When the server has `GENITA_VOICE_URL` + `GENITA_VOICE_TOKEN` (SSM `/genita/server/*`), the companion's
voice is **SeamlessM4T v2** (Meta open model) on our GPU (`deploy/modal-voice`). Without them the server
runs device mode (above), so a checkout with only `MODEL_API_KEY` still works.

- `start.tts` omitted or `"server"` → `ready.tts:"server"`. `"device"` still forces device mode.
- Voice: `ready.voiceId` = `seamless:<n>` (speaker 0–199). `start.voiceId` / `persona.voice.id` of the form
  `seamless:<n>` picks that speaker; any other id (old ElevenLabs ids) gets the companion kind's default
  (`GENITA_VOICE_SPEAKERS`, now human 72 · animal 16 · character 68, picked by UTMOS over 100 speakers).
- Each reply is spoken clause by clause: the **first clause is cut at its first comma** ("Oh wow,") so the
  first sound starts while Spark is still writing; later sentences over 140 chars are cut at a comma. The
  server sends clause n+1 to the voice service while clause n streams. Short clauses ("Hmm,", "Oh!", "Yeah.")
  are cached per speaker.
- Per clause: one `audio` event + binary frame for the first ~300 ms, then ≤ 1 s pieces. Each clause ends with
  a short silence that is part of its audio (comma ~110 ms, period 220 ms, question 260 ms, "..." 320 ms).
- Timing for the mouth (lane L4): every `audio` event carries `words` `[{w, s, e}]` in ms on the reply's
  timeline (0 = first sample of the reply), from the model's own per-character durations (unit model ×
  vocoder), so they line up with the samples. Ask for `lip:"atlas"` to also get letter-level `mouth` cues
  (any companion kind). The `audio` event always arrives before its binary frame, so timing is never late.
- Interpretation uses the same service: a sentence that is mostly Hangul is spoken in Korean (`kor`),
  everything else in English (`eng`). Same speaker as the companion.
- Text is rewritten for speech before synthesis (numbers, money, times, %, ordinals, units, `Dr.`, lists →
  spoken form; markdown, emojis, URLs dropped). Captions (`reply.delta`, `reply`) keep the written text.
- **Voice service down or slow** (no first byte in 4 s, 5xx, daily cap): one `tts_unavailable`, then the rest of
  that reply arrives as `say` events — speak them on-device like device mode. For the next 30 s replies go
  straight to `say`, then the server tries the voice again. `turn.metrics.ttsModel` = `seamless-m4t-v2+device`
  (partly) or `device`.
- Barge-in unchanged: the in-flight voice request is aborted; no `audio` or `say` after `utterance.cancelled`.

Threat line (no new endpoint on genita-server): the voice service is called only by genita-server, bearer
token from SSM, constant-time compare, 400-char text cap, max 3 GPU containers, daily request cap
(`VOICE_DAILY_CAP`, 429 → device voice). Data sent = reply text only.

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
- `speaking` lasts until the reply's audio should have finished playing (first audio + audio length + 250 ms;
  device mode: the estimate above) or `playback_done`, so barge-in keeps working while the app is still playing.

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
- Peter (live A10G worker on Modal, `npm run smoke -- --turns=4 --lip=peter`): `lip.changed` 30.6 s after start (cold start); first mouth crop 350–684 ms after the reply's first TTS audio (p50 385 ms); crops arrive at 36–38 fps (faster than the 25 fps playback), max gap 200–320 ms (worker sends batches of 8); 102–113 crops per reply = audio length / 40 ms (±1); a barge-in stopped crops for that utterance (24 of 116).
