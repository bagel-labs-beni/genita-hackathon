# New versus existing

What in this repository predates the hackathon (10/28 – 11/5), and what does not.

## Existing (pre-hackathon)

Nothing in the submitted apps or server. Code that predated the hackathon is no longer in this repository (see Removed).

## Removed

The earlier account gateway (`server/index.mjs`, `src/api.js`, `src/persona-call.js`, `src/original-call.js`), the web design prototype and the Peter lip-sync engine bundle (`peter-engine/`) were not used by the submitted apps, so they were deleted.

## New

Everything here was built during the hackathon: the iOS and Mac apps, genita-server, device ownership (`shared/Handoff/ConversationOwnership.swift`), the handoff sheets, local camera and microphone controls, the Genita sounds, and the iPhone ↔ Mac move effect — `shared/Handoff/EffectSource/`, the built `shared/Handoff/handoff-effect.{js,html}` and `ios-app/Genita/LidarWorldTracker.swift` — which came from `handoff-effects-lab`, a scratch repo started during the hackathon (first commit 11/1; first commit here 11/1). Three.js (MIT) is a third-party library; its license is kept next to the sources.
