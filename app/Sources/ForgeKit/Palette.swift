// Palette — the app's visual vocabulary, as data.
//
// WHY THIS FILE EXISTS AT ALL
// ---------------------------
// A census of the app before this file was written:
//
//     75 × Color.accentOrange
//     19 × Color.secondary
//     14 × Color.green
//      7 × Color.orange
//      3 × Color.accentColor
//
// Six colours in ~27k lines, and 75 of the ~118 uses are the same orange. That
// is not restraint, it is an app with no visual identity — and it was decided
// on purpose, by rule 1 at the top of `Views.swift`: "One accent colour …
// colouring everything is the same as colouring nothing."
//
// The rule is right about ALERTING and was over-applied to EVERYTHING. Orange
// answering "does this want me?" is a good rule and stays. But the app also
// knows things no other tool on this machine knows — which engine ran a unit,
// which phase a run is in, which agent is holding the pen — and it rendered
// every one of them as grey text. Encoding those is not decoration: it is the
// difference between reading a run and decoding it.
//
// TWO DIMENSIONS, TWO ENCODINGS. Phase gets COLOUR, engine gets a MARK/TAG.
// Encoding both as colour is what the old rule was actually warning against:
// two colour scales in one row compete, and the reader ends up decoding a
// legend instead of glancing. Attention stays a third thing — `ember`, and
// only ember — so "is anything orange?" survives untouched.
//
// TOKENS, NOT COLOURS. Same split `ItemTint` already established: ForgeKit
// carries no `import SwiftUI`, so the RULE ("which tone does `execute` get")
// is decided and assertable here, and `Design.swift` does nothing but map a
// token to a concrete `Color`. A palette expressed as `Color` would be
// verifiable only by looking at a screen.

import Foundation

// MARK: - Tones

/// The hues the app is allowed to draw. A closed set on purpose: a palette
/// anyone can extend at a call site is how six colours became a hundred in
/// every app that ever tried this.
///
/// `ember` is load-bearing and reserved. It is the "this wants you" tone —
/// gates, pending questions, the focused pane — and nothing that merely
/// EXISTS may use it. `amber` is its deliberate near-neighbour for the
/// `execute` phase, which is the one phase where time and money are burning:
/// the two read as one family at a glance and separate on a look, which is the
/// intended relationship. The declared cost of that near-collision: on a
/// screen showing both, an operator must read the shape (chip vs ring) and not
/// only the hue. That is why phase always ships with a glyph.
public enum ForgeTone: String, CaseIterable, Hashable {
    case ember      // attention — reserved
    case amber      // execute
    case violet     // discuss
    case teal       // research
    case indigo     // plan
    case rose       // review
    case mint       // complete
    case slate      // memory, and anything structural
}

// MARK: - Phase

/// What kind of work a unit is. Derived from the worker string the engines
/// already write (`Run.worker`, `MetricsEvent.unit`), so this adds a reading
/// of existing data rather than a new field anyone has to remember to emit.
public enum ForgePhase: String, CaseIterable, Hashable {
    case discuss
    case research
    case plan
    case execute
    case review
    case complete
    case memory
    case unknown

    /// Parses `"execute-task/T03"`, `"execute-task"` or `"plan-slice"`.
    ///
    /// Prefix matching and not a table of every unit id: the unit vocabulary
    /// grows additively (`plan-milestone` arrived after `plan-slice`, and a
    /// future `discuss-task` would too), and a table is the shape that silently
    /// returns `.unknown` for the new one. Matching the verb is the part that
    /// is actually stable.
    public init(unit: String?) {
        guard let unit, !unit.isEmpty else { self = .unknown; return }
        let verb = unit.split(separator: "/").first.map(String.init) ?? unit
        let head = verb.split(separator: "-").first.map(String.init) ?? verb
        switch head.lowercased() {
        case "discuss":  self = .discuss
        case "research": self = .research
        case "plan":     self = .plan
        case "execute":  self = .execute
        case "review":   self = .review
        case "complete": self = .complete
        case "memory":   self = .memory
        default:         self = .unknown
        }
    }

