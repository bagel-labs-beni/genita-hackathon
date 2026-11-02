import Testing
@testable import GenitaKit

struct CapturePermissionTests {
    @Test func currentCallOwnerCanApplyPermission() {
        let requests = CapturePermissionRequests()
        #expect(requests.accepts(requests.generation, callEnded: false, isOwner: true))
    }

    @Test func endedCallOrNonOwnerCannotApplyPermission() {
        let requests = CapturePermissionRequests()
        #expect(!requests.accepts(requests.generation, callEnded: true, isOwner: true))
        #expect(!requests.accepts(requests.generation, callEnded: false, isOwner: false))
    }

    @Test func suspendInvalidatesBothPendingMediaPermissions() {
        var requests = CapturePermissionRequests()
        let microphone = requests.generation
        let camera = requests.generation
        requests.invalidate()
        #expect(!requests.accepts(microphone, callEnded: false, isOwner: true))
        #expect(!requests.accepts(camera, callEnded: false, isOwner: true))
        #expect(requests.accepts(requests.generation, callEnded: false, isOwner: true))
    }

    @Test func returningOwnershipOrStartingAnotherCallDoesNotReviveOldRequests() {
        var requests = CapturePermissionRequests()
        let oldRequest = requests.generation
        requests.invalidate()
        requests.invalidate()
        #expect(!requests.accepts(oldRequest, callEnded: false, isOwner: true))
    }
}
