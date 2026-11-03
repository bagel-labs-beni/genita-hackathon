import XCTest
import SwiftUI
@testable import Genita

/// ui-deferred: flowing text screens scale with Dynamic Type (exact Figma sizes at the default Large), and cap
/// where their layout would break. Screens are rendered at Large, xxxLarge and AX3 for the CI screenshots.
@MainActor final class DynamicTypeTests: XCTestCase {
    func testScalableTextKeepsTheDesignSizeAtTheDefaultAndGrowsAboveIt() {
        let large = UITraitCollection(preferredContentSizeCategory: .large)
        let bigger = UITraitCollection(preferredContentSizeCategory: .accessibilityMedium)
        for size: CGFloat in [12, 13, 14, 15, 16, 17, 18, 20, 28, 35] {
            let style = TypeStyle.style(for: size)
            let metrics = UIFontMetrics(forTextStyle: Self.uiStyle(style))
            XCTAssertEqual(metrics.scaledValue(for: size, compatibleWith: large), size, accuracy: 0.01, "\(size) pt is unchanged at the default text size")
            XCTAssertGreaterThan(metrics.scaledValue(for: size, compatibleWith: bigger), size, "\(size) pt grows with larger text")
        }
        XCTAssertEqual(TypeStyle.style(for: 14), .subheadline)
        XCTAssertEqual(TypeStyle.style(for: 16), .callout)
        XCTAssertEqual(TypeStyle.style(for: 17), .body)
    }

    func testCapsStopBeforeLayoutsBreak() {
        XCTAssertEqual(TextScale.screen.upperBound, .accessibility2)
        XCTAssertEqual(TextScale.sheet.upperBound, .xxxLarge)
        XCTAssertTrue(TextScale.screen.contains(.large) && TextScale.sheet.contains(.large))
    }

    func testRenderTextScreensAtThreeSizes() {
        let model = AppState(storage: UserDefaults(suiteName: UUID().uuidString)!, imageURL: URL.temporaryDirectory.appending(path: UUID().uuidString))
        let screens: [(String, AnyView)] = [
            ("consent", AnyView(ConsentView(model: model))),
            ("email", AnyView(EmailSignInSheet(model: model))),
            ("camera-guide", AnyView(CameraGuideSheet(bottomInset: 34, turnOn: {}, notNow: {}))),
        ]
        for (name, view) in screens {
            for (label, size) in [("L", DynamicTypeSize.large), ("xxxL", .xxxLarge), ("AX3", .accessibility3)] {
                let image = render(view.environment(\.dynamicTypeSize, size))
                let shot = XCTAttachment(image: image); shot.name = "uidef-dt-\(name)-\(label)"; shot.lifetime = .keepAlways; add(shot)
            }
        }
    }

    private func render(_ view: some View) -> UIImage {
        let size = CGSize(width: 390, height: 844)
        // an offscreen window has no safe area: give it the device's (top 47 / bottom 34), as the real screen does
        let host = UIHostingController(rootView: view.safeAreaPadding(.top, 47).safeAreaPadding(.bottom, 34).frame(width: size.width, height: size.height))
        let window = UIWindow(frame: CGRect(origin: .zero, size: size))
        window.rootViewController = host; window.isHidden = false
        host.view.frame = window.bounds; host.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.15))
        let format = UIGraphicsImageRendererFormat(); format.scale = 2
        let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true) }
        window.isHidden = true
        return image
    }

    private static func uiStyle(_ style: Font.TextStyle) -> UIFont.TextStyle {
        switch style {
        case .largeTitle: .largeTitle
        case .title: .title1
        case .title2: .title2
        case .title3: .title3
        case .headline: .headline
        case .subheadline: .subheadline
        case .callout: .callout
        case .footnote: .footnote
        case .caption: .caption1
        case .caption2: .caption2
        default: .body
        }
    }
}
