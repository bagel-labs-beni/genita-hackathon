import CoreImage
import XCTest
@testable import Genita

/// L4 · The animated Meta face on the call screen: the call feeds the face driver, cancels rest the mouth,
/// the face set comes from the prep manifest with the session token, and the render rate on the CI simulator.
/// Uses GenitaKit's fixture face set (512 px animal set) straight from the checkout.
@MainActor final class CompanionFaceTests: XCTestCase {
    static let fixtureDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appending(path: "shared/GenitaKit/Tests/GenitaKitTests/Fixtures/face-animal")
    private static var cachedSet: FaceSet?
    static func fixtureSet() throws -> FaceSet {
        if let cachedSet { return cachedSet }
        let set = try FaceSet(directory: fixtureDir)
        cachedSet = set
        return set
    }

    /// 24 kHz s16le speech-like tone: 180 Hz carrier, syllable-rate loudness swing.
    private func pcm(ms: Int) -> Data {
        let n = 24 * ms
        return PCM.data(from: (0..<n).map { i -> Int16 in
            let t = Double(i) / 24_000
            let env = 0.35 + 0.3 * sin(2 * .pi * 4 * t)
            return Int16(env * sin(2 * .pi * 180 * t) * 32_000)
        })
    }
    private func frame(seq: UInt32, _ pcm: Data) -> Data {
        var out = AudioFrameHeader(kind: GenitaProtocol.frameKindTTSPCM, seq: seq).encoded()
        out.append(pcm)
        return out
    }
    private func audio(_ utterance: Int, seq: UInt32, offsetMs: Int = 0, durationMs: Int = 400, words: String = "[]") -> String {
        #"{"type":"audio","utteranceId":\#(utterance),"seq":\#(seq),"sentence":0,"offsetMs":\#(offsetMs),"durationMs":\#(durationMs),"sampleRate":24000,"model":"meta-tts","words":\#(words)}"#
    }
    private func callWithFace() throws -> (CallController, FaceDriver, Box<[(bytes: Int, utterance: Int)]>) {
        let call = CallController()
        let played = Box<[(bytes: Int, utterance: Int)]>([])
        call.playbackSink = { pcm, id in played.value.append((pcm.count, id)) }
        call.useFace(try Self.fixtureSet(), key: "test", reduceMotion: true)
        return (call, try XCTUnwrap(call.face), played)
    }

    // MARK: routing

