import XCTest
import UIKit
@testable import Genita

@MainActor final class AppStateTests: XCTestCase {
    var store: UserDefaults!
    override func setUp() { super.setUp(); store = UserDefaults(suiteName: UUID().uuidString)! }
    func testBundledDesignTokensAndFontsAreVisible() {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        XCTAssertTrue(UIColor(named: "Ink")!.getRed(&red, green: &green, blue: &blue, alpha: &alpha))
        XCTAssertEqual(alpha, 1, accuracy: 0.001)
        XCTAssertEqual(red, 0.067, accuracy: 0.002)
        XCTAssertNotNil(UIFont(name: "KMUTTF-SungkokSemiSerif", size: 35))
        XCTAssertNotNil(UIFont(name: "PretendardVariable-Regular", size: 16))
    }
    func testImageIsStoredOutsidePreferencesAndSurvivesRestart() {
        let url = URL.temporaryDirectory.appending(path: UUID().uuidString + ".jpg")
        defer { try? FileManager.default.removeItem(at: url) }
        let model = AppState(storage: store, imageURL: url)
        let image = Data(repeating: 77, count: 5_000_000)
        model.setup.imageData = image; model.complete()
        XCTAssertLessThan(store.data(forKey: AppState.storageKey)!.count, 1000)
        let reopened = AppState(storage: store, imageURL: url)
        XCTAssertEqual(reopened.setup.imageData, image)
        XCTAssertEqual(reopened.stage, .conversation)
    }
    func testCallStopRoutesToSignInAndConsent() {
        let model = AppState(storage: store)
        model.go(.connecting); model.go(.conversation)
        model.route(.consent)
        XCTAssertEqual(model.stage, .consent, "4403 → CS01")
        model.consentAccepted()
        XCTAssertEqual(model.stage, .conversation, "agree → back to the call")
        model.route(.signIn)
        XCTAssertEqual(model.stage, .signIn, "4401 → A02")
        model.route(.timeLimit)
        XCTAssertEqual(model.stage, .signIn, "4001 is not a route")
    }
    func testSignOutSurvivesARestartAndSignInReturnsToTheCall() {
        let model = AppState(storage: store)
        model.setup.hasOnboarded = true; model.go(.conversation); model.save()
        model.signedOut()
        XCTAssertEqual(model.stage, .signIn)
        let restarted = AppState(storage: store)
        XCTAssertEqual(restarted.stage, .signIn, "a signed-out user does not land back in the call")
        restarted.signedIn()
        XCTAssertEqual(restarted.stage, .conversation)
        XCTAssertEqual(AppState(storage: store).stage, .conversation)
    }
    func testReturnToEditorDoesNotReplayProcessing() {
        let model = AppState(storage: store)
        model.go(.prompt); model.go(.paste); model.go(.preparing); model.go(.preferences)
        model.returnTo(.paste); model.back()
        XCTAssertEqual(model.stage, .prompt)
    }
    func testContinueInBackgroundDoesNotReplayProcessing() {
        let model = AppState(storage: store)
        model.go(.prompt); model.go(.paste); model.go(.preparing); model.go(.image)
        model.back()
        XCTAssertEqual(model.stage, .preferences)
        model.back()
        XCTAssertEqual(model.stage, .paste)
        model.go(.preparing); model.go(.preferences)
        XCTAssertFalse(model.history.contains(.preparing))
    }
    func testSetupPersistsAndReopensSameConversation() {
        let model = AppState(storage: store)
        model.setup.name = "Dyno"
        model.setup.response = "Communication style\nWarm, clear and direct."
        model.setup.voice = 2
        model.answer("help", "Think with me")
        model.complete()
        let reopened = AppState(storage: store)
        XCTAssertEqual(reopened.stage, .conversation)
        XCTAssertEqual(reopened.setup.name, "Dyno")
        XCTAssertEqual(reopened.setup.voice, 2)
        XCTAssertEqual(reopened.setup.answers["help"], "Think with me")
    }
    func testOnlyRequestedPreferenceStepsAppear() {
        XCTAssertFalse(SetupDepth.quick.path.contains(.challenge))
        XCTAssertTrue(SetupDepth.right.path.contains(.challenge))
        XCTAssertFalse(SetupDepth.right.path.contains(.boundaries))
        XCTAssertTrue(SetupDepth.deep.path.contains(.boundaries))
        for depth in SetupDepth.allCases { XCTAssertEqual(Set(depth.path).count, depth.path.count); XCTAssertEqual(depth.path.last, .summary) }
    }
    func testBackKeepsDraftAndChoices() {
        let model = AppState(storage: store)
        model.go(.prompt); model.go(.paste); model.setup.response = "A draft"
        model.back(); model.go(.paste)
        XCTAssertEqual(model.setup.response, "A draft")
        model.setup.depth = .quick; model.go(.depth); model.nextPreference()
        XCTAssertEqual(model.stage, .help)
    }
    func testEmptyInputsAndWhitespaceAreRejected() {
        let model = AppState(storage: store)
        model.setup.name = " \n"; model.setup.response = "\n "
        XCTAssertFalse(model.validName); XCTAssertFalse(model.validResponse)
        model.setup.response = "I prefer concise replies."
        XCTAssertTrue(model.validResponse)
    }
    func testInterruptedProcessingReturnsToEditableDraft() {
        let model = AppState(storage: store)
        model.setup.response = "Saved reply"; model.go(.preparing)
        let reopened = AppState(storage: store)
        XCTAssertEqual(reopened.stage, .paste)
        XCTAssertEqual(reopened.setup.response, "Saved reply")
    }
    func testBoundaryTogglesAndPathChangesDoNotDeleteAnswers() {
        let model = AppState(storage: store)
        model.toggleBoundary("Message anyone for me"); XCTAssertEqual(model.setup.boundaries.count, 1)
        model.toggleBoundary("Message anyone for me"); XCTAssertTrue(model.setup.boundaries.isEmpty)
        model.answer("challenge", "4"); model.setup.depth = .quick; model.setup.depth = .deep
        XCTAssertEqual(model.setup.answers["challenge"], "4")
    }
}
