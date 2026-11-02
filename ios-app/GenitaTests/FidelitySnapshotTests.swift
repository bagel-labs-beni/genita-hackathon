import XCTest
import SwiftUI
@testable import Genita

@MainActor final class FidelitySnapshotTests: XCTestCase {
    func testSourceTypographyAndNativeFaces() {
        let name = DesignLibrary.nodes("name").first { $0.fontFamily == "KMU80 TTF" }!
        XCTAssertEqual(name.fontSize, 40); XCTAssertEqual(name.lineHeight, 33); XCTAssertEqual(name.letterSpacing, -0.4)
        XCTAssertEqual(name.font.fontName, "KMUTTF-SungkokSemiSerif")
        let input = DesignLibrary.nodes("name").first { $0.characters == "Dyno" }!
        XCTAssertEqual(input.font.pointSize, 20); XCTAssertEqual(input.font.fontName, "PretendardVariable-Medium")
        let heading = DesignLibrary.nodes("depth").first { $0.characters == "Quick start" }!
        let subtitle = DesignLibrary.nodes("depth").first { $0.characters == "About 3 minutes" }!
        XCTAssertEqual(heading.font.pointSize, 18); XCTAssertEqual(heading.font.fontName, "PretendardVariable-SemiBold")
        XCTAssertEqual(subtitle.font.pointSize, 12); XCTAssertEqual(subtitle.font.fontName, "PretendardVariable-Medium")
        let prompt = DesignLibrary.nodes("prompt").first { $0.characters == "Your prompt" }!
        let bounds = prompt.attributed().boundingRect(with: CGSize(width: prompt.w, height: 1000), options: [.usesLineFragmentOrigin], context: nil)
        XCTAssertLessThanOrEqual(bounds.height, prompt.h + 1, "The source label must not wrap or clip")
        // D44/D55: the I01/I02 subtitles name no assistant and still fit their two source lines
        for (stage, id) in [("prompt", "526:17751"), ("paste", "526:17821")] {
            let sub = DesignLibrary.nodes(stage).first { $0.figmaId == id }!
            let text = (sub.characters ?? "").replacingOccurrences(of: "\n", with: " ").lowercased()
            XCTAssertTrue(text.contains("ai assistant") && !text.contains("chatgpt") && !text.contains("claude"), stage)
            let fit = sub.attributed().boundingRect(with: CGSize(width: sub.w, height: 1000), options: [.usesLineFragmentOrigin], context: nil)
            XCTAssertLessThanOrEqual(fit.height, sub.h + 1, "\(stage) subtitle must stay on two lines")
        }
    }
    func testNativeReferenceScreens() throws {
        let stages: [Stage] = [.welcome, .signIn, .name, .prompt, .paste, .preferences, .preparing, .image, .voice, .depth, .help, .relationship, .challenge, .tempo, .initiative, .boundaries, .presence, .summary]
        for stage in stages {
            let store = UserDefaults(suiteName: UUID().uuidString)!
            let model = AppState(storage: store, imageURL: URL.temporaryDirectory.appending(path: UUID().uuidString))
            model.setup.stage = stage; model.setup.name = "Dyno"; model.setup.depth = .right
            if let body = DesignLibrary.nodes(stage.rawValue).first(where: { $0.y == 319 && $0.type == "text" }) { model.setup.response = body.characters ?? "" }
            model.setup.answers = ["help":"Keep me moving", "relationship":"Trusted partner", "challenge":"3", "tempo":"2", "initiative":"1"]
            model.setup.boundaries = ["Use sensitive memories"]; model.setup.presence = ["Calm"]
            let height: CGFloat = stage == .name ? 519 : 844
            let content: AnyView
            if stage == .welcome { content = AnyView(ReferenceWelcomeView(action: {}, referenceViewport: true)) }
            else if stage == .signIn { content = AnyView(ReferenceSignInView(model: model, referenceViewport: true)) }
            else { content = AnyView(ReferenceOnboardingView(model: model, referenceViewport: true)) }
            let view = content.frame(width: 390, height: height)
            let host = UIHostingController(rootView: view)
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: height))
            window.rootViewController = host; window.isHidden = false
            host.view.frame = CGRect(x: 0, y: 0, width: 390, height: height)
            host.view.setNeedsLayout(); host.view.layoutIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.15))
            let format = UIGraphicsImageRendererFormat(); format.scale = 1
            let image = UIGraphicsImageRenderer(size: CGSize(width: 390, height: height), format: format).image { _ in host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true) }
            let attachment = XCTAttachment(image: image); attachment.name = "fidelity-\(stage.rawValue)"; attachment.lifetime = .keepAlways; add(attachment)
            XCTAssertEqual(image.size.width, 390)
            window.isHidden = true
        }
    }
}
