// Design — the palette made drawable, and the surfaces built from it.
//
// The rules this file changes are the ones written at the top of `Views.swift`,
// and they are changed on purpose rather than drifted away from:
//
//   RULE 1 WAS  "One accent colour. … colouring everything is the same as
//               colouring nothing."
//   NOW         One accent colour FOR ATTENTION. Orange still means, and only
//               means, "this wants you". Phase gets its own scale because a
//               phase is not an alert — it is an identity, and rendering six
//               identities as the same grey is throwing away the one thing this
//               app knows that a terminal does not.
//
//   RULE 3 WAS  "Native materials so it reads as a Mac app rather than a web
//               page."
//   NOW         Native BEHAVIOUR, deliberate SURFACES. `.regularMaterial` on
//               `.background` is not a design decision, it is the absence of
//               one: it is what an app looks like before anyone chose. Maestri
//               is also a native Mac app and shares no pixel with this one.
//
// Rules 2 (hierarchy from type and whitespace) and 4 (big numbers only where a
// decision hangs on them) are untouched and still hold.
//
// The tokens themselves live in `ForgeKit.Palette` and are decided there. This
// file is the mapping and nothing else — if you find yourself deciding WHICH
// tone something gets here, it belongs one target down.

import SwiftUI
import AppKit
import ForgeKit

// MARK: - Ground

extension Color {
    /// Builds a colour that answers to the system appearance.
    ///
    /// `NSColor(name:dynamicProvider:)` and not two static values chosen by a
    /// `@Environment(\.colorScheme)` read: the dynamic provider is re-evaluated
    /// by AppKit on every appearance change, including inside an `NSView` that
    /// SwiftUI does not re-render (the terminal is exactly that view), which is
    /// the case a colorScheme read gets wrong.
    fileprivate static func dyn(_ name: String,
                                dark: (Double, Double, Double),
                                light: (Double, Double, Double)) -> Color {
        Color(nsColor: NSColor(name: NSColor.Name(name)) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            let c = isDark ? dark : light
            return NSColor(srgbRed: c.0, green: c.1, blue: c.2, alpha: 1)
        })
    }

    /// The window floor. Slightly blue-black rather than neutral grey: a true
    /// grey ground is what makes the warm accent read as dirty instead of hot.
    static let forgeGround = dyn("forgeGround",
                                 dark: (0.051, 0.055, 0.071),
                                 light: (0.961, 0.965, 0.973))

    /// Furniture — rails, strips, headers.
    static let forgePanel = dyn("forgePanel",
                                dark: (0.078, 0.086, 0.110),
                                light: (1.000, 1.000, 1.000))

    /// Cards and panes: the things you look at rather than through.
    static let forgeRaised = dyn("forgeRaised",
                                 dark: (0.098, 0.110, 0.141),
                                 light: (1.000, 1.000, 1.000))

    /// Hairline between surfaces. Carried as a colour and not as `.quaternary`
    /// so panel and pane agree at every level — `.quaternary` resolves against
    /// whatever is behind it, which is how two adjacent cards end up with two
    /// different edges.
    static let forgeEdge = dyn("forgeEdge",
                               dark: (0.298, 0.325, 0.396),
                               light: (0.780, 0.796, 0.827))

    /// The single accent, unchanged in value and in meaning (`ForgeTone.ember`).
    /// Kept under its old name because 75 call sites use it and renaming them
    /// would be a diff nobody could review.
    static let accentOrange = Color(red: 1.0, green: 0.58, blue: 0.13)

    /// A tone, resolved for the current appearance.
    static func tone(_ t: ForgeTone) -> Color {
        switch t {
        case .ember:  return dyn("toneEmber",  dark: (1.000, 0.580, 0.130), light: (0.839, 0.416, 0.020))
        case .amber:  return dyn("toneAmber",  dark: (0.941, 0.722, 0.286), light: (0.706, 0.482, 0.055))
        case .violet: return dyn("toneViolet", dark: (0.655, 0.545, 0.980), light: (0.482, 0.318, 0.878))
        case .teal:   return dyn("toneTeal",   dark: (0.176, 0.831, 0.749), light: (0.055, 0.514, 0.475))
        case .indigo: return dyn("toneIndigo", dark: (0.506, 0.549, 0.973), light: (0.310, 0.337, 0.812))
        case .rose:   return dyn("toneRose",   dark: (0.984, 0.443, 0.522), light: (0.808, 0.153, 0.290))
        case .mint:   return dyn("toneMint",   dark: (0.290, 0.871, 0.502), light: (0.086, 0.545, 0.294))
        case .slate:  return dyn("toneSlate",  dark: (0.580, 0.639, 0.722), light: (0.392, 0.443, 0.518))
        }
    }
}

