// F0-L4 · Genita realtime session wire types (protocol v1).
// Twin of genita-server/src/protocol.ts. Contract: genita-server/PROTOCOL.md.
// Both sides decode the same samples in shared/protocol-samples/.

import Foundation

public enum GenitaProtocol {
    public static let version = 1
    /// Mic and TTS audio: PCM s16le, mono, 24 kHz.
    public static let sampleRate = 24_000
    /// Binary server frame header: "GA" | kind u8 | reserved u8 | seq u32 LE.
    public static let frameHeaderBytes = 8
    public static let frameKindTTSPCM: UInt8 = 1
    /// Peter mouth crop: header seq = utteranceId; payload = frame u32 LE + JPEG.
    public static let frameKindPeter: UInt8 = 2
    /// App → server, Mac call interpretation only (F8): header + mic PCM.
    public static let clientFrameKindMic: UInt8 = 3
    /// App → server, Mac call interpretation only (F8): header + the call's sound (ScreenCaptureKit).
    public static let clientFrameKindCall: UInt8 = 4
}

public struct AudioFrameHeader: Equatable, Sendable {
    public let kind: UInt8
    public let seq: UInt32

    public init(kind: UInt8, seq: UInt32) {
        self.kind = kind
        self.seq = seq
    }

    /// Parses the 8-byte header of a binary server frame; nil if it is not one.
    public init?(frame: Data) {
        guard frame.count >= GenitaProtocol.frameHeaderBytes else { return nil }
        let b = [UInt8](frame.prefix(GenitaProtocol.frameHeaderBytes))
        guard b[0] == 0x47, b[1] == 0x41 else { return nil } // "GA"
        kind = b[2]
        seq = UInt32(b[4]) | UInt32(b[5]) << 8 | UInt32(b[6]) << 16 | UInt32(b[7]) << 24
    }

    public func encoded() -> Data {
        Data([0x47, 0x41, kind, 0, UInt8(seq & 0xff), UInt8(seq >> 8 & 0xff), UInt8(seq >> 16 & 0xff), UInt8(seq >> 24 & 0xff)])
    }

    /// PCM payload after the header.
    public static func payload(of frame: Data) -> Data {
        frame.dropFirst(GenitaProtocol.frameHeaderBytes)
    }

    /// For kind 2 (Peter): `seq` is the utteranceId; returns the frame index and JPEG.
    /// Frame k lines up with the utterance's audio at k × 40 ms (25 fps).
    public static func peterCrop(of frame: Data) -> (frame: UInt32, jpeg: Data)? {
        let p = [UInt8](frame.dropFirst(GenitaProtocol.frameHeaderBytes).prefix(4))
        guard p.count == 4 else { return nil }
        let index = UInt32(p[0]) | UInt32(p[1]) << 8 | UInt32(p[2]) << 16 | UInt32(p[3]) << 24
        return (index, Data(frame.dropFirst(GenitaProtocol.frameHeaderBytes + 4)))
    }
}

// MARK: - Shared value types

public enum LipMode: String, Codable, Sendable { case peter, atlas, none }
/// Who speaks the reply: the server (TTS PCM frames) or the device (`say` text, on-device speech).
public enum TtsMode: String, Codable, Sendable { case server, device }
public enum ConversationMode: String, Codable, Sendable { case chat, interpret }
public enum Phase: String, Codable, Sendable { case listening, thinking, speaking, interrupted }
public enum CancelReason: String, Codable, Sendable { case bargeIn = "barge_in", text, client }
public enum Viseme: String, Codable, Sendable { case X, A, E, O, U, M, F, L, S }

public struct LipPlan: Codable, Equatable, Sendable {
    public var requested: LipMode
    public var active: LipMode
    /// peter_connecting | peter_unavailable | peter_not_deployed | null (wire sends null, not absent)
    public var reason: String?

    private enum K: String, CodingKey { case requested, active, reason }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        try c.encode(requested, forKey: .requested)
        try c.encode(active, forKey: .active)
        try c.encode(reason, forKey: .reason)
    }
}

/// F8 interpretation options on `start` and `mode`.
public struct InterpretOptions: Codable, Equatable, Sendable {
    public enum Source: String, Codable, Sendable { case face, call }
    public var source: Source?
    /// Fix the other language instead of detecting it.
    public var other: String?
    /// Call app shown back in `interpret.pair` ("FaceTime", "Zoom").
    public var app: String?
    public init(source: Source? = nil, other: String? = nil, app: String? = nil) { self.source = source; self.other = other; self.app = app }
}

