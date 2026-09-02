// TerminalPalette — the 16 ANSI colours, in the app's own tones.
//
// Its own file because it is the one place that must import SwiftTerm, and
// SwiftTerm exports a `Color` of its own: importing it into `Design.swift`
// makes every bare `Color` in the palette ambiguous. Splitting is cheaper than
// spelling `SwiftUI.Color` at forty call sites.

import AppKit
import SwiftTerm

// MARK: - The terminal's own palette

/// The 16 ANSI colours, derived from the same tones the chrome uses.
///
/// This is the largest surface in the app by a wide margin and it was running
/// SwiftTerm's stock palette — a set tuned for a white Terminal.app in 2009.
/// Sharing the tones is not decoration: an operator reading a diff in the
/// terminal and a phase chip in the rail is reading ONE app only if the green
/// in both is the same green.
enum ForgeTerminalPalette {
    private static func c(_ r: Int, _ g: Int, _ b: Int) -> SwiftTerm.Color {
        // SwiftTerm stores 16-bit channels; 8-bit values are widened by 257 so
        // 0xFF maps to 0xFFFF exactly rather than to 0xFF00.
        SwiftTerm.Color(red: UInt16(r * 257), green: UInt16(g * 257), blue: UInt16(b * 257))
    }

    /// Index order is the ANSI one: 0-7 normal, 8-15 bright.
    static let ansi: [SwiftTerm.Color] = [
        c(0x1A, 0x1D, 0x24),  // black
        c(0xFB, 0x71, 0x85),  // red      — tone.rose
        c(0x4A, 0xDE, 0x80),  // green    — tone.mint
        c(0xF0, 0xB8, 0x49),  // yellow   — tone.amber
        c(0x81, 0x8C, 0xF8),  // blue     — tone.indigo
        c(0xA7, 0x8B, 0xFA),  // magenta  — tone.violet
        c(0x2D, 0xD4, 0xBF),  // cyan     — tone.teal
        c(0xC7, 0xCB, 0xD4),  // white
        c(0x3A, 0x40, 0x4E),  // bright black
        c(0xFF, 0x97, 0xA6),  // bright red
        c(0x7E, 0xE9, 0xA5),  // bright green
        c(0xFF, 0xD2, 0x7A),  // bright yellow
        c(0xA5, 0xAE, 0xFF),  // bright blue
        c(0xC4, 0xB0, 0xFF),  // bright magenta
        c(0x6E, 0xE7, 0xDA),  // bright cyan
        c(0xF2, 0xF4, 0xF8),  // bright white
    ]

    /// The terminal's own ground, one step darker than `forgeRaised` so the
    /// pane's edge is visible where a terminal meets its chrome.
    static let background = NSColor(srgbRed: 0.043, green: 0.047, blue: 0.063, alpha: 1)
    static let foreground = NSColor(srgbRed: 0.816, green: 0.831, blue: 0.867, alpha: 1)
}
