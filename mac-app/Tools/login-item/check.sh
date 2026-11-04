#!/bin/sh
# Open at login (MacLoginItem) and the hidden launch at login. Command Line Tools are enough (no Xcode).
#   mac-app/Tools/login-item/check.sh              policy checks + hidden-launch live move (run from the repo root)
#   mac-app/Tools/login-item/check.sh --policy     policy checks only
#   mac-app/Tools/login-item/check.sh --build-only both built, nothing run
# The live-move check builds the whole Mac app (like watch-shots/render.sh) and opens real windows, so it wants a
# logged-in GUI session (the CI macOS runner has one).
set -eu
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SDK="$(xcrun --sdk macosx --show-sdk-path)"
swiftc -parse-as-library -sdk "$SDK" -target arm64-apple-macos15.0 \
  mac-app/GenitaMac/MacLoginItem.swift mac-app/Tools/login-item/PolicyChecks.swift -o "$WORK/policy"
[ "${1:-}" = "--build-only" ] || "$WORK/policy"
[ "${1:-}" = "--policy" ] && exit 0
sed 's/^@main struct GenitaMacApp/struct GenitaMacApp/' mac-app/GenitaMac/GenitaMacApp.swift > "$WORK/GenitaMacAppNoMain.swift"
# CallAudio / InterpretAudioOutput catch AVAudioPlayerNode.play()'s ObjC exception through GenitaObjCCatch (as render.sh)
clang -c -fobjc-arc -isysroot "$SDK" -target arm64-apple-macos15.0 shared/Call/GenitaObjCCatch.m -o "$WORK/GenitaObjCCatch.o"
swiftc -parse-as-library -sdk "$SDK" -target arm64-apple-macos15.0 -D DEBUG \
  -import-objc-header shared/Call/Genita-Bridging-Header.h "$WORK/GenitaObjCCatch.o" \
  $(ls mac-app/GenitaMac/*.swift | grep -v GenitaMacApp.swift) mac-app/GenitaMac/Interpret/*.swift "$WORK/GenitaMacAppNoMain.swift" \
  mac-app/Tools/login-item/HiddenMoveCheck.swift \
  shared/Handoff/*.swift shared/Call/*.swift $(find shared/GenitaKit/Sources/GenitaKit -name '*.swift') \
  ios-app/Genita/AppState.swift ios-app/Genita/SharedSettingsView.swift -o "$WORK/hidden-move"
[ "${1:-}" = "--build-only" ] || "$WORK/hidden-move"