public struct MouthCue: Codable, Equatable, Sendable {
    public var t: Int
    public var v: Viseme
}

public struct WordTiming: Codable, Equatable, Sendable {
    public var w: String
    public var s: Int
    public var e: Int
}

// MARK: - Server → app

public enum ServerEvent: Equatable, Sendable {
    case ready(Ready)
    case state(StateChange)
    case speechStart(Turn)
    case speechEnd(Turn)
    case transcript(Transcript)
    case interpretDetected(InterpretDetected)
    case interpretPair(InterpretPair)
    case interpretBubble(InterpretBubble)
    case tool(Tool)
    case replyDelta(ReplyDelta)
    case speaking(Speaking)
    case audio(Audio)
    case say(Say)
    case reply(Reply)
    case utteranceCancelled(UtteranceCancelled)
    case turnMetrics(TurnMetrics)
    case asrStatus(AsrStatus)
    case modeChanged(ModeChanged)
    case lipChanged(LipChanged)
    case error(ServerError)
    case pong(Pong)
    case findStarted(FindStarted)
    case findProgress(FindProgress)
    case findItems(FindItems)
    case observeBoxes(ObserveBoxes)
    case findCreated(FindCreated)
    case findImage(FindImageEvent)
    case findFailed(FindFailed)
    /// F2-L26: the user renamed the companion by voice ("Call yourself Max"). Already saved on the server;
    /// update every {name} label (S07, S09-T, PREP-1 …).
    case companionNamed(CompanionNamed)
    /// A type this build does not know yet. Ignore it; never fail the socket.
    case unknown(type: String)

