import Foundation
#if os(macOS)
import CoreAudio
#endif

/// b18 (Chelsea 04:46, MUST-FIX; 411 QA: coreaudiod turned the Mac speaker mute 0→1 at 03:33:14.967, 0.35 s after
/// Genita's mic-off, and every later engine event re-applied it): Genita never leaves the Mac's system output muted.
///
/// Around every voice-processing change (engine build, mic off, stop) the call reads the default output device's mute
/// first; if it was off then and is on shortly after (`checkDelays`), that was our change and is undone, logged as
/// `audio.output_mute_restored`. A mute that was already on, or that the user sets later, is left alone.
enum OutputMuteGuard {
    enum Action: Equatable { case none, restore }
    /// Only our own change is undone: off before our audio change, on after it.
    static func action(before: Bool?, after: Bool?) -> Action { before == false && after == true ? .restore : .none }
    /// coreaudiod applied the mute 0.35 s after the change in the 411 log; looked at once more a little later. Kept
    /// short: a mute the user sets inside this second after one of our audio changes would be taken as ours (Codex r3,
    /// accepted: the change cannot be told apart from coreaudiod's).
    static let checkDelays: [Double] = [0.05, 0.6, 1.0]
}

#if os(macOS)
/// The default output device's mute (kAudioDevicePropertyMute, output scope). Read and set only by OutputMuteGuard.
enum MacOutputMute {
    static func defaultOutputDevice() -> AudioDeviceID? {
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice,
                                                 mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id) == noErr, id != 0 else { return nil }
        return id
    }
    private static func address() -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyMute, mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
    }
    static func muted(_ device: AudioDeviceID) -> Bool? {
        var a = address()
        guard AudioObjectHasProperty(device, &a) else { return nil }
        var value = UInt32(0)
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(device, &a, 0, nil, &size, &value) == noErr else { return nil }
        return value != 0
    }
    @discardableResult static func setMuted(_ device: AudioDeviceID, _ on: Bool) -> Bool {
        var a = address()
        var value = UInt32(on ? 1 : 0)
        return AudioObjectSetPropertyData(device, &a, 0, nil, UInt32(MemoryLayout<UInt32>.size), &value) == noErr
    }
}
#endif
