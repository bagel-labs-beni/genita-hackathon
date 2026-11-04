# New versus existing

What in this repository predates the hackathon (Oct 27 – Nov 5, 2026, KST), and what does not.

Everything we wrote was built during the hackathon; open-source dependencies are listed in Credits ([`docs/CREDITS.md`](docs/CREDITS.md)).

## Existing (pre-hackathon)

None of our own code. Code from our earlier products is no longer in this repository (see Removed).

Open-source dependencies are existing third-party code, used under their licenses:

- EffectSource's Duo blur shader and sampler (`shared/Handoff/EffectSource/`): open-source dependency (MIT, © 2026 Akash T, license kept next to the sources). Genita's compositor is new code written on top of it.
- Three.js (MIT), bundled into `shared/Handoff/handoff-effect.{js,html}`, and the other libraries, fonts and models listed in Credits.

## Removed

An account gateway and a web prototype from our earlier products, and our earlier lip-sync engine, were removed before submission and are not part of this submission.

## New

Everything we wrote was built during the hackathon: the iOS and Mac apps, genita-server, device ownership (`shared/Handoff/ConversationOwnership.swift`), the handoff sheets, local camera and microphone controls, the Genita sounds, the iPhone ↔ Mac move effect's compositor (built on the EffectSource dependency above) and `ios-app/Genita/LidarWorldTracker.swift`. The first commit of this repository is dated Oct 31, 2026 (KST).
