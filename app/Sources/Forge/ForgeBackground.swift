// ForgeBackground — the room the app happens in.
//
// The ground was a flat fill. Flat is what makes a dark UI read as a rectangle
// of #0D0E12 rather than as a space: there is no gradient for the eye to place
// depth against, and no texture, so every large empty area looks like an
// unfinished screen instead of a quiet one.
//
// Four layers, and each one is doing a specific job:
//
//   GROUND    the base fill, unchanged.
//   COALS     a wide, weak ember bloom anchored LOW. This is the app's whole
//             thesis in one gradient: a forge is a dark room lit from the fire,
//             so the light comes from below and it is warm. It is also why the
//             bloom is off-centre and enormous — a small centred glow reads as
//             a spotlight on the content, which is a different, cheaper effect.
//   GRAIN     tiled noise at ~4% alpha. The layer nobody notices and everybody
//             feels: without it a dark gradient bands visibly on an 8-bit
//             display, and with it the same gradient reads as a surface.
//   VIGNETTE  darkening at the corners, so the content sits in the middle of a
//             room rather than on a poster.
//
// Everything here is static. No timers, no per-frame work, and the grain is
// generated once per process — a background that costs frames is a background
// that gets deleted the first time a terminal feels slow.

import SwiftUI
import AppKit
import ForgeKit

struct ForgeBackground: View {
    /// Turns the coals up. The home is the screen with nothing on it, so it can
    /// carry more light than one behind a terminal.
    var intensity: Double = 1.0
    /// Whether the fire is alive. Off behind the board and the terminals, where
    /// anything moving in the background competes with what an agent is
    /// printing — and loses, because the operator turns it off.
    var embers: Bool = true

    var body: some View {
        ZStack {
            Color.forgeGround

            GeometryReader { geo in
                let w = geo.size.width, h = geo.size.height

                // Coals: below the fold, wider than the window.
                RadialGradient(
                    colors: [Color.tone(.ember).opacity(0.13 * intensity),
                             Color.tone(.ember).opacity(0.05 * intensity),
                             .clear],
                    center: UnitPoint(x: 0.5, y: 1.06),
                    startRadius: 0,
                    endRadius: max(w, h) * 0.95)

                // A second, cooler source high on the opposite side. One light
                // is flat; two lights at different temperatures is what gives a
                // surface a front and a back. Kept far weaker than the coals so
                // it never competes for the "where is the heat" read.
                RadialGradient(
                    colors: [Color.tone(.indigo).opacity(0.07 * intensity), .clear],
                    center: UnitPoint(x: 0.88, y: -0.05),
                    startRadius: 0,
                    endRadius: max(w, h) * 0.7)
            }
            .allowsHitTesting(false)

            if embers { emberField }
            grain
            vignette
        }
        .ignoresSafeArea()
    }

    /// Embers rising off the coals, forever.
    ///
    /// This is the layer the gradient could not supply. A static gradient tells
    /// you the room is lit; something MOVING in it tells you the fire is still
    /// going, and a screen with nothing on it stops reading as empty the moment
    /// one thing in it is alive.
    ///
    /// One `Canvas` and not N views: twenty-eight `Circle`s in a `ZStack` is
    /// twenty-eight nodes SwiftUI diffs on every tick, and this runs behind a
    /// terminal. A Canvas is one node and one draw.
    ///
    /// 24fps, not 60. Embers drift; nobody can tell, and behind a live PTY the
    /// difference is real CPU.
    private var emberField: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 24.0, paused: false)) { tl in
            Canvas { ctx, size in
                let t = tl.date.timeIntervalSinceReferenceDate
                for e in ForgeBackground.emberSeeds {
                    // Each ember runs its own loop, offset by phase, so they
                    // never restart together — a synchronised field reads as a
                    // repeating animation instead of as a fire.
                    let cycle = (t / e.life + e.phase).truncatingRemainder(dividingBy: 1)
                    let y = size.height * (1.02 - cycle * e.rise)
                    let x = size.width * e.x + sin(cycle * 6.2 + e.phase * 9) * e.sway
                    // Born dim, brightest early, gone by the top. A linear fade
                    // makes them look like they are being deleted.
                    let a = sin(cycle * .pi) * e.alpha
                    guard a > 0.01 else { continue }
                    ctx.fill(
                        Path(ellipseIn: CGRect(x: x, y: y, width: e.size, height: e.size)),
                        with: .color(Color.tone(.ember).opacity(a * intensity)))
                }
            }
            .blur(radius: 0.6)
        }
        .allowsHitTesting(false)
    }

    /// Deterministic, and tuned so no two share a lane or a period.
    private static let emberSeeds: [(x: Double, size: Double, life: Double,
                                     rise: Double, sway: Double, alpha: Double,
                                     phase: Double)] = {
        var out: [(Double, Double, Double, Double, Double, Double, Double)] = []
        var seed: UInt64 = 0xC0FFEE_BADCAFE
        func rnd() -> Double {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return Double((seed >> 33) & 0xFFFF) / Double(0xFFFF)
        }
        for _ in 0..<26 {
            out.append((
                x: rnd(),
                size: 1.0 + rnd() * 1.8,
                life: 9 + rnd() * 14,          // seconds to cross
                rise: 0.45 + rnd() * 0.55,     // how far up it gets
                sway: 6 + rnd() * 16,
                alpha: 0.10 + rnd() * 0.22,
                phase: rnd()
            ))
        }
        return out
    }()

    @ViewBuilder private var grain: some View {
        if let cg = ForgeBackground.noise {
            Image(decorative: cg, scale: 1)
                .resizable(resizingMode: .tile)
                .opacity(0.035)
                .blendMode(.plusLighter)
                .allowsHitTesting(false)
        }
    }

    private var vignette: some View {
        RadialGradient(
            colors: [.clear, .clear, .black.opacity(0.30)],
            center: .center, startRadius: 120, endRadius: 900)
        .allowsHitTesting(false)
    }

    // MARK: The grain

    /// A 128×128 tile of white noise in the alpha channel, built once.
    ///
    /// DETERMINISTIC, by a hand-rolled LCG rather than `SystemRandomNumberGenerator`.
    /// Nobody can see the difference between two noise fields, but a texture
    /// that is regenerated per launch is one more thing that can differ between
    /// two screenshots of the same build — and this repo already pays that price
    /// on purpose for the launch sparks and the logo.
    ///
    /// 128 and not 64: at 64 the tile repeat becomes visible as a faint grid on
    /// a large empty screen, which is worse than no grain at all.
    static let noise: CGImage? = {
        let side = 128
        var bytes = [UInt8](repeating: 0, count: side * side * 4)
        var seed: UInt64 = 0x5F3759DF
        for i in stride(from: 0, to: bytes.count, by: 4) {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            let v = UInt8((seed >> 33) & 0xFF)
            bytes[i] = 255; bytes[i + 1] = 255; bytes[i + 2] = 255
            bytes[i + 3] = v
        }
        guard let provider = CGDataProvider(data: Data(bytes) as CFData) else { return nil }
        return CGImage(width: side, height: side,
                       bitsPerComponent: 8, bitsPerPixel: 32,
                       bytesPerRow: side * 4,
                       space: CGColorSpaceCreateDeviceRGB(),
                       bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
                       provider: provider, decode: nil,
                       shouldInterpolate: false, intent: .defaultIntent)
    }()
}
