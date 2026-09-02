// LaunchCurtain — the first second of the app.
//
// WHY AN APP THAT OPENS INSTANTLY GETS AN ANIMATION ANYWAY
// -------------------------------------------------------
// Not to cover a slow launch — the window is up in well under a second, and an
// animation that made the app SLOWER would be the worst possible trade. It is
// there because the first second is the only moment the app gets to say what it
// is before the operator starts working, and Forge was spending it showing an
// empty grey shell. Every app in the category the operator compares this one to
// spends it deliberately.
//
// The animation is the icon's own story: cold metal on the anvil, the coals come
// up, one strike, the metal is hot. It uses `ForgeMark` — the SAME outline the
// .icns is drawn from — so launching the app is literally watching its Dock icon
// being made. A logo animation drawn from a second copy of the shape would come
// apart the first time either was tuned.
//
// THREE RULES IT MUST NOT BREAK
//   1. It never delays anything. The real UI is mounted and live underneath from
//      frame one; this is an overlay that leaves.
//   2. It is skippable. Any click or key ends it immediately — an animation you
//      cannot dismiss stops being charm on the third launch of the day.
//   3. It respects Reduce Motion. With that on, the whole sequence collapses to
//      a short cross-fade: the point is made, nothing moves.

import SwiftUI
import AppKit
import ForgeKit

struct LaunchCurtain: View {
    let onFinished: () -> Void

    /// Heat rising from the coals, behind the mark.
    @State private var bloom: Double = 0
    /// 0 = cold iron, 1 = at temperature. Drives the mark's own gradient.
    @State private var heat: Double = 0
    /// The strike: a single frame of white that decays.
    @State private var flash: Double = 0
    /// When the blow landed. The sparks are driven from this and a clock, not
    /// from an animated `Double`.
    ///
    /// `Canvas` DOES NOT PARTICIPATE IN IMPLICIT ANIMATION. It redraws when the
    /// state it reads actually changes — not on the frames SwiftUI interpolates
    /// in between — so a `withAnimation { sparkProgress = 1 }` drew exactly two
    /// frames: the start and the end, both invisible. This is the same reason
    /// `ForgeBackground`'s embers are a `TimelineView`, and it cost a build to
    /// re-learn.
    @State private var strikeAt: Date?
    /// The swing, 0 = raised, 1 = landed. Drives rotation and nothing else, so
    /// the hammer's own geometry never changes shape mid-swing.
    @State private var swing: Double = 0
    /// The trail. Two values that lag `swing` by a few frames; the gap between
    /// them and it is what the ghosts are drawn from, so a still hammer has none.
    @State private var ghostNear: Double = 0
    @State private var ghostFar: Double = 0
    /// How far the anvil is driven down by the blow, in points. Metal struck by
    /// metal does not sit still — without this the hammer passes through a prop,
    /// which is most of why the first cut read as raw.
    @State private var recoil: Double = 0
    /// The whole scene's jolt on contact, in points.
    @State private var shake: Double = 0
    /// The shock ring leaving the contact point, 0…1.
    @State private var ring: Double = 0
    /// Embers drifting up off the face after the blow, 0…1.
    @State private var embers: Double = 0
    /// How hot the STRUCK SPOT is, 0…1. Separate from `heat`, which tints the
    /// whole silhouette: metal does not warm evenly, it is incandescent where it
    /// was hit and dark two inches away, and that contrast is the entire reason
    /// a glow reads as heat instead of as a colour.
    @State private var strikeGlow: Double = 0
    /// The exit — the mark grows a touch and the curtain goes.
    @State private var exiting = false
    @State private var finished = false

    /// Deterministic, like the sparks and for the same reason.
    private static let driftSeeds: [(x: Double, size: Double, speed: Double, phase: Double)] = [
        (-0.16, 1.8, 0.90, 0.4), (-0.06, 1.3, 1.00, 2.1), (0.03, 2.1, 0.78, 3.6),
        ( 0.12, 1.5, 0.94, 1.2), ( 0.19, 1.2, 0.70, 5.0), (-0.23, 1.6, 0.85, 2.8),
    ]

