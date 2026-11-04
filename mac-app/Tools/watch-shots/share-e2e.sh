#!/bin/sh
# Build the "Share this window" end-to-end player (ShareE2E.swift + the Mac's real WatchCapture/WatchUplink) and run
# it, or just build it with --build-only. Command Line Tools are enough (no Xcode).
#   mac-app/Tools/watch-shots/share-e2e.sh --build-only <out-binary>
#   mac-app/Tools/watch-shots/share-e2e.sh <video> <ws://host:port> <sessionId> [leadSec] [tailSec]
# npm run watch-sim -- --moments --mac-bin=<out-binary> drives it per clip and measures the reactions.
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
build() {
  swiftc -O -parse-as-library -sdk "$(xcrun --sdk macosx --show-sdk-path)" -target arm64-apple-macos15.0 \
    "$ROOT/mac-app/GenitaMac/WatchCapture.swift" "$ROOT/mac-app/GenitaMac/WatchUplink.swift" \
    "$ROOT/mac-app/Tools/watch-shots/ShareE2E.swift" -o "$1"
}
if [ "${1:-}" = "--build-only" ]; then build "$2"; exit 0; fi
BIN="$(mktemp -d)/share-e2e"
build "$BIN"
exec "$BIN" "$@"
