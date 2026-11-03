import Testing
@testable import GenitaKit

/// #358 review P2s: the first /me and a call reconnect must not wipe or replace a code pairing in progress.
@Suite struct HandoffPairingInputTests {
    @Test func onlyTheFirstVerifiedScopeCarriesTheTypedCode() {
        #expect(HandoffPairingInput.carries(from: nil, to: "account-a"), "/me verified this sign-in: keep P01's digits")
        #expect(!HandoffPairingInput.carries(from: "account-a", to: "account-b"), "an account switch never carries input")
        #expect(!HandoffPairingInput.carries(from: "account-a", to: nil), "logout drops it")
        #expect(!HandoffPairingInput.carries(from: nil, to: nil))
    }

    @Test func aCodePairingInProgressIsNotReplacedByTheRememberedMac() {
        #expect(!HandoffPairingInput.mayReconnectRemembered(sheetOpen: true, code: "482918", linkConnected: false),
                "P01 open with six digits: the call reconnect keeps joining that Mac")
        #expect(HandoffPairingInput.mayReconnectRemembered(sheetOpen: true, code: "482", linkConnected: false), "half a code is not a pairing")
        #expect(HandoffPairingInput.mayReconnectRemembered(sheetOpen: false, code: "", linkConnected: false), "no sheet: look for the remembered Mac")
        #expect(!HandoffPairingInput.mayReconnectRemembered(sheetOpen: false, code: "", linkConnected: true), "already connected")
    }
}
