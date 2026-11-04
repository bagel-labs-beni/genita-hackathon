import CoreGraphics
import XCTest
@testable import Genita

/// Face plan items 2 + 6 (11/4): a returning account's face comes from Caches before `/prep` answers (poster, then
/// set), `/prep` only swaps it when it changed; a flow face never downloads its viseme stills and is drawn from
/// neutral + flow before the expression stills land; the face.timing line (#645 part 1).
/// Uses GenitaKit's small flow fixture (face-flow-animal, 512 × 910) so every set builds in about a second.
@MainActor final class CompanionFaceCacheTests: XCTestCase {
    static let flowDir = CompanionFaceTests.fixtureDir.deletingLastPathComponent().appending(path: "face-flow-animal")
    private let endpointURL = URL(string: "wss://api.genita.test/v1/session")!

    private func jwt(_ sub: String) -> String {
        let body = Data(#"{"sub":"\#(sub)"}"#.utf8).base64EncodedString().replacingOccurrences(of: "=", with: "")
        return "h.\(body).s"
    }

    private func tempDir() -> URL {
        let url = URL.temporaryDirectory.appending(path: "face-cache-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    /// The flow fixture as the server names it: every ref is `/v1/companion/face/<name>`; `files` maps a name to the
    /// fixture file it serves. Expression stills and the two viseme stills reuse the neutral picture.
    private func flowManifest(faceBoxNudge: Double = 0) throws -> (manifest: FaceManifest, prep: Data, files: [String: String]) {
        var m = try JSONDecoder().decode(FaceManifest.self, from: Data(contentsOf: Self.flowDir.appending(path: "manifest.json")))
        var files: [String: String] = [:]
        func ref(_ name: String, _ file: String) -> String { files[name] = file; return "/v1/companion/face/\(name)" }
        m.images = ["neutral": ref("neutral", "neutral-full.jpg"), "blink": ref("blink", "neutral-full.jpg"),
                    "smile": ref("smile", "neutral-full.jpg"), "warm": ref("warm", "neutral-full.jpg")]
        m.visemes = ["A": ref("A", "neutral-full.jpg"), "O": ref("O", "neutral-full.jpg")]
        var flow = try XCTUnwrap(m.flow)
        for (k, f) in flow.files {
            var g = f
            g.key = ref("flow_\(k)_key", f.key)
            g.nk = f.nk.map { ref("flow_\(k)_nk", $0) }
            g.kn = f.kn.map { ref("flow_\(k)_kn", $0) }
            flow.files[k] = g
        }
        flow.mask = ref("flow_mask", flow.mask)
        flow.neutralRoi = flow.neutralRoi.map { ref("flow_neutral", $0) }
        m.flow = flow
        m.faceBox[0] += faceBoxNudge
        let prep = try JSONSerialization.data(withJSONObject: ["status": "ready", "face": try JSONSerialization.jsonObject(with: JSONEncoder().encode(m))])
        return (m, prep, files)
    }

    /// A stub server: `/prep` answers `prep` (after `prepDelay`), face files come from the fixture folder.
    private func server(prep: Data, files: [String: String], missing: Set<String> = [], prepDelay: Duration = .zero) -> (CompanionFaceLoader.Fetch, Box<[String]>) {
        let seen = Box<[String]>([])
        let dir = Self.flowDir
        let fetch: CompanionFaceLoader.Fetch = { req in
            let url = req.url!
            seen.value.append(url.lastPathComponent)
            func reply(_ status: Int, _ body: Data) -> (Data, URLResponse) {
                (body, HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!)
            }
            if url.path == "/v1/companion/prep" {
                if prepDelay > .zero { try await Task.sleep(for: prepDelay) }
                return reply(200, prep)
            }
            let name = url.lastPathComponent
            if !missing.contains(name), let file = files[name], let data = try? Data(contentsOf: dir.appending(path: file)) { return reply(200, data) }
            return reply(404, Data())
        }
        return (fetch, seen)
    }

    private func loader(_ sub: String, root: URL, fetch: @escaping CompanionFaceLoader.Fetch) -> CompanionFaceLoader {
        CompanionFaceLoader(endpoint: CallEndpoint(url: endpointURL, token: jwt(sub)), cacheRoot: root, fetch: fetch)
    }

    /// What the early consumer got, with how many requests had gone out at that moment.
    private final class EarlyLog: @unchecked Sendable {
        let lock = NSLock()
        var events: [(kind: String, key: String, set: FaceSet?, requests: Int)] = []
        func add(_ e: CompanionFaceLoader.Early, requests: Int) {
            lock.withLock {
                switch e {
                case let .poster(key, _): events.append(("poster", key, nil, requests))
                case let .face(key, set): events.append(("face", key, set, requests))
                }
            }
        }
        var all: [(kind: String, key: String, set: FaceSet?, requests: Int)] { lock.withLock { events } }
    }

    private func consumer(_ log: EarlyLog, _ seen: Box<[String]>) -> CompanionFaceLoader.EarlyConsumer {
        { e in log.add(e, requests: seen.value.count); return true }
    }

    private func poster() -> CGImage {
        let ctx = CGContext(data: nil, width: 8, height: 12, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(CGColor(red: 0.8, green: 0.4, blue: 0.2, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: 8, height: 12))
        return ctx.makeImage()!
    }

    // MARK: item 6 — first download

    func testAFlowFaceNeverDownloadsItsVisemesAndIsDrawnBeforeTheExpressionStills() async throws {
        let (_, prep, files) = try flowManifest()
        let (fetch, seen) = server(prep: prep, files: files)
        let root = tempDir()
        let early = EarlyLog()
        guard case let .loaded(key, set) = try await loader("a", root: root, fetch: fetch).load(currentKey: nil, early: consumer(early, seen)) else {
            return XCTFail("no face set")
        }
        XCTAssertFalse(seen.value.contains("A") || seen.value.contains("O"), "the flow morph draws every mouth: no viseme stills (\(seen.value))")
        XCTAssertNotNil(set.flow)
        XCTAssertTrue(set.patches.isEmpty, "no viseme patches computed for a flow face")
        XCTAssertEqual(Set(set.expressions.keys), [.neutral, .blink, .smile, .warm], "the full set has the expression stills")

        let first = try XCTUnwrap(early.all.first, "the neutral + flow set was handed over before the expressions")
        XCTAssertEqual(first.kind, "face")
        XCTAssertEqual(first.key, key + CompanionFaceLoader.partialSuffix, "a partial key, so a later load still finishes it")
        XCTAssertNotNil(first.set?.flow)
        XCTAssertEqual(first.set.map { Set($0.expressions.keys) }, [.neutral])
        let before = Array(seen.value.prefix(first.requests))
        XCTAssertEqual(before.first, "prep")
        XCTAssertFalse(before.contains { ["blink", "smile", "warm"].contains($0) }, "expression stills come after the first set: \(before)")
        XCTAssertTrue(before.contains("neutral") && before.contains("flow_mask"))
        XCTAssertEqual(early.all.count, 1)
        XCTAssertNotNil(CompanionFaceLoader.diskManifest(root: root, subject: "a"), "the whole set is on disk for the next launch")
    }

    /// Codex P2: a load cancelled after its partial set (call screen gone) never marks the folder as a finished set.
    func testACancelledLoadIsNeverSavedAsAFinishedSet() async throws {
        let (_, prep, files) = try flowManifest()
        let (fetch, _) = server(prep: prep, files: files)
        let root = tempDir()
        let handle = Box<Task<CompanionFaceLoader.Outcome, Error>?>(nil)
        let l = loader("a", root: root, fetch: fetch)
        let task = Task { try await l.load(currentKey: nil, early: { _ in handle.value?.cancel(); return true }) }
        handle.value = task
        _ = try? await task.value
        XCTAssertNil(CompanionFaceLoader.diskManifest(root: root, subject: "a"), "next launch must not take it as complete")
    }

    func testWithoutAnEarlyConsumerTheSetIsBuiltOnceWithEverything() async throws {
        let (_, prep, files) = try flowManifest()
        let (fetch, seen) = server(prep: prep, files: files)
        guard case let .loaded(_, set) = try await loader("a", root: tempDir(), fetch: fetch).load(currentKey: nil) else { return XCTFail() }
        XCTAssertEqual(Set(set.expressions.keys), [.neutral, .blink, .smile, .warm])
        XCTAssertEqual(seen.value.count, 1 + 4 + 8, "prep + 4 images + 8 flow files (J2/J3 key·nk·kn, mask, neutral roi), no visemes")
    }

    func testAFlowFaceMissingAFlowFileFallsBackToItsVisemes() async throws {
        let (_, prep, files) = try flowManifest()
        let (fetch, seen) = server(prep: prep, files: files, missing: ["flow_J2_nk"])
        guard case let .loaded(_, set) = try await loader("a", root: tempDir(), fetch: fetch).load(currentKey: nil) else { return XCTFail() }
        XCTAssertNil(set.flow, "a flow set with a file missing is dropped")
        XCTAssertTrue(seen.value.contains("A") && seen.value.contains("O"), "then the viseme stills are needed: \(seen.value)")
    }

    // MARK: item 2 — returning account

    func testAReturningAccountGetsItsSavedPosterAndSetBeforePrepAndPrepOnlyConfirms() async throws {
        let (_, prep, files) = try flowManifest()
        let root = tempDir()
        let (fetch1, _) = server(prep: prep, files: files)
        guard case let .loaded(key, _) = try await loader("a", root: root, fetch: fetch1).load(currentKey: nil) else { return XCTFail() }
        CompanionFaceLoader.savePoster(poster(), root: root, key: key, reduceMotion: false)
        XCTAssertNotNil(CompanionFaceLoader.loadPoster(root: root, key: key, reduceMotion: false))

        let (fetch, seen) = server(prep: prep, files: files)
        let early = EarlyLog()
        let outcome = try await loader("a", root: root, fetch: fetch).load(currentKey: nil, early: consumer(early, seen))
        XCTAssertEqual(early.all.map(\.kind), ["poster", "face"])
        XCTAssertEqual(early.all.map(\.key), [key, key])
        XCTAssertEqual(early.all.map(\.requests), [0, 0], "both before any request")
        XCTAssertEqual(early.all.last?.set.map { Set($0.expressions.keys) }, [.neutral, .blink, .smile, .warm], "the full set from disk")
        guard case .unchanged = outcome else { return XCTFail("prep named the same face: nothing to swap") }
        XCTAssertEqual(seen.value, ["prep"], "only /prep; nothing downloaded again")

        // a reduce-motion poster was never drawn: no poster, the set still comes
        let rm = EarlyLog()
        let (fetch3, seen3) = server(prep: prep, files: files)
        _ = try await loader("a", root: root, fetch: fetch3).load(currentKey: nil, posterReduceMotion: true, early: consumer(rm, seen3))
        XCTAssertEqual(rm.all.map(\.kind), ["face"])
        // the face on screen already is that set: nothing from disk again
        let same = EarlyLog()
        let (fetch4, seen4) = server(prep: prep, files: files)
        guard case .unchanged = try await loader("a", root: root, fetch: fetch4).load(currentKey: key, early: consumer(same, seen4)) else { return XCTFail() }
        XCTAssertTrue(same.all.isEmpty)
    }

    func testAChangedFaceReplacesTheSavedOneAfterPrep() async throws {
        let (_, prep, files) = try flowManifest()
        let root = tempDir()
        let (fetch1, _) = server(prep: prep, files: files)
        guard case let .loaded(oldKey, _) = try await loader("a", root: root, fetch: fetch1).load(currentKey: nil) else { return XCTFail() }

        let (_, remade, files2) = try flowManifest(faceBoxNudge: 0.01)   // reflowMask etc.: a new manifest
        let (fetch, _) = server(prep: remade, files: files2)
        let early = EarlyLog()
        guard case let .loaded(newKey, _) = try await loader("a", root: root, fetch: fetch).load(currentKey: nil, early: { e in early.add(e, requests: 0); return true }) else {
            return XCTFail("the new face replaces the saved one")
        }
        XCTAssertEqual(early.all.first?.key, oldKey, "the saved face showed first")
        XCTAssertNotEqual(newKey, oldKey)
        XCTAssertEqual(CompanionFaceLoader.diskManifest(root: root, subject: "a")?.key, newKey, "only the new set stays on disk")
    }

    func testAnotherAccountNeverGetsTheSavedFaceOrPoster() async throws {
        let (_, prep, files) = try flowManifest()
        let root = tempDir()
        let (fetch1, _) = server(prep: prep, files: files)
        guard case let .loaded(keyA, _) = try await loader("a", root: root, fetch: fetch1).load(currentKey: nil) else { return XCTFail() }
        CompanionFaceLoader.savePoster(poster(), root: root, key: keyA, reduceMotion: false)

        let (fetch, seen) = server(prep: prep, files: files)
        let early = EarlyLog()
        guard case let .loaded(keyB, _) = try await loader("b", root: root, fetch: fetch).load(currentKey: nil, early: consumer(early, seen)) else { return XCTFail() }
        XCTAssertNotEqual(keyA, keyB, "the key is per account")
        XCTAssertFalse(early.all.contains { $0.kind == "poster" || $0.key == keyA }, "B never sees A's poster or set")
        XCTAssertEqual(seen.value.first, "prep")
        XCTAssertNil(CompanionFaceLoader.diskManifest(root: root, subject: "a"), "A's set is pruned")
        XCTAssertNil(CompanionFaceLoader.loadPoster(root: root, key: keyA, reduceMotion: false))
    }

    func testAPosterOnlyGoesIntoAFolderTheLoaderMade() throws {
        let root = tempDir()
        for bad in ["../evil", "dir:/tmp/x", "a/b", ""] {
            XCTAssertNil(CompanionFaceLoader.posterURL(root: root, key: bad, reduceMotion: false), bad)
        }
        let key = "v1-" + String(repeating: "ab", count: 12)   // the shape cacheKey gives
        CompanionFaceLoader.savePoster(poster(), root: root, key: key, reduceMotion: false)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path), "no set folder → nothing written")
        try FileManager.default.createDirectory(at: root.appending(path: key), withIntermediateDirectories: true)
        CompanionFaceLoader.savePoster(poster(), root: root, key: key + CompanionFaceLoader.partialSuffix, reduceMotion: true)
        let back = try XCTUnwrap(CompanionFaceLoader.loadPoster(root: root, key: key, reduceMotion: true), "a partial set's poster is its set's")
        XCTAssertEqual(back.width, 8); XCTAssertEqual(back.height, 12)
        XCTAssertNil(CompanionFaceLoader.loadPoster(root: root, key: key, reduceMotion: false), "one file per reduce-motion setting")
    }

    func testPartsPutNeutralPersonAndFlowFirst() throws {
        var (m, _, _) = try flowManifest()
        m.images["person"] = "/v1/companion/face/person"
        m.images["surprised"] = "/v1/companion/face/surprised"
        let p = CompanionFaceLoader.parts(of: m)
        XCTAssertEqual(Set(p.images.keys), ["neutral", "person"])
        XCTAssertEqual(Set(p.later.keys), ["blink", "smile", "warm", "surprised"])
        XCTAssertEqual(Set(p.visemes.keys), ["A", "O"])
        XCTAssertEqual(p.flow?.count, 8)
        XCTAssertEqual(Set(p.first.keys), Set(p.images.keys).union(p.flow!.keys))
    }

    // MARK: the call

    /// A relaunch into a call: the saved poster is up while `/prep` is still on its way, then the saved set moves.
    func testACallShowsTheSavedFaceBeforePrepAnswers() async throws {
        let saved = CallEndpoint.userToken
        defer { CallEndpoint.userToken = saved }
        let tokA = jwt("acct")
        CallEndpoint.userToken = { tokA }
        let (_, prep, files) = try flowManifest()
        let root = tempDir()
        let (fetch1, _) = server(prep: prep, files: files)
        guard case let .loaded(key, _) = try await loader("acct", root: root, fetch: fetch1).load(currentKey: nil) else { return XCTFail() }
        CompanionFaceLoader.savePoster(poster(), root: root, key: key, reduceMotion: true)

        let (slow, seen) = server(prep: prep, files: files, prepDelay: .seconds(30))
        let call = CallController()
        call.faceLoaderOverride = { CompanionFaceLoader(endpoint: $0, cacheRoot: root, fetch: slow) }
        call.showFace(reduceMotion: true, animate: false)
        for _ in 0..<200 where call.facePoster == nil { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(call.facePoster?.width, 8, "the saved poster, before /prep answered")
        for _ in 0..<1200 where call.face == nil { try await Task.sleep(for: .milliseconds(100)) }
        XCTAssertNotNil(call.face, "the saved set moves before /prep answered")
        XCTAssertNotEqual(call.facePoster?.width, 8, "the set's own rest frame replaces the saved one")
        XCTAssertTrue(seen.value.allSatisfy { $0 == "prep" }, "nothing downloaded: \(seen.value)")
        call.hideFace()

        // another account on the same phone: never A's poster
        let tokB = jwt("other")
        CallEndpoint.userToken = { tokB }
        let b = CallController()
        b.faceLoaderOverride = { CompanionFaceLoader(endpoint: $0, cacheRoot: root, fetch: slow) }
        b.showFace(reduceMotion: true, animate: false)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertNil(b.facePoster)
        XCTAssertNil(b.face)
        b.hideFace()
    }

    // MARK: #645 part 1

    func testTimingLineHasEachStepOnceAndGoesOutOnce() {
        let t = FaceLoadTiming()
        t.mark("prep"); t.mark("poster", note: "disk"); t.mark("prep")
        XCTAssertNil(t.lineOnce(needing: ["firstFrame", "done"]))
        t.mark("firstFrame"); t.mark("done")
        let line = t.lineOnce(needing: ["firstFrame", "done"])
        XCTAssertNotNil(line)
        XCTAssertTrue(line?.hasPrefix("face.timing prep=") == true, line ?? "")
        XCTAssertTrue(line?.contains("poster=") == true && line?.contains("(disk)") == true)
        XCTAssertEqual(line?.components(separatedBy: "prep=").count, 2, "a step's first time only")
        XCTAssertNil(t.lineOnce(needing: ["firstFrame", "done"]), "one line per load")
    }
}
