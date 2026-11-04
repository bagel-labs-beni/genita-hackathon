import SwiftUI

private let ink = Color(white: 17.0 / 255)
private let onInk = Color(white: 253.0 / 255)
private let sheetSurface = Color(white: 254.0 / 255)
private let boxFill = Color(white: 241.0 / 255)
private let mute = Color(white: 115.0 / 255)
private let errorRed = Color(red: 214.0 / 255, green: 40.0 / 255, blue: 29.0 / 255)

/// P01 (pair), P01-E (wrong code) and P02 (paired). Board design-flow r01 (direction A), values from the
/// 195 pt thumbnails doubled to 390 pt. The system number pad is the board's keypad.
struct PhonePairingView: View {
    @ObservedObject private var handoff = PhoneHandoff.shared
    @FocusState private var focused: Bool
    /// how far the sheet is pulled down (swipe-down dismiss, CRASH-1 / MOVE-2)
    @State private var pull: CGFloat = 0
    private var paired: Bool { handoff.link.connected || handoff.debugPaired }
    var body: some View {
        ZStack(alignment: .bottom) {
            // a modal: the scrim takes every touch outside the sheet and closes it; nothing reaches the call under it
            handoffScrim.ignoresSafeArea().contentShape(Rectangle()).onTapGesture { close() }
                .accessibilityLabel("Close pairing").accessibilityAddTraits(.isButton).accessibilityIdentifier("pairingScrim")
            Group { paired ? AnyView(pairedSheet) : AnyView(codeSheet) }
                .padding(.top, 28).padding(.horizontal, 38).padding(.bottom, 24)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(UnevenRoundedRectangle(topLeadingRadius: 30, topTrailingRadius: 30).fill(sheetSurface).shadow(color: .black.opacity(0.04), radius: 13).ignoresSafeArea(edges: .bottom))
                .overlay(alignment: .top) { Capsule().fill(Color(white: 219.0 / 255)).frame(width: 47, height: 5).padding(.top, 12) }
                .contentShape(Rectangle())
                .offset(y: pull)
                // the handle's promise: a pull down closes it (the system sheets do the same); a short one springs back
                .simultaneousGesture(DragGesture(minimumDistance: 12, coordinateSpace: .global)
                    .onChanged { g in pull = PairingSheetPull.vertical(g.translation) ? max(0, g.translation.height) : 0 }
                    .onEnded { g in
                        if PairingSheetPull.vertical(g.translation), PairingSheetPull.closes(translation: g.translation.height, predicted: g.predictedEndTranslation.height) { close() }
                        else { withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { pull = 0 } }
                    })
        }
        .accessibilityAddTraits(.isModal)
        .onAppear { if !paired { focused = true } }
        .onChange(of: paired) { _, now in if now { focused = false } }
        .onDisappear { focused = false }
    }
    /// Every way out (scrim, Cancel, Not now / Done, pull down): the number pad goes first, then the sheet, so the
    /// text field never leaves while it is still first responder. The call keeps running; a half-entered code is dropped.
    private func close() {
        focused = false
        DispatchQueue.main.async { handoff.closePairing() }
    }