    /// Where the blow lands, in the curtain's unit square. The anvil's top bar
    /// sits at ~0.29 of the height and Mjölnir comes down on its centre; every
    /// layer that has to agree about "here" reads this rather than repeating the
    /// numbers, which is how the sparks and the hot spot stopped disagreeing.
    private static let contact = UnitPoint(x: 0.50, y: 0.288)

    private var reduceMotion: Bool {
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    }

    var body: some View {
        ZStack {
            Color.forgeGround.ignoresSafeArea()

            ZStack {
                coals
                shockRing
                emberDrift
                mark
                hammer
                // In front of everything but the flash: sparks come off the
                // strike toward the viewer, and behind the anvil most of them
                // were never visible at all.
                sparkSpray
                flashLayer
            }
            .frame(width: 168, height: 168)
            // The jolt, applied to the whole group so the coals and sparks move
            // with the anvil — shaking only the mark would read as the logo
            // wobbling rather than as the bench taking a hit.
            .offset(x: shake * 0.6, y: shake)
            .scaleEffect(exiting ? 1.14 : 1.0)
            .opacity(exiting ? 0 : 1)
        }
        .opacity(finished ? 0 : 1)
        .allowsHitTesting(!finished)
        .contentShape(Rectangle())
        .onTapGesture { skip() }
        // A zero-size button is the only way to catch a bare key press in a
        // SwiftUI overlay that owns no focusable control. `.escape` and `.return`
        // cover the two keys someone actually presses at a splash screen.
        .background {
            Group {
                Button("") { skip() }.keyboardShortcut(.cancelAction)
                Button("") { skip() }.keyboardShortcut(.defaultAction)
            }
            .opacity(0)
        }
        .task { await run() }
    }

    // MARK: Layers

    /// The forge's light. Sits behind and below the mark, because that is where
    /// coals are — the same offset the .icns uses.
    private var coals: some View {
        RadialGradient(
            colors: [Color.tone(.ember).opacity(0.34 * bloom),
                     Color.tone(.ember).opacity(0.13 * bloom),
                     .clear],
            center: UnitPoint(x: 0.5, y: 0.66),
            startRadius: 2, endRadius: 120 * (0.5 + bloom * 0.6))
        .blur(radius: 8)
    }

    private var mark: some View {
        GeometryReader { geo in
            let rect = CGRect(origin: .zero, size: geo.size).insetBy(dx: 26, dy: 26)
            Path.forgeAnvil(fitting: rect)
                .fill(
                    LinearGradient(
                        colors: [
                            // Cold iron → hot iron. Interpolating the COLOURS
                            // rather than cross-fading two shapes is what keeps
                            // the silhouette perfectly still while it heats.
                            // Cool steel, warming only a little. The old values
                            // took the whole anvil to ember, which left nothing
                            // dark for the struck spot to be bright against.
                            blend(.init(white: 0.26), Color(red: 0.42, green: 0.20, blue: 0.10), heat),
                            blend(.init(white: 0.38), Color(red: 0.55, green: 0.28, blue: 0.13), heat),
                        ],
                        startPoint: .bottom, endPoint: .top)
                )
                .shadow(color: Color.tone(.ember).opacity(0.75 * heat),
                        radius: 22 * heat)
                // Driven down and squashed a hair. The squash is 3% over ~120ms:
                // more reads as rubber, less and the eye never registers that
                // anything was struck at all.
                .overlay {
                    // Incandescence, local to the blow and clipped to the metal.
                    //
                    // Three stops and not two: steel at temperature goes white
                    // at the core, amber around it and deep red at the edge of
                    // the heat-affected zone. A single orange stop is what makes
                    // a glow look like a sticker of a glow.
                    RadialGradient(
                        colors: [.white.opacity(0.95 * strikeGlow),
                                 Color.tone(.amber).opacity(0.85 * strikeGlow),
                                 Color.tone(.ember).opacity(0.55 * strikeGlow),
                                 Color(red: 0.55, green: 0.06, blue: 0.0)
                                     .opacity(0.35 * strikeGlow),
                                 .clear],
                        center: LaunchCurtain.contact,
                        startRadius: 1,
                        endRadius: geo.size.width * (0.16 + 0.20 * strikeGlow))
                    .blendMode(.plusLighter)
                    .clipShape(Path.forgeAnvil(fitting: rect))
                }
                .offset(y: recoil)
                .scaleEffect(x: 1 + recoil * 0.012, y: 1 - recoil * 0.03,
                             anchor: .bottom)
        }
    }