// MARK: - Surfaces

/// Gives a view the app's idea of a surface: a fill with a gradient shallow
/// enough to read as light rather than as a gradient, a hairline edge, a top
/// inner highlight, and the shadow its level earns.
///
/// The top highlight is the part that does the work. A flat fill with a stroke
/// reads as a rectangle; one pixel of light along the top edge reads as an
/// object with a lit side, and that single line is most of the distance between
/// "functional" and "designed".
struct ForgeSurface: ViewModifier {
    let level: SurfaceLevel
    var tint: ForgeTone?
    var tintStrength: Double = 0.14

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: level.cornerRadius, style: .continuous)
        content
            .background {
                shape.fill(
                    LinearGradient(
                        colors: [base.opacity(1), base.opacity(0.92)],
                        startPoint: .top, endPoint: .bottom)
                )
                // The tint wash. Deliberately weak: it says "this pane belongs
                // to the execute phase", not "this pane is amber".
                if let tint {
                    shape.fill(Color.tone(tint).opacity(tintStrength * 0.18))
                }
            }
            .overlay {
                shape.strokeBorder(
                    LinearGradient(
                        colors: [Color.white.opacity(highlight), edgeColor],
                        startPoint: .top, endPoint: .bottom),
                    lineWidth: 1)
            }
            .shadow(color: .black.opacity(level.shadowOpacity),
                    radius: level.shadowRadius, y: level.shadowRadius / 2.5)
    }

    private var base: Color {
        switch level {
        case .ground:   return .forgeGround
        case .panel:    return .forgePanel
        case .raised, .floating: return .forgeRaised
        }
    }

    private var edgeColor: Color {
        if let tint { return Color.tone(tint).opacity(0.22) }
        return Color.forgeEdge.opacity(0.22)
    }

    private var highlight: Double {
        switch level {
        case .ground:   return 0
        case .panel:    return 0.04
        case .raised:   return 0.07
        case .floating: return 0.10
        }
    }
}

extension View {
    func forgeSurface(_ level: SurfaceLevel,
                      tint: ForgeTone? = nil,
                      tintStrength: Double = 0.14) -> some View {
        modifier(ForgeSurface(level: level, tint: tint, tintStrength: tintStrength))
    }
}

// MARK: - Signs of life

/// A dot that breathes while the thing it stands for is working.
///
/// Motion is the cheapest honest signal an app has: a static green dot says
/// "this session exists", a breathing one says "something is happening in it
/// right now", and the operator learns the difference without being told. It
/// stops dead when `alive` is false — an idle process pretending to pulse would
/// be worse than no animation, because it is the animation people trust.
struct PulseDot: View {
    let tone: ForgeTone
    var alive: Bool = true
    var size: Double = 7

    @State private var phase = false

    var body: some View {
        ZStack {
            if alive {
                Circle()
                    .fill(Color.tone(tone).opacity(0.34))
                    .frame(width: size * 2.4, height: size * 2.4)
                    .scaleEffect(phase ? 1.0 : 0.45)
                    .opacity(phase ? 0 : 0.9)
            }
            Circle()
                .fill(Color.tone(alive ? tone : .slate))
                .frame(width: size, height: size)
        }
        .frame(width: size * 2.4, height: size * 2.4)
        .onAppear {
            guard alive else { return }
            withAnimation(.easeOut(duration: 1.9).repeatForever(autoreverses: false)) {
                phase = true
            }
        }
        .animation(.easeInOut(duration: 0.25), value: alive)
    }
}

// MARK: - Domain chips