    // MARK: P01 / P01-E
    private var codeSheet: some View {
        VStack(alignment: .leading, spacing: 0) {
            title("Pair with your Mac.").padding(.top, 12)
            Text("Enter the six digits in Genita on your Mac. You only do this once.").font(.custom("PretendardVariable-Regular", fixedSize: 16)).foregroundStyle(ink)
                .fixedSize(horizontal: false, vertical: true).padding(.top, 16)
            codeBoxes.padding(.top, 24)
            statusLine.padding(.top, 16)
            // MOVE-2: a visible way out, the same text button as P02's Not now (the handoff sheets' dismiss)
            Button(action: close) {
                Text("Cancel").font(.custom("PretendardVariable-Medium", fixedSize: 15)).foregroundStyle(ink)
                    .frame(maxWidth: .infinity).frame(height: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).padding(.top, 8).accessibilityIdentifier("pairingCancel")
        }
    }
    private var codeBoxes: some View {
        let digits = Array(handoff.code)
        return ZStack {
            HStack(spacing: 8) {
                ForEach(0..<6, id: \.self) { i in
                    let active = i == digits.count && !handoff.pairingFailed && focused
                    ZStack {
                        RoundedRectangle(cornerRadius: 12).fill(active ? Color.white : boxFill)
                        if active { RoundedRectangle(cornerRadius: 12).strokeBorder(ink, lineWidth: 1.5) }
                        if i < digits.count { Text(String(digits[i])).font(.custom("PretendardVariable-Medium", fixedSize: 22)).foregroundStyle(ink) }
                    }.frame(width: 44, height: 52)
                }
            }
            // The real field sits over the boxes: nearly invisible, still tappable and focusable.
            TextField("", text: Binding(get: { handoff.code }, set: { entered in
                let clean = String(entered.filter(\.isNumber).prefix(6))
                guard clean != handoff.code else { return }
                handoff.codeEdited()
                handoff.code = clean
                if clean.count == 6 { handoff.connect() }
            })).keyboardType(.numberPad).focused($focused).textContentType(.oneTimeCode)
                .foregroundStyle(.clear).tint(.clear).frame(width: 304, height: 52).opacity(0.02)
                // the sheet is white but the call behind it runs dark: the number pad follows the sheet, not the call
                // (UI sweep 11/3: three of the four pairing shots had a dark keypad under the white sheet)
                .environment(\.colorScheme, .light)
                .accessibilityLabel("Pairing code").accessibilityIdentifier("pairingCode")
        }.frame(width: 304, height: 52, alignment: .leading)
    }
    @ViewBuilder private var statusLine: some View {
        if handoff.pairingFailed {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.circle").font(.system(size: 14, weight: .semibold))
                Text("That code didn’t match. Check your Mac.").font(.custom("PretendardVariable-Regular", fixedSize: 14))
            }.foregroundStyle(errorRed).frame(minHeight: 20).accessibilityElement(children: .combine).accessibilityIdentifier("pairingError")
        } else if handoff.code.count == 6 {
            HStack(spacing: 8) {
                CueSpinnerDark()
                Text("Looking for your Mac").font(.custom("PretendardVariable-Regular", fixedSize: 14)).foregroundStyle(mute)
            }.frame(minHeight: 20).accessibilityElement(children: .combine).accessibilityIdentifier("pairingLooking")
        } else {
            // Same height as the other two states, so the sheet never jumps while the digits go in.
            Text(" ").font(.custom("PretendardVariable-Regular", fixedSize: 14)).frame(minHeight: 20)
        }
    }