    public struct Ready: Codable, Equatable, Sendable {
        public struct AudioFormat: Codable, Equatable, Sendable {
            public var `in`: String
            public var out: String
            public var frameHeaderBytes: Int
        }
        public struct BargeIn: Codable, Equatable, Sendable {
            public var minMs: Int
            public var minWords: Int
        }
        public var `protocol`: Int
        public var sessionId: String
        public var mode: ConversationMode
        public var audio: AudioFormat
        public var lip: LipPlan
        public var voiceId: String
        public var bargeIn: BargeIn
        /// Voice mode used for this call. Optional: servers before 11/2 (metaface) do not send it (= server).
        public var tts: TtsMode?
    }
    public struct StateChange: Codable, Equatable, Sendable { public var state: Phase }
    public struct Turn: Codable, Equatable, Sendable { public var turnId: Int }
    public struct Transcript: Codable, Equatable, Sendable {
        public enum Source: String, Codable, Sendable { case voice, text }
        public var text: String
        public var final: Bool
        public var turnId: Int?
        public var source: Source?
    }
    public struct InterpretDetected: Codable, Equatable, Sendable {
        public var from: String
        public var to: String
    }
    /// F8: the language pair; `other == nil` = still listening for the other language (INT-1).
    public struct InterpretPair: Codable, Equatable, Sendable {
        public var user: String
        public var other: String?
        public var source: InterpretOptions.Source
        /// "auto" (detected) | "client" (fixed by the app)
        public var by: String
        public var app: String?
        private enum K: String, CodingKey { case user, other, source, by, app }
        public init(user: String, other: String?, source: InterpretOptions.Source, by: String, app: String? = nil) {
            self.user = user; self.other = other; self.source = source; self.by = by; self.app = app
        }
        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: K.self)
            try c.encode(user, forKey: .user)
            try c.encode(other, forKey: .other) // null on the wire, not absent
            try c.encode(source, forKey: .source)
            try c.encode(by, forKey: .by)
            try c.encodeIfPresent(app, forKey: .app)
        }
    }
    /// F8: one two-language bubble. Sent again on every change; upsert by `bubbleId`.
    public struct InterpretBubble: Codable, Equatable, Sendable {
        public enum Speaker: String, Codable, Sendable { case them, me, unknown }
        public enum Via: String, Codable, Sendable { case voice, hold, call, text }
        public enum Status: String, Codable, Sendable { case hearing, translating, speaking, done, unknown, skipped, cancelled }
        public struct Line: Codable, Equatable, Sendable {
            public var lang: String?
            public var text: String
            private enum K: String, CodingKey { case lang, text }
            public init(lang: String?, text: String) { self.lang = lang; self.text = text }
            public func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: K.self)
                try c.encode(lang, forKey: .lang) // null on the wire, not absent
                try c.encode(text, forKey: .text)
            }
        }
        public var bubbleId: Int
        public var speaker: Speaker
        public var via: Via
        public var status: Status
        public var original: Line
        public var translation: Line?
        public var utteranceId: Int?
        /// language_unclear | no_other_language | same_language | echo | empty
        public var reason: String?
        public init(bubbleId: Int, speaker: Speaker, via: Via, status: Status, original: Line, translation: Line? = nil, utteranceId: Int? = nil, reason: String? = nil) {
            self.bubbleId = bubbleId; self.speaker = speaker; self.via = via; self.status = status
            self.original = original; self.translation = translation; self.utteranceId = utteranceId; self.reason = reason
        }
    }
    public struct Tool: Codable, Equatable, Sendable {
        public var utteranceId: Int
        public var name: String
        public var status: String
    }
    public struct ReplyDelta: Codable, Equatable, Sendable {
        public var utteranceId: Int
        public var text: String
    }
    public struct Speaking: Codable, Equatable, Sendable {
        public var on: Bool
        public var utteranceId: Int
        public var emotion: String?
    }
    /// Timing for the binary frame with the same `seq` that follows it.
    public struct Audio: Codable, Equatable, Sendable {
        public var utteranceId: Int
        public var seq: UInt32
        public var sentence: Int
        public var offsetMs: Int
        public var durationMs: Int
        public var sampleRate: Int
        public var model: String
        public var words: [WordTiming]
        public var mouth: [MouthCue]?
    }
    /// Device mode: one sentence for the app to speak, in order. `text` is plain (no tags);
    /// `lang` is a BCP-47 hint (en-US, ko-KR, …) for the voice.
    public struct Say: Codable, Equatable, Sendable {
        public var utteranceId: Int
        public var sentence: Int
        public var text: String
        public var emotion: String
        public var lang: String
    }
    public struct Reply: Codable, Equatable, Sendable {
        public var utteranceId: Int
        public var text: String
        public var emotion: String
        public var interpret: Bool
        public var final: Bool
    }
    public struct UtteranceCancelled: Codable, Equatable, Sendable {
        public var utteranceId: Int
        public var reason: CancelReason
    }
    public struct TurnMetrics: Codable, Equatable, Sendable {
        public var utteranceId: Int
        public var model: String
        public var ttsModel: String?
        public var speechEndToCompleteMs: Int?
        public var replyStartToFirstTokenMs: Int?
        public var replyStartToFirstSentenceMs: Int?
        public var firstSentenceToFirstAudioMs: Int?
        public var speechEndToFirstAudioMs: Int?
        public var audioMs: Int
        public var speculative: String?
    }
    public struct AsrStatus: Codable, Equatable, Sendable {
        public enum Status: String, Codable, Sendable { case connected, reconnecting }
        public var status: Status
    }
    public struct ModeChanged: Codable, Equatable, Sendable {
        public var mode: ConversationMode
        public var by: String
    }
    public struct LipChanged: Codable, Equatable, Sendable {
        public struct Peter: Codable, Equatable, Sendable {
            public var bundleId: String
            public var pasteDy: Int
            public var fps: Int
        }
        public var lip: LipPlan
        public var peter: Peter?
    }
    public struct ServerError: Codable, Equatable, Sendable {
        public var code: String
        public var message: String
        public var retryable: Bool
    }
    public struct Pong: Codable, Equatable, Sendable { public var t: Double? }
    public struct CompanionNamed: Codable, Equatable, Sendable {
        public var name: String
        public init(name: String) { self.name = name }
    }
}

private enum TypeKey: String, CodingKey { case type }

