# Meta-only face and lips (lane L4, 11/3)

Everything the companion runs on at call time is Meta (muse-spark, muse-image, sam-3.1,
muse-voice-transcribe, the Meta open TTS on our GPU) or on the device. The face is a still made
alive on the device; no video model and no ML run in the app.

## Pieces

| piece | where | what |
|---|---|---|
| face set | prep (#158) | scene + expression stills (neutral, blink, smile, warm) and viseme stills from Muse Image edits, SAM face/mouth boxes, drift-checked |
| flow morph data | prep (#226) | lower-face key composites on the neutral, classical optical flow both ways (float16), a mask locked below the nose, per-kind map of rules |
| lip timeline | GenitaKit `Lips/` | server PCM loudness + aligner word/phoneme timings (#210 `audio.timing`), reply text where timings are missing |
| face engine | GenitaKit `Face/` | flow morph (option B) over the active keys, snap texture switch, closure hold, jaw floor, cheek coupling; key patches when a set has no flows |
| alive base | GenitaKit `Face/AliveMotion.swift` | head / body / background layers: tilt and drift, nod on speech onsets, breathing, small handheld drift, blinks |
| app | `shared/Call` (#177) | loads the face set and flow files with the session token, feeds the driver from the call events, draws on the call screen (iOS + Mac) |

## Invariants

- The nose and everything above the lock line are the still's own pixels on every frame.
- A manifest without `face.flow` (or with any flow file missing) uses the key patches.
- Reduce Motion stops the alive base and blinks; the mouth still moves.
- Rules are data (`face.flow.map`), merged per kind by prep; the app only interprets them.

## Rollback

Revert the PRs; a server without flow prep already sends no `face.flow`.
