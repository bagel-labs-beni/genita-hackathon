// swift-tools-version: 5.9
import PackageDescription

// GenitaKit: code shared by the iOS and macOS apps. Protocol.swift mirrors
// genita-server/src/protocol.ts (F0-L4); both test against ../protocol-samples.
let package = Package(
    name: "GenitaKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "GenitaKit", targets: ["GenitaKit"])],
    targets: [
        .target(name: "GenitaKit"),
        .testTarget(name: "GenitaKitTests", dependencies: ["GenitaKit"], resources: [.copy("Fixtures")]),
    ]
)
