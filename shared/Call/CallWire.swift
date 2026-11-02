// Wire helpers for the call. The wire types themselves are GenitaKit's (shared/GenitaKit/Sources/GenitaKit/
// Protocol.swift, F0-L4), compiled straight into both app targets through a synchronized group, so there is
// no `import GenitaKit` here.

import Foundation

extension GenitaProtocol {
    /// Recommended uplink frame: 80 ms = 1,920 samples = 3,840 bytes.
    static let micFrameSamples = sampleRate * 80 / 1000
}

extension ServerEvent {
    static func decode(_ text: String) throws -> ServerEvent {
        try JSONDecoder().decode(ServerEvent.self, from: Data(text.utf8))
    }
}

extension ClientMessage {
    /// One JSON text frame.
    func json() throws -> String { String(decoding: try JSONEncoder().encode(self), as: UTF8.self) }
}

// MARK: - PCM framing

/// Collects mic samples (s16 mono 24 kHz) and hands out fixed 80 ms frames for the uplink.
struct PCMFramer {
    let frameSamples: Int
    private var pending: [Int16] = []
    init(frameSamples: Int = GenitaProtocol.micFrameSamples) { self.frameSamples = frameSamples }

    /// Appends samples and returns every complete frame as little-endian bytes.
    mutating func append(_ samples: [Int16]) -> [Data] {
        pending.append(contentsOf: samples)
        var frames: [Data] = []
        while pending.count >= frameSamples {
            frames.append(PCM.data(from: pending[0..<frameSamples]))
            pending.removeFirst(frameSamples)
        }
        return frames
    }
    mutating func reset() { pending.removeAll(keepingCapacity: true) }
    var pendingSamples: Int { pending.count }
}

enum PCM {
    static func data<C: Collection>(from samples: C) -> Data where C.Element == Int16 {
        var out = Data(capacity: samples.count * 2)
        for s in samples { let v = UInt16(bitPattern: s.littleEndian); out.append(UInt8(v & 0xff)); out.append(UInt8(v >> 8)) }
        return out
    }
    /// s16le bytes → Float32 samples in −1…1. A trailing odd byte is ignored.
    static func floats(fromS16LE data: Data) -> [Float] {
        let n = data.count / 2
        var out = [Float](repeating: 0, count: n)
        data.withUnsafeBytes { raw in
            let bytes = raw.bindMemory(to: UInt8.self)
            for i in 0..<n {
                let v = Int16(bitPattern: UInt16(bytes[2 * i]) | UInt16(bytes[2 * i + 1]) << 8)
                out[i] = Float(v) / 32768
            }
        }
        return out
    }
    static func durationMs(bytes: Int, sampleRate: Int = GenitaProtocol.sampleRate) -> Double {
        Double(bytes / 2) * 1000 / Double(sampleRate)
    }
}
