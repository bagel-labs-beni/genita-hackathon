# Product decisions — 2026-11-04 (KST)

This file is the in-repo copy of the product decisions made on the night of 11/3 → 11/4 KST.
It is the current truth for the behaviors below. QA and merges check against it.

- Full PRD: D2 PRD v12.2e, section 2.2 (decisions D101–D116). The PRD itself is kept outside
  this public repo; this file carries every decision that changes UI or behavior.
- QA: each decision maps to one or more scenario IDs in the Genita QA scenario book
  (`LG-01`, `IS-01`, …). A PR that implements a decision cites those IDs.
- Where Figma and this file disagree, this file wins for the items marked "deviates from Figma".

## Merge rule (from 11/4 05:00 KST)

1. Every merged PR names the scenario ID(s) it satisfies.
2. A PR that changes UI or behavior not covered by the PRD and the scenario book is synced first
   (PRD + scenario book updated) and merged after.

## Decisions log 11/4

| ID | Decision | Why | PR | Scenarios |
| --- | --- | --- | --- | --- |
| D101 | **Insight report = R1 "Lou's read".** The SUM step becomes one scrolling, light-only report in the companion's voice ("Here's my read on you"): type name → one-line definition → three signature words → "Your mix" (only from answers the user actually gave) → traits with quoted evidence (That's me / Not quite) → strengths and watch-outs (each watch-out ends with "I'll …") → YOU'RE → SO YOU → SO I'LL → share card. A pinned CTA starts the call at any point. With 0–1 observations the type name is replaced by "Still getting to know you". No invented numbers or percentages. | A grounded "wow, that's me" moment instead of four summary lines. Approved 04:19. | #534 (server), #543 (app) | IS-01 |
| D102 | **Settings = option C.** M02 is a short iOS list (companion card → About you → Account → Start over → legal links). "What Lou knows about you" (preview sentence + count) opens an **About you** page that reuses the R1 components: type card, "What Lou noticed" with quotes and sources, one "Still learning" block (no repeated "Not enough information yet."), three source rows, and "Forget all of this" (forgets knowledge only, keeps the companion). Tapping an observation offers That's me / Not quite… / Remove. | The old list showed more unknowns than knowns and could not be corrected or deleted. Approved 04:19. | #535 | SE-01 |
| D103 | **Call HUD = option A.** 16 pt side margins. The status pill sits on the same row as the settings button, center y = safeAreaTop + 30 (height 32, radius 16), fixed (does not follow the face). A second line sits at safeAreaTop + 54. "Noted" replaces the pill's content for 2.4 s instead of a separate chip. Controls 44 pt, 12 pt apart, bottom baseline = height − safeAreaBottom − 12. Self view is a glass tile, **72×96 with the camera off, 108×144 with it on**, radius 16, left 16, on the baseline. Deviates from Figma S09. | The pill sat on the hair and margins were 24/31/34. Approved 04:19. | #530 (iPhone), #540 (Mac self view) | IC-03, IC-01, CL-01 |
| D104 | **Glass button glyphs = 55 % of the circle diameter** (settings, camera, mic, ⋮; call, rail and Mac). | The gear had shrunk. | #544 | SY-04 |
| D105 | **CTAs follow the Figma flat style.** Primary 313×50, radius 12, #111, Pretendard Medium 16, white text. Secondary #FFF with a 1 pt #E3E3E3 border, radius 12. Liquid Glass only on call controls and the HUD (inactive-window ink 0.88 stays). Mac login "Continue with email" has a 1 pt border (Figma 344:2). Replaces the earlier "keep glass on buttons" for CTAs. | Figma is the reference for CTAs. | #554 (Mac) | SY-05, MC-01 |
| D106 | **Screen design review.** D1: secondary text #B7B7B7 → **#737373** (voice descriptions, "About 3 minutes", onboarding card subtitles, report labels; 2.0:1 → 4.8:1). D3: the interpreter partner bubble has **no border** (fill only). D4: product finds drop the color-legend sentence; chips carry symbols **✦ = my style**, **“ = what I said**; evidence line "From your style and what you said · {domain} +n"; a card whose photo failed uses **#F3F1ED** with a hanger icon. D2 held: onboarding margins stay as in Figma. D5: nothing to do (R1 removes the blue SUM CTA). Deviates from Figma for D1/D5. | Readability and "broken" looking cards. Approved 04:53. | #556 | SY-06, TR-01, FD-02 |
| D107 | **I03 orb top is ≥ 24 pt below the subtitle.** Deviates from the Figma soul-orb node. | The orb crowded the subtitle. | #515 | IM-01 |
| D108 | **Mac: a cold launch never starts a call.** Home (MAC-4) shows "Continue here"; mic, camera and screen capture start only after that tap. Only a live iPhone → Mac move opens the call directly. | Opening the app should not start talking. | #551 | MC-01 |
| D109 | **The original uploaded photo is never shown after onboarding V02** — not on cold launch, not at call connect, not in PiP. A veiled orb / placeholder shows until the generated face loads. | A frame of the original before the face reads as fake. | #524 | CL-03 |
| D110 | **ASR is English-only for normal calls** (`GENITA_ASR_LANGUAGES=English`, live). Interpreter mode adds Korean automatically and drops it when turned off. Watch-together audio ASR is English-only too (accepted). | English-only product; fewer mis-hearings. | config | SY-07, TR-01, CW-03 |
| D111 | **Crisis.** Method / means / imminence phrases trigger even in isolation; everyday near-miss phrases (kitchen, screen, routine) must not. A crisis reply always includes the 988 line. Low mood alone is normal conversation. | Three plan lines were missed; some crisis replies had no number. | #533, #545 | SY-08, CL-02 |
| D112 | **TTS prosody post-processing is closed (11/3); keep the current voice.** Emotion maps to speech rate only. | Decided 11/3. | — | SY-09 |
| D113 | **Reconnect after a drop on the same device greets with one short reconnect line** (not the first-call greeting, not silence). In progress. | Silence or a repeated "Hey, {name}!" felt broken. | #555 | IC-02 |
| D114 | **The Mac app is `Genita.app`.** Old installs rename themselves after a Sparkle update. | No internal names where people look. | #528 | MC-01 |
| D115 | **The onboarding orb is Dyno's original three.js volumetric orb ported to Metal.** Reduce Motion = breathing only. | Match the original motion. | #515 | IM-01 |
| D116 | **QA sample photos for QA accounts.** V01 shows "Use a test photo" only for accounts on the allowlist `GENITA_QA_SAMPLE_PHOTOS`. | Device QA cannot open the photo library. | #519 | PU-03 |

## Superseded earlier decisions

- D76 / D83 "buttons stay Liquid Glass" → for CTAs, replaced by D105. Glass stays on call controls and the HUD.
- D87 "emotion: all of it" → replaced by D112 (speech rate only).
- Motion detail 3 (separate "Noted" chip dropping 8 pt) → replaced by D103 (content swap inside the pill).
- Figma SUM (four lines, blue CTA), secondary text #B7B7B7, S09 HUD positions and the I03 soul-orb position → replaced by D101, D106, D103 and D107.
