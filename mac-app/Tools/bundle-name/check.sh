#!/bin/bash
# MacBundleName (GenitaMac.app → Genita.app at launch): plan + on-disk moves. Run from the repository root.
set -euo pipefail
BIN="$(mktemp -d)/bundle-name-check"
swiftc -o "$BIN" mac-app/GenitaMac/MacBundleName.swift mac-app/Tools/bundle-name/main.swift 2>&1 | grep -v "^$" || true
test -x "$BIN"
"$BIN"