/// What kind of work is happening, in one glyph and one word.
struct PhaseChip: View {
    let phase: ForgePhase
    var compact = false

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: phase.symbol)
                .font(.system(size: compact ? 8 : 9, weight: .semibold))
            if !compact {
                Text(phase.label)
                    .font(.system(size: 10, weight: .medium))
            }
        }
        .foregroundStyle(Color.tone(phase.tone))
        .padding(.horizontal, compact ? 5 : 7)
        .padding(.vertical, compact ? 2.5 : 3)
        .background(Color.tone(phase.tone).opacity(0.14), in: Capsule())
        .overlay(Capsule().strokeBorder(Color.tone(phase.tone).opacity(0.28), lineWidth: 0.5))
        .help(phase.label)
    }
}

/// Which engine is holding the pen. A tag and not a hue — see the note at the
/// top of `Palette.swift` on why these two dimensions are encoded differently.
struct EngineTag: View {
    let engine: ForgeEngine

    var body: some View {
        Text(engine.tag)
            .font(.system(size: 9, weight: .bold, design: .monospaced))
            .foregroundStyle(Color.forgeEdge)
            .padding(.horizontal, 4).padding(.vertical, 1.5)
            .background(Color.forgeEdge.opacity(0.14), in: RoundedRectangle(cornerRadius: 3))
            .help(engine.label)
    }
}

// MARK: - The mark, as AppKit needs it

extension NSImage {
    /// The anvil as a TEMPLATE image, for the menu-bar item.
    ///
    /// Template and not a coloured render: AppKit then uses the alpha channel
    /// only, so the mark takes the menu bar's own tone and follows light/dark
    /// without a second asset. Same discipline `BrandMark` already holds for the
    /// vendored marks, and the same reason.
    ///
    /// It replaces `bolt.fill`. A bolt is not what this app is called and not
    /// what it does — and on a menu bar with three other bolts in it, it was not
    /// even findable.
    static func forgeAnvilTemplate(size: CGFloat = 16) -> NSImage {
        let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            let xs = ForgeMark.anvil.map { CGFloat($0.x) }
            let ys = ForgeMark.anvil.map { CGFloat($0.y) }
            let minX = xs.min()!, maxX = xs.max()!
            let minY = ys.min()!, maxY = ys.max()!

            // Inset by a point: a menu-bar glyph that touches its own bounds
            // sits visually larger than every Apple item beside it.
            let box = rect.insetBy(dx: 0.5, dy: 1.5)
            let scale = min(box.width / (maxX - minX), box.height / (maxY - minY))
            let w = (maxX - minX) * scale, h = (maxY - minY) * scale
            let ox = box.midX - w / 2, oy = box.midY - h / 2

            let p = NSBezierPath()
            for (i, pt) in ForgeMark.anvil.enumerated() {
                let point = NSPoint(x: ox + (CGFloat(pt.x) - minX) * scale,
                                    y: oy + (CGFloat(pt.y) - minY) * scale)
                if i == 0 { p.move(to: point) } else { p.line(to: point) }
            }
            p.close()
            NSColor.black.setFill()
            p.fill()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Forge"
        return image
    }
}

// MARK: - Type

/// The app's type scale.
///
/// Before this there were fifteen distinct `.system(size:)` values scattered
/// across the views — 9, 10, 10.5, 11, 12, 13, 15, 22 — chosen one call site at
/// a time. That is what makes a UI read as assembled rather than designed: not
/// any single wrong size, but the absence of a rhythm between them.
///
/// Six roles, and a screen should need no more. If something does not fit one,
/// the answer is almost always that it is playing a role the screen already has
/// — not that the scale is short a step.
enum ForgeType {
    /// The one line a screen is about. At most one per screen.
    static let display = Font.system(size: 24, weight: .semibold)
    /// Section headings and card titles.
    static let title = Font.system(size: 15, weight: .semibold)
    /// Running text and list rows — the default, and what most things are.
    static let body = Font.system(size: 13)
    /// Controls and chips: short, and read at a glance rather than read.
    static let label = Font.system(size: 11, weight: .medium)
    /// Supporting text under something else.
    static let caption = Font.system(size: 10)
    /// Uppercased rail marks and tags. Semibold because at 9pt regular
    /// disappears against a dark ground.
    static let micro = Font.system(size: 9, weight: .semibold)

    /// Identifiers — run ids, models, paths. Monospaced because they are read
    /// character by character and compared, not scanned.
    static let mono = Font.system(size: 11, design: .monospaced)
    static let monoSmall = Font.system(size: 9, design: .monospaced)
}