    // MARK: P02
    private var pairedSheet: some View {
        VStack(alignment: .leading, spacing: 0) {
            title("Paired with your Mac.").padding(.top, 12)
            Text(handoff.offersTouchSetup
                 ? "You can also move by touching your Mac’s\u{00A0}screen edge. Show this iPhone your Mac’s\u{00A0}screen once to set it up."   // "Mac’s / screen" never splits (pixel QA)
                 : "Use Move to Mac in the menu to move the conversation.")
                .font(.custom("PretendardVariable-Regular", fixedSize: 16)).foregroundStyle(ink).fixedSize(horizontal: false, vertical: true).padding(.top, 16)
            if handoff.offersTouchSetup {
                Button(action: handoff.registerScreen) {
                    Text("Set up touch to move").font(.custom("PretendardVariable-Medium", fixedSize: 16)).foregroundStyle(onInk)
                        .frame(maxWidth: .infinity).frame(height: 50).background(ink, in: RoundedRectangle(cornerRadius: 6)).contentShape(Rectangle())
                }.buttonStyle(.plain).padding(.top, 32).accessibilityIdentifier("setUpTouchToMove")
            }
            Button(action: close) {
                Text(handoff.offersTouchSetup ? "Not now" : "Done").font(.custom("PretendardVariable-Medium", fixedSize: 15)).foregroundStyle(ink)
                    .frame(maxWidth: .infinity).frame(height: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).padding(.top, handoff.offersTouchSetup ? 6 : 32).accessibilityIdentifier("pairingNotNow")
            if handoff.offersTouchSetup { calibration }
        }
    }
    /// Dyno's position fine-tuning and forget-this-Mac, kept for the device test but folded away (not on the board).
    private var calibration: some View {
        DisclosureGroup("Adjust") {
            VStack(spacing: 8) {
                HStack { Text("Center down \(Int(handoff.tracker.centerDownMM)) mm"); Slider(value: Binding(get: { handoff.tracker.centerDownMM }, set: { handoff.tracker.centerDownMM = $0 }), in: 0...90, step: 1) }
                HStack { Text("Right \(Int(handoff.tracker.centerRightMM)) mm"); Slider(value: Binding(get: { handoff.tracker.centerRightMM }, set: { handoff.tracker.centerRightMM = $0 }), in: -35...35, step: 1) }
                Button("Forget this Mac", role: .destructive, action: handoff.forgetMac)
            }.font(.custom("PretendardVariable-Regular", fixedSize: 12)).padding(.top, 8)
        }.font(.custom("PretendardVariable-Regular", fixedSize: 13)).foregroundStyle(mute).tint(mute).padding(.top, 4).accessibilityIdentifier("pairingAdjust")
    }

    private func title(_ text: String) -> some View {
        Text(text).font(.custom("KMUTTF-SungkokSemiSerif", fixedSize: 28)).tracking(-0.28).foregroundStyle(ink).frame(minHeight: 34, alignment: .leading)
    }
}

/// The pairing sheet's pull-down: far enough, or flicked down, closes it.
enum PairingSheetPull {
    static func closes(translation: CGFloat, predicted: CGFloat) -> Bool { translation > 90 || (translation > 24 && predicted > 220) }
    /// a pull, not a slider drag (P02's Adjust) or a sideways swipe
    static func vertical(_ t: CGSize) -> Bool { abs(t.height) > abs(t.width) * 1.5 }
}

private struct CueSpinnerDark: View {
    @State private var turn = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        Circle().stroke(Color(white: 227.0 / 255), lineWidth: 1.5)
            .overlay(Circle().trim(from: 0, to: 0.25).stroke(mute, style: StrokeStyle(lineWidth: 1.5, lineCap: .round)).rotationEffect(.degrees(turn ? 360 : 0)))
            .frame(width: 14, height: 14)
            .onAppear { guard !reduceMotion else { return }; withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) { turn = true } }
    }
}

/// MV-1 "Moving to your Mac…" and MV-E "Mac not responding. Still here.": the call's status line, never a system alert.
struct HandoffMoveStatusLine: View {
    @ObservedObject private var handoff = PhoneHandoff.shared
    var body: some View {
        Group {
            if handoff.moving { pill(icon: AnyView(CueSpinner()), text: Self.text(moving: true), id: "moveStatusMoving") }
            else if handoff.moveFailed { pill(icon: AnyView(CueAlert()), text: Self.text(moving: false), id: "moveStatusFailed") }
        }
        .animation(.easeOut(duration: 0.2), value: handoff.moving).animation(.easeOut(duration: 0.2), value: handoff.moveFailed)
    }
    static func text(moving: Bool) -> String { moving ? "Moving to your Mac…" : "Mac not responding. Still here." }
    private func pill(icon: AnyView, text: String, id: String) -> some View {
        // the same pill box as the call cue (HUD r01 A, CallPillMetrics)
        HStack(spacing: CallPillMetrics.iconSpacing) {
            icon
            Text(text).font(TypeStyle.body(14, .medium)).foregroundStyle(CallInk.onInk).lineLimit(1).fixedSize()
        }
        .padding(.leading, CallPillMetrics.leading).padding(.trailing, CallPillMetrics.trailing).padding(.vertical, CallPillMetrics.vertical)
        .frame(minHeight: CallPillMetrics.height)
        .background(CallInk.pill, in: RoundedRectangle(cornerRadius: CallPillMetrics.radius))
        .accessibilityElement(children: .combine).accessibilityAddTraits(.updatesFrequently).accessibilityIdentifier(id)
    }
}
