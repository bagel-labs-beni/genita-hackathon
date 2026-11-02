#!/bin/sh
# PCM conversion, black-frame detection, change detection and watch-socket decoding.
#   mac-app/Tools/watch-shots/check.sh     (run from the repo root)
set -eu
BIN="$(mktemp -d)/capture-checks"
swiftc -parse-as-library -sdk "$(xcrun --sdk macosx --show-sdk-path)" -target arm64-apple-macos15.0 \
  mac-app/GenitaMac/WatchCapture.swift mac-app/GenitaMac/WatchUplink.swift mac-app/Tools/watch-shots/CaptureChecks.swift -o "$BIN"
"$BIN"
