// L4 lips · The mouth-shape set the face renderer draws, and the maps from every timing
// source onto it (letters, phonemes, the server's legacy mouth letters).

import Foundation

/// Mouth shapes of a face set: `rest` is the expression image's own mouth, the other ten are
/// the viseme edits in the face manifest (`visemes` keys).
public enum LipViseme: String, CaseIterable, Codable, Sendable {
    case rest, MBP, FV, TH, L, WQ, O, EI, A, U, CDG

    /// The ten shapes that come as images (everything but `rest`).
    public static let shapes: [LipViseme] = allCases.filter { $0 != .rest }

    /// How far the jaw is open for this shape when no audio level is known (0…1).
    public var naturalOpenness: Float {
        switch self {
        case .rest, .MBP: 0
        case .FV: 0.15
        case .WQ: 0.2
        case .TH, .CDG: 0.25
        case .L, .U: 0.3
        case .EI: 0.45
        case .O: 0.6
        case .A: 0.85
        }
    }

    /// Open vowels: their patch is shown in proportion to how loud the audio is.
    public var isOpenVowel: Bool { self == .A || self == .O || self == .EI }

    /// The server's `audio.mouth` letters (X/A/E/O/U/M/F/L/S).
    public init(legacy v: Viseme) {
        switch v {
        case .X: self = .rest
        case .A: self = .A
        case .E: self = .EI
        case .O: self = .O
        case .U: self = .U
        case .M: self = .MBP
        case .F: self = .FV
        case .L: self = .L
        case .S: self = .CDG
        }
    }

    /// A phoneme label: ARPAbet (stress digits ignored), a single IPA symbol, or a letter.
    public init(phoneme: String) {
        let trimmed = phoneme.trimmingCharacters(in: .whitespacesAndNewlines)
        let arpa = trimmed.uppercased().filter { !$0.isNumber }
        if let v = LipViseme.arpabet[arpa] { self = v; return }
        if let first = trimmed.unicodeScalars.first, let v = LipViseme.ipa[first] { self = v; return }
        self = LipGraphemes.visemes(in: trimmed).first ?? .CDG
    }

    private static let arpabet: [String: LipViseme] = {
        var m: [String: LipViseme] = [:]
        for p in ["M", "B", "P"] { m[p] = .MBP }
        for p in ["F", "V"] { m[p] = .FV }
        for p in ["TH", "DH"] { m[p] = .TH }
        m["L"] = .L
        m["W"] = .WQ
        for p in ["AO", "OW", "OY", "AW"] { m[p] = .O }
        for p in ["EH", "EY", "IH", "IY", "Y"] { m[p] = .EI }
        for p in ["AA", "AH", "AE", "AY"] { m[p] = .A }
        for p in ["UW", "UH"] { m[p] = .U }
        for p in ["CH", "D", "G", "HH", "JH", "K", "N", "NG", "R", "S", "SH", "T", "Z", "ZH", "ER"] { m[p] = .CDG }
        return m
    }()

    private static let ipa: [Unicode.Scalar: LipViseme] = {
        var m: [Unicode.Scalar: LipViseme] = [:]
        func put(_ s: String, _ v: LipViseme) { for u in s.unicodeScalars { m[u] = v } }
        put("mbpɱ", .MBP); put("fvɸβ", .FV); put("θð", .TH); put("lɫʎ", .L); put("wʍ", .WQ)
        put("oɔɒø", .O); put("eɛiɪjɘ", .EI); put("aɑʌəæɐ", .A); put("uʊɯy", .U)
        put("tdkgnŋszʃʒrɹɾxhʔ", .CDG)
        return m
    }()
}

/// Words → mouth shapes by spelling. Covers Latin script (with common English digraphs) and
/// Hangul (by jamo); other scripts get a neutral open/close alternation so the mouth still moves.
public enum LipGraphemes {
    /// Shapes in speaking order, with immediate repeats collapsed.
    public static func visemes(in word: String) -> [LipViseme] {
        var out: [LipViseme] = []
        var latin: [Character] = []
        func flushLatin() {
            if !latin.isEmpty { out += latinShapes(latin); latin = [] }
        }
        for ch in word.lowercased() {
            guard let scalar = ch.unicodeScalars.first, ch.isLetter else { flushLatin(); continue }
            if ch.isASCII { latin.append(ch); continue }
            flushLatin()
            if let h = hangul(scalar) { out += h; continue }
            if let folded = String(ch).applyingTransform(.stripDiacritics, reverse: false), folded.count == 1,
               let f = folded.first, f.isASCII {
                latin.append(f); continue
            }
            out.append(otherScript[Int(scalar.value) % otherScript.count])
        }
        flushLatin()
        return collapsed(out)
    }