extension ServerEvent: Codable {
    public init(from decoder: Decoder) throws {
        let type = try decoder.container(keyedBy: TypeKey.self).decode(String.self, forKey: .type)
        switch type {
        case "ready": self = .ready(try .init(from: decoder))
        case "state": self = .state(try .init(from: decoder))
        case "speech.start": self = .speechStart(try .init(from: decoder))
        case "speech.end": self = .speechEnd(try .init(from: decoder))
        case "transcript": self = .transcript(try .init(from: decoder))
        case "interpret.detected": self = .interpretDetected(try .init(from: decoder))
        case "interpret.pair": self = .interpretPair(try .init(from: decoder))
        case "interpret.bubble": self = .interpretBubble(try .init(from: decoder))
        case "tool": self = .tool(try .init(from: decoder))
        case "reply.delta": self = .replyDelta(try .init(from: decoder))
        case "speaking": self = .speaking(try .init(from: decoder))
        case "audio": self = .audio(try .init(from: decoder))
        case "say": self = .say(try .init(from: decoder))
        case "reply": self = .reply(try .init(from: decoder))
        case "utterance.cancelled": self = .utteranceCancelled(try .init(from: decoder))
        case "turn.metrics": self = .turnMetrics(try .init(from: decoder))
        case "asr.status": self = .asrStatus(try .init(from: decoder))
        case "mode.changed": self = .modeChanged(try .init(from: decoder))
        case "lip.changed": self = .lipChanged(try .init(from: decoder))
        case "error": self = .error(try .init(from: decoder))
        case "pong": self = .pong(try .init(from: decoder))
        case "find.started": self = .findStarted(try .init(from: decoder))
        case "find.progress": self = .findProgress(try .init(from: decoder))
        case "find.items": self = .findItems(try .init(from: decoder))
        case "observe.boxes": self = .observeBoxes(try .init(from: decoder))
        case "find.created": self = .findCreated(try .init(from: decoder))
        case "find.image": self = .findImage(try .init(from: decoder))
        case "find.failed": self = .findFailed(try .init(from: decoder))
        case "companion.named": self = .companionNamed(try .init(from: decoder))
        default: self = .unknown(type: type)
        }
    }

    public var type: String {
        switch self {
        case .ready: "ready"
        case .state: "state"
        case .speechStart: "speech.start"
        case .speechEnd: "speech.end"
        case .transcript: "transcript"
        case .interpretDetected: "interpret.detected"
        case .interpretPair: "interpret.pair"
        case .interpretBubble: "interpret.bubble"
        case .tool: "tool"
        case .replyDelta: "reply.delta"
        case .speaking: "speaking"
        case .audio: "audio"
        case .say: "say"
        case .reply: "reply"
        case .utteranceCancelled: "utterance.cancelled"
        case .turnMetrics: "turn.metrics"
        case .asrStatus: "asr.status"
        case .modeChanged: "mode.changed"
        case .lipChanged: "lip.changed"
        case .error: "error"
        case .pong: "pong"
        case .findStarted: "find.started"
        case .findProgress: "find.progress"
        case .findItems: "find.items"
        case .observeBoxes: "observe.boxes"
        case .findCreated: "find.created"
        case .findImage: "find.image"
        case .findFailed: "find.failed"
        case .companionNamed: "companion.named"
        case let .unknown(type): type
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case let .ready(p): try p.encode(to: encoder)
        case let .state(p): try p.encode(to: encoder)
        case let .speechStart(p), let .speechEnd(p): try p.encode(to: encoder)
        case let .transcript(p): try p.encode(to: encoder)
        case let .interpretDetected(p): try p.encode(to: encoder)
        case let .interpretPair(p): try p.encode(to: encoder)
        case let .interpretBubble(p): try p.encode(to: encoder)
        case let .tool(p): try p.encode(to: encoder)
        case let .replyDelta(p): try p.encode(to: encoder)
        case let .speaking(p): try p.encode(to: encoder)
        case let .audio(p): try p.encode(to: encoder)
        case let .say(p): try p.encode(to: encoder)
        case let .reply(p): try p.encode(to: encoder)
        case let .utteranceCancelled(p): try p.encode(to: encoder)
        case let .turnMetrics(p): try p.encode(to: encoder)
        case let .asrStatus(p): try p.encode(to: encoder)
        case let .modeChanged(p): try p.encode(to: encoder)
        case let .lipChanged(p): try p.encode(to: encoder)
        case let .error(p): try p.encode(to: encoder)
        case let .pong(p): try p.encode(to: encoder)
        case let .findStarted(p): try p.encode(to: encoder)
        case let .findProgress(p): try p.encode(to: encoder)
        case let .findItems(p): try p.encode(to: encoder)
        case let .observeBoxes(p): try p.encode(to: encoder)
        case let .findCreated(p): try p.encode(to: encoder)
        case let .findImage(p): try p.encode(to: encoder)
        case let .findFailed(p): try p.encode(to: encoder)
        case let .companionNamed(p): try p.encode(to: encoder)
        case .unknown: break
        }
        var c = encoder.container(keyedBy: TypeKey.self)
        try c.encode(type, forKey: .type)
    }
}

