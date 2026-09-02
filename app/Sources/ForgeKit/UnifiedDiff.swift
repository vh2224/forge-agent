// UnifiedDiff — a pure parser from `git diff` unified-diff text to typed
// files and hunks, with +/- counts PROVEN against `git diff --numstat` of
// the same range (S05-PLAN.md § Medido no planning, T02).
//
// The classic mistake here is counting `+`/`-` by scanning every line for a
// leading character: the file header lines (`--- a/x`, `+++ b/x`) and a hunk
// header that happens to contain a literal `+` in its trailing function
// signature both look like content lines to a naive scanner and inflate the
// count. `added`/`deleted` on `DiffHunk`/`DiffFile` are derived ONLY from
// `DiffLine.added`/`.removed` cases inside a hunk body — never from raw text
// matching — which is exactly what the numstat-parity test in
// ForgeKitTests exists to catch.
//
// Pure by design: `String` in, `[DiffFile]` out. No disk, no git, no
// process — the host (T06) is the only place that calls `Git.run(["diff", …])`
// and hands the resulting string here.

import Foundation

/// One line inside a hunk body, typed by its leading marker (already
/// stripped from `text`).
public enum DiffLine: Hashable {
    case context(String)
    case added(String)
    case removed(String)
    case noNewline   // "\ No newline at end of file"
}

public struct DiffHunk: Hashable {
    public let oldStart: Int
    public let oldCount: Int
    public let newStart: Int
    public let newCount: Int
    /// The text after the second `@@` — usually the enclosing function/type
    /// signature git includes as context. "" when git emits none.
    public let header: String
    public let lines: [DiffLine]

    public init(oldStart: Int, oldCount: Int, newStart: Int, newCount: Int, header: String, lines: [DiffLine]) {
        self.oldStart = oldStart
        self.oldCount = oldCount
        self.newStart = newStart
        self.newCount = newCount
        self.header = header
        self.lines = lines
    }

    public var added: Int {
        lines.reduce(0) { count, line in
            if case .added = line { return count + 1 }
            return count
        }
    }

    public var deleted: Int {
        lines.reduce(0) { count, line in
            if case .removed = line { return count + 1 }
            return count
        }
    }
}

public struct DiffFile: Hashable {
    public let oldPath: String   // "/dev/null" when the file is new
    public let newPath: String   // "/dev/null" when the file was deleted
    public let isBinary: Bool
    public let isRename: Bool
    public let hunks: [DiffHunk]

    public init(oldPath: String, newPath: String, isBinary: Bool, isRename: Bool, hunks: [DiffHunk]) {
        self.oldPath = oldPath
        self.newPath = newPath
        self.isBinary = isBinary
        self.isRename = isRename
        self.hunks = hunks
    }

    public var added: Int { hunks.reduce(0) { $0 + $1.added } }
    public var deleted: Int { hunks.reduce(0) { $0 + $1.deleted } }

    /// The path to display: `newPath`, except when the file was deleted, in
    /// which case `newPath` is "/dev/null" and `oldPath` is the only real name.
    public var displayPath: String {
        newPath != "/dev/null" ? newPath : oldPath
    }
}

public enum UnifiedDiff {

