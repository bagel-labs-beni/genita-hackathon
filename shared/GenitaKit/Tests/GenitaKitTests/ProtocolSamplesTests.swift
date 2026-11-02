import Foundation
import Testing
@testable import GenitaKit

/// F0-L4: the Swift types decode and re-encode the same samples the server tests use.
struct ProtocolSamplesTests {
    private func samples(_ side: String) throws -> [(String, Data)] {
        let dir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("protocol-samples/\(side)")
        let files = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".json") }.sorted()
        #expect(!files.isEmpty, "no samples in \(dir.path)")
        return try files.map { ($0, try Data(contentsOf: dir.appendingPathComponent($0))) }
    }

    private func object(_ data: Data) throws -> NSDictionary {
        try JSONSerialization.jsonObject(with: data) as! NSDictionary
    }

    @Test func testEveryServerSampleDecodesToAKnownEventAndRoundTrips() throws {
        for (name, data) in try samples("server") {
            let event = try JSONDecoder().decode(ServerEvent.self, from: data)
            if case let .unknown(type) = event { Issue.record("\(name): decoded as unknown \(type)") }
            let again = try JSONEncoder().encode(event)
            #expect(try JSONDecoder().decode(ServerEvent.self, from: again) == event, "\(name)")
            #expect(try object(again) == object(data), "\(name): re-encoded JSON differs")
        }
    }

    @Test func testEveryClientSampleDecodesAndRoundTrips() throws {
        for (name, data) in try samples("client") {
            let msg = try JSONDecoder().decode(ClientMessage.self, from: data)
            let again = try JSONEncoder().encode(msg)
            #expect(try JSONDecoder().decode(ClientMessage.self, from: again) == msg, "\(name)")
        }
    }

    /// Device voice mode (metaface): `say` carries plain text + BCP-47 lang; ready.tts says which mode won.
    @Test func testDeviceVoiceSamples() throws {
        let say = try JSONDecoder().decode(ServerEvent.self, from: Data(#"{"type":"say","utteranceId":3,"sentence":1,"text":"Hi there.","emotion":"happy","lang":"en-US"}"#.utf8))
        #expect(say == .say(.init(utteranceId: 3, sentence: 1, text: "Hi there.", emotion: "happy", lang: "en-US")))
        let ready = Dictionary(uniqueKeysWithValues: try samples("server")).first { $0.key == "ready.device.json" }!.value
        guard case let .ready(r) = try JSONDecoder().decode(ServerEvent.self, from: ready) else { Issue.record("ready"); return }
        #expect(r.tts == .device)
        #expect(r.lip.active == .none)
        let start = Dictionary(uniqueKeysWithValues: try samples("client")).first { $0.key == "start.device.json" }!.value
        guard case let .start(s) = try JSONDecoder().decode(ClientMessage.self, from: start) else { Issue.record("start"); return }
        #expect(s.tts == .device)
        let encoded = try object(JSONEncoder().encode(ClientMessage.start(.init(persona: .init(name: "A"), tts: .device))))
        #expect(encoded["tts"] as? String == "device")
    }

    @Test func testUnknownServerTypeDoesNotThrow() throws {
        let e = try JSONDecoder().decode(ServerEvent.self, from: Data(#"{"type":"observe.boxes","boxes":[]}"#.utf8))
        #expect(e == .unknown(type: "observe.boxes"))
    }

    @Test func testFrameHeader() {
        let h = AudioFrameHeader(kind: 1, seq: 0xfffffffe)
        #expect(AudioFrameHeader(frame: h.encoded() + Data([1, 2])) == h)
        #expect(AudioFrameHeader.payload(of: h.encoded() + Data([1, 2])) == Data([1, 2]))
        #expect(AudioFrameHeader(frame: Data("XX123456".utf8)) == nil)
        let peter = AudioFrameHeader(kind: GenitaProtocol.frameKindPeter, seq: 7).encoded() + Data([3, 0, 0, 0, 0xff, 0xd8])
        let crop = AudioFrameHeader.peterCrop(of: peter)
        #expect(crop?.frame == 3)
        #expect(crop?.jpeg == Data([0xff, 0xd8]))
    }
}
