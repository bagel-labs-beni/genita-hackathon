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
| 11/4 | Handoff: a call's `start` now takes the conversation when the recorded owner has no live connection (no presence, no call; e.g. the Mac app was quit), and the call URL's `owner=` for an offline other device is ignored. A connected owner still keeps it. Server-only, no message changes; fixes the iPhone call staying silent after the Mac app quit. Additive. |
| 11/4 | `backchannel.kind: "inhale"` (watch together, lead's call): a big move on the shared screen → the companion's instant nonverbal reaction, a small inhale in `audio` (≤ 0.45 s, ~−30 dBFS), no words; the spoken reaction follows as before. Apps that know it also raise the face's brows for ≤ 0.5 s; older apps just play the audio (the field is a string; nothing else changes). ≥ 30 s apart, shares the reaction gap. `GENITA_WATCH_NONVERBAL=0` turns it off. Additive. |
| 11/4 | Companion reset: `POST /v1/companion/reset` (PREP_API.md) closes the account's live calls with **`4410` `companion_reset`** (new, additive). Clients: stop reconnecting and route like `/me` with no companion (iPhone → V01, Mac → "Set up on iPhone"). Older clients treat it like any other close and reconnect; the next `/me` routes them. |
| 11/4 | `proximity.seen` accepts optional `requestId` (nonempty string, ≤128 characters); all `proximity.result` replies to it echo `requestId` and `token`. Macs match both, ignore superseded/uncorrelated replies, and treat a 5 s timeout as unconfirmed while keeping the leave-range latch. Additive: requests without an ID keep the legacy result shape. |
| 11/4 | `proximity.result` gets `reason: server_error`: a store failure now answers the Mac's `proximity.seen` (it used to be a bare `error`, which left the Mac's one report in flight until it reconnected). Additive; older Macs treat it as any other refusal. |
| 11/4 | `/v1/presence` `peer` gets `inCall` (bool): the other device has a started call socket right now (its `start` was handled, until the socket closes). The Mac home says "Talking on your iPhone" only while it is true (QA 171). Additive; older apps ignore it and newer apps fall back when it is missing. |
| 11/4 | `backchannel.audio?` (base64 PCM, the companion's own "Mm-hm.") — the app plays it quietly beside the reply queue (same engine, so echo cancellation removes it) and stops it when the user's voice is heard or a reply starts; the uplink is never cut; the server drops a stray "mm-hm" from that turn's transcript. Rate: ≥ 20 s apart. Additive. |
| 11/3 | `backchannel {kind: "mm" \| "yeah"}` (server → app, convo P1 #345): during a long user turn, a 1.2 s mid-sentence pause → play a soft listening sound from the app's own clips; it is not a reply and changes no state. Server flag `GENITA_BACKCHANNEL=1`, off by default. Additive: older apps decode it as unknown and ignore it. |
| 11/3 | Proximity handoff: `/v1/presence` gets `proximity.arm` / `proximity.disarm` (iPhone) and `proximity.seen {token}` (Mac), answered with `proximity.token`, `proximity.unavailable`, `proximity.result`, plus `proximity.peer {armed}` to Macs; new claim trigger `proximity` (section **Handoff → Proximity**). Additive; older builds never send them. |
| 11/3 | D34 / #153 prep: scene → Meta face set only. Session hints use `lip:"none"` for humans, animals and characters; the device animates the face set. Legacy prep response keys remain neutral (`emotionVideos:{}`, video/lip steps `skipped`, lip URL `null`). See [PREP_API.md](PREP_API.md). |
| 11/2 | D34 / #153: removed non-Meta voice and remote lip-worker paths. Binary kind 2 is reserved and never emitted. Unknown legacy lip modes safely select `none`; `atlas` playback, kind 1 audio, `say` and protocol v1 remain supported. |
| 11/2 | v1 published. |
| 11/3 | Watch together, screen text (additive): `start.title` and a new `context {title}` message carry the shared window's title (a browser tab: "<YouTube video title> - YouTube"), read on the Mac with the ScreenCaptureKit window title (no OCR, no extra permission). Server: control/bidi characters stripped, ≤ 160 chars, handed to Spark as quoted data (memo + question context), cleared on stop. A name written on screen (title, caption) may be used as written; the no-face-identity rule is unchanged. Old clients simply never send it. |
| 11/3 | Watch together, motion + reactions (additive): `frame.motion` (optional); the Mac sends ≤ 3 fps at ≤ 768 px. The memo (scene timeline) runs every 3 s while the screen changes, 1.2 s after a finished video line, and 0.7 s after a motion spike, on a 5-frame sequence ~0.6 s apart; a turn gets the last ~1.4 s as 3 frames. Proactive reactions: ≥ 30 s apart (25 s until 11/4, D67), held for a pause (never over the video's dialogue or anyone talking), face tag `[smileopen]` (funny), `[smile]` (sweet), `[surprised]`. A black video inside a visible page (DRM, e.g. Netflix) gets one honest line instead of a guess. |
| 11/3 | Watch together, realtime (no wire change): a turn while sharing gets the newest screen frame (last) plus one ~2 s older (was 4 over ≈6 s), the memo refreshes every 5 s while the screen changes (was 12 s), the echo check decides from the video's partial line instead of waiting up to 1.5 s, and the prompt takes the user's naming of someone on screen as given and answers with what is visible (no face-based identity). |
| 11/3 | Handoff (#199): with server memory on, a call starting while the account has another live call (or one ended < 10 min ago) is seeded with that call's turns and skips the greeting; optional `start.handoff: true` lets the app's own `history` seed it when the server has none. Additive. |
| 11/2 | F0-L4: TS + Swift types and shared samples. Added optional `turn.metrics.speculative` (`hit`/`miss`/`none`). No breaking change. |
| 11/2 | F10 Finds (F5-L3, F5-L8, F10-L3~L6): new events `find.started`, `find.progress`, `find.items`, `observe.boxes`, `find.created`, `find.image`, `find.failed`; new client messages `find.confirm`, `find.stop`; optional `text.findId`, `start.user.id`, `start.user.timeZone`; REST `/v1/finds`. A turn may now get one server-initiated reply after it (the card's line; an ordinary `state`/`reply.delta`/`audio`/`reply` sequence with a new `utteranceId`). Additive. |
| 11/2 | F1-L5: the bearer can be the user's session JWT (from `POST /auth/apple` or `/auth/exchange`); the shared `GENITA_SESSION_TOKEN` keeps working as a dev fallback. Auth failures now complete the upgrade and close with `4401` (was HTTP 401 before the upgrade); a signed-in user without AI-data consent gets `4403`. Clients that treated any failed connect as "can't connect" keep working; to route correctly, map 4401 → sign in (A02), 4403 → consent (CS01). |
| 11/3 | D41 Judge access: `POST /auth/judge {code, device?}` → the same body as `POST /auth/apple` (session JWT + `/me` view) for the demo account that code belongs to. 401 wrong code, 400 no code, 429 after 5 wrong tries per IP in 10 min, 404 when `GENITA_JUDGE_CODES` is unset. Additive; WS and other routes unchanged. |
| 11/3 | D41 judge demo companion: a Judge access account with no companion gets a ready-made "Jin" at sign-in (copied from the `demo:template` account, `npm run demo:template`). `/me` (and the sign-in body) adds `companionDemo: boolean`; `GET /v1/companion` adds `demo: boolean`; `POST /v1/companion` replaces a `demo:true` companion instead of `409` (see PREP_API.md). Additive. |
| 11/3 | D41 Judge access daily cap: new `error` code `daily_limit` (retryable `false`) when a judge demo account has used today's turns (per code, UTC day, `GENITA_JUDGE_DAILY_TURNS`, default 200). The socket stays open; the refused turn gets no reply. Additive: apps that don't know the code just log it. |
| 11/2 | F8-L1 interpretation: new events `interpret.pair` and `interpret.bubble` (two-language bubbles with speaker side); new app message `hold`; `start` and `mode` take optional `interpret {source, other, app}`; Mac call mode sends app→server binary frames with a `GA` header (kind `3` mic, `4` call sound); `mode.changed.by` can be `model` (voice switch). In interpret mode speech no longer cancels Genita (only `barge_in` does). Additive: a chat-only app sees nothing new. |
| 11/3 | Pill line: optional `FindCard.pill` and `find.items.pill` — the status pill's text for a card, ≤ 28 characters (one line on iPhone and Mac). `say` is spoken, `pill` is shown. Product: same as `say`. Additive. |
| 11/3 | #199: `find.started` and `find.progress` take optional `evidence {style, situation}` on product searches — the import line the search follows (top Likes line at start, the line the picks follow once known); show as-is when present. A product ask on a call continued from the other device refines the search asked there (from the conversation's turns). Additive. |
| 11/3 | SAM masks (#298, behind server env `GENITA_SAM_MASKS=1`): `observe.boxes.items[]` gains optional `mask {w, h, rle}` — a w×h binary grid stretched over that item's `box`, row-major run lengths alternating 0s then 1s (the first run may be 0), `sum(rle) == w*h`, long side ≤ 96. With the flag on, an ingredient with several matches arrives as one item per match (same `label` repeated, each with its own `box`/`mask`), at most 12 items; over that, the largest group arrives as one merged item. An item without `mask` (flag off, or a mask that did not decode) is drawn as a box. Additive. |
| 11/3 | Fridge order (#122, D23): a camera cooking turn's reply is now the short line "Let me take a look." (not a full answer from the raw photo); `observe.boxes` follow; then one server-initiated reply names only `have` items ("I can see eggs and tofu. You could make …, if you have kimchi."), also stored as `card.say`. A failed card for such a turn (or a product search) is spoken as its own reply. Same message types; additive. |
| 11/3 | F7 product search (#119): `FindKind` gains `product`; `FindCard` gains optional `products[]` ({id, name, url, domain, store, price?, image?, taste, situation}) and `evidence` ({style, situation}). A product ask (voice alone, no camera) gets a short spoken line ("On it.") as that turn's reply instead of a full answer, then the card and its `say`. Product pictures are `find.image` slots `product-1`/`product-2`. Swift `FindKind` decodes an unknown kind as `.unknown`. Additive. |
| 11/2 | F7/F9: optional server memory, Spark `recall`/`remember`, automatic greeting after `ready`, and authenticated REST memory/settings/Us-photo routes. No new WebSocket fields/events; legacy sessions without the memory dependency retain their behavior. |
| 11/2 | Metaface (lane L4) device voice mode: `start.tts` (`server` \| `device`), `ready.tts` (always sent), new event `say`. In device mode the server sends no `audio` events and no binary frames, and `ready.lip` is `{active:"none", reason:"device_tts"}`. Default is `device` unless the server runs server TTS (`GENITA_VOICE_URL` + `GENITA_VOICE_TOKEN`). Additive — but an app that does not handle `say` hears nothing in device mode; it needs a server with `GENITA_VOICE_URL` + `GENITA_VOICE_TOKEN` (there, an omitted `start.tts` means `server`). |
| 11/2 | L6 Meta voice service (SeamlessM4T v2 on our GPU, D3): with `GENITA_VOICE_URL` set the server runs server voice again — same `audio` events + binary kind 1 frames as before, `audio.model` = `seamless-m4t-v2`, `ready.voiceId` = `seamless:<speaker>`. If the voice service fails mid-reply the rest of that reply comes as `say` (after one `tts_unavailable`). Additive: apps that play server audio need no change; apps that handle `say` also get the fallback. See "Server voice (Meta voice service)". |
| 11/3 | Funnel telemetry: authenticated `POST /v1/events` accepts up to 20 allowlisted, flat app event properties and returns `204`; server logs `call.greeted`, `tts.first_audio`, `tts.fallback_device`, prep readiness, cancellation and mode events. `turn.metrics` adds nullable `stt_ms`, `llm_ms`, `tts_ms`, and `first_audio_ms`. Additive. |
| 11/3 | F2-L26 naming + D21 first-call wait: new event `companion.named {name}` (the user renamed the companion by voice, already saved — update every {name} label); optional `start.greetAfterMs` (0–3000; the app sends 2000 on the first call after onboarding: the server waits that long for the user to speak or type first, then greets). REST `POST /v1/companion/name/suggest`, `PATCH /v1/companion {name}` (PREP_API.md). Additive: an app that ignores both sees no change. |
| 11/3 | Lane 개인화: new events `profile.updated {text, fields}` (a correction said in the call — "Updated: no cilantro" — or the answer to the call's getting-to-know-you question — "Noted: quiet company" — was saved; chip for 2.5 s) and `profile.asking {topic}` (the companion just asked that question; soft chip "Getting to know you · {topic}"). `FindCard.reasons?` (1–2 `{text, source, from}` chips: `from:"profile"` blue "Your style/taste: …", `from:"call"` grey "You said: …"). With an account the server uses the **stored** profile (corrections included) instead of `start.user.profile`. REST `GET /v1/profile/story`, `PATCH /v1/profile` (PREP_API.md). Additive: an app that ignores them sees no change. |
| 11/2 | F5 watch together: second socket `/v1/watch?session=<sessionId>` (section below). On the call socket nothing new except that the companion may now speak first while a screen is shared (normal `state`/`speaking`/`audio`/`reply` events) and `speaking.emotion` can be `laugh` (play the laugh clip, F4-L13). Additive. |
| 11/2 | F6-L7: conversation owner. New socket `/v1/presence` and `GET /v1/handoff`, `POST /v1/handoff/claim|release` (section **Handoff**). `/v1/session?device=iphone\|mac` now plays audio only while that device owns the conversation; a call without `device` is not gated (old builds keep working). Call sockets also get the `ownership` event (unknown to old builds → ignored). After a move the old device's reply ends with `utterance.cancelled` reason `client`, so every build flushes its queue. No breaking change. |
| 11/3 | L4 lip timing (Meta MMS forced aligner): new event `audio.timing {utteranceId, sentence, seq, words, phonemes}` after each clause's audio when the server runs with `GENITA_VOICE_ALIGN=1`. Additive: unknown to old builds → ignored; `audio` events are unchanged. |
| 11/3 | Expression layer: new event `expression {utteranceId, sentence, tag, intensity, startMs, endMs}` (tag `smile\|smileopen\|laugh\|surprised\|concerned`), at most one per reply clause, server voice only, after that clause's audio. Nothing for neutral clauses. `GENITA_EXPRESSION=0` turns it off. Additive: unknown to old builds → ignored. |
| 11/3 | PERC-1 perception (#319): new app message `perception.frame {image}` and optional `ready.perception: true` (sent only when the server runs `GENITA_PERCEPTION=1`). The app sends face crops only when it sees `ready.perception`. No server event; the companion just reacts more like a person. Additive: off by default, old apps send nothing and see nothing new. |
| 11/3 | App config: new public REST `GET /v1/app-config` (copy, flags, tuning, update nudges, remote asset URLs; ETag/304). No WebSocket change. Additive. |
| 11/4 | No robot voice (Chelsea TF 341): `GENITA_VOICE_DEVICE_FALLBACK` is ignored, so with server TTS `say` is never sent (not over the seat cap, not on a failed clause). Device mode (`tts: device`, or no voice service) is unchanged. No wire changes. |
| 11/4 | Voice identity (Chelsea build 7: "왜 여자 + 기계식"): with server TTS, `say` is no longer sent by default — over the seat cap the call keeps the server voice; a clause the voice service fails is retried once, then the reply is captions only (`error tts_unavailable`, `turn.metrics.ttsModel` never `device`). `GENITA_VOICE_DEVICE_FALLBACK=1` restores the 11/3 rows below. Device mode (`tts: device`) is unchanged. `GET /v1/companion/voices`: the face's gender (image check `voice_fit`) orders the list and sets `suggested`. No wire changes. |
| 11/3 | D27 voice GPU capacity: above `GENITA_VOICE_MAX_CALLS` (default 3, 0 = unlimited), chat and interpretation replies use the existing `say` fallback; server voice resumes from the next reply once a seat is free. Voice never switches mid-reply. No wire or `ready` changes. |
| 11/3 | D27 capacity for judging: `GENITA_VOICE_MAX_CALLS` default 3 → 8 (the voice GPU now autoscales early, up to 4 containers). A full GPU queue answers 503 `busy` within 2.5 s; that sentence uses the existing `say` fallback and server voice is retried after 2 s (other failures still 30 s). No wire changes. |
| 11/4 | Finds audit (additive): new client message `find.focus {findId}` ("Talk about this on a call" names the card, including one from an earlier call; AU-70). Outfit cards: the occasion line ("for this weekend") is the last `why` line and `evidence {style, situation}` is set (CW-02, AU-57). |
| 11/4 | Device QA test photos: `/me` (and the sign-in body) adds `qaSamplePhotos: true` **only** for accounts listed in server env `GENITA_QA_SAMPLE_PHOTOS` (account ids / verified emails); every other account's `/me` is unchanged (no key). The iPhone app then shows "Use a test photo" on V01 (bundled samples → the same `POST /v1/companion/image`). Additive. |
| 11/4 | D59 (additive): `frames` takes optional `unclear: true` when the app judged every frame too dark or too blurry. A fridge (recipe) question on such frames gets the IC-4 line as its whole reply plus `find.failed {reason:"unclear"}` at once — no "let me see" first. |
| 11/4 | Visual everything (all optional, additive): `FindCard.layout` (`recipe` · `product` · `place` · `how-to` · `general`; absent → lay out by `kind`; Swift `FindLayout`, unknown → `.unknown`); `FindItem.image` (find.image slot `ingredient-<item id>`, keyed by id since items re-sort by tier); `sources[].place {address?, rating?, reviews?, hours?, mapUrl?}` on layout `place` (from the search's own JSON; `mapUrl` built by the server). Pictures for ingredients, recipe steps, how-to steps, the dish and web rows without an og:image come from one Spark web search per row (the first returned page whose og:image loads), re-hosted like product photos. Only `status:"ready"` is ever sent for any slot now; cards carry no pending picture; a row with no picture gets no event. Server `GENITA_FIND_WEB_IMAGES=0` turns the web photos off. |
| 11/4 | No empty pictures (all optional, additive; server `GENITA_FIND_IMAGE_GATE=0` turns it off, `GENITA_FIND_IMAGE_GEN=0` turns generation off): `find.image` and `FindImage` gain `source: "generated"` (a Muse Image picture, made only when no photo was found — ingredients, recipe steps, the dish, how-to steps, general cards; never products or places; the app may label it "Illustration") and `omit: true` (always with `status:"failed"`: no picture will come for this slot, draw no box — old apps read the plain `failed`). `find.image` for `product-N` may carry `replace` (with `omit`): a `FindProduct` that takes that slot's place, its `image` already ready under the same slot — the product whose picture could not be found is swapped for the next verified one (old apps ignore it and keep the failed slot). Chain per slot: page og:image / JSON-LD → web search (ingredients and dishes: Wikipedia first) → product: swap / general and how-to rows: the hero / food, how-to, general: generated → omit. The card is never held for pictures. |

```
wss://<host>/v1/session
Authorization: Bearer <session JWT>     (or ?token=… ; dev fallback: GENITA_SESSION_TOKEN)
```

With neither accounts (`DATABASE_URL`) nor `GENITA_SESSION_TOKEN` the server only binds to loopback (local dev).
Rejections at upgrade: `503` server full. Auth is checked after the upgrade and closes with `4401` (no/bad/expired/revoked token → sign in again) or `4403` (signed in, no AI-data consent yet → CS01).
Server close codes: `1000` normal / `stop`, `4000` idle 120 s, `4001` max call length (30 min default), `4401` unauthorized or account deleted mid-call, `4403` consent required, `4410` the companion was reset (`POST /v1/companion/reset`; no reconnect, route from `/me`).

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
| 2 | kind: `1` = TTS PCM; `2` reserved (never emitted) |
| 3 | reserved (0) |
| 4–7 | uint32 LE: `seq` of the `audio` JSON event sent just before it |

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
| `perception.frame` | `image: jpeg` | PERC-1: one fixed upper-centre crop of the front-camera frame (the selfie face region, no face detection on device), base64 JPEG 256–384 px, < 300 k chars, for perception. Only when `ready.perception` is true, camera on, chat mode; on face change (≥ 1 s apart) or every 2.5 s. Ignored otherwise; never stored. See **Perception**. |
| `frames` | `images: [jpeg]` (≤2), optional `unclear: true` (D59: the app judged every frame too dark or blurry) | camera frames for the **next** user turn (voice or text), valid 15 s. Base64 JPEG or `data:image/jpeg;base64,…`, each < 1.5 MB. Two frames measured 2.1 s first token vs 6.5 s for a video upload. |
| `barge_in` | — | user tapped to interrupt; cancels immediately |
| `playback_done` | `utteranceId` | app finished playing the reply; ends `speaking` earlier than the server's estimate |
| `mode` | `mode: "chat" \| "interpret"`, optional `interpret {source?, other?, app?}` | interpret = Genita interprets between the user and someone else (F8, see below). `source`: `face` (default, iPhone between two people) or `call` (Mac FaceTime/Zoom). `other`: fix the other language instead of detecting it. `app`: shown back in `interpret.pair`. |
| `hold` | `on: boolean` | F8 "Hold to talk / Hold to reply": while held, the mic is the user ("me") whatever the language; in `call` mode the mic is only listened to while held. |
| `ping` | `t` | server answers `pong {t}` |
| `stop` | — | end the call |
| `find.confirm` | `findId`, `itemId`, `yes` | the user answered "맞아?" on a maybe ingredient (IC-3): yes → have, no → buy (or gone if no recipe needs it) |
| `find.stop` | `findId` | Stop on the searching sheet; answered with `find.failed {reason:"stopped"}` |
| `find.focus` | `findId` | "Talk about this on a call" (FD-01): later turns are about this card. A card from an earlier call is read back from this account's Finds; an unknown id is ignored. No reply. |

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
    "voice": { "id": "seamless:0" }
  },
  "user": { "name": "Chelsea", "profile": "<imported profile text>" },
  "memories": ["Her sister Jiwoo visits next week."],
  "history": [{ "role": "user", "text": "…" }, { "role": "assistant", "text": "…" }],
  "mode": "chat",
  "language": "English",
  "voiceId": "optional override",
  "lip": { "mode": "atlas" },   // or just "none"
  "bargeIn": { "minMs": 400, "minWords": 2 },
  "mic": true,
  "tts": "device",                         // server | device (see "Device voice mode")
  "interpret": { "source": "face" },         // only read when mode is "interpret"
  "greetAfterMs": 2000                       // D21, optional: first call after onboarding only
}
```

Only `persona.name` is required. Without the memory dependency the app still sends
persona, profile, memories and recent history itself. With server memory enabled,
`start.memories` and `start.history` are ignored so stale app snapshots cannot
restore forgotten memories. **Handoff exception:** a chat call that starts while the
same account has another live call (or one that ended < 10 min ago) begins with that
call's turns (server-side, never another account's) and skips the greeting — the
conversation continues on the new device. A `start` with `handoff: true` uses its own
`history` only when the server has no such turns. Turns seeded this way are context
only, never written as memories. The server uses its authenticated user identity and
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
`companion.named {name}` (after the save, before that reply's audio). Update every {name} label (S07, S09-T,
PREP-1). If the save fails, nothing changes: no event, the call keeps the old name. A negated phrase
("Don't call yourself Max"), reported speech ("My friend said your name is Max") or a question about the name ("Why do you call yourself Max?", "Should I
call you Max?") is not a rename; a request ("Can I call you Max?") is.

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

## App funnel events REST

The app may batch its client-only funnel transitions on the same authenticated,
consented principal as the other `/v1/*` routes. The server discards unknown names
and every property outside that event's closed schema, then writes one JSON log line
per accepted event. It never logs a client event body or free-text value. Allowed
properties are fixed enums, bounded integers, booleans, and safe IDs only.

| method | path | result |
| --- | --- | --- |
| POST | `/v1/events` | `{events:[{name,at?,props?}]}`; max 20 events, 120 events/user/minute; `204` accepted, malformed bodies/over-20 `400`, over rate `429` |

The trusted vision adapter supplies only a <=480px SAM crop plus a safe one-line
summary to `src/memory/`; original camera frames are never persisted. Its pixel
safety check must exclude faces/people, documents, money and addresses. Integration
contracts and offline/live checks: [`src/memory/README.md`](src/memory/README.md).

## Server → app events

| type | fields | meaning |
|---|---|---|
| `ready` | `protocol`, `sessionId`, `mode`, `audio {in,out,frameHeaderBytes}`, `lip {requested, active, reason}`, `voiceId`, `bargeIn`, `tts` | session is live; `tts` = the voice mode actually used (`server` \| `device`) |
| `state` | `state: listening \| thinking \| speaking \| interrupted` | `interrupted` is momentary, always followed by `listening` |
| `speech.start` / `speech.end` | `turnId` | ASR heard the user start / stop |
| `backchannel` | `kind: mm \| yeah \| inhale`, `audio?` (base64 PCM s16le 24 kHz mono, server voice) | mid user turn (≥ 12 words, 1.2 s pause, ≤ 2 per turn, ≥ 20 s apart): play `audio` quietly beside the reply queue (stop it when the user speaks or a reply starts); not a reply, no state change; the uplink is never cut. On by default; `GENITA_BACKCHANNEL=0` turns it off (rollback). `inhale` (watch together): the instant nonverbal reaction, play `audio` the same way; brows up ≤ 0.5 s where the app supports it; `GENITA_WATCH_NONVERBAL=0` turns it off |
| `transcript` | `text`, `final`, `turnId?`, `source?: voice \| text` | partials are cumulative; `final:true` is the user's turn |
| `interpret.detected` | `from`, `to` | chat mode only: a Korean turn is being passed on to the user instead of answered |
| `interpret.pair` | `user`, `other` (string or null), `source`, `by: auto \| client`, `app?` | interpret mode started (`other: null` = INT-1 "listening for the other language") or the other language was just detected (INT-2 bar "Korean ↔ English") |
| `interpret.bubble` | `bubbleId`, `speaker`, `via`, `status`, `original {lang, text}`, `translation? {lang, text}`, `utteranceId?`, `reason?` | one two-language bubble; sent again on every change — **upsert by `bubbleId`**. See below. |
| `tool` | `utteranceId`, `name`, `status` | e.g. `web_search` `searching` — show a hint if you like |
| `reply.delta` | `utteranceId`, `text` | caption text, one sentence at a time (append) |
| `speaking` | `on`, `utteranceId`, `emotion?` | `on:true` with the emotion when a sentence's audio (device mode: its `say`) starts and the emotion changed (switch the face, F4-L13); `on:false` when done or cancelled |
| `say` | `utteranceId`, `sentence`, `text`, `emotion`, `lang` | device mode only: one sentence for the app to speak, in order. `text` is plain (no tags); `lang` is a BCP-47 hint (`en-US`, `ko-KR`, …) |
| `audio` | `utteranceId`, `seq`, `sentence`, `offsetMs`, `durationMs`, `sampleRate`, `model`, `words`, `mouth?` | server mode only: timing for the binary frame that follows |
| `audio.timing` | `utteranceId`, `sentence`, `seq`, `words`, `phonemes` | server voice with `GENITA_VOICE_ALIGN=1`: forced-aligner timing of one clause, after its audio (below) |
| `expression` | `utteranceId`, `sentence`, `tag`, `intensity`, `startMs`, `endMs` | server voice: the face expression of one clause, after its audio (below) |
| `reply` | `utteranceId`, `text`, `emotion`, `interpret`, `final:true` | full reply text (what was spoken) |
| `utterance.cancelled` | `utteranceId`, `reason: barge_in \| text \| client` | **stop playback now and drop queued audio** |
| `turn.metrics` | `model`, `ttsModel`, `speechEndToFirstAudioMs`, … | per-turn latency breakdown (server clock). Device mode: `ttsModel:"device"`, "first audio" = first `say` sent, `audioMs` = the speaking estimate below |
| `asr.status` | `status: connected \| reconnecting` | speech recognition reconnecting (show a mic hint) |
| `mode.changed` | `mode`, `by` | |
| `lip.changed` | `lip {requested, active, reason}` | Updated playback lip plan (`atlas` or `none`) |
| `error` | `code`, `message`, `retryable` | see below |
| `pong` | `t` | |
| `find.started` | `findId`, `utteranceId`, `kind: recipe \| outfit \| link`, `title`, `detail` | open the sheet in "searching" (r03 #1) |
| `find.progress` | `findId`, `detail` | update the searching line ("Kimchi, eggs, tofu · recipes") |
| `find.items` | `findId`, `items`, `checking`, `subtitle?`, `status?` | full ingredient list each time; replace, don't merge. `checking:false` = all checks done |
| `observe.boxes` | `findId`, `frame`, `w`, `h`, `items[{label, box, mask?}]` | boxes to pop on the camera preview (CAM-H, 240 ms pop, 4 s); `mask` = SAM outline over the box (`GENITA_SAM_MASKS=1`, see changelog 11/3) |
| `find.created` | `findId`, `card` | the card's text; pictures may still be `pending` |
| `find.image` | `findId`, `slot`, `status: ready \| failed`, `url?`, `source?: "generated"`, `omit?: true`, `replace?: FindProduct` | a picture landed. Slots: `hero`, `step-N` (1-based), `product-N` (1-based), `source-N` (0-based), `ingredient-<item id>`. `ready` + `source:"generated"` = a made picture ("Illustration"). `failed` + `omit:true` = no picture will come: remove the box. `replace` (product-N, with omit): show this product in that slot instead (see changelog 11/4 "No empty pictures") |
| `find.failed` | `findId`, `reason: unclear \| search_failed \| error \| stopped`, `message` | `unclear` = IC-4 "show me again"; nothing was made up |
| `companion.named` | `name` | the user renamed the companion in the call ("Call yourself Max"); already saved. Update every {name} label |
| `profile.updated` | `text`, `fields` | saved to the profile from the call: a correction (`text` = "Updated: no cilantro") or the answer to the call's question (`text` = "Noted: quiet company"); `fields` = profile sections, e.g. `likes`. Chip under the status line for 2.5 s (CC-1). Comes beside the reply, any time after the user's line |
| `profile.asking` | `topic` | the companion's reply just asked this call's getting-to-know-you question (calls 1–3, once per call). Soft chip "Getting to know you · {topic}" (GK-1), no modal |

`audio` timing (all ms on the reply's own audio timeline, 0 = first sample of the reply):

```json
{ "type": "audio", "utteranceId": 3, "seq": 41, "sentence": 0,
  "offsetMs": 0, "durationMs": 380, "sampleRate": 24000, "model": "seamless-m4t-v2",
  "words": [{ "w": "That's", "s": 80, "e": 310 }],
  "mouth": [{ "t": 80, "v": "A" }, { "t": 140, "v": "L" }, { "t": 310, "v": "X" }] }
```

- `words`: always sent (captions/karaoke). A word can rarely split across two chunks.
- `mouth`: only when `lip.active` is `atlas`. Visemes: `X` rest, `A` open, `E` wide, `O` round, `U` small round, `M` closed (m/b/p), `F` lip-teeth, `L` tongue, `S` small open. Apply each cue at its time against the audio clock. F4-L20 will swap these for atlas cell ids (`{f, cell}`); the field position stays.

## Device voice mode (`start.tts`)

| `start.tts` | server has server TTS (`GENITA_VOICE_URL` + `GENITA_VOICE_TOKEN`) | server without it (default) |
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
  no mouth cues come from the server; the device makes its mouth from its own speech.
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
  `seamless:<n>` picks that speaker; any other id (legacy voice ids) gets the companion kind's default
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
- **Forced-aligner timing (`audio.timing`, `GENITA_VOICE_ALIGN=1`)**: after a clause's audio, the voice service
  runs Meta's MMS forced aligner (torchaudio `MMS_FA`, same GPU) on the audio it just made and the text it spoke,
  and the server sends one `audio.timing` for that clause:

  ```json
  { "type": "audio.timing", "utteranceId": 4, "sentence": 0, "seq": 41,
    "words": [{ "w": "Oh", "s": 40, "e": 190 }, { "w": "wow,", "s": 190, "e": 520 }],
    "phonemes": [{ "p": "AO", "s": 40, "e": 190 }, { "p": "W", "s": 190, "e": 260 }, { "p": "OW", "s": 260, "e": 520 }] }
  ```
  - `seq` = the clause's first `audio` seq (the timing covers that clause's frames); `s`/`e` are ms on the reply's
    timeline, the same clock as `audio.words`, so they can be used as they arrive.
  - `words[].w` = the spoken form of the word (what the voice said, e.g. "five" for "5"). `phonemes[].p` = ARPAbet
    (`M`, `AA`, `OW`, `TH`, …; GenitaKit `LipViseme(phoneme:)` maps it). English letters are grouped by spelling
    rules; Korean is split into jamo. Short gaps (< 120 ms) are held by the previous phoneme, so a phoneme lasts
    until the next one starts; a real pause stays a gap (mouth at rest).
  - It never holds audio: the aligner starts after the clause's first audio line is out and the event follows the
    clause's frames (measured lag below). Prefer it over `audio.words` for the mouth when it is there.
  - Fallback: if the aligner fails, is late (> 250 ms after the clause's last audio) or is not confident, no
    `audio.timing` comes for that clause; keep using `audio.words` / text + loudness for it. Nothing comes for a
    cancelled utterance.
- **Face expression (`expression`, 11/3)**: at most one per clause of a chat reply, never for a neutral clause, never in
  interpretation or device mode. Sent after the clause's audio (and after its `audio.timing` when the aligner is on):

  ```json
  { "type": "expression", "utteranceId": 4, "sentence": 0, "tag": "smile", "intensity": 0.7, "startMs": 40, "endMs": 520 }
  ```
  - `tag` = `smile` | `smileopen` | `laugh` | `surprised` | `concerned`. `intensity` 0…1: 0.7, `laugh` 1.0.
  - `startMs`/`endMs` = ms on the reply's audio timeline (the `audio.offsetMs` clock): the clause's first word start →
    last word end from the aligner when it is on, else the clause's audio span. The app eases in before `startMs`
    and out after `endMs` (envelope in the app spec).
  - Where it comes from: Spark may start a clause with `[smile]`, `[laugh]`, … (the server strips it: never spoken,
    never in captions). Without a tag, laughing words ("haha") → `laugh`, "oh no / sorry / long day" → `concerned`,
    else the reply's leading `<emotion>` on its first clause (`happy`/`warm`/`teasing` → `smile`, `excited` →
    `smileopen`, `surprised` → `surprised`, `sad` → `concerned`; `curious`/`whisper`/`neutral` → none).
  - `GENITA_EXPRESSION=0` on the server sends none.
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

## Perception (PERC-1, camera reactions)

Off unless the server runs `GENITA_PERCEPTION=1`; then `ready.perception: true`. While the camera is on in chat mode the app
sends `perception.frame` (a fixed upper-centre crop of the front-camera frame; no on-device AI, runtime AI is Meta-only) at most every second, normally every 2.5 s or when the face changes. The server reads one
crop at a time with Muse Spark (strict JSON: expression, intensity, gaze, engagement, notable, confidence), smooths the reads
and keeps only that in memory for the call; the crop is dropped right after the read. Nothing comes back on the socket: the
conversation engine uses the state to react (a smile at its joke, a laugh, confusion, tiredness, looking away) at most once a
minute. No new server events. Design: `conversation-engine/PERCEPTION.md`.

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
| app → server | text | `start {source?}` first (source = shared app name, "Safari"; sent again while sharing = the share moved to another window or display), then `frame {image, blank?, motion?}`, `context {title}` (title changed, 11/3), `stop`, `ping {t}`. `start.title` = window title. `motion` (11/3, optional): 0–1 change from the previous sent frame (mean abs luma, 32×18); ≥ 0.1 = a cut or a big move |
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
react out loud (11/3: every ~5 s while the screen changes). Reactions: only while sharing, ≥ 30 s apart, not in the first 6 s, never while
the user or companion talks or the video's dialogue is running. A question while sharing gets
the memo, the last 90 s of lines (with speaker names) and the newest 4 frames (≈ 6 s).
11/3 realtime: the newest frame (≤ 1 s old while a video plays; the last image, "the screen right now") plus one ~2 s
older. "Oh, it's Karina!": the companion goes along with the user's name and adds one thing visible on that person now
(outfit, setting, action). It never identifies anyone from their face and adds no facts about a real person; with nobody
on screen it says it can't spot them. While the video is mid-line, the echo check uses that line's partial transcript and
only waits (≤ 1.5 s) when the partial is too short to tell. `npm run watch-sim -- --naming` measures it.

Measured 11/2 (`npm run watch-sim`, local server, real vendors; T5 clips played in real time, then asked as typed turns):
T5 set 38/50 correct (T5 video-file baseline 42/50; same judge re-run: 37 vs 42 strict, 39 vs 45 tone-tolerant — most misses are
where the generated video differs from its prompt, e.g. range hood vs "ceiling"); dialogue questions 7/7 on clips that have
dialogue; question → first audio p50 2.73 s (max 4.47 s; T5 was 3.4 s to text without voice); memo call p50 ≈ 3.2 s.
Reactions over a 250 s share: 3 (3.6 per 5 min), min gap 33 s, 0 rule violations, 2 with the laugh. Black screen: 5/5 answers
say it can't see, 0 claim to see something.

## Lip source (`start.lip`)

| mode | who | what the server sends |
|---|---|---|
| `atlas` | animals, characters | `mouth` cues in each `audio` event; device composites its mouth atlas |
| `none` | anyone | audio + `words` only; app plays its speaking clip |

Default: `atlas` for animal/character personas, `none` for humans. Always read `ready.lip.active`.

Unknown legacy lip modes select `none`. Removed worker metadata is ignored; the server never emits it.

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

`mouth {f, cell}` (F4-L20 atlas cells) · binary kind `2` (retired, never reuse) ·
`camera`, `frame` (F5) · `claim`, `ownership` (handoff: now defined, see **Handoff**) ·
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

**Fridge order (D23, #122).** A camera cooking turn is answered in three steps:
① the turn's reply is "Let me take a look." at once (a full answer from the raw
photo named things that were not there, 7/10 on 11/1); ② `observe.boxes` as each
item is confirmed; ③ once the checks are in (at most 3 s after the card), one
reply names only `have` items (Spark YES + SAM box, or a confirmed "맞아?") and the
dish, qualifying any dish ingredient that is not `have` ("…, if you have kimchi").
That line is also `card.say`. Real vendors, 10 runs on the test fridge photos:
names outside the photo 0/10, boxes before the line 10/10, short line p50 8 ms
after the question (server), first boxes p50 4.0 s, line p50 6.1 s, card p50 4.7 s.

**Product search (F7 PF-1 / MAC-RS, D2 D24 D25).** A shopping ask needs no camera
("can we look for a jacket for this weekend?", "find a couple that match my style,
and send me the links"). That turn's reply is a short line ("On it.") — never a
full answer, which would guess products and links — and the card follows:

```
find.started {kind:"product", title:"Finding 2 for your style…", detail:"Jacket · searching shops", evidence?:{style:"<import line>", situation:""}}
→ find.progress {detail:"Light jacket · checking 2 shops"} → find.created (products[], pictures pending)
→ find.image {slot:"product-1"|"product-2"} → the companion says card.say
```

`products[]` holds at most 2 product detail pages. Each `url` is an `open_page` the
search really completed (Spark's tool trace); a URL the model only wrote, a failed
open, or a category / collection / search page (URL shape, or the page's own
og:type / JSON-LD) is dropped. `price` only when the page showed it (absent → show
"Price on site"). `taste` (blue chip) follows a line of the account's import
(I04 Likes & dislikes), quoted in `evidence.style`; empty when there is none.
`situation` (grey chip) follows what they said (+ weather), quoted in
`evidence.situation`. One proven product → the card has one and says so; none →
`find.failed {reason:"search_failed"}` ("Couldn't find a good match…"). A later
product ask in the same call that names no new thing ("match my style") refines
the last search. Pictures are the page's og:image, fetched by the server (public
https hosts only, size-capped) and served like illustrations.

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

Server env: `GENITA_FINDS=0` off · `GENITA_FINDS_DIR` (default `./data/finds`) · `GENITA_FIND_IMAGES=0` no illustrations · `GENITA_SHOP_REGION` (default `US`) where product search shops.

## App config (`GET /v1/app-config`)

Public (no token: the apps read it before sign-in; the body has no user data). Data only — the apps never run
downloaded code; they bundle the same defaults (`shared/protocol-samples/http/app-config.json` shape) and ignore unknown keys.

| field | meaning |
|---|---|
| `schema` | `1` |
| `updates.ios` / `updates.mac` | `{minBuild, latestBuild, url}` — iOS: `latestBuild` > installed `CFBundleVersion` shows the "new version" banner linking `url` (TestFlight public link); below `minBuild` the banner can't be dismissed. Mac: below `minBuild` the app asks Sparkle to check now (`url` = appcast) |
| `flags` | booleans, e.g. `watchReactions`, `textChat`, `judgeAccess`, `interactiveSplash`, `motion` |
| `tuning` | numbers, e.g. `prepContinueAfterSceneMs`, `prepStallMs`, `firstCallWaitMs`, `updateCheckHours`; `bargeInMs` mirrors the server's `GENITA_BARGE_IN_MIN_MS` (read-only) |
| `copy` | strings by key (`{name}` placeholders), e.g. `prep.title`, `call.thinking`, `update.title` |
| `assets` | name → https URL (remote motion assets) |

Caching: `ETag` + `If-None-Match` → `304`; `Cache-Control: public, max-age=60, stale-while-revalidate=600`.
Server env: `GENITA_APP_CONFIG_FILE` = JSON overrides deep-merged over the defaults (`src/appconfig/appConfig.ts`), re-read when the file
changes (checked at most every 5 s), sanitized per key (wrong types, non-https URLs, copy over 500 chars are dropped; a broken file keeps
the last good config). Change a flag or string on AWS = edit that file on the instance, no restart.

## Handoff (F6-L7): which device has the sound

One conversation per user, stored as `conversations.active_device` (`iphone` | `mac` | null) and `epoch`.
The rule is the apps' `ConversationOwnership`: **the highest epoch wins; equal epochs with different owners → the Mac**.
Opening an app is never a claim. A lock, a background or a dropped socket never changes the owner.

```
wss://<host>/v1/presence?device=iphone|mac     (same auth as /v1/session; consent not needed)
```

The device is the JWT's device when it is `iphone`/`mac`, else `?device=`. Missing → close `4400`.
The server pings every 2 s and drops a socket silent for 6 s, so the other device learns "not responding" (R1-E / R2-E) within ~6 s.

| app → server | fields | meaning |
|---|---|---|
| `hello` | `owner?`, `epoch?`, `active?` | first message: the device's last known owner/epoch (`phone` accepted for `iphone`). A newer one than the server's (a tap made offline) is applied as a claim with trigger `sync`; otherwise nothing moves. |
| `claim` | `epoch?`, `trigger?` | this device takes the conversation. Without `epoch` the server uses current + 1 (no-op if it already owns it). `trigger`: `button` \| `touch` \| `continue` \| `start` \| `move` |
| `release` | `epoch?` | the owner gives it up → owner null until the next call `start` or claim |
| `move.request` | `to` | Move to Mac / Move to iPhone. Relayed to the other device, which answers by sending `claim`. |
| `presence` | `active` | `false` on lock/background, `true` on return. A locked device does not take move requests. |
| `proximity.arm` | — | iPhone only: "I own the conversation in a live call, give me a Bluetooth token". Re-sent every 30 s to rotate. |
| `proximity.disarm` | — | iPhone only: the call ended, moved, or the app left the front; its tokens stop counting |
| `proximity.seen` | `token`, `requestId?` | Mac only: this account's iPhone token was held close (RSSI over the threshold for 0.5 s). A new ID per attempt (nonempty string, ≤128 characters) correlates replies across timeouts/retries. |
| `ping` | `t` | → `pong {t}` |

| server → app | fields | meaning |
|---|---|---|
| `ownership` | `owner`, `epoch`, `conversationId`, `by`, `trigger` | the owner now (sent on connect, on hello, and to every device on each change). `trigger: "current"` = no change. |
| `claim.result` | `accepted`, `owner`, `epoch` | answer to this device's `claim`/`release`. `accepted` = this device holds the sound now. |
| `peer` | `device`, `online`, `active`, `inCall` | the other device's presence; `inCall` = it has a started call open (sent again when that changes) |
| `move.request` | `from` | the other device asked to move here: claim if the app is in front |
| `move.failed` | `to`, `reason: peer_offline \| peer_inactive` | at once, no 5 s wait (MV-E) |
| `proximity.token` | `token`, `expiresIn` (s) | answer to `proximity.arm`: advertise this as the BLE local name |
| `proximity.unavailable` | `reason: not_owner \| not_in_call` | answer to `proximity.arm` (`not_owner` = the Mac has it): don't advertise |
| `proximity.peer` | `armed` | to Macs: this account's iPhone is (not) advertising a token now. Sent on connect and on every change; the Mac scans (and asks for Bluetooth) only while `armed` |
| `proximity.result` | `accepted`, `requestId?`, `token?`, `reason: ok \| unknown_token \| expired \| not_owner \| not_in_call \| phone_inactive \| mac_inactive \| cooldown \| rate_limited \| server_error` | answer to `proximity.seen`, always; echoes both ID and token when the request supplied an ID (including refusals and store failures). A store failure is `server_error`: nothing moved, the token is spent, `proximity.peer {armed:false}` follows. `ok` → the server already claimed for the Mac (`ownership` with trigger `proximity` follows). A timeout is unconfirmed: keep the approach latched until a matching refusal or leaving range; a result for another attempt never releases it. |
| `error` | `code` | `bad_message`, `bad_epoch`, `unknown_type`, `server_error` |

What the server does on a claim that changes the owner: (1) shuts the audio gate and cancels the current
device's reply (`utterance.cancelled`, reason `client`), (2) writes the row, (3) sends `ownership` to every
presence and call socket of the user, (4) opens the gate for the new owner after a 250 ms handover lease
(the apps don't acknowledge the cancel, so the lease covers its delivery and the queue flush). Between (1) and (4) nobody plays.

On `/v1/session?device=…` (the query opts in; a JWT's device alone does not gate an older build): `audio` events and binary frames go only to the owner; mic audio from a non-owner is dropped;
captions and state still flow. A `start` on a conversation nobody holds (fresh, or released) makes that device the owner;
a `start` while the other device owns it does not move it — unless that device has no live connection (no presence socket
and no call: the app was quit), then the start takes it (`ownership`, trigger `start`). The call URL's `owner=` is applied
only for the calling device itself or for the other device while it is connected.

HTTP (same auth): `GET /v1/handoff` → `{owner, epoch, conversationId}` ·
`POST /v1/handoff/claim {device, epoch?, trigger?}` / `POST /v1/handoff/release {device, epoch?}` → `{accepted, owner, epoch, conversationId}` (400 on a bad device or an epoch outside int4).

### Proximity: bring the iPhone close to the Mac (no code, no tap)

Both apps are signed in to the same account, so they are already paired: the server knows both presences. During a
live iPhone call the iPhone (owner) sends `proximity.arm`; the server answers with an 8-symbol token (Crockford base32,
40 random bits, valid 60 s, at most two live per account). The iPhone advertises it over Bluetooth LE: service
`6E1D0001-7A2B-4C3D-9E4F-6A656E697461`, local name = the token. The Mac app scans for that service while the iPhone owns
the conversation and reports a token whose RSSI held at or above the threshold (default −45 dBm, re-armed below
−55 dBm) for 0.5 s. The server accepts it only when the token was issued to this account, is unexpired, its iPhone
presence socket is open and in front, the Mac has not taken the conversation since the token was issued (same epoch; a fresh conversation nobody claimed counts as the iPhone's), the account
has a started call (`start` accepted, not closed), the reporting Mac is in front, and no proximity move happened in the
last 10 s. All of that is checked inside the account's serial claim section, right before the write, so a tap, lock or
disarm that arrives first wins. Then it claims for the Mac with trigger `proximity` (the usual gate, cancel and
`ownership` broadcast), and all of that account's tokens are spent. Locking the iPhone (`presence {active:false}`) drops
its tokens. A stranger's token never matches another account. One report per account per 200 ms, across all its Mac
sockets (`rate_limited`). Tokens are
never logged; a rejection logs `handoff.proximity_rejected {reason}`.

Events for analytics: the server logs `handoff.preparing {from, to, trigger}`, `handoff.committed {from, to, total_ms, trigger, epoch}`, `handoff.failed {reason}`.
One process holds the gate (in memory); several server instances would need a shared channel for it.

## Errors

| code | retryable | what the app does |
|---|---|---|
| `spark_unavailable` | yes | show the "couldn't answer" state (S09-F); nothing was made up |
| `tts_unavailable` | yes | show captions for this reply; the next reply tries voice again |
| `asr_unavailable` | yes | voice input down; offer text (S08) |
| `daily_limit` | no | this account's turns for today are used up (Judge access codes, `GENITA_JUDGE_DAILY_TURNS`, D41). The turn was not answered and nothing was made up; the call stays open. Show the "couldn't answer" state; the limit resets at 00:00 UTC |
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

### Interpretation (11/2, `npm run smoke:interpret`, real vendors, the T7 clips: 5 Korean + 5 English alternating)

| run | turns relayed | speaker right | no mixing | voice end → first audio p50 | file end → first audio p50 | speculation hit |
|---|---|---|---|---|---|---|
| face (`source: face`, by language) | 10/10 | 10/10 | 10/10 | 1.65 s (1.68 s without turn 9*) | 1.37 s (1.44 s*) | 8/10 |
| face, run 2 | 10/10 | 10/10 | 10/10 | 1.57 s (max 1.90 s) | 1.27 s | 10/10 |
| Mac call (`source: call`, Korean as call sound, English held mic) | 10/10 | 10/10 | 10/10 | 1.68 s | 1.33 s | 9/10 |

Reference: 11/1 T7 (DIARIZATION) 3.9 s, T7b (ENDPOINTING + first sentence + v4 turbo) 2.2 s, both "file end". Target ≤ 2.5 s.
*Turn 9 ("It is on the second floor, next to the elevator.") was cut by ASR endpointing at the comma pause, so its
first half was translated before the clip ended (0.26 s); the second half became its own bubble.

