# New versus existing

What in this repository predates the hackathon (10/28 – 11/5), and what does not.

## Existing (pre-hackathon)

Nothing in the submitted apps or server. Code that predated the hackathon is no longer in this repository (see Removed).

## Removed

An account gateway and a web prototype from our earlier products, and our earlier lip-sync engine, were removed before submission and are not part of this submission.

## New

Everything here was built during the hackathon: the iOS and Mac apps, genita-server, device ownership (`shared/Handoff/ConversationOwnership.swift`), the handoff sheets, local camera and microphone controls, the Genita sounds, and the iPhone ↔ Mac move effect. The iPhone ↔ Mac handoff effects — EffectSource and its Duo shader (`shared/Handoff/EffectSource/`, built into `shared/Handoff/handoff-effect.{js,html}`) and `ios-app/Genita/LidarWorldTracker.swift` — are NEW; the first related commit was made during the hackathon (11/1), as was the first commit here. Three.js (MIT) is a third-party library; its license is kept next to the sources.