    public var tone: ForgeTone {
        switch self {
        case .discuss:  return .violet
        case .research: return .teal
        case .plan:     return .indigo
        case .execute:  return .amber
        case .review:   return .rose
        case .complete: return .mint
        case .memory:   return .slate
        case .unknown:  return .slate
        }
    }

    /// SF Symbol. Chosen so the SHAPE alone separates the phases for someone
    /// who cannot rely on colour — the same accessibility floor `ItemStatus`
    /// already holds itself to, and the reason the amber/ember near-collision
    /// is affordable.
    public var symbol: String {
        switch self {
        case .discuss:  return "bubble.left.and.bubble.right"
        case .research: return "magnifyingglass"
        case .plan:     return "list.bullet.rectangle"
        case .execute:  return "hammer"
        case .review:   return "checklist"
        case .complete: return "flag.pattern.checkered"
        case .memory:   return "brain"
        case .unknown:  return "circle.dotted"
        }
    }

    /// pt-BR, because it is read on screen.
    public var label: String {
        switch self {
        case .discuss:  return "discussão"
        case .research: return "pesquisa"
        case .plan:     return "plano"
        case .execute:  return "execução"
        case .review:   return "review"
        case .complete: return "fecho"
        case .memory:   return "memória"
        case .unknown:  return "—"
        }
    }

    /// Where the phase sits in a run's life, for anything that draws a ramp.
    /// `memory` and `unknown` are off-spine (they happen beside the sequence,
    /// not inside it) and report `nil` rather than a fake position.
    public var spineOrder: Int? {
        switch self {
        case .discuss:  return 0
        case .research: return 1
        case .plan:     return 2
        case .execute:  return 3
        case .review:   return 4
        case .complete: return 5
        case .memory, .unknown: return nil
        }
    }
}

// MARK: - Engine

/// Which LLM engine executed a unit. Encoded as a TAG, never as a hue — see
/// the file-top note on two dimensions, two encodings.
public enum ForgeEngine: String, CaseIterable, Hashable {
    case claude
    case codex
    case agy
    case unknown

    public init(_ raw: String?) {
        switch raw?.lowercased() {
        case "claude": self = .claude
        case "codex":  self = .codex
        case "agy":    self = .agy
        default:       self = .unknown
        }
    }

    /// Two characters, monospaced. Short enough to sit in a pane header that is
    /// already carrying a project name and an account, and unambiguous across
    /// the three engines that exist — which a truncated word is not.
    public var tag: String {
        switch self {
        case .claude:  return "CL"
        case .codex:   return "CX"
        case .agy:     return "AG"
        case .unknown: return "··"
        }
    }

    public var label: String {
        switch self {
        case .claude:  return "Claude"
        case .codex:   return "Codex"
        case .agy:     return "Agy"
        case .unknown: return "engine não declarado"
        }
    }
}

// MARK: - Surface levels

/// How far a surface sits off the app's ground.
///
/// Named levels rather than per-call-site numbers because depth only reads as
/// depth when it is CONSISTENT: three cards at three invented elevations read
/// as three mistakes, and that is what "material fill and no stroke" (rule 2)
/// was avoiding by having no depth at all.
public enum SurfaceLevel: Int, CaseIterable, Hashable {
    /// The window's floor. Nothing sits behind it.
    case ground = 0
    /// Panels, rails, tab strips — the furniture.
    case panel = 1
    /// Cards and panes: the things you look AT.
    case raised = 2
    /// Sheets, floating composers, popovers: the things over everything.
    case floating = 3

    /// Shadow radius in points. `ground` casts nothing — a floor with a shadow
    /// is the tell of a design that applied depth by find-and-replace.
    public var shadowRadius: Double {
        switch self {
        case .ground:   return 0
        case .panel:    return 0
        case .raised:   return 10
        case .floating: return 26
        }
    }

    public var shadowOpacity: Double {
        switch self {
        case .ground, .panel: return 0
        case .raised:         return 0.28
        case .floating:       return 0.45
        }
    }

    public var cornerRadius: Double {
        switch self {
        case .ground:   return 0
        case .panel:    return 8
        case .raised:   return 10
        case .floating: return 16
        }
    }
}
