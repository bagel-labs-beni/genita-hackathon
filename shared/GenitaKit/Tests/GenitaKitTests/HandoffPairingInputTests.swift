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

    /// Chelsea 11/4: the Mac shows its code but the iPhone never offered the code entry. During a call, signed in and in
    /// front, a same-account Mac that is online but not paired opens P01 once; Not now / outside tap keeps it closed.
    @Test func p01OpensByItselfOnceForAnUnpairedMacOnline() {
        func prompt(signedIn: Bool = true, foreground: Bool = true, inCall: Bool = true, macOnline: Bool = true, paired: Bool = false,
                    linkConnected: Bool = false, sheetOpen: Bool = false, prompted: Bool = false) -> Bool {
            HandoffPairingInput.autoPrompt(signedIn: signedIn, foreground: foreground, inCall: inCall, macOnline: macOnline, paired: paired,
                                           linkConnected: linkConnected, sheetOpen: sheetOpen, prompted: prompted)
        }
        #expect(prompt(), "unpaired Mac online during the call: offer the code")
        #expect(!prompt(prompted: true), "once per launch: Not now stays closed")
        #expect(!prompt(paired: true), "a remembered Mac never needs the code")
        #expect(!prompt(linkConnected: true))
        #expect(!prompt(macOnline: false), "no Mac running Genita on this account")
        #expect(!prompt(sheetOpen: true))
        #expect(!prompt(inCall: false), "P01 lives in the call")
        #expect(!prompt(foreground: false))
        #expect(!prompt(signedIn: false))
    }
}
