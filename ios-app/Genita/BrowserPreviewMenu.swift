#if DEBUG
import SwiftUI

// Appetize browser preview (see shared/Call/BrowserPreview.swift). Debug-compiled, and only on screen when the app was
// launched with `--browser-preview`: a small "Preview" tab on the right edge opens a list that jumps between the flows.
// Every entry is a fixture the UI tests already use (review stages, recorded call session, Finds fixtures, fixture camera).

enum PreviewTarget {
    case onboarding(Stage)
    case call(session: String = "r1", findsState: Int? = nil, findsTab: String? = nil, camera: Bool = false, settings: Bool = false)
}

struct PreviewEntry: Identifiable {
    let id: String
    let title: String
    let note: String
    let target: PreviewTarget
}

enum PreviewCatalog {
    static let onboarding: [PreviewEntry] = [
        .init(id: "welcome", title: "Welcome", note: "Start of onboarding, tap through", target: .onboarding(.welcome)),
        .init(id: "signIn", title: "Sign in", note: "Apple / Google → local demo, then Consent", target: .onboarding(.signIn)),
        .init(id: "consent", title: "Consent (CS01)", note: "Agree to continue", target: .onboarding(.consent)),
        .init(id: "name", title: "Your name", note: "A03", target: .onboarding(.name)),
        .init(id: "prompt", title: "Bring your AI profile", note: "I01 prompt", target: .onboarding(.prompt)),
        .init(id: "image", title: "Companion photo", note: "V01", target: .onboarding(.image)),
        .init(id: "voice", title: "Voice", note: "V04 (offline list)", target: .onboarding(.voice)),
        .init(id: "companionName", title: "Name your companion", note: "NM01", target: .onboarding(.companionName)),
        .init(id: "summary", title: "Summary", note: "SUM", target: .onboarding(.summary)),
        .init(id: "bringing", title: "Bringing to life", note: "PREP-1", target: .onboarding(.bringing)),
    ]
    static let call: [PreviewEntry] = [
        .init(id: "call", title: "Call, moving face", note: "Recorded session: listening, thinking, talking", target: .call()),
        .init(id: "findsFridge", title: "Finds sheet, fridge recipe", note: "Half-open card from a recorded run", target: .call(findsState: 3)),
        .init(id: "findsProduct", title: "Finds sheet, product search", note: "Two product cards", target: .call(findsState: 22)),
        .init(id: "findsList", title: "Finds list", note: "Saved and recent finds", target: .call(findsTab: "list")),
        .init(id: "findsSaved", title: "Saved recipe", note: "Opens the saved card", target: .call(findsTab: "detail")),
        .init(id: "fridge", title: "Fridge, camera view", note: "Fixture fridge photo, boxes and card", target: .call(findsState: 31, camera: true)),
        .init(id: "interpret", title: "Interpretation", note: "Recorded interpret session", target: .call(session: "int")),
        .init(id: "settings", title: "Settings", note: "Over the call", target: .call(settings: true)),
    ]
}

/// The tab and the list. Overlaid on the app's window by GenitaApp; a no-op view unless `--browser-preview`.
struct BrowserPreviewMenu: View {
    @Bindable var model: AppState
    @State private var open = false

    var body: some View {
        if BrowserPreview.isActive {
            ZStack(alignment: .trailing) {
                if open {
                    Color.black.opacity(0.32).ignoresSafeArea().onTapGesture { open = false }
                        .accessibilityHidden(true)
                    panel.padding(.trailing, 10).transition(.move(edge: .trailing).combined(with: .opacity))
                } else {
                    Button { withAnimation(.easeOut(duration: 0.2)) { open = true } } label: {
                        Text("Preview").font(.system(size: 12, weight: .semibold)).foregroundStyle(.white)
                            .fixedSize().rotationEffect(.degrees(-90)).frame(width: 30, height: 78)
                            .background(Color.black.opacity(0.62), in: UnevenRoundedRectangle(topLeadingRadius: 10, bottomLeadingRadius: 10))
                    }.buttonStyle(.plain).accessibilityLabel("Preview menu").accessibilityIdentifier("previewTab")
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
        }
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Browser preview").font(.system(size: 17, weight: .semibold))
                    Text("Demo data. No camera, mic, push or Apple login.").font(.system(size: 12)).foregroundStyle(.white.opacity(0.6))
                }
                Spacer()
                Button { withAnimation(.easeOut(duration: 0.2)) { open = false } } label: { Image(systemName: "xmark").font(.system(size: 14, weight: .semibold)) }
                    .buttonStyle(.plain).accessibilityLabel("Close preview menu").accessibilityIdentifier("previewClose")
            }.padding(16)
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    section("Call and Finds", PreviewCatalog.call)
                    section("Onboarding", PreviewCatalog.onboarding)
                }.padding(.horizontal, 8).padding(.bottom, 12)
            }
        }
        .foregroundStyle(.white)
        .frame(width: 300).frame(maxHeight: 620)
        .background(Color.black.opacity(0.9), in: RoundedRectangle(cornerRadius: 20))
        .environment(\.colorScheme, .dark)
    }

    private func section(_ title: String, _ entries: [PreviewEntry]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title.uppercased()).font(.system(size: 11, weight: .semibold)).foregroundStyle(.white.opacity(0.5)).padding(.horizontal, 8).padding(.top, 10).padding(.bottom, 4)
            ForEach(entries) { entry in
                Button { withAnimation(.easeOut(duration: 0.2)) { open = false }; show(entry) } label: {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(entry.title).font(.system(size: 15, weight: .medium))
                        Text(entry.note).font(.system(size: 12)).foregroundStyle(.white.opacity(0.55))
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 8).padding(.vertical, 7).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityIdentifier("preview." + entry.id)
            }
        }
    }

    /// Leave the call first (its teardown runs when the stage changes), then set the stub variables and the stage.
    private func show(_ entry: PreviewEntry) {
        Task { @MainActor in
            model.menuOpen = false
            model.settingsOpen = false
            if model.stage == .conversation || model.stage == .connecting {
                model.history = []
                model.setup.stage = .welcome
                try? await Task.sleep(for: .milliseconds(500))
            }
            model.history = []
            switch entry.target {
            case let .onboarding(stage):
                if stage == .welcome { model.resetLocalProfile(); model.setup.stage = .welcome }
                else { model.applyReviewFixture(stage: stage, variant: "") }
            case let .call(session, findsState, findsTab, camera, settings):
                BrowserPreview.configureCall(session: session, findsState: findsState, findsTab: findsTab, camera: camera)
                model.applyReviewFixture(stage: .conversation, variant: "")
                if settings {
                    try? await Task.sleep(for: .milliseconds(900))
                    model.settingsOpen = true
                }
            }
        }
    }
}
#endif
