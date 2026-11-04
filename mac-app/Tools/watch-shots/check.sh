#!/bin/sh
# PCM conversion, black-frame detection, change detection and watch-socket decoding.
#   mac-app/Tools/watch-shots/check.sh     (run from the repo root)
set -eu
BIN="$(mktemp -d)/capture-checks"
swiftc -parse-as-library -sdk "$(xcrun --sdk macosx --show-sdk-path)" -target arm64-apple-macos15.0 \
  mac-app/GenitaMac/WatchCapture.swift mac-app/GenitaMac/WatchUplink.swift mac-app/Tools/watch-shots/CaptureChecks.swift -o "$BIN"
"$BIN"
# #211: the call pill and the MAC-RS searching lines stay on one line (renders → build-output/watch-screens/cue-*.png)
CUE="$(mktemp -d)/cue-checks"
swiftc -parse-as-library -sdk "$(xcrun --sdk macosx --show-sdk-path)" -target arm64-apple-macos15.0 \
  shared/Call/OneLineText.swift mac-app/GenitaMac/MacCallCue.swift shared/Call/MacCallPlan.swift \
  shared/GenitaKit/Sources/GenitaKit/Protocol.swift shared/GenitaKit/Sources/GenitaKit/FindsProtocol.swift \
  mac-app/Tools/watch-shots/CueChecks.swift -o "$CUE"
"$CUE" "${1:-build-output/watch-screens}"
# 11/4: the "Share this window" e2e player (ShareE2E.swift + the real WatchCapture/WatchUplink) still builds
mac-app/Tools/watch-shots/share-e2e.sh --build-only "$(mktemp -d)/share-e2e"
