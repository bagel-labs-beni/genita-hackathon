import XCTest
import SwiftUI
@testable import Genita

/// ui-deferred: the I01 "Your prompt" card's text fades out at its scroll edge instead of being hard-cut,
/// and the reader has room under its last line so it can scroll clear of the fade.
@MainActor final class PromptFadeTests: XCTestCase {
    func testPromptReaderFadesAtTheBottomEdgeAndCanScrollPastIt() throws {
        let model = AppState(storage: UserDefaults(suiteName: UUID().uuidString)!, imageURL: URL.temporaryDirectory.appending(path: UUID().uuidString))
        model.setup.stage = .prompt; model.setup.name = "Dyno"
        let size = CGSize(width: 390, height: 844)
        let host = UIHostingController(rootView: ReferenceOnboardingView(model: model, referenceViewport: true).frame(width: size.width, height: size.height))
        let window = UIWindow(frame: CGRect(origin: .zero, size: size))
        window.rootViewController = host; window.isHidden = false
        host.view.frame = window.bounds; host.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))

        func find(_ v: UIView) -> UITextView? {
            if let t = v as? UITextView, t.accessibilityIdentifier == "promptReader" { return t }
            for s in v.subviews { if let t = find(s) { return t } }
            return nil
        }
        let reader = try XCTUnwrap(find(host.view), "the prompt reader is on I01")
        XCTAssertEqual(reader.textContainerInset.bottom, ScrollEdgeFade.height, "room for the last line above the fade")
        XCTAssertGreaterThan(reader.contentSize.height, reader.bounds.height, "the prompt is longer than the card, so it scrolls")

        func capture(_ name: String) {
            let format = UIGraphicsImageRendererFormat(); format.scale = 2
            let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true) }
            let shot = XCTAttachment(image: image); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        }
        capture("uidef-prompt-fade")
        // scrolled so body lines sit in the fade band (the top of the prompt has a paragraph break there)
        reader.setContentOffset(CGPoint(x: 0, y: 60), animated: false)
        RunLoop.main.run(until: Date().addingTimeInterval(0.15))
        capture("uidef-prompt-fade-scrolled")
        window.isHidden = true
    }
}