    /// The shock leaving the contact point.
    ///
    /// A ring and not just a brighter flash: a flash says "bright", a ring says
    /// "something happened HERE and it travelled". It is also the cue that
    /// survives being watched at a glance, which a 90ms flash does not.
    private var shockRing: some View {
        GeometryReader { geo in
            Circle()
                .strokeBorder(Color.tone(.amber).opacity((1 - ring) * 0.55),
                              lineWidth: max(0.5, 3 * (1 - ring)))
                .frame(width: 24 + 150 * ring, height: 24 + 150 * ring)
                .position(x: geo.size.width * 0.5, y: geo.size.height * 0.42)
                .opacity(ring > 0 && ring < 1 ? 1 : 0)
        }
        .allowsHitTesting(false)
    }

    /// Embers lifting off the hot face once the sparks are gone.
    ///
    /// Slower, fewer and dimmer than the sparks on purpose: sparks are the
    /// impact and embers are the aftermath. Same speed for both would read as
    /// one long spray instead of two events.
    private var emberDrift: some View {
        GeometryReader { geo in
            ForEach(Array(Self.driftSeeds.enumerated()), id: \.offset) { _, d in
                Circle()
                    .fill(Color.tone(.ember))
                    .frame(width: d.size, height: d.size)
                    .position(x: geo.size.width * (0.5 + d.x) + sin(embers * 6 + d.phase) * 7,
                              y: geo.size.height * 0.46 - 90 * embers * d.speed)
                    .opacity(embers > 0 ? max(0, (1 - embers) * 0.8) : 0)
                    .blur(radius: 0.4)
            }
        }
        .allowsHitTesting(false)
    }

    /// Mjölnir, coming down.
    ///
    /// WHY IT TRANSLATES AND DOES NOT ONLY ROTATE
    /// -----------------------------------------
    /// The first cut rotated the tool about the butt of a long handle. With a
    /// long shaft that is nearly right; with Mjölnir's stub of a grip it is
    /// hopeless, because rotating about a point 10pt from the head moves the
    /// head almost nowhere — so the animation read as a hammer dangling from the
    /// ceiling and twitching, not as a blow.
    ///
    /// A real strike is an ARM: the tool travels down and left while tipping
    /// forward. So the swing drives both a rotation and an offset, and the
    /// offset's vertical term is curved while its horizontal term is linear,
    /// which is what bends the path into an arc instead of a diagonal slide.
    private var hammer: some View {
        GeometryReader { geo in
            let side = geo.size.width * 0.60
            let box = CGRect(x: 0, y: 0, width: side, height: side)

            ZStack {
                ghost(box: box, side: side, at: ghostFar,  alpha: 0.42)
                ghost(box: box, side: side, at: ghostNear, alpha: 0.62)
                placed(tool(box: box, side: side), at: swing, side: side)
            }
            .frame(width: side, height: side)
            // Where the blow lands: the head's face on the anvil's top bar.
            .position(x: geo.size.width * 0.50, y: geo.size.height * 0.055)
            .opacity(swing > 0 ? 1 : 0)
        }
        .allowsHitTesting(false)
    }

