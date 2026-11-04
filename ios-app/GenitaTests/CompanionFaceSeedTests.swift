import XCTest
@testable import Genita

/// Face plan item 1: one motion seed per face key (prepared poster, disk poster and live face match), and the scene's
/// output size is the face set's.
@MainActor final class CompanionFaceSeedTests: XCTestCase {
    func testSeedComesFromTheFaceKey() {
        let face = "face set one", a = CompanionFace.seed(forKey: face), b = CompanionFace.seed(forKey: face)
        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, CompanionFace.seed(forKey: "face set two"))
        XCTAssertNotEqual(a, 0)
        XCTAssertEqual(CompanionFace.seed(forKey: nil), 1)
    }

    /// Face plan item 1 is on by default (gate passed 11/4); GENITA_SCENE_FRAMING=0 turns it off.
    func testSceneFramingIsOnByDefault() {
        XCTAssertTrue(CompanionFace.sceneFramingDefault)
        if ProcessInfo.processInfo.environment["GENITA_SCENE_FRAMING"] == nil { XCTAssertTrue(CompanionFace.sceneFraming) }
    }

    func testSceneOutputSizeIsTheFaceSetOutputSize() throws {
        let set = try CompanionFaceTests.fixtureSet()
        XCTAssertEqual(CompanionFace.outputSize(still: set.pixelSize), CompanionFace.outputSize(for: set))
        XCTAssertEqual(CompanionFace.outputSize(still: CGSize(width: 1152, height: 2048), pixelHeight: 1688), CGSize(width: 950, height: 1688))
    }
}
