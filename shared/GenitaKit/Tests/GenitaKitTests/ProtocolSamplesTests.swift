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

    /// Server voice timing (MMS forced aligner): words + ARPAbet phonemes, ms on the reply timeline.
    @Test func testAudioTimingSample() throws {
        let data = Dictionary(uniqueKeysWithValues: try samples("server")).first { $0.key == "audio.timing.json" }!.value
        guard case let .audioTiming(t) = try JSONDecoder().decode(ServerEvent.self, from: data) else { Issue.record("audio.timing"); return }
        #expect(t.utteranceId == 4 && t.sentence == 0 && t.seq == 41)
        #expect(t.words.first == WordTiming(w: "Oh", s: 40, e: 190))
        #expect(t.phonemes.map(\.p) == ["AO", "W", "OW"])
        #expect(t.phonemes.last == PhonemeTiming(p: "OW", s: 260, e: 520))
    }

    @Test func testUnknownServerTypeDoesNotThrow() throws {
        let e = try JSONDecoder().decode(ServerEvent.self, from: Data(#"{"type":"future.event","boxes":[]}"#.utf8))
        #expect(e == .unknown(type: "future.event"))
    }

    @Test func testFrameHeader() {
        let h = AudioFrameHeader(kind: 1, seq: 0xfffffffe)
        #expect(AudioFrameHeader(frame: h.encoded() + Data([1, 2])) == h)
        #expect(AudioFrameHeader.payload(of: h.encoded() + Data([1, 2])) == Data([1, 2]))
        #expect(AudioFrameHeader(frame: Data("XX123456".utf8)) == nil)
    }
}