    /// Puts the tool at its position for a given swing value.
    ///
    /// Rotation about the GRIP and not the centre: a tool tipped about its
    /// middle pivots around a point in mid-air, and the head and the pommel
    /// swap places instead of the head leading.
    private func placed<V: View>(_ view: V, at p: Double, side: CGFloat) -> some View {
        let lift = 1 - p
        return view
            .rotationEffect(.degrees(-44 * lift),
                            anchor: UnitPoint(x: ForgeMark.hammerGrip.x,
                                              y: 1 - ForgeMark.hammerGrip.y))
            .offset(x: side * 0.62 * lift,
                    // Curved: most of the height is lost early in the fall, so
                    // the head sweeps in along an arc rather than sliding down a
                    // straight line.
                    y: -side * 0.86 * lift * (0.55 + 0.45 * lift))
    }

    /// One lagging copy, for the trail.
    @ViewBuilder private func ghost(box: CGRect, side: CGFloat,
                                    at p: Double, alpha: Double) -> some View {
        placed(tool(box: box, side: side), at: p, side: side)
            .opacity(max(0, swing - p) * alpha)
    }

    /// The tool itself, unplaced.
    ///
    /// DEPTH COMES FROM TWO GRADIENTS CROSSED, not from one. A vertical fill
    /// alone is a card lit from above; the horizontal pass — dark at both edges,
    /// bright through the middle — is what tells the eye the block has sides
    /// that turn away from it. That single crossed pass is most of the volume,
    /// and it was the thing missing every time this looked flat.
    private func tool(box: CGRect, side: CGFloat) -> some View {
        let head = Path.forgeHammerHead(fitting: box)
        let grip = Path.forgeHammerHandle(fitting: box)

        return ZStack {
            // ── Grip ─────────────────────────────────────────────────────────
            grip
                .fill(LinearGradient(
                    colors: [Color(red: 0.30, green: 0.21, blue: 0.14),
                             Color(red: 0.50, green: 0.36, blue: 0.23),
                             Color(red: 0.24, green: 0.16, blue: 0.10)],
                    startPoint: .leading, endPoint: .trailing))
                .overlay {
                    // Leather wrap: bands across the grip, not along it.
                    LinearGradient(
                        colors: [.black.opacity(0.32), .clear, .black.opacity(0.28),
                                 .clear, .black.opacity(0.32), .clear],
                        startPoint: .top, endPoint: .bottom)
                    .clipShape(grip)
                }
                .overlay { grip.stroke(Color.black.opacity(0.55), lineWidth: 0.9) }

            // ── Head ─────────────────────────────────────────────────────────
            head
                .fill(LinearGradient(
                    colors: [Color(white: 0.80), Color(white: 0.46), Color(white: 0.20)],
                    startPoint: .top, endPoint: .bottom))
                // The crossed pass: the sides turning away.
                .overlay {
                    LinearGradient(
                        colors: [.black.opacity(0.55), .clear, .white.opacity(0.14),
                                 .clear, .black.opacity(0.60)],
                        startPoint: .leading, endPoint: .trailing)
                    .clipShape(head)
                }
                // Forged, not machined.
                .overlay {
                    if let cg = ForgeBackground.noise {
                        Image(decorative: cg, scale: 1)
                            .resizable(resizingMode: .tile)
                            .opacity(0.11)
                            .blendMode(.overlay)
                            .clipShape(head)
                    }
                }
                // The top plane, catching the light.
                .overlay {
                    LinearGradient(colors: [.white.opacity(0.5), .clear],
                                   startPoint: .top, endPoint: .bottom)
                    .frame(height: side * 0.07)
                    .frame(maxHeight: .infinity, alignment: .top)
                    .clipShape(head)
                }
                // The collar where the grip enters — the joint, stated. Without
                // it the head and the grip are two shapes that happen to touch.
                .overlay {
                    Rectangle()
                        .fill(Color.black.opacity(0.34))
                        .frame(width: side * 0.26, height: side * 0.030)
                        .offset(y: -side * 0.205)
                        .clipShape(head)
                }
                // Two incised bands. Norse, and structurally useful: a horizontal
                // line across a block is the cheapest way to say it has a front
                // face that is being seen straight on.
                .overlay {
                    VStack(spacing: side * 0.035) {
                        band(width: side * 0.62)
                        band(width: side * 0.62)
                    }
                    .offset(y: -side * 0.10)
                    .clipShape(head)
                }
                // The struck face, in shadow, with the coals under it.
                .overlay {
                    LinearGradient(colors: [.clear, .black.opacity(0.6)],
                                   startPoint: .top, endPoint: .bottom)
                    .frame(height: side * 0.10)
                    .frame(maxHeight: .infinity, alignment: .bottom)
                    .clipShape(head)
                }
                .overlay {
                    LinearGradient(
                        colors: [.clear, Color.tone(.ember).opacity(0.45 + 0.45 * heat)],
                        startPoint: .top, endPoint: .bottom)
                    .frame(height: side * 0.030)
                    .frame(maxHeight: .infinity, alignment: .bottom)
                    .blendMode(.plusLighter)
                    .clipShape(head)
                }
                .overlay { head.stroke(Color.black.opacity(0.6), lineWidth: 1) }
                .shadow(color: Color.tone(.ember).opacity(0.55 * heat), radius: 9)
        }
        .shadow(color: .black.opacity(0.55), radius: 7, y: 5)
    }

