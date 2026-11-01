import Foundation
import CoreHaptics
import AVFoundation
final class HandoffFeedback {
let enabled=true
var engine:CHHapticEngine?
var player:(any CHHapticPatternPlayer)?
var soundPlayers=[AVAudioPlayer]()
        func cancel() { try? player?.stop(atTime: CHHapticTimeImmediate); player = nil; soundPlayers.forEach{$0.stop()};soundPlayers=[] }
        func prepare() throws {
            guard enabled, CHHapticEngine.capabilitiesForHardware().supportsHaptics else { return }
            if engine == nil {
                engine = try CHHapticEngine(); engine?.playsHapticsOnly = true
                engine?.resetHandler = { [weak self] in DispatchQueue.main.async { self?.player = nil; try? self?.engine?.start() } }
            }
            try engine?.start()
        }
        func schedule(delay: Double, duration: Double, outgoing: Bool) throws {
            cancel(); try prepare(); guard enabled, let engine else { return }
            let d = min(8, max(1, duration))
            // An authored approximation: a soft start, a swelling ripple and a
            // short arrival tap. Apple's private AirDrop pattern is not used.
            let events: [CHHapticEvent] = [
                CHHapticEvent(eventType: .hapticTransient, parameters: [.init(parameterID: .hapticIntensity, value: 0.35), .init(parameterID: .hapticSharpness, value: 0.25)], relativeTime: outgoing ? 0 : d * 0.28),
                CHHapticEvent(eventType: .hapticContinuous, parameters: [.init(parameterID: .hapticIntensity, value: 0.5), .init(parameterID: .hapticSharpness, value: 0.2)], relativeTime: d * 0.24, duration: d * 0.4),
                CHHapticEvent(eventType: .hapticTransient, parameters: [.init(parameterID: .hapticIntensity, value: outgoing ? 0.25 : 0.65), .init(parameterID: .hapticSharpness, value: 0.45)], relativeTime: d * 0.86)
            ]
            let curve = CHHapticParameterCurve(parameterID: .hapticIntensityControl, controlPoints: [
                .init(relativeTime: 0, value: 0.2), .init(relativeTime: d * 0.2, value: 1), .init(relativeTime: d * 0.4, value: 0.05), .init(relativeTime: d * 0.6, value: 1)
            ], relativeTime: d * 0.24)
            player = try engine.makePlayer(with: CHHapticPattern(events: events, parameterCurves: [curve]))
            try player?.start(atTime: engine.currentTime + min(2, max(0, delay)))
        }
        func scheduleNameDrop(delay:Double,duration:Double) throws {
            for (name,offset) in [("NameDropHintingPrimaryDevice",0.0),("NameDropConnectedPrimaryDevice",duration*0.86)] {
                guard let file=Bundle.main.url(forResource:name,withExtension:"caf") else{throw NSError(domain:"GenitaAudio",code:1,userInfo:[NSLocalizedDescriptionKey:"NameDrop 효과음 파일 없음"])}
                let sound=try AVAudioPlayer(contentsOf:file);sound.volume=0.35;sound.prepareToPlay()
                sound.play(atTime:sound.deviceCurrentTime+max(0,delay)+offset);soundPlayers.append(sound)
            }
        }
}
