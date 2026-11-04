// Opened at login, no window: a proximity live move still opens the call window (CEO 11/4, "징" with Genita not open).
// Built by check.sh with the Mac app's sources (like watch-shots/render.sh). No sockets: GENITA_MAC_REVIEW_OUT keeps
// MacHandoff off the network; the server's messages are fed to the presence link as if they came from the socket.
import AppKit
import Foundation

@main struct HiddenMoveCheck {
    nonisolated(unsafe) static var failures = 0
    static func check(_ ok: Bool, _ name: String) {
        print(ok ? "ok   " : "FAIL ", name)
        if !ok { failures += 1 }
    }
    static func pump(_ seconds: Double = 0.5) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }

    @MainActor static func main() {
        setenv("GENITA_MAC_REVIEW_OUT", NSTemporaryDirectory(), 1) // no presence/link sockets, inert login item
        setenv("GENITA_LAUNCHED_AT_LOGIN", "1", 1)
        setenv("GENITA_PRESENCE_FADE", "0", 1) // the call window pops in; the check reads its state, not the slide
        let app = NSApplication.shared
        _ = app.setActivationPolicy(.regular)

        // 1. Launched at login: the home window SwiftUI creates at launch is put away, also when it shows up late.
        check(MacLoginLaunch.wasLaunchedAtLogin(event: nil), "launch reads as a login launch")
        let home = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 320), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        home.identifier = NSUserInterfaceItemIdentifier(MacHomeWindow.id)
        home.isReleasedWhenClosed = false
        home.orderFrontRegardless()
        pump(0.2)
        check(MacHomeWindow.isVisible, "precondition: the home window is up")
        MacHomeWindow.startHidden()
        pump(0.2)
        check(!MacHomeWindow.isVisible, "login launch: the home window is hidden")
        home.orderFrontRegardless() // SwiftUI putting it up after didFinishLaunching
        MacHomeWindow.hideIfStarting()
        check(!MacHomeWindow.isVisible, "login launch: a late first appearance is hidden too")
        check(MacHomeWindow.hidingAtLogin, "the login hide holds until the user opens the window (no time limit)")

        // 2. Signed in (the /me path calls setAccount), conversation on the iPhone.
        let handoff = MacHandoff.shared
        handoff.setAccount("hidden-check-\(UUID().uuidString)")
        pump(0.3)
        let server = handoff.server
        server.reviewReceive(["type": "ownership", "owner": "iphone", "epoch": 1, "trigger": "start"])
        pump(0.2)
        check(!handoff.ownership.isOwner && !handoff.companionVisible, "the conversation is on the iPhone, no call window")

        // 3. Control: a synced claim (connect-time copy) for this Mac only offers Continue here — it never opens the call.
        server.reviewReceive(["type": "ownership", "owner": "mac", "epoch": 2, "trigger": "sync"])
        pump(0.3)
        check(handoff.resumeOffered && !handoff.companionVisible, "control: a synced claim offers Continue here, no call window")
        server.reviewReceive(["type": "ownership", "owner": "iphone", "epoch": 3, "trigger": "button"])
        pump(0.3)
        check(!handoff.ownership.isOwner && !handoff.companionVisible, "back on the iPhone")

        // 4. The iPhone is brought close: the server moves the conversation here (trigger proximity).
        server.reviewReceive(["type": "proximity.result", "accepted": true, "reason": "ok", "requestId": "r1", "token": "t"])
        server.reviewReceive(["type": "ownership", "owner": "mac", "epoch": 4, "trigger": "proximity"])
        pump(0.6)
        check(handoff.ownership.isOwner, "proximity move: this Mac owns the conversation")
        check(!handoff.resumeOffered, "proximity move: no Continue here step")
        check(handoff.companionVisible, "proximity move: the call is shown")
        check(handoff.reviewCallWindow?.isVisible == true, "proximity move: the call window is on screen")
        check(!MacHomeWindow.isVisible, "proximity move: the home window stays hidden (the call window opens on its own)")

        check(handoff.status == "Conversation on this Mac", "b18: the status line follows the owner (was 'on your iPhone')")

        // 4b. b18 ("징" like the interaction demo): with a picture, a proximity arrival plays the incoming DUO wipe.
        handoff.profile = NSImage(size: NSSize(width: 8, height: 8), flipped: false) { r in NSColor.gray.setFill(); r.fill(); return true }.tiffRepresentation
        let played = handoff.playProximityArrival()
        check(played == !MacPresenceFade.reduceMotion, "b18: a proximity arrival starts the wipe (Reduce Motion: the fade)")
        if played { check(handoff.motion?.outgoing == false, "b18: the Mac plays the incoming half") }
        check(!handoff.playProximityArrival(), "b18: one effect at a time")
        handoff.motion = nil

        // 4c. b18 (Chelsea 04:10): End call on the Mac panel ends the call here, keeps the app and the conversation.
        handoff.endCallHere()
        pump(0.2)
        check(!handoff.companionVisible && handoff.reviewCallWindow?.isVisible != true, "b18: End call puts the call window away")
        check(handoff.ownership.isOwner && handoff.resumeOffered, "b18: the conversation stays here; the home offers Continue here")
        check(!MacCall.shared.call.micOn && MacCall.shared.call.link == .idle, "b18: End call: mic off, no session")
        handoff.resumeHere()
        pump(0.3)
        check(handoff.companionVisible, "b18: Continue here opens the call again")

        // 4d. b18 (411 QA: the Mac's speaker went muted after a mic-off): the Mac never sets the VP input mute.
        check(!CallAudio.mutesVoiceProcessingInput, "b18: no voice-processing input mute on the Mac")

        // 5. The user opens Genita (Dock icon / reopen): the home window comes back and is never hidden again.
        MacHomeWindow.show()
        pump(0.2)
        check(MacHomeWindow.isVisible && !MacHomeWindow.hidingAtLogin, "opening Genita brings the home window back")
        MacHomeWindow.hideIfStarting()
        check(MacHomeWindow.isVisible, "after the user opened it, it is never hidden again")

        print(failures == 0 ? "hidden launch live move: all passed" : "hidden launch live move: \(failures) failed")
        exit(failures == 0 ? 0 : 1)
    }
}