    private static let hunkHeaderRegex = try! NSRegularExpression(
        pattern: #"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[ \t]?(.*)$"#
    )
    private static let renameFromRegex = try! NSRegularExpression(pattern: #"^rename from (.*)$"#)
    private static let renameToRegex = try! NSRegularExpression(pattern: #"^rename to (.*)$"#)
    private static let binaryRegex = try! NSRegularExpression(
        pattern: #"^Binary files (.*) and (.*) differ$"#
    )

    public static func parse(_ text: String) -> [DiffFile] {
        guard !text.isEmpty else { return [] }
        let lines = text.components(separatedBy: "\n")
        var files: [DiffFile] = []
        var i = 0

        while i < lines.count {
            let line = lines[i]
            guard line.hasPrefix("diff --git ") else { i += 1; continue }

            i += 1
            var oldPath = "/dev/null"
            var newPath = "/dev/null"
            var isBinary = false
            var isRename = false
            var sawOldPath = false
            var sawNewPath = false
            var hunks: [DiffHunk] = []

            // Consume the per-file preamble: index/mode/rename/binary/---/+++
            // lines, until the next "diff --git" or the first "@@" hunk.
            while i < lines.count {
                let raw = lines[i]

                if raw.hasPrefix("diff --git ") { break }
                if raw.hasPrefix("@@ ") { break }

                if let m = firstMatch(renameFromRegex, raw) {
                    isRename = true
                    if !sawOldPath { oldPath = m }
                    i += 1
                    continue
                }
                if let m = firstMatch(renameToRegex, raw) {
                    isRename = true
                    if !sawNewPath { newPath = m }
                    i += 1
                    continue
                }
                if let (a, b) = binaryMatch(raw) {
                    isBinary = true
                    if !sawOldPath { oldPath = stripABPrefix(a) }
                    if !sawNewPath { newPath = stripABPrefix(b) }
                    i += 1
                    continue
                }
                if raw.hasPrefix("--- ") {
                    let p = String(raw.dropFirst(4))
                    oldPath = p == "/dev/null" ? p : stripABPrefix(p)
                    sawOldPath = true
                    i += 1
                    continue
                }
                if raw.hasPrefix("+++ ") {
                    let p = String(raw.dropFirst(4))
                    newPath = p == "/dev/null" ? p : stripABPrefix(p)
                    sawNewPath = true
                    i += 1
                    continue
                }

                i += 1
            }

            // Hunks (absent for binary files, and possibly absent for a bare rename).
            while i < lines.count, lines[i].hasPrefix("@@ ") {
                let (hunk, consumed) = parseHunk(lines: lines, startIndex: i)
                if let hunk = hunk { hunks.append(hunk) }
                i += consumed
            }

            files.append(DiffFile(oldPath: oldPath, newPath: newPath, isBinary: isBinary, isRename: isRename, hunks: hunks))
        }

        return files
    }

    // MARK: - Hunk

    /// Parses one `@@ … @@` hunk starting at `lines[startIndex]`. Returns the
    /// hunk (nil if the header doesn't match) and how many lines were
    /// consumed — including a partial/truncated body, which is returned as
    /// far as it was read, never crashing.
    private static func parseHunk(lines: [String], startIndex: Int) -> (DiffHunk?, Int) {
        let headerLine = lines[startIndex]
        let ns = headerLine as NSString
        guard let m = hunkHeaderRegex.firstMatch(in: headerLine, range: NSRange(location: 0, length: ns.length)) else {
            return (nil, 1)
        }

        let oldStart = Int(ns.substring(with: m.range(at: 1))) ?? 0
        let oldCount = m.range(at: 2).location != NSNotFound ? (Int(ns.substring(with: m.range(at: 2))) ?? 1) : 1
        let newStart = Int(ns.substring(with: m.range(at: 3))) ?? 0
        let newCount = m.range(at: 4).location != NSNotFound ? (Int(ns.substring(with: m.range(at: 4))) ?? 1) : 1
        let header = m.range(at: 5).location != NSNotFound ? ns.substring(with: m.range(at: 5)) : ""

        var bodyLines: [DiffLine] = []
        var j = startIndex + 1

        while j < lines.count {
            let raw = lines[j]

            if raw.hasPrefix("diff --git ") || raw.hasPrefix("@@ ") { break }

            if raw == "\\ No newline at end of file" {
                bodyLines.append(.noNewline)
                j += 1
                continue
            }
            if raw.hasPrefix("+") {
                bodyLines.append(.added(String(raw.dropFirst())))
                j += 1
                continue
            }
            if raw.hasPrefix("-") {
                bodyLines.append(.removed(String(raw.dropFirst())))
                j += 1
                continue
            }
            if raw.hasPrefix(" ") {
                bodyLines.append(.context(String(raw.dropFirst())))
                j += 1
                continue
            }
            // An empty line inside a hunk body (git emits a bare "" for an
            // empty context line at end of file) — treat as empty context.
            if raw.isEmpty {
                bodyLines.append(.context(""))
                j += 1
                continue
            }

            // Anything else ends the hunk body (e.g. trailing blank / EOF).
            break
        }

        let hunk = DiffHunk(oldStart: oldStart, oldCount: oldCount, newStart: newStart, newCount: newCount,
                             header: header, lines: bodyLines)
        return (hunk, j - startIndex)
    }

    // MARK: - Path helpers

    /// Strips the `a/` or `b/` prefix git puts on paths in `--- `/`+++ `/
    /// `rename from`/`rename to` lines and in the `Binary files` line.
    /// Leaves `/dev/null` untouched, and unwraps a quoted path (git quotes
    /// paths containing spaces or non-ASCII bytes).
    private static func stripABPrefix(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("\"") && s.hasSuffix("\"") && s.count >= 2 {
            s = String(s.dropFirst().dropLast())
        }
        if s == "/dev/null" { return s }
        if s.hasPrefix("a/") || s.hasPrefix("b/") {
            return String(s.dropFirst(2))
        }
        return s
    }

    private static func firstMatch(_ regex: NSRegularExpression, _ line: String) -> String? {
        let ns = line as NSString
        guard let m = regex.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return ns.substring(with: m.range(at: 1))
    }

    private static func binaryMatch(_ line: String) -> (String, String)? {
        let ns = line as NSString
        guard let m = binaryRegex.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (ns.substring(with: m.range(at: 1)), ns.substring(with: m.range(at: 2)))
    }
}
