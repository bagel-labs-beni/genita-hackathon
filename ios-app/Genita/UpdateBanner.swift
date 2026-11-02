import SwiftUI

/// "New version available" nudge, driven by `GET /v1/app-config` (`updates.ios`): TestFlight builds update
/// through TestFlight, so the banner only links the public TestFlight page. Dismissed once per build;
/// below `minBuild` it stays (no ×). Nothing shows while the config says latestBuild = 0 (not set).
struct UpdateBanner: View {
    var config: GenitaAppConfig
    var installedBuild: Int? = GenitaAppConfigStore.installedBuild
    @AppStorage("genita.update.dismissedBuild") private var dismissedBuild = 0
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drag: CGFloat = 0

    private var nudge: GenitaAppConfig.UpdateNudge { config.updates.ios.nudge(installedBuild: installedBuild) }
    private var visible: (build: Int, url: URL, required: Bool)? {
        switch nudge {
        case .none: nil
        case let .available(build, url): build == dismissedBuild ? nil : (build, url, false)
        case let .required(build, url): (build, url, true)
        }
    }

    var body: some View {
        ZStack(alignment: .top) {
            if let v = visible {
                card(v)
                    .padding(.horizontal, 16)
                    .padding(.top, 6)
                    .offset(y: min(drag, 0))
                    .gesture(DragGesture(minimumDistance: 8)
                        .onChanged { drag = $0.translation.height }
                        .onEnded { g in
                            if !v.required, g.translation.height < -28 { dismissedBuild = v.build }
                            withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) { drag = 0 }
                        })
                    .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.2) : .spring(response: 0.5, dampingFraction: 0.82), value: visible?.build)
    }

    private func card(_ v: (build: Int, url: URL, required: Bool)) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "arrow.down.circle.fill")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(.white, Color(red: 17 / 255, green: 17 / 255, blue: 17 / 255))
                .symbolEffect(.bounce, options: .nonRepeating, value: v.build)
            VStack(alignment: .leading, spacing: 2) {
                Text(config.text("update.title")).font(TypeStyle.body(15, .semibold))
                Text(config.text(v.required ? "update.required" : "update.body")).font(TypeStyle.body(13)).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 4)
            Button(config.text("update.action")) { openURL(v.url) }
                .font(TypeStyle.body(14, .semibold))
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .tint(.black)
                .accessibilityIdentifier("updateBannerAction")
            if !v.required {
                Button { dismissedBuild = v.build } label: { Image(systemName: "xmark").font(.system(size: 12, weight: .bold)).foregroundStyle(.secondary).padding(10).contentShape(Rectangle()) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dismiss")
                    .accessibilityIdentifier("updateBannerDismiss")
            }
        }
        .padding(.leading, 14).padding(.trailing, 8).padding(.vertical, 10)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(.white.opacity(0.5), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.12), radius: 18, y: 8)
        .environment(\.colorScheme, .light)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("updateBanner")
    }
}

extension GenitaAppConfigStore {
    /// UI tests stay offline (the replay server has no config); `--update-banner-demo` (DEBUG) shows the nudge.
    func refreshUnlessTesting(force: Bool = false) async {
        let args = ProcessInfo.processInfo.arguments
        #if DEBUG
        if args.contains("--update-banner-demo") { applyDemo(); return }
        #endif
        if args.contains("--uitesting") { return }
        await refresh(force: force)
    }
    #if DEBUG
    private func applyDemo() {
        var demo = config
        demo.updates.ios.latestBuild = (Self.installedBuild ?? 1) + 10
        applyForReview(demo)
    }
    #endif
}