    /// One incised band across the head: a dark groove with a lit lower lip,
    /// which is what an engraved line looks like when the light is above.
    private func band(width: CGFloat) -> some View {
        VStack(spacing: 0) {
            Rectangle().fill(Color.black.opacity(0.34)).frame(height: 1.2)
            Rectangle().fill(Color.white.opacity(0.16)).frame(height: 0.8)
        }
        .frame(width: width)
    }

    /// Sparks off the blow.
    ///
    /// THREE THINGS THE FIRST VERSION GOT WRONG, and they are the three things
    /// that separate sparks from confetti:
    ///
    ///   1. THEY WERE BEHIND THE ANVIL. Sparks come off the strike toward the
    ///      viewer; drawn under the mark, most of them never appeared at all.
    ///      This layer now sits in front of both the anvil and the hammer.
    ///   2. THEY WERE DOTS. A spark is a hot particle moving fast enough that
    ///      the eye integrates it into a STREAK. Drawing a line along the
    ///      direction of travel — longer while it is fast, shrinking as it
    ///      slows — is most of the read, and it costs the same as a circle.
    ///   3. THEY ALL FLEW THE SAME. Real sparks off an anvil go mostly sideways
    ///      and slightly up, in a fan, at wildly different speeds, and they
    ///      COOL: white at the face, amber a moment later, dull red as they die.
    ///
    /// A `Canvas`, because this is 34 particles at 60fps and 34 SwiftUI shapes
    /// would be 34 nodes to diff on every frame of the most timing-sensitive
    /// moment in the app.
    private var sparkSpray: some View {
        TimelineView(.animation) { tl in
            Canvas { ctx, size in
            guard let strikeAt else { return }
            let p = tl.date.timeIntervalSince(strikeAt) / 0.85
            guard p > 0, p < 1 else { return }
            let origin = CGPoint(x: size.width * LaunchCurtain.contact.x,
                                 y: size.height * LaunchCurtain.contact.y)

            for s in LaunchCurtain.sparks {
                // Each spark has its own lifetime, so the spray thins out
                // instead of vanishing all at once.
                let life = min(1, p / s.life)
                guard life < 1 else { continue }

                let rad = s.angle * .pi / 180
                let dist = size.width * 0.60 * s.speed * life
                // Gravity: quadratic in life, so they arc over and fall rather
                // than flying straight forever.
                let drop = 78 * life * life * s.mass
                let x = origin.x + cos(rad) * dist
                let y = origin.y - sin(rad) * dist + drop

                // The streak trails BACK along the path travelled.
                let len = s.size * 5.5 * (1 - life) + 1.2
                let bx = x - cos(rad) * len
                let by = y + sin(rad) * len - drop * 0.25

                // Cooling: white → amber → red.
                let colour: Color = life < 0.25
                    ? .white
                    : (life < 0.6 ? Color.tone(.amber) : Color.tone(.ember))
                let alpha = (1 - life) * (1 - life) * 0.95

                var path = Path()
                path.move(to: CGPoint(x: bx, y: by))
                path.addLine(to: CGPoint(x: x, y: y))
                ctx.stroke(path,
                           with: .color(colour.opacity(alpha)),
                           style: StrokeStyle(lineWidth: s.size, lineCap: .round))
            }
            }
        }
        .blendMode(.plusLighter)
        .allowsHitTesting(false)
    }

