import Foundation

/// The six digits typed into P01 while the iPhone's handoff scope is still being verified (#358 review P2s).
enum HandoffPairingInput {
    /// The scope going from "not verified yet" to an account keeps what was typed: it was typed under this sign-in
    /// (logout clears it). An account switch (A → B) or a logout never carries it.
    static func carries(from old: String?, to new: String?) -> Bool { old == nil && new != nil }

    /// A recovered call or a resume looks for the remembered Mac only when no code pairing is open: a code being
    /// joined (or just failed on P01-E) stays the user's choice until they edit it or close the sheet.
    static func mayReconnectRemembered(sheetOpen: Bool, code: String, linkConnected: Bool) -> Bool {
        !linkConnected && !(sheetOpen && code.count == 6)
    }
}
