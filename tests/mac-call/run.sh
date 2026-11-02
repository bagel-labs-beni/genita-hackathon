#!/bin/sh
# Runs ios-app/GenitaTests/MacCallPlanTests.swift without Xcode (Command Line Tools swiftc).
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${TMPDIR:-/tmp}/genita-mac-call-tests"
mkdir -p "$OUT"
sed 's/^@testable import Genita$//; s/^import XCTest$/import Foundation/' "$ROOT/ios-app/GenitaTests/MacCallPlanTests.swift" > "$OUT/Tests.swift"
cat > "$OUT/main.swift" <<'SWIFT'
import Foundation
let t = MacCallPlanTests()
var names: [String] = []
let mirror = Mirror(reflecting: t)
_ = mirror
for (name, run) in MacCallPlanTests.all(t) { print("• \(name)"); do { try run() } catch { XCTFail("threw \(error)") } }
print(shimFailures == 0 ? "PASS \(MacCallPlanTests.all(t).count) tests" : "FAILED \(shimFailures) assertions")
exit(shimFailures == 0 ? 0 : 1)
SWIFT
# test list (XCTest discovers these by name; the shim needs them listed)
{
  echo "extension MacCallPlanTests { static func all(_ t: MacCallPlanTests) -> [(String, () throws -> Void)] { ["
  grep -o 'func test[A-Za-z0-9]*' "$ROOT/ios-app/GenitaTests/MacCallPlanTests.swift" | sed 's/func \(.*\)/("\1", t.\1),/'
  echo "] } }"
} > "$OUT/List.swift"
swiftc -swift-version 5 -o "$OUT/run" \
  "$ROOT/shared/GenitaKit/Sources/GenitaKit/Protocol.swift" \
  "$ROOT/shared/GenitaKit/Sources/GenitaKit/FindsProtocol.swift" \
  "$ROOT/shared/Call/MacCallPlan.swift" "$ROOT/shared/Call/CallWire.swift" \
  "$ROOT/tests/mac-call/XCTShim.swift" "$OUT/Tests.swift" "$OUT/List.swift" "$OUT/main.swift"
"$OUT/run"