    /// Deterministic, and shaped like a real spray: a fan biased sideways and
    /// slightly up, because that is where metal goes when a flat face hits it.
    /// Hand-checked so no two share an angle closely enough to look paired.
    private static let sparks: [(angle: Double, speed: Double, size: Double,
                                 mass: Double, life: Double)] = [
        (  8, 0.95, 1.7, 1.00, 0.72), ( 22, 0.78, 1.2, 0.80, 0.55),
        ( 34, 1.00, 2.0, 1.15, 0.85), ( 47, 0.62, 1.0, 0.70, 0.48),
        ( 58, 0.88, 1.5, 0.95, 0.66), ( 71, 0.70, 1.1, 0.75, 0.52),
        ( 86, 0.55, 0.9, 0.60, 0.44), (100, 0.74, 1.3, 0.85, 0.60),
        (114, 0.92, 1.8, 1.05, 0.78), (127, 0.66, 1.1, 0.72, 0.50),
        (141, 0.84, 1.4, 0.90, 0.63), (154, 1.00, 2.1, 1.20, 0.88),
        (168, 0.72, 1.2, 0.78, 0.54), (176, 0.90, 1.6, 1.00, 0.70),
        ( -6, 0.86, 1.5, 0.95, 0.68), (-19, 0.64, 1.0, 0.70, 0.46),
        (-31, 0.98, 1.9, 1.10, 0.82), (188, 0.68, 1.1, 0.74, 0.51),
        (196, 0.94, 1.7, 1.02, 0.74), (205, 0.58, 0.9, 0.62, 0.42),
        ( 15, 0.52, 0.8, 0.55, 0.38), ( 63, 0.50, 0.8, 0.52, 0.36),
        (108, 0.54, 0.9, 0.58, 0.40), (148, 0.48, 0.8, 0.50, 0.35),
        ( 40, 1.10, 1.3, 1.30, 0.92), (135, 1.08, 1.2, 1.28, 0.90),
        ( 92, 1.05, 1.1, 1.35, 0.95), ( 76, 0.60, 1.0, 0.66, 0.45),
        (160, 0.76, 1.2, 0.82, 0.57), ( 28, 0.68, 1.1, 0.73, 0.49),
        (120, 0.80, 1.3, 0.88, 0.62), ( 52, 0.96, 1.6, 1.04, 0.76),
        (182, 0.56, 0.9, 0.60, 0.41), (  0, 0.88, 1.4, 0.92, 0.64),
    ]

    /// The flash of contact.
    ///
    /// Tight and short. The first version was a 90pt white disc at 0.9 centred
    /// on the whole scene, which is not a flash — it is a floodlight, and it
    /// erased the two things the blow is actually for: the sparks and the
    /// incandescent spot on the anvil. A strike blows out a small area for a
    /// few frames; everything beyond that stays dark, and the contrast is what
    /// sells it.
    private var flashLayer: some View {
        GeometryReader { geo in
            RadialGradient(
                colors: [.white.opacity(flash), Color.tone(.amber).opacity(flash * 0.5), .clear],
                center: LaunchCurtain.contact,
                startRadius: 0,
                endRadius: geo.size.width * 0.20)
            .blendMode(.plusLighter)
        }
        .allowsHitTesting(false)
    }

    // MARK: Sequence

