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

    @Test func testUnknownServerTypeDoesNotThrow() throws {
        let e = try JSONDecoder().decode(ServerEvent.self, from: Data(#"{"type":"observe.boxes","boxes":[]}"#.utf8))
        #expect(e == .unknown(type: "observe.boxes"))
    }

    @Test func testFrameHeader() {
        let h = AudioFrameHeader(kind: 1, seq: 0xfffffffe)
        #expect(AudioFrameHeader(frame: h.encoded() + Data([1, 2])) == h)
        #expect(AudioFrameHeader.payload(of: h.encoded() + Data([1, 2])) == Data([1, 2]))
        #expect(AudioFrameHeader(frame: Data("XX123456".utf8)) == nil)
    }
}