    /// Relative time each shape takes inside a word (vowels hold longer than consonants).
    public static func duration(of v: LipViseme) -> Double {
        switch v {
        case .A, .O, .EI, .U: 2
        default: 1
        }
    }

    private static let otherScript: [LipViseme] = [.A, .CDG, .EI, .O]

    private static func collapsed(_ v: [LipViseme]) -> [LipViseme] {
        var out: [LipViseme] = []
        for x in v where out.last != x { out.append(x) }
        return out
    }

    private static let vowels: Set<Character> = ["a", "e", "i", "o", "u", "y"]

    private static let digraphs: [String: [LipViseme]] = [
        "th": [.TH], "sh": [.CDG], "ch": [.CDG], "zh": [.CDG], "ph": [.FV], "wh": [.WQ],
        "ng": [.CDG], "ck": [.CDG], "gh": [], "qu": [.CDG, .WQ],
        "oo": [.U], "ee": [.EI], "ea": [.EI], "ie": [.EI], "ei": [.EI], "ey": [.EI],
        "ai": [.EI], "ay": [.EI], "ou": [.O], "ow": [.O], "oa": [.O], "au": [.O], "aw": [.O],
        "oi": [.O, .EI], "oy": [.O, .EI],
    ]

    private static func latinShapes(_ input: [Character]) -> [LipViseme] {
        var c = input
        // Silent final e after vowel + consonant ("make", "love"); kept in "the", "bubble".
        if c.count >= 3, c[c.count - 1] == "e", !vowels.contains(c[c.count - 2]), vowels.contains(c[c.count - 3]) {
            c.removeLast()
        }
        var out: [LipViseme] = []
        var i = 0
        while i < c.count {
            if i + 1 < c.count, let d = digraphs[String([c[i], c[i + 1]])] {
                out += d; i += 2; continue
            }
            let ch = c[i]
            switch ch {
            case "a": out.append(.A)
            case "e", "i": out.append(.EI)
            case "o": out.append(.O)
            case "u": out.append(.U)
            case "y": out.append(i == 0 && c.count > 1 && vowels.contains(c[1]) ? .CDG : .EI)
            case "m", "b", "p": out.append(.MBP)
            case "f", "v": out.append(.FV)
            case "l": out.append(.L)
            case "w": out.append(.WQ)
            case "h": break
            default: out.append(.CDG)
            }
            i += 1
        }
        return out
    }

    // Hangul syllable = initial (19) × medial (21) × final (28).
    private static func hangul(_ s: Unicode.Scalar) -> [LipViseme]? {
        let v = Int(s.value) - 0xAC00
        guard v >= 0, v < 11_172 else { return nil }
        let initial = v / 588, medial = (v % 588) / 28, final = v % 28
        var out: [LipViseme] = []
        switch initial {
        case 6, 7, 8, 17: out.append(.MBP)       // ㅁ ㅂ ㅃ ㅍ
        case 5: out.append(.L)                   // ㄹ
        case 11, 18: break                       // ㅇ (silent), ㅎ
        default: out.append(.CDG)
        }
        switch medial {
        case 0, 2: out.append(.A)                // ㅏ ㅑ
        case 1, 3, 5, 7, 18, 19, 20: out.append(.EI)
        case 4, 6, 8, 12: out.append(.O)         // ㅓ ㅕ ㅗ ㅛ
        case 9: out += [.WQ, .A]                 // ㅘ
        case 10, 11, 15, 16: out += [.WQ, .EI]   // ㅙ ㅚ ㅞ ㅟ
        case 13, 17: out.append(.U)              // ㅜ ㅠ
        case 14: out += [.WQ, .O]                // ㅝ
        default: break
        }
        switch final {
        case 0: break
        case 10, 14, 16, 17, 18, 26: out.append(.MBP)
        case 8, 9, 11, 12, 13, 15: out.append(.L)
        default: out.append(.CDG)
        }
        return out
    }
}
