// ForgeSound — the strike, synthesised.
//
// WHY SYNTHESISED AND NOT A FILE
// ------------------------------
// The same reason the icon is drawn in code: a committed .wav is a binary
// nobody in this repo can tune, and `build.sh` hand-assembles the bundle, so
// every added resource is another thing that can be present under `swift run`
// and missing from the real .app. A struck anvil is also an unusually easy
// sound to synthesise correctly — it is a handful of inharmonic partials with
// different decay rates over a very short noise transient, which is about forty
// lines of arithmetic.
//
// WHAT MAKES IT SOUND LIKE METAL. Two things, and both matter:
//
//   1. THE PARTIALS ARE NOT HARMONIC. A harmonic series (1, 2, 3, 4×) is a
//      string or a pipe — it sounds like a note. Struck metal rings at
//      irrational ratios, which is what the ear hears as "a hard object", and
//      the ratios below are the ones that stop it sounding like a bell.
//   2. THE HIGH PARTIALS DIE FIRST. Real metal loses its top end within
//      milliseconds and keeps the low ring. Decaying every partial at the same
//      rate is the single most common way a synthesised clang sounds fake.
//
// It is deliberately quiet and 700ms long. A launch sound is charm exactly once
// per launch and an annoyance every time after that, which is why it is also a
// preference and why it asks the system whether interface sounds are wanted at
// all.

import AVFoundation
import AppKit

@MainActor
enum ForgeSound {
    /// Held for the life of the process. Building the engine costs more than
    /// playing the buffer, and a launch sound that has to boot an audio engine
    /// first arrives after the animation it was supposed to land with.
    private static var engine: AVAudioEngine?
    private static var player: AVAudioPlayerNode?

    /// Whether the operator wants it. Default on — it was asked for — but this
    /// is the one setting that must be reachable, so `SettingsScene` shows it.
    static var enabled: Bool {
        get { UserDefaults.standard.object(forKey: "launchSound") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "launchSound") }
    }

    /// macOS's own "play user interface sound effects" switch. An app that keeps
    /// making noise after the user turned system UI sounds off is an app that
    /// gets muted at the OS level, which loses the setting we actually wanted.
    private static var systemAllowsUISounds: Bool {
        let d = UserDefaults(suiteName: "com.apple.systemsound")
        return d?.object(forKey: "com.apple.sound.uiaudio.enabled") as? Bool ?? true
    }

    /// `gain` scales the whole blow. The second tap of a pair is quieter, and a
    /// second tap at the same level is what makes two strikes sound like a
    /// stutter rather than like a smith working.
    static func strike(gain: Double = 1.0) {
        guard enabled, systemAllowsUISounds else { return }
        guard let buffer = makeStrike(gain: gain) else { return }

        if engine == nil {
            let e = AVAudioEngine()
            let p = AVAudioPlayerNode()
            e.attach(p)
            e.connect(p, to: e.mainMixerNode, format: buffer.format)
            // `try?` and not `try`: a Mac with no output device, or one where
            // CoreAudio is wedged, must not take the launch animation down with
            // it. A silent launch is a degraded launch; a crashed one is not a
            // launch.
            try? e.start()
            engine = e; player = p
        }
        guard let player, engine?.isRunning == true else { return }
        player.scheduleBuffer(buffer, at: nil, options: .interrupts)
        player.play()
    }

    // MARK: The sound itself

    private static func makeStrike(gain: Double) -> AVAudioPCMBuffer? {
        let rate = 44_100.0
        let seconds = 0.7
        let frames = AVAudioFrameCount(rate * seconds)
        guard let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames),
              let out = buffer.floatChannelData?[0]
        else { return nil }
        buffer.frameLength = frames

        // Inharmonic partials of a struck bar. `decay` is per-partial and rises
        // with frequency — see the file note.
        let partials: [(freq: Double, amp: Double, decay: Double)] = [
            (523,  0.55,  4.0),
            (1_047, 0.42,  6.5),
            (1_523, 0.30,  9.0),
            (2_310, 0.22, 13.0),
            (3_190, 0.14, 18.0),
            (4_720, 0.09, 26.0),
        ]

        var seed: UInt64 = 0x9E3779B97F4A7C15
        for i in 0..<Int(frames) {
            let t = Double(i) / rate
            var sample = 0.0
            for p in partials {
                sample += p.amp * sin(2 * .pi * p.freq * t) * exp(-p.decay * t)
            }
            // The transient: 6ms of noise, which is the sound of contact rather
            // than of ringing. Without it the strike has no impact and reads as
            // a chime that faded in.
            if t < 0.006 {
                seed = seed &* 6364136223846793005 &+ 1442695040888963407
                let n = Double(Int64(bitPattern: seed >> 11)) / Double(1 << 52) - 1
                sample += n * 0.5 * (1 - t / 0.006)
            }
            // Soft clip, then a quiet overall level. Metal peaks hard and this
            // keeps the peak from crackling without flattening the attack.
            sample = tanh(sample * 1.4) * 0.18 * gain
            out[i] = Float(sample)
        }
        return buffer
    }
}