    private func run() async {
        guard !reduceMotion else {
            // Reduce Motion: the mark is stated, hot, and gone. No travel.
            heat = 1; bloom = 0.7
            swing = 1; ghostNear = 1; ghostFar = 1
            strikeGlow = 0.6
            ForgeSound.strike()
            try? await Task.sleep(for: .milliseconds(420))
            finish(animated: true)
            return
        }

        // ── Anticipation ─────────────────────────────────────────────────────
        // The coals catch and the tool comes UP. The first cut skipped this: the
        // hammer simply appeared already raised and then fell, which is why the
        // blow read as a cut rather than as a movement. A fast action is only
        // read as fast if something slow happened first.
        withAnimation(.easeOut(duration: 0.42)) { bloom = 1 }
        withAnimation(.easeOut(duration: 0.26)) {
            swing = 0.001; ghostNear = 0.001; ghostFar = 0.001
        }
        try? await Task.sleep(for: .milliseconds(290))
        guard !finished else { return }

        // ── The hold ─────────────────────────────────────────────────────────
        // 90ms of nothing at the top of the arc. This is the cheapest frame in
        // the whole sequence and the one that makes the fall land: stillness
        // before a fast move is what the eye measures the move against.
        try? await Task.sleep(for: .milliseconds(90))
        guard !finished else { return }

        // ── The fall ─────────────────────────────────────────────────────────
        // 230ms and not 160. The old timing crossed 58° in about six frames,
        // which no easing can smooth — there were not enough frames to ease. The
        // curve stays hard into contact (a hammer accelerates all the way down)
        // but now has the duration for that acceleration to be visible.
        //
        // The ghosts run the same curve a few milliseconds behind, so the trail
        // is the tool's own past positions rather than a smear drawn over it.
        let fall = Animation.timingCurve(0.42, 0, 0.98, 0.32, duration: 0.23)
        withAnimation(fall) { swing = 1 }
        withAnimation(fall.delay(0.028)) { ghostNear = 1 }
        withAnimation(fall.delay(0.056)) { ghostFar = 1 }
        try? await Task.sleep(for: .milliseconds(228))
        guard !finished else { return }

        // ── Contact ──────────────────────────────────────────────────────────
        // The sound goes here and nowhere else: a clang that plays before the
        // head lands is worse than no clang, because the ear notices the
        // mismatch even when the eye does not.
        ForgeSound.strike()

        // Everything that happens AT the moment of impact, in one frame. Flash
        // and heat land together; the flash decays four times faster, which is
        // what makes it read as an impact rather than as a fade.
        withAnimation(.easeOut(duration: 0.06)) {
            flash = 0.62; shake = 3.2; recoil = 5; strikeGlow = 1
        }
        withAnimation(.easeOut(duration: 0.30)) { heat = 1 }
        // Sparks run longer than the flash and shorter than the glow: the
        // impact is instant, the spray is a beat, the metal stays hot. Started
        // by stamping the clock, not by animating a value — see `strikeAt`.
        strikeAt = Date()
        withAnimation(.easeOut(duration: 0.55)) { ring = 1 }

        // The settle. A spring and not an ease: an anvil driven down returns
        // past its rest position and back, and that overshoot is the difference
        // between "it moved" and "it was hit".
        try? await Task.sleep(for: .milliseconds(60))
        withAnimation(.spring(response: 0.26, dampingFraction: 0.42)) {
            recoil = 0; shake = 0
        }
        withAnimation(.easeIn(duration: 0.17)) { flash = 0 }
        // The metal cools long after everything else has stopped moving — which
        // is the point of a separate value: heat is the slowest thing in the
        // scene and the last thing to leave it.
        withAnimation(.easeOut(duration: 1.5)) { strikeGlow = 0.22 }
        // The bounce, then the settle. Metal does not absorb a hammer, it throws
        // it back — and then the arm brings it down again, which is why this is
        // two moves and not one. A hammer that springs up and freezes there is
        // the pose nobody's arm holds.
        withAnimation(.easeOut(duration: 0.20)) {
            swing = 0.66; ghostNear = 0.66; ghostFar = 0.66
        }
        try? await Task.sleep(for: .milliseconds(200))
        guard !finished else { return }
        withAnimation(.easeInOut(duration: 0.42)) {
            swing = 0.80; ghostNear = 0.80; ghostFar = 0.80
        }

        // ONE BLOW. A second tap was here and it was wrong: at launch the
        // operator is waiting to use the app, and the difference between one
        // strike and two is 320ms of watching a logo. The rhythm reads as craft
        // in a demo and as a delay in a tool.
        withAnimation(.easeOut(duration: 0.9)) { embers = 1 }

        try? await Task.sleep(for: .milliseconds(430))
        guard !finished else { return }
        finish(animated: true)
    }

