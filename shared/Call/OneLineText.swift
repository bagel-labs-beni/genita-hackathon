import SwiftUI

/// Shared by the iPhone PF-1 sheet and the Mac call (MAC-RS lines, call pill) — moved from FindsSheet.swift (#211).
/// A status line that stays on one line: the whole text when it fits, else the given alternates, else the text
/// shortened by whole words with "…" — never a cut word, never a smaller font. VoiceOver reads the whole text.
struct OneLineText: View {
    let text: String
    let font: Font
    let color: Color
    var alternates: [String] = []

    var body: some View {
        ViewThatFits(in: .horizontal) {
            ForEach(Self.options(text, alternates), id: \.self) { option in
                Text(option).font(font).foregroundStyle(color).lineLimit(1).fixedSize(horizontal: true, vertical: false)
            }
        }
        .accessibilityElement(children: .ignore).accessibilityLabel(text)
    }

    /// "Light jacket · checking 2 shops" → ["Checking 2 shops"]
    static func afterDot(_ text: String) -> [String] {
        guard let r = text.range(of: " · ") else { return [] }
        let tail = String(text[r.upperBound...])
        return tail.isEmpty ? [] : [tail.prefix(1).uppercased() + tail.dropFirst()]
    }

    static func options(_ text: String, _ alternates: [String]) -> [String] {
        var out = [text] + alternates
        var words = text.split(separator: " ").map(String.init)
        while words.count > 1 {
            words.removeLast()
            let head = words.joined(separator: " ").trimmingCharacters(in: CharacterSet(charactersIn: " ,;:·–-…."))
            if !head.isEmpty { out.append(head + "…") }
        }
        var seen = Set<String>()
        return out.filter { seen.insert($0).inserted }
    }
}
