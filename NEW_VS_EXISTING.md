# New versus existing

What in this repository predates the hackathon, and what does not.

## Existing (pre-hackathon)

- `existing/peter-engine/`: Peter lip-sync engine bundle, native Swift compositor, demo character cache and test media. Offline only. The apps do not call it.
- `shared/Handoff/EffectSource/` and the built `shared/Handoff/handoff-effect.{js,html}`: Duo blur shader, sampler and payload compositor from `handoff-effects-lab`. Upstream license is kept next to the sources. Three.js is MIT.
- `ios-app/Genita/LidarWorldTracker.swift`: plane, corner and world-map algorithm ported from `handoff-effects-lab`.

`handoff-effects-lab` is not in this repository. Treat the last two items as existing until the lab's dates are confirmed.

## Removed

The earlier account gateway in `server/index.mjs`, `src/api.js`, `src/persona-call.js` and `src/original-call.js` were not used by any screen, so they were deleted. They remain in git history.

## New

Everything else: the iOS and Mac apps, the web design prototype, device ownership (`shared/Handoff/ConversationOwnership.swift`), the handoff sheets, local camera and microphone controls, and the Genita sounds.
