// swift-tools-version: 5.9
import PackageDescription

// FaceRender: renders a face set talking to an audio file → mp4 (H.264 + AAC), and prints
// render fps and the A/V offset. Local/CI tool; not part of the apps.
let package = Package(
    name: "FaceRender",
    platforms: [.macOS(.v14)],
    dependencies: [.package(path: "../..")],
    targets: [
        .executableTarget(name: "FaceRender", dependencies: [.product(name: "GenitaKit", package: "GenitaKit")]),
    ]
)