// MARK: - App → server

public enum ClientMessage: Equatable, Sendable {
    case start(Start)
    case audioStart
    case audioStop
    case text(Text)
    case frames(Frames)
    case bargeIn
    case playbackDone(utteranceId: Int)
    case mode(ConversationMode)
    /// `mode` with `interpret` options (F8), e.g. `.modeInterpret(.init(source: .call, app: "FaceTime"))`.
    case modeInterpret(InterpretOptions)
    /// F8 hold to talk / hold to reply.
    case hold(on: Bool)
    case ping(t: Double?)
    case stop
    /// "맞아?" answer for a maybe ingredient (IC-3).
    case findConfirm(FindConfirm)
    /// Stop button while a card is still being looked for.
    case findStop(findId: String)

    public struct Persona: Codable, Equatable, Sendable {
        public enum Kind: String, Codable, Sendable { case human, animal, character }
        public struct Voice: Codable, Equatable, Sendable {
            public var id: String
            public var description: String?
            public init(id: String, description: String? = nil) { self.id = id; self.description = description }
        }
        public var name: String
        public var kind: Kind?
        public var traits: [String]?
        public var speakingStyle: String?
        public var backstory: String?
        public var voice: Voice?
        public init(name: String, kind: Kind? = nil, traits: [String]? = nil, speakingStyle: String? = nil, backstory: String? = nil, voice: Voice? = nil) {
            self.name = name; self.kind = kind; self.traits = traits; self.speakingStyle = speakingStyle; self.backstory = backstory; self.voice = voice
        }
    }
    public struct User: Codable, Equatable, Sendable {
        public var name: String?
        public var profile: String?
        /// Stable owner key for Finds until login (F1-L5).
        public var id: String?
        /// IANA zone, for "7:12 PM" in cards.
        public var timeZone: String?
        public init(name: String? = nil, profile: String? = nil, id: String? = nil, timeZone: String? = nil) {
            self.name = name; self.profile = profile; self.id = id; self.timeZone = timeZone
        }
    }
    public struct HistoryItem: Codable, Equatable, Sendable {
        public enum Role: String, Codable, Sendable { case user, assistant }
        public var role: Role
        public var text: String
        public init(role: Role, text: String) { self.role = role; self.text = text }
    }
    /// `lip` is either "atlas" or {"mode":"peter","fallback":"none"} on the wire.
    public struct Lip: Codable, Equatable, Sendable {
        public var mode: LipMode
        public var fallback: LipMode?
        public init(mode: LipMode, fallback: LipMode? = nil) { self.mode = mode; self.fallback = fallback }
        private enum K: String, CodingKey { case mode, fallback }
        public init(from decoder: Decoder) throws {
            if let s = try? decoder.singleValueContainer().decode(LipMode.self) {
                mode = s; fallback = nil; return
            }
            let c = try decoder.container(keyedBy: K.self)
            mode = try c.decode(LipMode.self, forKey: .mode)
            fallback = try c.decodeIfPresent(LipMode.self, forKey: .fallback)
        }
        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: K.self)
            try c.encode(mode, forKey: .mode)
            try c.encodeIfPresent(fallback, forKey: .fallback)
        }
    }
    public struct BargeIn: Codable, Equatable, Sendable {
        public var minMs: Int?
        public var minWords: Int?
        public init(minMs: Int? = nil, minWords: Int? = nil) { self.minMs = minMs; self.minWords = minWords }
    }
    public struct Start: Codable, Equatable, Sendable {
        public var persona: Persona
        public var user: User?
        public var memories: [String]?
        public var history: [HistoryItem]?
        public var mode: ConversationMode?
        public var language: String?
        public var voiceId: String?
        public var lip: Lip?
        public var bargeIn: BargeIn?
        public var mic: Bool?
        /// "device" = speak `say` events on-device. Omitted: the server's default (device unless it runs server TTS).
        public var tts: TtsMode?
        /// F8: read only when `mode` is interpret.
        public var interpret: InterpretOptions?
        /// D21: first call after onboarding — send 2000. The server waits up to this many ms (0–3000) for the
        /// user to speak or type first; if nobody does, the companion greets. nil = greet as before.
        public var greetAfterMs: Int?
        public init(persona: Persona, user: User? = nil, memories: [String]? = nil, history: [HistoryItem]? = nil, mode: ConversationMode? = nil, language: String? = nil, voiceId: String? = nil, lip: Lip? = nil, bargeIn: BargeIn? = nil, mic: Bool? = nil, interpret: InterpretOptions? = nil, tts: TtsMode? = nil, greetAfterMs: Int? = nil) {
            self.persona = persona; self.user = user; self.memories = memories; self.history = history; self.mode = mode
            self.language = language; self.voiceId = voiceId; self.lip = lip; self.bargeIn = bargeIn; self.mic = mic; self.interpret = interpret; self.tts = tts
            self.greetAfterMs = greetAfterMs
        }
    }
    public struct Text: Codable, Equatable, Sendable {
        public var text: String
        /// Base64 JPEG camera frames (≤2) for this turn.
        public var frames: [String]?
        /// "Ask about this" from a card: the follow-up is about that card.
        public var findId: String?
        public init(text: String, frames: [String]? = nil, findId: String? = nil) { self.text = text; self.frames = frames; self.findId = findId }
    }
    public struct Frames: Codable, Equatable, Sendable {
        /// ≤2 base64 JPEGs (or data URLs), each < 1.5 MB; used by the next turn within 15 s.
        public var images: [String]
        public init(images: [String]) { self.images = images }
    }
}

