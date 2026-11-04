import Foundation
import Testing
@testable import GenitaKit

/// F8-U-INT: the interpretation screens are a function of server events.
struct InterpretBoardTests {
    typealias B = ServerEvent.InterpretBubble

    static func pair(_ other: String?, source: InterpretOptions.Source = .face, app: String? = nil) -> ServerEvent {
        .interpretPair(.init(user: "English", other: other, source: source, by: "auto", app: app))
    }
    static func bubble(_ id: Int, _ speaker: B.Speaker, _ status: B.Status, _ text: String, lang: String? = nil, via: B.Via = .voice,
                       translation: String? = nil, to: String? = nil, utterance: Int? = nil, reason: String? = nil) -> ServerEvent {
        .interpretBubble(.init(bubbleId: id, speaker: speaker, via: via, status: status, original: .init(lang: lang, text: text),
                               translation: translation.map { .init(lang: to, text: $0) }, utteranceId: utterance, reason: reason))
    }

    @Test func listeningThenDetectedThenThemSpeakingThenJinSaysIt() {
        var b = InterpretBoard(companionName: "Jin")
        b.apply(Self.pair(nil))
        #expect(b.active)
        #expect(b.bar == .init(title: "Interpreting", subtitle: "Listening for the other language", warn: false))
        #expect(b.showsIntro)
        #expect(b.holdTitle == "Hold to talk in English")

        b.apply(Self.bubble(1, .them, .hearing, "혹시 이 근처에", lang: "Korean"))
        #expect(b.speakerLine == .init(who: .them, name: "Them", detail: "Korean", live: true))
        b.apply(Self.pair("Korean"))
        #expect(b.bar.title == "Korean ↔ English")
        #expect(b.bar.subtitle == "Detected automatically")
        #expect(!b.showsIntro)

        b.apply(Self.bubble(1, .them, .speaking, "혹시 이 근처에 약국 있어요?", lang: "Korean", translation: "Is there a pharmacy near here?", to: "English", utterance: 4))
        #expect(b.speakerLine == .init(who: .companion, name: "Jin", detail: "saying it in English", live: true))
        #expect(b.visible.count == 1)
        #expect(b.route(utteranceId: 4) == .normal)
        #expect(b.moreSubtitle == "On · Korean ↔ English")
    }

    @Test func myReplyGoesOutInKoreanAndTheirBubbleTurnsFaint() {
        var b = InterpretBoard(companionName: "Jin")
        b.apply(Self.pair("Korean"))
        b.apply(Self.bubble(1, .them, .done, "혹시 이 근처에 약국 있어요?", lang: "Korean", translation: "Is there a pharmacy near here?", to: "English", utterance: 1))
        b.holding = true
        #expect(b.holdTitle == "Release to translate")
        b.apply(Self.bubble(2, .me, .hearing, "Yes, two blocks down", lang: "English", via: .hold))
        #expect(b.speakerLine?.who == .you)
        #expect(b.isFaint(b.visible[0]))
        #expect(!b.isFaint(b.visible[1]))
        b.holding = false
        b.apply(Self.bubble(2, .me, .speaking, "Yes, two blocks down, next to the bakery.", lang: "English", via: .hold, translation: "네, 두 블록 내려가면 빵집 옆에 있어요.", to: "Korean", utterance: 2))
        #expect(b.speakerLine == .init(who: .companion, name: "Jin", detail: "saying it in Korean", live: true))
    }

    @Test func unclearLanguageWarnsAndSkippedBubblesDisappear() {
        var b = InterpretBoard(companionName: "Jin")
        b.apply(Self.pair("Korean"))
        b.apply(Self.bubble(1, .me, .hearing, "Yes", lang: "English"))
        b.apply(Self.bubble(1, .me, .skipped, "Yes", lang: "English", reason: "echo"))
        #expect(b.bubbles.isEmpty)
        b.apply(Self.bubble(2, .unknown, .unknown, "…", reason: "language_unclear"))
        #expect(b.unclear)
        #expect(b.bar == .init(title: "Couldn’t tell the language", subtitle: "I didn’t pass that on. Say it again?", warn: true))
        #expect(b.speakerLine?.detail == "Not sure")
        // the next utterance clears the warning (back to INT-2)
        b.apply(Self.bubble(3, .them, .hearing, "이거", lang: "Korean"))
        #expect(!b.unclear)
        #expect(!b.bar.warn)
    }

    @Test func macCallRoutesTheirTranslationToHeadphonesAndMineToTheSpeaker() {
        var b = InterpretBoard(companionName: "Jin")
        b.apply(Self.pair(nil, source: .call, app: "FaceTime"))
        #expect(b.bar.title == "FaceTime · Interpreting")
        #expect(!b.showsIntro)
        #expect(b.holdTitle == "Hold to reply")
        b.apply(Self.pair("Korean", source: .call, app: "FaceTime"))
        b.apply(Self.bubble(1, .them, .speaking, "다음 주 화요일 회의 괜찮으세요?", lang: "Korean", via: .call, translation: "Does next Tuesday’s meeting work for you?", to: "English", utterance: 7))
        #expect(b.bar == .init(title: "FaceTime · Korean ↔ English", subtitle: "Call sound in · whispering to you", warn: false))
        #expect(b.speakerLine?.detail == "whispering in English, headphones only")
        #expect(b.route(utteranceId: 7) == .whisper)
        b.apply(Self.bubble(2, .me, .speaking, "Tuesday works. Can we do 3 pm?", lang: "English", via: .hold, translation: "화요일 좋아요. 오후 3시 괜찮을까요?", to: "Korean", utterance: 8))
        #expect(b.bar.subtitle == "Your reply goes out in Korean")
        #expect(b.speakerLine?.detail == "speaking Korean through your speaker")
        #expect(b.route(utteranceId: 8) == .speaker)
        #expect(b.route(utteranceId: 99) == .normal)
    }

    @Test func leavingInterpretResetsTheBoard() {
        var b = InterpretBoard(companionName: "Mina")
        b.apply(Self.pair("Korean"))
        b.apply(Self.bubble(1, .them, .done, "이거 얼마예요?", lang: "Korean", translation: "How much is this?", to: "English", utterance: 1))
        b.apply(.modeChanged(.init(mode: .chat, by: "client")))
        #expect(!b.active)
        #expect(b.bubbles.isEmpty)
        #expect(b.companionName == "Mina")
    }

    @Test func clientMessagesForInterpretEncodeAsTheServerExpects() throws {
        let hold = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ClientMessage.hold(on: true))) as! NSDictionary
        #expect(hold == ["type": "hold", "on": true] as NSDictionary)
        let mode = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ClientMessage.modeInterpret(.init(source: .call, app: "FaceTime")))) as! NSDictionary
        #expect(mode == ["type": "mode", "mode": "interpret", "interpret": ["source": "call", "app": "FaceTime"]] as NSDictionary)
        let plain = try JSONDecoder().decode(ClientMessage.self, from: Data(#"{"type":"mode","mode":"interpret"}"#.utf8))
        #expect(plain == .mode(.interpret))
    }
}
