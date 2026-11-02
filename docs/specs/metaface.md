# Meta-only face and voice (lane L4, 11/2)

> **Update 11/2 21:xx (Chelsea via coordinator):** the companion voice is a Meta open TTS model on our
> GPU (SeamlessM4T v2 or Orpheus, lane L6-voice, #150), streamed by genita-server as PCM chunks with
> `audio` events (+ word/phoneme timings where derivable). The device voice (`say` +
> AVSpeechSynthesizer, PR #157) is only the offline fallback. The lip engine therefore consumes
> **server audio + timing events**, and falls back to **received PCM loudness + reply text** when
> timings are absent. Sections below that make device speech the main voice are superseded.

Chelsea 11/2 19:50 KST: everything the companion runs on at call time is Meta (muse-spark-1.3,
muse-image-1.0, sam-3.1, muse-voice-transcribe-1.0) or on the device. No ElevenLabs, Kling,
fal/H3 or Peter in the submission build. Those paths stay in the code behind flags that are
off by default, and the server starts without their keys.

## As-is → to-be

| area | as-is (origin/main b2aabf3) | to-be |
|---|---|---|
| voice | server streams ElevenLabs PCM (binary kind 1) + `audio` events | server streams reply text per sentence (`say`); the device speaks it with AVSpeechSynthesizer into the existing AVAudioPlayerNode (voice-processing echo cancellation unchanged) |
| face | still + Kling silent loop per emotion (`LoopingVideo`) | Muse Image expression set from the scene (neutral, blink, smile, warm); device animates the still (breathing, sway, blinks, expression crossfades) |
| lips | `atlas` cues for animals/characters (MiniMax H3 bake, PR #112, not merged), Peter crops for humans | one lip engine for all types: viseme patches baked with Muse Image edits of the companion's own scene, mouth located with SAM 3.1; timing from the speech engine's own phoneme/word markers; device composites with a feathered mask, colour match and a jaw warp |
| prep | scene → 3 Kling clips → lips (Peter / atlas todo) | scene → face set (3 expression edits + 10 viseme edits + SAM mouth/face boxes, drift-checked) |
| keys | `ELEVENLABS_API_KEY` required at boot, `FAL_KEY` used if set | only `MODEL_API_KEY` required |

The lip engine below is new code written during the hackathon with generic techniques; PR #112 is
not merged or copied.

## Protocol (additive, v1 stays)

- `start.tts`: `"server" | "device"`. Default: `"device"` when the server has no server TTS
  (`GENITA_SERVER_TTS` unset), else `"server"`.
- `ready.tts`: the mode actually used (always sent from now on; old apps ignore it).
- New event `say` `{utteranceId, sentence, text, emotion, lang}`: one sentence for the device to
  speak, in order. `text` is plain (no tags). `lang` is a BCP-47 hint (`en-US`, `ko-KR`, …)
  from the reply language (interpretation sends the target language). Sent only in device mode.
- Device mode sends no `audio` events and no binary frames. `speaking {on:true, emotion}` is sent
  with the first `say` of each emotion change, like today. The turn machine's `first_audio` fires
  on the first `say`.
- `speaking` ends on `playback_done` (the app sends it when the last buffer has played) or on a
  server estimate (70 ms per character + 1.5 s, capped at 60 s) if the app never says so.
- Barge-in unchanged: `utterance.cancelled` → the app stops synthesis and flushes the player now.
- `turn.metrics.ttsModel` = `"device"`; `speechEndToFirstAudioMs` = speech end → first `say` sent.
- `ready.lip` in device mode: `{requested, active:"none", reason:"device_tts"}`. No mouth cues
  come from the server; the device makes them from its own speech.
- PROTOCOL.md changelog line; TS `protocol.ts` + Swift `Protocol.swift` + samples
  `shared/protocol-samples/server/say.json`, `ready.device.json`, `client/start.device.json`.

Threat line (new event, no new endpoint/auth): who = iOS/Mac app on the existing authenticated
session socket · auth = unchanged (session token / JWT) · abuse = none new (server sends text it
already sent as `reply.delta`; client `tts` is an enum) · data = reply text only, already exposed.

## Server flags (all default off)

| env | turns on | needs |
|---|---|---|
| `GENITA_SERVER_TTS=1` | ElevenLabs streaming + voice previews | `ELEVENLABS_API_KEY` |
| `GENITA_KLING=1` | fal: gpt-image-2 scene fallback, Kling silent clips | `FAL_KEY` |
| `GENITA_PETER=1` | Peter live worker + Peter prepare | `GENITA_PETER_URL/TOKEN`, `GENITA_PETER_PREPARE_URL` |

With a flag off the code path is not reached and its key is not read. `loadConfig` throws only
for a missing `MODEL_API_KEY`, or a missing key of a flag that is on.

## Face set (prep step `face`)

Inputs: the scene (existing Muse Image edit, step `scene`). Output stored with the companion and
returned by `GET /v1/companion/prep` as `face` (manifest) — PREP_API.md documents it.

```json
{
  "version": 1,
  "size": [1024, 1820],
  "faceBox": [x1, y1, x2, y2],
  "mouthBox": [x1, y1, x2, y2],
  "images": { "neutral": "<url>", "blink": "<url>", "smile": "<url>", "warm": "<url>" },
  "visemes": { "MBP": "<url>", "FV": "<url>", "TH": "<url>", "L": "<url>", "WQ": "<url>",
               "O": "<url>", "EI": "<url>", "A": "<url>", "U": "<url>", "CDG": "<url>" },
  "boxes": { "<image or viseme key>": { "face": [..], "mouth": [..] } },
  "rejected": [{ "key": "TH", "reason": "face_moved", "retried": true }],
  "ms": { "total": 0, "edits": 0, "sam": 0 }
}
```

- Boxes are normalised 0–1 (x1,y1,x2,y2) in the image's own pixels.
- `rest` = the neutral scene itself (no edit). A viseme missing after rejection is simply absent;
  the device falls back along a fixed nearest-shape table.
- Muse Image edit prompts share one scaffold: "Edit only the mouth/eyes …; keep identity, face,
  hair, eyes, lighting, background, framing and camera exactly the same" + the shape line
  (e.g. A = "mouth wide open as in 'ah', jaw dropped, teeth and tongue visible").
- Drift check (server, Meta-only): SAM 3.1 face box + mouth box on every edit; reject if the face
  box centre moved > 3% of the image width or its size changed > 6%, or the mouth box is missing;
  one retry with the stricter prompt; then mark rejected.
- Concurrency 6. Edits for expressions and visemes run in parallel.
- Pixel work (crop, registration, colour match, drift outside the mouth) happens on the device,
  where ImageIO decodes Muse Image's WebP.

## Device lip engine (GenitaKit, new files)

- Speech: `AVSpeechSynthesizer.write(_:toBufferCallback:toMarkerCallback:)` (iOS 17 / macOS 14).
  Buffers are converted to 24 kHz mono and scheduled on `CallAudio`'s player (same path as server
  PCM). Markers (`.phoneme`, `.word`) give sample offsets. Barge-in calls `stopSpeaking(at:
  .immediate)` and flushes the player.
- Visemes (12): rest, MBP, FV, TH, L, WQ, O, EI, A, U, CDG (+ closed transition). Phoneme →
  viseme table; if the voice gives no phoneme marks, word marks + a grapheme → viseme pass over
  the word's letters spread across the word's duration.
- Openness: RMS of the rendered buffer per 40 ms window → 0…1, scales the jaw warp and the
  patch's vertical scale. MBP forces closed.
- Cues `{t, viseme, open}` on the audio clock (`CallAudio.playbackPositionMs`); viseme changes
  crossfade over 60 ms. Target A/V offset ≤ 40 ms.
- Compositor (Core Image): base = expression image (crossfade on `speaking.emotion`: laugh/happy →
  smile, warm → warm, else neutral) → mouth patch (crop of the viseme image around `mouthBox`
  with margin, registered to the base by a small translation search, colour-matched by mean/std
  of a ring around the mouth, feathered elliptical mask from the SAM box) → jaw warp (lower-face
  vertical stretch driven by openness so the chin moves) → blink layer (crossfade to the blink
  image, ~120 ms, random 2–6 s). Idle: breathing scale ±0.6% at ~0.25 Hz, sway ±0.4°.
  Reduce Motion: no breathing/sway/blinks; mouth still moves.
- Render tool `shared/GenitaKit/Tools/FaceRender`: face set dir + text → mp4 with sound,
  prints fps and A/V offset. CI workflow renders one sample per type and uploads the mp4s.

## App

- `shared/Call`: `CallSession` sends `start.tts:"device"`, handles `say` → `DeviceSpeech` →
  `CallAudio.enqueue`; `playback_done` as before; `utterance.cancelled`/barge-in → stop.
- Call screen: `CompanionFaceView` draws the animated face from the prep `face` manifest; the
  Kling `LoopingVideo` path stays behind `GENITA_KLING_FACE` (off).
- Voice picker: system voices (Premium/Enhanced en-US first; ko-KR etc. for interpretation).

## Acceptance

1. Server with only `MODEL_API_KEY`: `npm test`, typecheck, `npm run smoke` (device mode) pass; no
   ElevenLabs/fal/Peter request is made (tests assert the deps are never called).
2. User stops talking → `say` arrives; p50 speech end → first `say` measured (n ≥ 10).
3. Device: first PCM buffer from AVSpeechSynthesizer measured on the CI simulator (n ≥ 10);
   sum = first-sound estimate.
4. Barge-in during device speech: no audio after cancel (unit test with a fake synthesizer).
5. Prep: photo → face set ready; time measured per type (human/animal/character).
6. Render: sample mp4 per type; fps on CI; A/V offset ≤ 40 ms; viseme frames checked by eye.

## Units

| unit | files | depends | branch / worktree |
|---|---|---|---|
| S server voice + flags | genita-server/src/{config,server,protocol}.ts, session/, tts/, PROTOCOL.md, Protocol.swift, protocol-samples, tests, smoke | — | feat/metaface-voice · genita-metaface-voice |
| P prep face set | genita-server/src/prep/**, PREP_API.md, prep tests, scripts/face-e2e.ts | config flags from S (reads env itself) | feat/metaface-prep · genita-metaface-prep |
| K GenitaKit face + lips + render tool + CI | shared/GenitaKit/Sources/GenitaKit/Face*/Lip*/DeviceSpeech*, Tools/FaceRender, .github/workflows/face-kit.yml | P assets for samples | feat/metaface · genita-metaface |
| A app wiring | shared/Call, ios-app/Genita/CallScreen.swift, ConversationView, mac-app | S, K | feat/metaface |

## Risk / rollback

- Server: `GENITA_SERVER_TTS=1` (+key) returns to ElevenLabs; `start.tts:"server"` per call.
- App: `GENITA_KLING_FACE=1` returns to the clip loop.
- Rollback = revert + redeploy.