    private func skip() {
        guard !finished else { return }
        finish(animated: true)
    }

    private func finish(animated: Bool) {
        finished = true
        withAnimation(.easeIn(duration: animated ? 0.28 : 0)) { exiting = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + (animated ? 0.30 : 0)) {
            onFinished()
        }
    }

    /// Linear blend in sRGB. Good enough for two greys turning orange, and it
    /// avoids dragging a colour-space dependency into a splash screen.
    private func blend(_ a: Color, _ b: Color, _ t: Double) -> Color {
        let ca = NSColor(a).usingColorSpace(.sRGB) ?? .gray
        let cb = NSColor(b).usingColorSpace(.sRGB) ?? .orange
        let k = max(0, min(1, t))
        return Color(nsColor: NSColor(
            srgbRed: ca.redComponent   + (cb.redComponent   - ca.redComponent)   * k,
            green:   ca.greenComponent + (cb.greenComponent - ca.greenComponent) * k,
            blue:    ca.blueComponent  + (cb.blueComponent  - ca.blueComponent)  * k,
            alpha: 1))
    }
}

// MARK: - The mark as a SwiftUI path

extension Path {
    /// `ForgeMark.anvil` fitted into `rect`, with y flipped.
    ///
    /// The flip is the whole reason this is a function and not a literal:
    /// `ForgeMark` is stated in AppKit's bottom-left origin (it is drawn into a
    /// bitmap for the .icns), and `Path` is top-left. Doing the subtraction at
    /// each call site is how the launch animation ends up with an upside-down
    /// anvil that nobody notices because an upside-down anvil still looks like
    /// an anvil.
    /// Both parts of the hammer are fitted against the WHOLE tool's bounds, so
    /// they stay assembled. `fit(_:in:)` would otherwise centre each part in the
    /// rect on its own and take the tool apart.
    static func forgeHammerHead(fitting rect: CGRect) -> Path {
        fit(ForgeMark.hammerHead, in: rect, bounds: ForgeMark.hammer)
    }

    static func forgeHammerHandle(fitting rect: CGRect) -> Path {
        fit(ForgeMark.hammerHandle, in: rect, bounds: ForgeMark.hammer)
    }

    static func forgeAnvil(fitting rect: CGRect) -> Path {
        fit(ForgeMark.anvil, in: rect)
    }

    /// Fits a normalised outline into `rect`, flipping y.
    ///
    /// Shared by both marks because the flip is the part that is easy to get
    /// wrong once and then copy: `ForgeMark` is stated in AppKit's bottom-left
    /// origin (it is drawn into a bitmap for the .icns) and `Path` is top-left.
    private static func fit(_ points: [(x: Double, y: Double)], in rect: CGRect,
                            bounds: [(x: Double, y: Double)]? = nil) -> Path {
        let frame = bounds ?? points
        let xs = frame.map { CGFloat($0.x) }
        let ys = frame.map { CGFloat($0.y) }
        let minX = xs.min()!, maxX = xs.max()!
        let minY = ys.min()!, maxY = ys.max()!

        let scale = min(rect.width / (maxX - minX), rect.height / (maxY - minY))
        let w = (maxX - minX) * scale
        let h = (maxY - minY) * scale
        let ox = rect.midX - w / 2
        let oy = rect.midY - h / 2

        var p = Path()
        for (i, pt) in points.enumerated() {
            let point = CGPoint(x: ox + (CGFloat(pt.x) - minX) * scale,
                                y: oy + h - (CGFloat(pt.y) - minY) * scale)
            if i == 0 { p.move(to: point) } else { p.addLine(to: point) }
        }
        p.closeSubpath()
        return p
    }
}
