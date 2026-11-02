import Testing
@testable import GenitaKit

struct ScreenSharingRequestTests {
    @Test func stopRejectsAStartStillAwaitingTheContentFilter() {
        var request = ScreenSharingRequest()
        let pending = request.begin()
        #expect(request.isCurrent(pending))

        request.invalidate()

        #expect(request.current == nil)
        #expect(!request.isCurrent(pending))
    }

    @Test func stopRejectsAStreamThatFinishesStartingAfterLogout() {
        var request = ScreenSharingRequest()
        let starting = request.begin()
        request.invalidate()

        // A new account/call does not authorize capture. Only a new picker request does.
        #expect(!request.isCurrent(starting))
        #expect(request.current == nil)
        let explicitlySelected = request.begin()
        #expect(request.isCurrent(explicitlySelected))
        #expect(!request.isCurrent(starting))
    }

    @Test func newSelectionRejectsPreviousStartAndQueuedMedia() {
        var request = ScreenSharingRequest()
        let previous = request.begin()
        let latest = request.begin()

        #expect(!request.isCurrent(previous))
        #expect(request.isCurrent(latest))
        request.invalidate()
        request.invalidate()
        #expect(!request.isCurrent(previous))
        #expect(!request.isCurrent(latest))
    }
}
