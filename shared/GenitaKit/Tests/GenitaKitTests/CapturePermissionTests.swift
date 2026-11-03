import Testing
@testable import GenitaKit

struct CapturePermissionTests {
    @Test func permissionPromptInactivityKeepsTheCurrentRequest() {
        var requests = CapturePermissionRequests()
        let generation = requests.generation
        requests.updateActivity(.inactive, callEnded: false, isOwner: true)
        requests.updateActivity(.active, callEnded: false, isOwner: true)
        #expect(requests.accepts(generation, callEnded: false, isOwner: true))
    }

    @Test func actualBackgroundInvalidatesThePromptRequestEvenAfterReturn() {
        var requests = CapturePermissionRequests()
        let generation = requests.generation
        requests.updateActivity(.inactive, callEnded: false, isOwner: true)
        requests.updateActivity(.background, callEnded: false, isOwner: true)
        requests.updateActivity(.active, callEnded: false, isOwner: true)
        #expect(!requests.accepts(generation, callEnded: false, isOwner: true))
    }

    @Test(arguments: [CapturePermissionRequests.Media.microphone, .camera], [true, false])
    func promptAnswerWaitsForActiveAndIsAppliedOnce(media: CapturePermissionRequests.Media, granted: Bool) {
        var requests = CapturePermissionRequests()
        let generation = requests.generation
        requests.updateActivity(.inactive, callEnded: false, isOwner: true)
        #expect(requests.resolve(media, granted: granted, generation: generation, callEnded: false, isOwner: true) == nil)
        let answers = requests.updateActivity(.active, callEnded: false, isOwner: true)
        #expect(answers == [.init(media: media, granted: granted)])
        #expect(requests.updateActivity(.active, callEnded: false, isOwner: true).isEmpty)
    }

    @Test(arguments: [CapturePermissionRequests.Media.microphone, .camera], [true, false])
    func promptAnswerAfterActiveReturnAppliesImmediately(media: CapturePermissionRequests.Media, granted: Bool) {
        var requests = CapturePermissionRequests()
        let generation = requests.generation
        requests.updateActivity(.inactive, callEnded: false, isOwner: true)
        requests.updateActivity(.active, callEnded: false, isOwner: true)
        #expect(requests.resolve(media, granted: granted, generation: generation, callEnded: false, isOwner: true)
                == .init(media: media, granted: granted))
    }

    @Test func backgroundDiscardsDeferredAndLateAnswersForBothMedia() {
        var requests = CapturePermissionRequests()
        let generation = requests.generation
        requests.updateActivity(.inactive, callEnded: false, isOwner: true)
        for media in [CapturePermissionRequests.Media.microphone, .camera] {
            #expect(requests.resolve(media, granted: true, generation: generation, callEnded: false, isOwner: true) == nil)
        }
        requests.updateActivity(.background, callEnded: false, isOwner: true)
        #expect(requests.updateActivity(.active, callEnded: false, isOwner: true).isEmpty)
        for media in [CapturePermissionRequests.Media.microphone, .camera] {
            #expect(requests.resolve(media, granted: true, generation: generation, callEnded: false, isOwner: true) == nil)
        }
    }

    @Test func suspensionOrEndDiscardsDeferredAnswersEvenIfOwnershipReturns() {
        var requests = CapturePermissionRequests()
        let generation = requests.generation
        requests.updateActivity(.inactive, callEnded: false, isOwner: true)
        #expect(requests.resolve(.microphone, granted: true, generation: generation, callEnded: false, isOwner: true) == nil)
        #expect(requests.resolve(.camera, granted: false, generation: generation, callEnded: false, isOwner: true) == nil)
        requests.invalidate()
        #expect(requests.updateActivity(.active, callEnded: false, isOwner: true).isEmpty)
    }

    @Test func activeReturnRechecksCallAndOwnershipBeforeApplyingDeferredAnswers() {
        for context in [(ended: true, owner: true), (ended: false, owner: false)] {
            var requests = CapturePermissionRequests()
            let generation = requests.generation
            requests.updateActivity(.inactive, callEnded: false, isOwner: true)
            #expect(requests.resolve(.microphone, granted: true, generation: generation, callEnded: false, isOwner: true) == nil)
            #expect(requests.resolve(.camera, granted: false, generation: generation, callEnded: false, isOwner: true) == nil)
            #expect(requests.updateActivity(.active, callEnded: context.ended, isOwner: context.owner).isEmpty)
            #expect(requests.updateActivity(.active, callEnded: false, isOwner: true).isEmpty)
            #expect(requests.resolve(.camera, granted: true, generation: generation,
                                     callEnded: context.ended, isOwner: context.owner) == nil)
        }
    }

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
