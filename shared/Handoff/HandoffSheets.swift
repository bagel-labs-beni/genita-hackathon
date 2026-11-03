import SwiftUI

private let sheetInk = Color(red: 17.0 / 255, green: 17.0 / 255, blue: 17.0 / 255)
private let sheetSurface = Color(white: 254.0 / 255)
private let sheetOnInk = Color(white: 253.0 / 255)
/// Dims the companion image behind a waiting sheet.
let handoffScrim = sheetInk.opacity(0.46)

/// Approved copy for the waiting screens (design r01, direction A).
struct HandoffCopy: Equatable {
    let title: String
    let lines: [String]
    static let phoneWaiting = HandoffCopy(title: "Continue on your Mac.", lines: ["You’re talking on your Mac right now.", "If you switch, your Mac will wait."])
    static let phoneUnreachable = HandoffCopy(title: "Mac not responding.", lines: ["It may be asleep or offline.", "You can keep talking here."])
    static let macUnreachable = HandoffCopy(title: "iPhone not responding.", lines: ["It may be offline.", "You can keep talking here."])
    static func macWaiting(sharingStopped: Bool) -> HandoffCopy {
        HandoffCopy(title: "Now on your iPhone.", lines: (sharingStopped ? ["Screen sharing stopped."] : []) + ["Your Mac is ready when you are."])
    }
    static func phone(_ surface: HandoffSurface) -> HandoffCopy? {
        switch surface { case .active: nil; case .waiting: phoneWaiting; case .waitingPeerUnreachable: phoneUnreachable }
    }
    static func mac(_ surface: HandoffSurface, sharingStopped: Bool) -> HandoffCopy? {
        switch surface { case .active: nil; case .waiting: macWaiting(sharingStopped: sharingStopped); case .waitingPeerUnreachable: macUnreachable }
    }
}

/// R1, R2, R1-E and R2-E: the white sheet with one action.
struct HandoffWaitingSheet: View {
    let copy: HandoffCopy
    let action: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(copy.title).font(.custom("KMUTTF-SungkokSemiSerif", fixedSize: 28)).tracking(-0.28).foregroundStyle(sheetInk).frame(minHeight: 34, alignment: .leading)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(copy.lines, id: \.self) { line in
                    Text(line).font(.custom("PretendardVariable-Regular", fixedSize: 16)).foregroundStyle(sheetInk).frame(minHeight: 24, alignment: .leading)
                }
            }.padding(.top, 16)
            Button(action: action) {
                Text("Continue here").font(.custom("PretendardVariable-Medium", fixedSize: 16)).foregroundStyle(sheetOnInk)
                    .frame(maxWidth: .infinity).frame(height: 50).background(GlassCTA(color: sheetInk, radius: 6)).contentShape(Rectangle())
            }.buttonStyle(.plain).padding(.top, 32).accessibilityIdentifier("continueHere")
        }
        .padding(.top, 40).padding(.horizontal, 38).padding(.bottom, 48)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(UnevenRoundedRectangle(topLeadingRadius: 30, topTrailingRadius: 30).fill(sheetSurface).shadow(color: .black.opacity(0.04), radius: 13))
    }
}

/// E01 and E02: microphone or camera permission was denied.
struct MediaPermissionSheet: View {
    let kind: LocalCallMedia.Kind
    /// The companion's own name (E01 / E02 never say "Jin" unless that is the name).
    var name: String = "your companion"
    let openSettings: () -> Void
    let dismiss: () -> Void
    private var title: String { kind == .camera ? "Allow camera access." : "Allow microphone." }
    private var lines: [String] { Self.lines(kind: kind, name: name) }
    static func lines(kind: LocalCallMedia.Kind, name: String) -> [String] {
        let who = name.trimmingCharacters(in: .whitespaces).isEmpty ? "your companion" : name
        return kind == .camera
            ? ["Allow camera access in Settings", "to show \(who) what you see.", "You can keep talking without it."]
            : ["Allow microphone access in Settings", "to talk with \(who).", "Your conversation will stay here."]
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Capsule().fill(Color(white: 219.0 / 255)).frame(width: 47, height: 5).frame(maxWidth: .infinity).padding(.top, 12)
            Text(title).font(.custom("KMUTTF-SungkokSemiSerif", fixedSize: 28)).tracking(-0.28).foregroundStyle(sheetInk).frame(minHeight: 34, alignment: .leading).padding(.top, 35)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(lines, id: \.self) { Text($0).font(.custom("PretendardVariable-Regular", fixedSize: 16)).foregroundStyle(sheetInk).frame(minHeight: 22, alignment: .leading) }
            }.padding(.top, 15)
            Spacer(minLength: 16)
            Button(action: openSettings) {
                Text("Open Settings").font(.custom("PretendardVariable-Medium", fixedSize: 16)).foregroundStyle(sheetOnInk)
                    .frame(maxWidth: .infinity).frame(height: 50).background(GlassCTA(color: sheetInk, radius: 6)).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityIdentifier("permissionOpenSettings")
            Button(action: dismiss) {
                Text(kind == .camera ? "Keep camera off" : "Not now").font(.custom("PretendardVariable-Medium", fixedSize: 15)).foregroundStyle(sheetInk).frame(maxWidth: .infinity).frame(height: 36).contentShape(Rectangle())
            }.buttonStyle(.plain).padding(.top, 6).padding(.bottom, 41).accessibilityIdentifier("permissionDismiss")
        }
        .padding(.horizontal, 38).frame(maxWidth: .infinity, alignment: .leading).frame(height: 366, alignment: .top)
        .background(UnevenRoundedRectangle(topLeadingRadius: 30, topTrailingRadius: 30).fill(sheetSurface).shadow(color: .black.opacity(0.04), radius: 13))
    }
}
