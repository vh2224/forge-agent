// Changelog — parsing CHANGELOG.md into something renderable.
//
// The file is the release notes: `## <version> — <headline>` with `### Added /
// Changed / Fixed / Documentation` beneath, entries as markdown bullets that
// may wrap over several lines. Rendering it in the app beats sending people to
// a raw file, and beats a summary the app would have to keep in sync.
//
// Version comparison is semantic, not lexicographic: "v2.11.0" is newer than
// "v2.9.0", which a string compare gets backwards — and that comparison decides
// whether the app tells you to update.

import Foundation

public struct Release: Identifiable, Hashable {
    public let version: String        // "v2.11.0" or "Unreleased"
    public let headline: String?
    public let sections: [ReleaseSection]

    public var id: String { version }
    public var isUnreleased: Bool { version.lowercased().contains("unreleased") }

    public var entryCount: Int { sections.reduce(0) { $0 + $1.entries.count } }
}

public extension String {
    /// Split "**Lead.** rest of the entry" into its two halves. These notes are
    /// written that way consistently, and the lead is the part worth reading
    /// first in a long list.
    var changelogLead: (lead: String, rest: String)? {
        guard hasPrefix("**"), let close = range(of: "**", range: index(startIndex, offsetBy: 2)..<endIndex)
        else { return nil }
        let lead = String(self[index(startIndex, offsetBy: 2)..<close.lowerBound])
        let rest = String(self[close.upperBound...]).trimmingCharacters(in: .whitespaces)
        guard !lead.isEmpty else { return nil }
        return (lead, rest)
    }
}

public struct ReleaseSection: Identifiable, Hashable {
    public let kind: Kind
    public let entries: [String]

    public var id: String { kind.key }

    /// The kind of a section — and, for any heading this app does not model,
    /// THE HEADING ITSELF rather than a bucket.
    ///
    /// `.other` used to be a plain case whose `rawValue` was "Outros", and
    /// `ReleaseSection.id` is that string, so every unmodelled heading produced
    /// the SAME id. `Breaking`, `Notes`, `Not shipped`, `Known, not fixed` and
    /// `Architecture (…)` are all real headings in this repo's file, and a
    /// release carrying two of them handed `ForEach` two identical ids —
    /// undefined behaviour in SwiftUI, and silent. It is exactly the defect D36
    /// exists against, one level down: D36 guards release ids, nothing guarded
    /// section ids, and eight releases in the file were in that state.
    ///
    /// Carrying the text fixes both halves with one change. The id becomes the
    /// heading — unique, measured at 0 repeats within a release across the
    /// file's 83 sections — and the label stops rendering 17 distinct headings
    /// as "OUTROS", which threw away the only thing each heading said.
    public enum Kind: Hashable, Sendable {
        case added
        case changed
        case fixed
        case removed
        case documentation
        case security
        case other(String)

        private static let known: [String: Kind] = [
            "Added": .added,
            "Changed": .changed,
            "Fixed": .fixed,
            "Removed": .removed,
            "Documentation": .documentation,
            "Security": .security,
        ]

        public static func from(_ raw: String) -> Kind {
            let trimmed = raw.trimmingCharacters(in: .whitespaces)
            if let k = known[trimmed] { return k }
            // An empty `### ` heading keeps the old bucket rather than an empty
            // id: degenerate input should degrade to the previous behaviour,
            // not to a section that renders as a blank label.
            return .other(trimmed.isEmpty ? "Outros" : trimmed)
        }

        /// Structural identity: stable, English, never displayed. `label` is the
        /// display string and is translated — keying a `ForEach` on it would
        /// make a row's identity depend on the UI language.
        public var key: String {
            switch self {
            case .added:              return "Added"
            case .changed:            return "Changed"
            case .fixed:              return "Fixed"
            case .removed:            return "Removed"
            case .documentation:      return "Documentation"
            case .security:           return "Security"
            case .other(let heading): return heading
            }
        }

        public var label: String {
            switch self {
            case .added:         return "Novidades"
            case .changed:       return "Mudanças"
            case .fixed:         return "Correções"
            case .removed:       return "Removido"
            case .documentation: return "Documentação"
            case .security:      return "Segurança"
            case .other(let heading):
                // The view uppercases this into a caption, and two headings in
                // this file run to 85 characters (`Architecture (M004 decisions
                // … — see …)`). Cut at the first parenthetical or dash, the same
                // separator the release heading itself is split on. Identity is
                // unaffected: `key` keeps the whole heading.
                let cuts = [" (", " — ", " - "].compactMap { heading.range(of: $0)?.lowerBound }
                guard let first = cuts.min() else { return heading }
                let head = String(heading[..<first]).trimmingCharacters(in: .whitespaces)
                return head.isEmpty ? heading : head
            }
        }

