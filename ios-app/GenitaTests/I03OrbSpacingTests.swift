import XCTest
import SwiftUI
@testable import Genita

/// I03 spacing (Chelsea 11/4): the orb starts 24 pt under "Using the profile you chose to share.", keeps its size
/// where it fits, and shrinks evenly on short screens instead of running into the CTA.
@MainActor final class I03OrbSpacingTests: XCTestCase {
    private let nodes = DesignLibrary.nodes("preparing")
    private var orb: DesignNode { nodes.first { $0.name.hasPrefix("soul-orb") }! }
    private var subtitle: DesignNode { nodes.first { $0.characters == "Using the profile you chose to share." }! }

    func testOrbSitsUnderTheSubtitleAtFullSizeOnA390Phone() {
        // 390 × 844 (safe top 47 → top 3): content bottom 680 − 3
        let fit = ReferenceOnboardingView.readingFit(orb: orb, nodes: nodes, limit: 677)
        XCTAssertEqual(fit.scale, 1)
        XCTAssertEqual(fit.orb.y, subtitle.y + subtitle.h + 24, "24 pt under the subtitle")
        XCTAssertEqual(fit.orb.w, orb.w); XCTAssertEqual(fit.orb.h, orb.h)
        XCTAssertEqual(fit.shift, fit.orb.y - orb.y, "the reading block keeps its Figma distance")
        XCTAssertLessThanOrEqual(620 + fit.shift, 677, "the % label stays above the CTA")
    }

    func testOrbShrinksOnAnSEInsteadOfOverlappingTheCTA() {
        // 375 × 667 (safe top 20 → top −24): footer 527, content bottom 503 → body limit 527
        let fit = ReferenceOnboardingView.readingFit(orb: orb, nodes: nodes, limit: 527)
        XCTAssertLessThan(fit.scale, 1); XCTAssertGreaterThan(fit.scale, 0.4)
        XCTAssertEqual(fit.orb.y, subtitle.y + subtitle.h + 24)
        XCTAssertEqual(fit.orb.w / orb.w, fit.orb.h / orb.h, accuracy: 1e-9, "same proportions")
        XCTAssertEqual(fit.orb.x + fit.orb.w / 2, orb.x + orb.w / 2, accuracy: 1e-9, "same centre line")
        XCTAssertLessThanOrEqual(620 + fit.shift, 527 + 0.001, "the whole block fits above the CTA")
    }

    func testSpacingOffIsTheFigmaNode() {
        ReferenceOnboardingView.orbSpacing = false
        defer { ReferenceOnboardingView.orbSpacing = true }
        let fit = ReferenceOnboardingView.readingFit(orb: orb, nodes: nodes, limit: 527)
        XCTAssertEqual(fit.orb.y, orb.y); XCTAssertEqual(fit.shift, 0); XCTAssertEqual(fit.scale, 1)
    }

    /// 3× captures at 390 × 844 and SE 375 × 667, before (Figma node) and after; exported as preview-i03-spacing-*.
    func testCaptures() {
        for (label, size, safeTop, safeBottom) in [("390", CGSize(width: 390, height: 844), 47.0, 34.0), ("se", CGSize(width: 375, height: 667), 20.0, 0.0)] {
            for after in [false, true] {
                ReferenceOnboardingView.orbSpacing = after
                let model = AppState(storage: UserDefaults(suiteName: UUID().uuidString)!, imageURL: URL.temporaryDirectory.appending(path: UUID().uuidString))
                model.setup.stage = .preparing
                let host = UIHostingController(rootView: ReferenceOnboardingView(model: model).frame(width: size.width, height: size.height))
                let window = UIWindow(frame: CGRect(origin: .zero, size: size))
                window.rootViewController = host; window.isHidden = false
                host.view.frame = window.bounds
                host.view.setNeedsLayout(); host.view.layoutIfNeeded()
                // the final safe area is the phone's (47 / 20 top), whatever the test window already brings
                let base = host.view.safeAreaInsets
                host.additionalSafeAreaInsets = UIEdgeInsets(top: max(0, safeTop - base.top), left: 0, bottom: max(0, safeBottom - base.bottom), right: 0)
                host.view.setNeedsLayout(); host.view.layoutIfNeeded()
                if base.top <= safeTop { XCTAssertEqual(host.view.safeAreaInsets.top, safeTop, accuracy: 0.5, label) }
                RunLoop.main.run(until: Date().addingTimeInterval(0.2))
                let format = UIGraphicsImageRendererFormat(); format.scale = 3
                let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true) }
                let a = XCTAttachment(image: image); a.name = "preview-i03-spacing-\(label)-\(after ? "after" : "before")"; a.lifetime = .keepAlways; add(a)
                XCTAssertEqual(image.size, size)
                window.isHidden = true
            }
        }
        ReferenceOnboardingView.orbSpacing = true
    }

    /// SE (375): "Picking up your preferences and communication style." wraps to two whole lines instead of being cut,
    /// "communication style." together; 390 keeps the Figma one-liner.
    func testPickingUpLineWrapsOnSEAndStaysOneLineAt390() {
        let line = nodes.first { $0.characters == "Picking up your preferences and communication style." }!
        let at390 = ReferenceOnboardingView.processingLine(line, width: 390, percent: "62%")
        XCTAssertNil(at390.text, "390: Figma's single line")
        XCTAssertEqual(at390.node.h, line.h)
        let se = ReferenceOnboardingView.processingLine(line, width: 375, percent: "62%")
        XCTAssertEqual(se.text, "Picking up your preferences and communication\u{00A0}style.")
        XCTAssertGreaterThanOrEqual(se.node.h, 2 * (line.lineHeight ?? line.font.lineHeight) - 0.5, "two lines tall, nothing clipped")
        XCTAssertLessThanOrEqual(line.y + se.node.h, 569, "still above the progress track (y 569)")
    }
}
