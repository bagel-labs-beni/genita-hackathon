import SwiftUI

/// A scrolling text card's bottom edge: the last `height` points fade out instead of being hard-cut by the card,
/// the same 32 pt fade the Finds sheet uses over its scroll (FindsSheet `.full`). The mask stays fixed while the
/// text scrolls; give the scroll view a bottom inset of the same height so its last line can rise above the fade.
enum ScrollEdgeFade {
    static let height: CGFloat = 32
}

extension View {
    func bottomScrollFade(_ height: CGFloat = ScrollEdgeFade.height) -> some View {
        mask {
            VStack(spacing: 0) {
                Color.black
                LinearGradient(colors: [.black, .black.opacity(0)], startPoint: .top, endPoint: .bottom).frame(height: height)
            }
        }
    }
}
