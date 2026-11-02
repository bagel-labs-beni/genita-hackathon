import SwiftUI

/// To-be designs waiting for Chelsea's OK (11/3). Off by default: the shipped flow is unchanged until a flag
/// flips. Turn on with `defaults write ai.thebeni.genita.mac genita.mac.designV2 -bool YES` (or env
/// GENITA_MAC_DESIGN_V2=1); after the OK the default becomes true in one line.
enum MacDesignV2 {
    static var enabled: Bool {
        #if DEBUG
        if let review = reviewOverride { return review }
        #endif
        return ProcessInfo.processInfo.environment["GENITA_MAC_DESIGN_V2"] == "1" || UserDefaults.standard.bool(forKey: "genita.mac.designV2")
    }
    #if DEBUG
    /// review renders only (watch-shots harness)
    nonisolated(unsafe) static var reviewOverride: Bool?
    #endif
}

/// MAC-P (to-be): the Mac side of P01 "Pair with your Mac". The same six boxes the iPhone types into
/// (P01 60:2: 44 × 52 grey boxes, 12 radius), split 3 · 3 like the iPhone field, and P01's
/// "Looking for your Mac" row mirrored as "Looking for your iPhone". References: Copilot Money's six digit
/// boxes, HoneyBook's code panel, Apple TV / Netflix "enter this code on your phone".
struct MacPairingCode: View {
    let code: String
    var connected = false
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Enter these six digits in Genita on your iPhone. You only do this once.")
                .font(MacSheetInk.sans(14)).foregroundStyle(MacSheetInk.mute).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
                .frame(width: 356, alignment: .leading)
            HStack(spacing: 8) {
                digits(Array(code.prefix(3)))
                Capsule().fill(MacSheetInk.handle).frame(width: 10, height: 2).padding(.horizontal, 2)
                digits(Array(code.dropFirst(3).prefix(3)))
            }
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Pairing code " + code.map(String.init).joined(separator: " "))
            .accessibilityIdentifier("macPairingCode")
            HStack(spacing: 8) {
                if connected {
                    Circle().fill(Color(red: 0, green: 162.0 / 255, blue: 1)).frame(width: 8, height: 8).frame(width: 16, height: 16)
                } else {
                    // MAC-2's waiting ring (87:2 "Checking for your companion"), not a system spinner
                    Circle().strokeBorder(Color(white: 227.0 / 255), lineWidth: 2).frame(width: 16, height: 16)
                }
                Text(connected ? "Paired with your iPhone" : "Looking for your iPhone").font(MacSheetInk.sans(14)).foregroundStyle(MacSheetInk.mute)
            }.frame(height: 22).accessibilityElement(children: .combine).accessibilityIdentifier("macPairingStatus")
        }
    }

    private func digits(_ chars: [Character]) -> some View {
        HStack(spacing: 8) {
            ForEach(0..<3, id: \.self) { i in
                Text(i < chars.count ? String(chars[i]) : "")
                    .font(MacSheetInk.sans(24, .medium)).foregroundStyle(MacSheetInk.ink).monospacedDigit()
                    .frame(width: 48, height: 56)
                    .background(Color(white: 241.0 / 255), in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }
}