    func testAudioEventAndItsPCMFrameReachTheFaceAndStillPlay() throws {
        let (call, face, played) = try callWithFace()
        call.handle(#"{"type":"reply.delta","utteranceId":7,"text":"Hello there, how are you?"}"#)
        call.handle(audio(7, seq: 3))
        call.handle(binary: frame(seq: 3, pcm(ms: 400)))
        XCTAssertEqual(face.currentUtteranceId, 7)
        let mid = face.timeline.sample(atMs: 200)
        XCTAssertGreaterThan(mid.openness, 0.2, "the received PCM opens the jaw")
        XCTAssertNotEqual(mid.dominant, .rest)
        XCTAssertEqual(played.value.count, 1, "the chunk still goes to the speaker")
        XCTAssertEqual(played.value.first?.bytes, 24 * 400 * 2)
        XCTAssertEqual(played.value.first?.utterance, 7)
        XCTAssertEqual(face.timeline.sample(atMs: 900).openness, 0, "after the received audio there is no sound")
    }

    func testWordTimingsInTheAudioEventShapeTheMouth() throws {
        let (call, face, _) = try callWithFace()
        call.handle(audio(8, seq: 1, words: #"[{"w":"mama","s":0,"e":400}]"#))
        call.handle(binary: frame(seq: 1, pcm(ms: 400)))
        let shapes = Set(stride(from: 10.0, to: 400, by: 20).map { face.timeline.sample(atMs: $0).dominant })
        XCTAssertTrue(shapes.contains(.MBP), "the word's letters drive the shapes (m → MBP): \(shapes)")
    }

    func testPCMWithoutItsAudioEventIsNotGuessed() throws {
        let (call, face, played) = try callWithFace()
        call.handle(binary: frame(seq: 99, pcm(ms: 200)))
        XCTAssertNil(face.currentUtteranceId)
        XCTAssertEqual(played.value.count, 1)
    }

    func testServerCancelRestsTheMouthAndLateAudioStaysClosed() throws {
        let (call, face, _) = try callWithFace()
        call.handle(audio(7, seq: 3))
        call.handle(binary: frame(seq: 3, pcm(ms: 400)))
        XCTAssertGreaterThan(face.timeline.sample(atMs: 200).openness, 0.2)
        call.handle(#"{"type":"utterance.cancelled","utteranceId":7,"reason":"barge_in"}"#)
        XCTAssertNil(face.currentUtteranceId)
        XCTAssertEqual(face.timeline.sample(atMs: 200), .rest)
        // a late chunk of the cancelled reply
        call.handle(audio(7, seq: 4, offsetMs: 400))
        call.handle(binary: frame(seq: 4, pcm(ms: 400)))
        XCTAssertEqual(face.timeline.sample(atMs: 600), .rest)
    }

    func testLocalBargeInRestsTheMouth() throws {
        let (call, face, _) = try callWithFace()
        call.handle(#"{"type":"state","state":"speaking"}"#)
        call.handle(#"{"type":"speaking","on":true,"utteranceId":5,"emotion":"happy"}"#)
        call.handle(audio(5, seq: 1))
        call.handle(binary: frame(seq: 1, pcm(ms: 400)))
        XCTAssertEqual(face.currentUtteranceId, 5)
        call.interrupt()   // tap on the face
        XCTAssertNil(face.currentUtteranceId)
        XCTAssertEqual(face.timeline.sample(atMs: 200), .rest)
    }

    func testNoFaceSetKeepsTheStill() {
        let call = CallController()
        call.playbackSink = { _, _ in }
        call.handle(audio(1, seq: 1))
        call.handle(binary: frame(seq: 1, pcm(ms: 100)))
        XCTAssertNil(call.face)
        call.useFace(nil, key: nil, reduceMotion: false)
        XCTAssertNil(call.face)
    }

    func testFaceFramesCoverTheBoardAtTwiceItsHeight() throws {
        let size = CompanionFace.outputSize(for: try Self.fixtureSet())
        XCTAssertEqual(size.height, 910, "never above the set's own pixels")
        XCTAssertEqual(size.width / size.height, 512.0 / 910, accuracy: 0.002)
        XCTAssertEqual(CompanionFace.pixelHeight, 1688)
    }

    func testKlingLoopIsOffByDefault() {
        XCTAssertFalse(CompanionFace.flag(nil) ?? false)
        XCTAssertEqual(CompanionFace.flag("1"), true)
        XCTAssertEqual(CompanionFace.flag(true), true)
        XCTAssertEqual(CompanionFace.flag("0"), false)
        XCTAssertFalse(CompanionFace.klingFace, "the Meta face is the default; GENITA_KLING_FACE=1 brings the loop back")
    }

    // MARK: loading

    private func serverManifest() throws -> (FaceManifest, Data) {
        var m = try JSONDecoder().decode(FaceManifest.self, from: Data(contentsOf: Self.fixtureDir.appending(path: "manifest.json")))
        m.images = Dictionary(uniqueKeysWithValues: m.images.keys.map { ($0, "/v1/companion/face/\($0)") })
        m.visemes = Dictionary(uniqueKeysWithValues: m.visemes.keys.map { ($0, "/v1/companion/face/\($0)") })
        let prep = try JSONSerialization.data(withJSONObject: ["status": "ready", "face": try JSONSerialization.jsonObject(with: JSONEncoder().encode(m))])
        return (m, prep)
    }

    private func stubServer(prep: Data, missing: Set<String> = []) -> (CompanionFaceLoader.Fetch, Box<[URLRequest]>) {
        let seen = Box<[URLRequest]>([])
        let dir = Self.fixtureDir
        let fetch: CompanionFaceLoader.Fetch = { req in
            seen.append(req)
            let url = req.url!
            func reply(_ status: Int, _ body: Data) -> (Data, URLResponse) {
                (body, HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!)
            }
            if url.path == "/v1/companion/prep" { return reply(200, prep) }
            if url.path.hasPrefix("/v1/companion/face/") {
                let key = url.lastPathComponent
                if missing.contains(key) { return reply(404, Data(#"{"error":"no_image"}"#.utf8)) }
                if let data = try? Data(contentsOf: dir.appending(path: "\(key).jpg")) { return reply(200, data) }
            }
            return reply(404, Data())
        }
        return (fetch, seen)
    }

    private func tempDir() -> URL {
        let url = URL.temporaryDirectory.appending(path: "face-cache-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    func testLoaderBuildsTheFaceSetFromThePrepManifestWithTheSessionToken() async throws {
        let (_, prep) = try serverManifest()
        let (fetch, seen) = stubServer(prep: prep)
        let endpoint = CallEndpoint(url: URL(string: "wss://api.genita.test/v1/session")!, token: "tok")
        let loader = CompanionFaceLoader(endpoint: endpoint, cacheRoot: tempDir(), fetch: fetch)

        guard case let .loaded(key, set) = try await loader.load(currentKey: nil) else { return XCTFail("no face set") }
        XCTAssertEqual(set.expressions.count, 4)
        XCTAssertGreaterThanOrEqual(set.patches.count, 8, set.notes.joined(separator: "; "))
        XCTAssertEqual(seen.value.count, 1 + 14, "prep + 4 expressions + 10 visemes")
        for req in seen.value {
            XCTAssertEqual(req.url?.scheme, "https")
            XCTAssertEqual(req.url?.host(), "api.genita.test")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
            XCTAssertEqual(req.httpMethod ?? "GET", "GET")
        }

        // Same companion again: images come from the disk cache, and the driver can stay as it is.
        guard case .loaded(let again, _) = try await loader.load(currentKey: nil) else { return XCTFail("cache miss") }
        XCTAssertEqual(again, key)
        XCTAssertEqual(seen.value.count, 15 + 1, "only the prep call; images from Caches")
        guard case .unchanged = try await loader.load(currentKey: key) else { return XCTFail("rebuilt an unchanged set") }
        XCTAssertEqual(seen.value.count, 16 + 1)
    }

    func testLoaderToleratesARejectedImageButNeedsNeutral() async throws {
        let (_, prep) = try serverManifest()
        let endpoint = CallEndpoint(url: URL(string: "wss://api.genita.test/v1/session")!, token: "tok")
        let (fetch, _) = stubServer(prep: prep, missing: ["blink", "TH"])
        guard case let .loaded(_, set) = try await CompanionFaceLoader(endpoint: endpoint, cacheRoot: tempDir(), fetch: fetch).load(currentKey: nil) else { return XCTFail() }
        XCTAssertFalse(set.hasBlink)
        XCTAssertNil(set.patches[.TH])

        let (noNeutral, _) = stubServer(prep: prep, missing: ["neutral"])
        do {
            _ = try await CompanionFaceLoader(endpoint: endpoint, cacheRoot: tempDir(), fetch: noNeutral).load(currentKey: nil)
            XCTFail("a face set without its neutral still can't be drawn")
        } catch {}
    }

    func testLoaderKeepsTheStillWithoutAFaceOrAToken() async throws {
        let running = Data(#"{"status":"running","face":null,"sceneUrl":null}"#.utf8)
        let (fetch, seen) = stubServer(prep: running)
        let endpoint = CallEndpoint(url: URL(string: "wss://api.genita.test/v1/session")!, token: "tok")
        guard case .none = try await CompanionFaceLoader(endpoint: endpoint, cacheRoot: tempDir(), fetch: fetch).load(currentKey: nil) else { return XCTFail() }
        XCTAssertEqual(seen.value.count, 1)

        let signedOut = CallEndpoint(url: URL(string: "wss://api.genita.test/v1/session")!, token: nil)
        guard case .none = try await CompanionFaceLoader(endpoint: signedOut, cacheRoot: tempDir(), fetch: fetch).load(currentKey: nil) else { return XCTFail() }
        XCTAssertEqual(seen.value.count, 1, "no request without a token")
    }

    func testLoaderNeverSendsTheTokenToAnotherHost() async throws {
        var (m, _) = try serverManifest()
        m.images["neutral"] = "https://elsewhere.test/neutral"
        m.visemes["A"] = "//elsewhere.test/A"
        let prep = try JSONSerialization.data(withJSONObject: ["status": "ready", "face": try JSONSerialization.jsonObject(with: JSONEncoder().encode(m))])
        let (fetch, seen) = stubServer(prep: prep)
        let endpoint = CallEndpoint(url: URL(string: "wss://api.genita.test/v1/session")!, token: "tok")
        do {
            _ = try await CompanionFaceLoader(endpoint: endpoint, cacheRoot: tempDir(), fetch: fetch).load(currentKey: nil)
            XCTFail("neutral on another host must not load")
        } catch {}
        XCTAssertFalse(seen.value.contains { $0.url?.host() == "elsewhere.test" })
    }

    // MARK: render rate

    /// The number for the PR: frames per second of the face renderer at 540×960 on the CI simulator.
    func testRenderThroughputAt540x960() throws {
        let set = try Self.fixtureSet()
        let renderer = FaceRenderer(faceSet: set, outputSize: CGSize(width: 540, height: 960), seed: 7)
        let shapes = LipViseme.shapes
        _ = renderer.render(at: 0, lip: .rest)   // warm up the context
        let n = 120
        let start = CFAbsoluteTimeGetCurrent()
        var last: CGImage?
        for i in 0..<n {
            let v = shapes[i % shapes.count]
            let lip = LipFrame(weights: [v: 0.7, .rest: 0.3], openness: Float(i % 10) / 10)
            last = renderer.render(at: Double(i) / 30, lip: lip)
            XCTAssertNotNil(last)
        }
        let seconds = CFAbsoluteTimeGetCurrent() - start
        let fps = Double(n) / seconds
        let line = String(format: "FACE_FPS=%.1f (%d frames 540x960, %.2f s, simulator)", fps, n, seconds)
        print(line)
        XCTContext.runActivity(named: line) { _ in }
        if let last {
            let shot = XCTAttachment(image: UIImage(cgImage: last))
            shot.name = "face-render-540x960"
            shot.lifetime = .keepAlways
            add(shot)
        }
        XCTAssertEqual(last?.width, 540)
        XCTAssertEqual(last?.height, 960)
        XCTAssertGreaterThan(fps, 1, "renderer stalled")
    }
}

/// A mutable box the stub fetcher (a @Sendable closure) can write to.
final class Box<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: T
    init(_ value: T) { _value = value }
    var value: T {
        get { lock.withLock { _value } }
        set { lock.withLock { _value = newValue } }
    }
}

extension Box where T == [URLRequest] {
    func append(_ r: URLRequest) { lock.withLock { _value.append(r) } }
}
