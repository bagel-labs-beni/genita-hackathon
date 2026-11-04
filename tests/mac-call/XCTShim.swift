// Minimal XCTest stand-in so MacCallPlanTests runs with the Command Line Tools (no Xcode on the dev Mac).
// CI runs the same file under real XCTest in GenitaTests.
import Foundation

class XCTestCase { required init() {} }
nonisolated(unsafe) var shimFailures = 0
struct ShimUnwrapError: Error {}
func XCTFail(_ m: String = "", file: StaticString = #filePath, line: UInt = #line) { shimFailures += 1; print("  FAIL \(file):\(line) \(m)") }
func XCTAssertEqual<T: Equatable>(_ a: @autoclosure () throws -> T, _ b: @autoclosure () throws -> T, _ m: String = "", file: StaticString = #filePath, line: UInt = #line) {
    do { let x = try a(), y = try b(); if x != y { XCTFail("\(x) != \(y) \(m)", file: file, line: line) } } catch { XCTFail("threw \(error)", file: file, line: line) }
}
func XCTAssertNil<T>(_ a: @autoclosure () throws -> T?, _ m: String = "", file: StaticString = #filePath, line: UInt = #line) {
    if let v = try? a() { XCTFail("not nil: \(v) \(m)", file: file, line: line) }
}
func XCTAssertTrue(_ a: @autoclosure () throws -> Bool, _ m: String = "", file: StaticString = #filePath, line: UInt = #line) {
    if (try? a()) != true { XCTFail("not true \(m)", file: file, line: line) }
}
func XCTAssertFalse(_ a: @autoclosure () throws -> Bool, _ m: String = "", file: StaticString = #filePath, line: UInt = #line) {
    if (try? a()) != false { XCTFail("not false \(m)", file: file, line: line) }
}
func XCTUnwrap<T>(_ a: @autoclosure () throws -> T?, file: StaticString = #filePath, line: UInt = #line) throws -> T {
    guard let v = try a() else { XCTFail("nil", file: file, line: line); throw ShimUnwrapError() }
    return v
}