        public var icon: String {
            switch self {
            case .added:         return "sparkles"
            case .changed:       return "arrow.triangle.2.circlepath"
            case .fixed:         return "wrench.adjustable"
            case .removed:       return "minus.circle"
            case .documentation: return "book"
            case .security:      return "lock.shield"
            case .other:         return "circle"
            }
        }
    }
}

public enum ChangelogParser {

    public static func parse(_ text: String) -> [Release] {
        var releases: [Release] = []
        var version: String?
        var headline: String?
        var sections: [ReleaseSection] = []
        var sectionKind: ReleaseSection.Kind?
        var entries: [String] = []
        var buffer: [String] = []

        func flushEntry() {
            let joined = buffer.joined(separator: " ")
                .trimmingCharacters(in: .whitespaces)
            if !joined.isEmpty { entries.append(normalise(joined)) }
            buffer = []
        }

        func flushSection() {
            flushEntry()
            if let k = sectionKind, !entries.isEmpty {
                sections.append(ReleaseSection(kind: k, entries: entries))
            }
            entries = []
            sectionKind = nil
        }

        func flushRelease() {
            flushSection()
            if let v = version {
                releases.append(Release(version: v, headline: headline, sections: sections))
            }
            sections = []
            headline = nil
            version = nil
        }

        for raw in text.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)

            if line.hasPrefix("## ") {
                flushRelease()
                let body = String(line.dropFirst(3))
                // "## v2.11.0 — Headline" — em dash separates version from title.
                if let dash = body.range(of: " — ") ?? body.range(of: " - ") {
                    version = String(body[..<dash.lowerBound]).trimmingCharacters(in: .whitespaces)
                    headline = String(body[dash.upperBound...]).trimmingCharacters(in: .whitespaces)
                } else {
                    version = body.trimmingCharacters(in: .whitespaces)
                }
                continue
            }

            if line.hasPrefix("### ") {
                flushSection()
                sectionKind = ReleaseSection.Kind.from(String(line.dropFirst(4)))
                continue
            }

            guard version != nil else { continue }

            if line.hasPrefix("- ") || line.hasPrefix("* ") {
                flushEntry()
                buffer = [String(line.dropFirst(2))]
            } else if line.isEmpty || line == "---" {
                flushEntry()
            } else if !buffer.isEmpty {
                // Continuation of a wrapped bullet.
                buffer.append(line)
            }
        }
        flushRelease()
        return releases
    }

    /// Entries keep their markdown: SwiftUI renders **bold** and `code` from an
    /// AttributedString, and these notes lead with a bold sentence that carries
    /// the point of the item. Stripping it threw away the only hierarchy the
    /// entries have.
    static func normalise(_ s: String) -> String {
        s.trimmingCharacters(in: .whitespaces)
    }

    /// Markdown removed, for places that cannot render it (a notification body,
    /// a search index).
    public static func plain(_ s: String) -> String {
        var out = s.replacingOccurrences(of: "**", with: "")
        out = out.replacingOccurrences(of: "`", with: "")
        return out.trimmingCharacters(in: .whitespaces)
    }
}

// MARK: - Versions

public enum Version {
    /// Compare semantic versions with an optional leading "v". Returns true when
    /// `a` is strictly newer than `b`. A string compare would rank v2.9.0 above
    /// v2.11.0, which is exactly the case that matters as a project ages.
    public static func isNewer(_ a: String, than b: String) -> Bool {
        let x = components(a), y = components(b)
        for i in 0..<max(x.count, y.count) {
            let l = i < x.count ? x[i] : 0
            let r = i < y.count ? y[i] : 0
            if l != r { return l > r }
        }
        return false
    }

    public static func components(_ v: String) -> [Int] {
        let trimmed = v.trimmingCharacters(in: CharacterSet(charactersIn: "v \n\t"))
        // Stop at any pre-release suffix ("2.1.0-beta.1" → [2,1,0]).
        let core = trimmed.split(separator: "-", maxSplits: 1).first.map(String.init) ?? trimmed
        return core.split(separator: ".").map { Int($0) ?? 0 }
    }
}
