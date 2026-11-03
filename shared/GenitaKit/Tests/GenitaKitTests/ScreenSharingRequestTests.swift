import Testing
@testable import GenitaKit

struct ScreenSharingRequestTests {
    @Test func delayedSamplesCannotUseTheNextAccountsRequest() {
        final class Stream {}
        let oldStream = Stream(), newStream = Stream()
        var request = ScreenSharingRequest()
        request.begin()
        let old = request.beginCapture()!
        var oldGate = ScreenSharingSampleGate(request: old, stream: ObjectIdentifier(oldStream))
        #expect(request.completeCapture(old) == true)
        request.invalidate()
        oldGate.invalidate()

        request.begin()
        let next = request.beginCapture()!
        let nextGate = ScreenSharingSampleGate(request: next, stream: ObjectIdentifier(newStream))
        #expect(request.completeCapture(next) == true)
        #expect(!oldGate.accepts(stream: ObjectIdentifier(oldStream), request: old))
        // Even if a late A buffer is presented with B's callback/request, it is rejected at intake.
        #expect(!nextGate.accepts(stream: ObjectIdentifier(oldStream), request: next))
        #expect(!nextGate.accepts(stream: ObjectIdentifier(newStream), request: old))
        #expect(!request.acceptsSamples(old))
        #expect(request.acceptsSamples(next))
        #expect(nextGate.accepts(stream: ObjectIdentifier(newStream), request: next))
    }

    @Test func cancellingReselectionKeepsActiveCaptureAuthorized() {
        var request = ScreenSharingRequest()
        request.begin()
        let active = request.beginCapture()!
        #expect(request.completeCapture(active) == true)

        request.begin()
        #expect(request.acceptsSamples(active))
        request.cancelPicker()

        #expect(request.acceptsSamples(active))
        #expect(request.beginCapture() == nil)
    }

    @Test func reselectionWhileStartingUsesANewCaptureRequest() {
        var request = ScreenSharingRequest()
        request.begin()
        let first = request.beginCapture()!
        request.begin()
        let replacement = request.beginCapture()!

        #expect(first != replacement)
        #expect(!request.isStarting(first))
        #expect(request.isStarting(replacement))
        #expect(request.completeCapture(first) == false)
        #expect(request.completeCapture(replacement) == true)
        #expect(!request.acceptsSamples(first))
        #expect(request.acceptsSamples(replacement))
    }

    @Test func replacingActiveCaptureKeepsOldMediaUntilTheNewStartCompletes() {
        var request = ScreenSharingRequest()
        request.begin()
        let active = request.beginCapture()!
        #expect(request.completeCapture(active) == true)
        request.begin()
        let replacement = request.beginCapture()!
        #expect(request.acceptsSamples(active))
        #expect(!request.acceptsSamples(replacement))

        #expect(request.completeCapture(replacement) == true)
        #expect(!request.acceptsSamples(active))
        #expect(request.acceptsSamples(replacement))
    }

    @Test func logoutRejectsStartingAndActiveCaptures() {
        var request = ScreenSharingRequest()
        request.begin()
        let active = request.beginCapture()!
        #expect(request.completeCapture(active) == true)
        request.begin()
        let starting = request.beginCapture()!

        request.invalidate()

        #expect(!request.isStarting(starting))
        #expect(request.completeCapture(starting) == false)
        #expect(!request.acceptsSamples(active))
        #expect(!request.acceptsSamples(starting))
        #expect(request.beginCapture() == nil)
    }

    @Test func aFailedReplacementKeepsActiveMediaAndCannotCancelANewerStart() {
        var request = ScreenSharingRequest()
        request.begin()
        let active = request.beginCapture()!
        #expect(request.completeCapture(active) == true)
        request.begin()
        let failed = request.beginCapture()!
        request.cancelCapture(failed)
        #expect(!request.isStarting(failed))
        #expect(request.acceptsSamples(active))

        request.begin()
        let next = request.beginCapture()!
        request.cancelCapture(failed)
        #expect(request.isStarting(next))
        #expect(request.completeCapture(next) == true)
        #expect(request.acceptsSamples(next))
    }

    @Test func aPickerSelectionIsConsumedOnlyOnce() {
        var request = ScreenSharingRequest()
        request.begin()
        let starting = request.beginCapture()!
        #expect(request.beginCapture() == nil)
        #expect(request.isStarting(starting))
    }

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

    // #318 review P1: A's picker answers late, after logout and after B opened a picker.
    @Test func aStalePickerSelectionCannotConsumeTheNextAccountsRequest() {
        var request = ScreenSharingRequest()
        request.begin()                      // A opens the picker
        request.invalidate()                 // A signs out while it is still on screen
        #expect(request.stalePicker)
        let b = request.begin()              // B opens a picker
        #expect(request.beginCapture() == nil)   // A's late selection: dropped
        #expect(request.isCurrent(b))            // B's request is untouched
        #expect(request.beginCapture() == b)     // B's own selection starts B's capture
        #expect(!request.stalePicker)
    }

    @Test func aStalePickerCancelDoesNotCancelTheNextPicker() {
        var request = ScreenSharingRequest()
        request.begin()
        request.invalidate()
        let b = request.begin()
        #expect(request.cancelPicker() == false)  // A's cancel: dropped
        #expect(request.isCurrent(b))
        #expect(request.cancelPicker() == true)   // B's own cancel
        #expect(request.current == nil)
    }

    @Test func afterTheWaitTheNextCallbackBelongsToTheNewPicker() {
        var request = ScreenSharingRequest()
        request.begin()
        request.invalidate()
        request.clearStalePicker()               // the app waited; A's picker never answered
        let b = request.begin()
        #expect(request.beginCapture() == b)
    }

    @Test func stopWithoutAnOpenPickerLeavesNothingStale() {
        var request = ScreenSharingRequest()
        request.begin()
        let active = request.beginCapture()!
        #expect(request.completeCapture(active))
        request.invalidate()
        #expect(!request.stalePicker)
        let b = request.begin()
        #expect(request.beginCapture() == b)
    }
}