extension ClientMessage: Codable {
    private enum K: String, CodingKey { case type, utteranceId, mode, t, interpret, on, findId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "start": self = .start(try .init(from: decoder))
        case "audio_start": self = .audioStart
        case "audio_stop": self = .audioStop
        case "text": self = .text(try .init(from: decoder))
        case "frames": self = .frames(try .init(from: decoder))
        case "barge_in": self = .bargeIn
        case "playback_done": self = .playbackDone(utteranceId: try c.decode(Int.self, forKey: .utteranceId))
        case "mode":
            let mode = try c.decode(ConversationMode.self, forKey: .mode)
            if mode == .interpret, let o = try c.decodeIfPresent(InterpretOptions.self, forKey: .interpret) { self = .modeInterpret(o) } else { self = .mode(mode) }
        case "hold": self = .hold(on: try c.decode(Bool.self, forKey: .on))
        case "ping": self = .ping(t: try c.decodeIfPresent(Double.self, forKey: .t))
        case "stop": self = .stop
        case "find.confirm": self = .findConfirm(try .init(from: decoder))
        case "find.stop": self = .findStop(findId: try c.decode(String.self, forKey: .findId))
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: c, debugDescription: "unknown client message \(type)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        switch self {
        case let .start(p): try p.encode(to: encoder); try c.encode("start", forKey: .type)
        case .audioStart: try c.encode("audio_start", forKey: .type)
        case .audioStop: try c.encode("audio_stop", forKey: .type)
        case let .text(p): try p.encode(to: encoder); try c.encode("text", forKey: .type)
        case let .frames(p): try p.encode(to: encoder); try c.encode("frames", forKey: .type)
        case .bargeIn: try c.encode("barge_in", forKey: .type)
        case let .playbackDone(id): try c.encode("playback_done", forKey: .type); try c.encode(id, forKey: .utteranceId)
        case let .mode(m): try c.encode("mode", forKey: .type); try c.encode(m, forKey: .mode)
        case let .modeInterpret(o): try c.encode("mode", forKey: .type); try c.encode(ConversationMode.interpret, forKey: .mode); try c.encode(o, forKey: .interpret)
        case let .hold(on): try c.encode("hold", forKey: .type); try c.encode(on, forKey: .on)
        case let .ping(t): try c.encode("ping", forKey: .type); try c.encodeIfPresent(t, forKey: .t)
        case .stop: try c.encode("stop", forKey: .type)
        case let .findConfirm(p): try p.encode(to: encoder); try c.encode("find.confirm", forKey: .type)
        case let .findStop(id): try c.encode("find.stop", forKey: .type); try c.encode(id, forKey: .findId)
        }
    }
}
