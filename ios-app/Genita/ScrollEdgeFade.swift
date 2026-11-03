import SwiftUI

/// A scrolling text card's edges: the text fades out instead of being hard-cut by the card. Bottom: the same 32 pt
/// fade the Finds sheet uses over its scroll (FindsSheet `.full`). Top: 20 pt under the card's header. The mask
/// stays fixed while the text scrolls; give the scroll view insets of the same heights so its first and last lines
/// rest clear of the fades.
enum ScrollEdgeFade {
    static let height: CGFloat = 32
    static let top: CGFloat = 20
    /// The card header band ("Your prompt" + copy) that sits opaque over the scrolled text.
    static let header: CGFloat = 44
}

extension View {
    func scrollEdgeFade(top: CGFloat = 0, bottom: CGFloat = ScrollEdgeFade.height) -> some View {
        mask {
            VStack(spacing: 0) {
                if top > 0 { LinearGradient(colors: [.black.opacity(0), .black], startPoint: .top, endPoint: .bottom).frame(height: top) }
                Color.black
                LinearGradient(colors: [.black, .black.opacity(0)], startPoint: .top, endPoint: .bottom).frame(height: bottom)
            }
        }
    }
}
