#!/bin/sh
# Runs the GenitaKit tests. With only Command Line Tools (no Xcode), Swift
# Testing lives outside the default search path and its Foundation overlay has
# no module, so point at the framework and skip cross-import overlays.
set -e
cd "$(dirname "$0")"
F=/Library/Developer/CommandLineTools/Library/Developer/Frameworks
if [ "$(xcode-select -p)" = "/Library/Developer/CommandLineTools" ] && [ -d "$F/Testing.framework" ]; then
  exec swift test -Xswiftc -F -Xswiftc "$F" -Xswiftc -Xfrontend -Xswiftc -disable-cross-import-overlays \
    -Xlinker -F -Xlinker "$F" -Xlinker -rpath -Xlinker "$F" "$@"
fi
exec swift test "$@"
