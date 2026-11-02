import SwiftUI

/// The one-line toast of a proximity move (behind GENITA_PROXIMITY_HANDOFF, needs Chelsea's OK).
/// Same ink and type as the P04 "Mac screen learned" toast, so it reads as part of the handoff family.
struct ProximityToast: View {
    /// iPhone: "Moved to your Mac" · Mac: "Continued from your iPhone"
    let text: String
    /// SF Symbol of the device the conversation is now on / came from
    let symbol: String
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: symbol).font(.system(size: 15, weight: .semibold))
            Text(text).font(.custom("PretendardVariable-Medium", fixedSize: 15)).lineLimit(1).fixedSize()
        }
        .foregroundStyle(Color(white: 253.0 / 255))
        .padding(.horizontal, 18).frame(height: 44)
        .background(Color(white: 17.0 / 255), in: Capsule())
        .shadow(color: .black.opacity(0.14), radius: 14, y: 8)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("proximityToast")
    }
}

/// The face's glide off the iPhone, toward the Mac: the call screen as it was, rising and shrinking into a
/// rounded card that fades as it leaves (0.7 s). `progress` 0 = in place, 1 = gone.
struct ProximityGlideModifier: ViewModifier, Animatable {
    var progress: Double
    var animatableData: Double { get { progress } set { progress = newValue } }
    func body(content: Content) -> some View {
        let p = min(1, max(0, progress))
        content
            .clipShape(RoundedRectangle(cornerRadius: 56 * p, style: .continuous))
            .scaleEffect(1 - 0.58 * p, anchor: .top)
            .offset(y: -360 * p * p)
            .opacity(1 - p * p)
            .blur(radius: 8 * p * p)
    }
}
