// GitActivity — the git source of the progress panel.
//
// This is source 3 of the panel, and the one where the arithmetic can be wrong
// without ever looking wrong. Two failure modes, both silent:
//
//   1. Under `forge_isolation.mode = worktree` a milestone's commits live in a
//      SECOND checkout. Reading only the folder the operator added shows zero
//      for a project that is shipping (DS6/F8). So commits are collected from
//      EVERY checkout of `Git.checkouts(at:)` — and a commit reachable from two
//      checkouts (they share history) must be counted ONCE. Hence `union`,
//      deduplicating by SHA.
//   2. Counting lines per checkout and summing would DOUBLE every shared
//      commit. `linesTouched` therefore consumes the deduplicated union, never
//      the per-checkout arrays.
//
// The dedupe is the risky part precisely because it is unfalsifiable in place:
// this repo has ONE checkout (`git worktree list` → 1), so an implementation
// that concatenates instead of uniting passes any test written against it. The
// proof lives in ForgeKitTests, which builds a real two-checkout repo in a
// tmpdir and asserts both that the union is 3 AND that the naive concatenation
// is 5 — the bite is observed, not assumed (DS3).

import Foundation

/// One file's contribution inside a commit. `added`/`deleted` are 0 for
/// binaries: git prints `-` there, which is "not applicable", not "zero lines"
/// — but for a line count they are the same thing, and refusing to parse the
/// line would drop the rest of the commit.
public struct FileStat: Hashable {
    public let added: Int
    public let deleted: Int
    public let path: String

    public init(added: Int, deleted: Int, path: String) {
        self.added = added
        self.deleted = deleted
        self.path = path
    }
}

/// A commit as the panel needs it: identity, instant, and what it touched.
/// `epoch` is `%ct` (committer date, seconds) — the window is filtered on THIS
/// value in Swift rather than with `git log --since` (DS7), so both the parse
/// and the window are pure and testable, and "24h" means the same thing here
/// as in the other two sources.
public struct Commit: Hashable {
    public let sha: String
    public let epoch: Int
    public let files: [FileStat]

    public init(sha: String, epoch: Int, files: [FileStat]) {
        self.sha = sha
        self.epoch = epoch
        self.files = files
    }

    public var date: Date { Date(timeIntervalSince1970: TimeInterval(epoch)) }
}

public enum GitActivity {

    // MARK: - Ignore list

    /// The engine's default `file_audit.ignore_list`.
    ///
    /// The canonical source is the prefs cascade, resolved by the CALLER via
    /// `forge-prefs.js --resolved --key file_audit.ignore_list` — the same path
    /// `agents/forge-completer.md` takes (DS5). This constant is only the
    /// fallback for when that key is absent or empty, which is the case in this
    /// repo today.
    ///
    /// It is a hardcode, and it is allowed to be one exactly once: the pure
    /// read-only guard `scripts/forge-app-progress.test.js` fails the suite if
    /// this array and the inline default in `agents/forge-completer.md` ever
    /// drift apart. Never inline these strings at a call site — the counting
    /// logic takes `[String]` and reads no prefs of its own.
    public static let defaultIgnoreList = [
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "dist/**",
        "build/**",
        ".next/**",
        ".gsd/**",
        "node_modules/**",
    ]

    /// Caller-resolved value wins; empty or absent falls back to the engine
    /// default. An explicitly empty list from prefs means "the key is not set"
    /// here, mirroring the completer's `Array.isArray(v) && v.length` check —
    /// there is no way to express "ignore nothing" in that cascade either.
    public static func resolveIgnoreList(prefValue: [String]?) -> [String] {
        guard let prefValue, !prefValue.isEmpty else { return defaultIgnoreList }
        return prefValue
    }

    // MARK: - Parsing

    /// Parse `git log --format='%H %ct' --numstat`.
    ///
    /// Shape (git emits a blank line between the format line and the numstat
    /// block, and merge commits carry no numstat at all):
    ///
    ///     <sha> <epoch>
    ///
    ///     12	3	src/a.swift
    ///     -	-	assets/logo.png
    ///     4	0	a/{b => c}/d.js
    ///
    /// Malformed lines are skipped rather than fatal, following
    /// `MetricsEngine.parse`: this text comes from a subprocess whose output can
    /// be truncated, and one unreadable line must not cost the whole window.
    public static func parseLog(_ text: String) -> [Commit] {
        var commits: [Commit] = []
        var sha: String?
        var epoch = 0
        var files: [FileStat] = []

        func flush() {
            defer { sha = nil; epoch = 0; files = [] }
            guard let s = sha else { return }
            commits.append(Commit(sha: s, epoch: epoch, files: files))
        }

        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line.isEmpty { continue }

            // A numstat row is the only shape with tabs. Checking this FIRST
            // matters: a path can contain spaces, so a numstat line would
            // otherwise be mistaken for a header by a naive field count.
            if line.contains("\t") {
                let parts = line.split(separator: "\t", omittingEmptySubsequences: false)
                guard parts.count >= 3, sha != nil else { continue }
                // `-` means binary. Not a parse failure — a file whose lines
                // cannot be counted still belongs to the commit.
                let added = parts[0] == "-" ? 0 : Int(parts[0])
                let deleted = parts[1] == "-" ? 0 : Int(parts[1])
                guard let a = added, let d = deleted else { continue }
                let path = parts[2...].joined(separator: "\t")
                files.append(FileStat(added: a, deleted: d, path: normalizeRename(path)))
                continue
            }

            let fields = line.split(separator: " ")
            guard fields.count == 2,
                  let ct = Int(fields[1]),
                  isSha(String(fields[0]))
            else { continue }
            flush()
            sha = String(fields[0])
            epoch = ct
        }
        flush()
        return commits
    }

    /// A rename is reported against BOTH paths, and the glob has to be matched
    /// against the one that exists now — otherwise moving a file into `dist/`
    /// keeps counting it, and moving one out of `dist/` never starts.
    ///
    ///     a/{b => c}/d.js   → a/c/d.js
    ///     {old => new}.js   → new.js
    ///     old.js => new.js  → new.js
    static func normalizeRename(_ path: String) -> String {
        if let open = path.firstIndex(of: "{"),
           let close = path[open...].firstIndex(of: "}"),
           let arrow = path[open..<close].range(of: " => ") {
            let prefix = path[path.startIndex..<open]
            let middle = path[arrow.upperBound..<close]
            let suffix = path[path.index(after: close)...]
            // `{a => }` and `{ => b}` collapse a segment, leaving `//`.
            return (prefix + middle + suffix)
                .replacingOccurrences(of: "//", with: "/")
        }
        if let arrow = path.range(of: " => ") {
            return String(path[arrow.upperBound...])
        }
        return path
    }

    static func isSha(_ s: String) -> Bool {
        s.count >= 7 && s.allSatisfy { $0.isHexDigit }
    }

    // MARK: - Union

    /// Merge the per-checkout logs into one commit list, keeping the FIRST
    /// sighting of each SHA and the input order.
    ///
    /// Worktrees of one repo share history: the same commit appears in every
    /// checkout that can reach it. Concatenating would inflate both the commit
    /// count and every line total by the number of checkouts (D12, criterion
    /// #10) — and on a machine with a single checkout the inflation is exactly
    /// 1x, which is why this is proved against a synthetic two-checkout repo.
    public static func union(_ perCheckout: [[Commit]]) -> [Commit] {
        var seen: Set<String> = []
        var result: [Commit] = []
        for commits in perCheckout {
            for c in commits where seen.insert(c.sha).inserted {
                result.append(c)
            }
        }
        return result
    }

    // MARK: - Globs

    /// The minimum glob vocabulary the default ignore list actually speaks —
    /// deliberately not a general matcher, because anything it accepts becomes
    /// a promise. Semantics, and nothing else:
    ///
    ///   - trailing `/**` → matches the directory as a PATH SEGMENT at ANY
    ///     depth (`dist/**` matches `dist/a/b.js` and `packages/app/dist/a.js`),
    ///     and never as a substring (it does NOT match `mydist/a.js` nor
    ///     `a/mydist/b.js`);
    ///   - a pattern with no `/` → matched against the BASENAME, so
    ///     `package-lock.json` is ignored in any directory;
    ///   - `*` matches within one segment only (never across `/`).
    ///
    /// The depth rule is not a convenience: it is the semantics
    /// `agents/forge-completer.md` (S03 review R24) and
    /// `isInstallArtifactPath` in `scripts/forge-surgical-reset.js` already
    /// speak, and this matcher was the one copy still anchored at the root.
    /// A vendored `packages/app/node_modules/**` counted thousands of lines
    /// into the metrics panel — a wrong number that nobody reads as wrong.
    public enum Glob {
        public static func matches(_ pattern: String, _ path: String) -> Bool {
            if pattern.hasSuffix("/**") {
                let dir = String(pattern.dropLast(3))  // drop "/**", keep the dir
                guard !dir.isEmpty else { return false }
                return path.hasPrefix(dir + "/") || path.contains("/" + dir + "/")
            }
            let subject = pattern.contains("/")
                ? path
                : String(path.split(separator: "/").last ?? Substring(path))
            return segmentMatch(pattern, subject)
        }

        /// `*` expanded as "anything but a separator", anchored at both ends.
        static func segmentMatch(_ pattern: String, _ subject: String) -> Bool {
            guard pattern.contains("*") else { return pattern == subject }
            let escaped = pattern
                .split(separator: "*", omittingEmptySubsequences: false)
                .map { NSRegularExpression.escapedPattern(for: String($0)) }
                .joined(separator: "[^/]*")
            guard let re = try? NSRegularExpression(pattern: "^" + escaped + "$") else {
                return false
            }
            let range = NSRange(subject.startIndex..., in: subject)
            return re.firstMatch(in: subject, range: range) != nil
        }
    }

    public static func isIgnored(_ path: String, globs: [String]) -> Bool {
        globs.contains { Glob.matches($0, path) }
    }

    // MARK: - Counting

    /// Added/deleted lines across the given commits, skipping any path that
    /// matches an ignore glob.
    ///
    /// Feed this the UNION, never the per-checkout arrays: every commit shared
    /// between checkouts would otherwise be counted once per checkout.
    public static func linesTouched(_ commits: [Commit],
                                    ignoring globs: [String]) -> (added: Int, deleted: Int) {
        var added = 0
        var deleted = 0
        for c in commits {
            for f in c.files where !isIgnored(f.path, globs: globs) {
                added += f.added
                deleted += f.deleted
            }
        }
        return (added, deleted)
    }

    /// Keep only commits at or after `since`, on the parsed epoch (DS7).
    public static func inWindow(_ commits: [Commit], since: Date?) -> [Commit] {
        guard let since else { return commits }
        return commits.filter { $0.date >= since }
    }

    // MARK: - Collection (impure)

    /// Run the log in every checkout. The only impure entry point here.
    ///
    /// DS6 — checkouts come from `Git.checkouts(at: workspace)` (primary plus
    /// worktrees); items and the ledger do NOT read from here, they read the
    /// PRIMARY workspace. Reading the wrong place shows zero for a project that
    /// is delivering.
    ///
    /// The window is applied to the parsed epoch, not passed as `--since`, so
    /// the command stays constant and the filtering stays testable (DS7).
    ///
    /// Returns one array per checkout, in checkout order — the caller passes
    /// the whole thing to `union` before counting anything.
    public static func collect(checkouts: [Checkout], since: Date? = nil) -> [[Commit]] {
        checkouts.map { checkout in
            guard let out = Git.run(["log", "--format=%H %ct", "--numstat"],
                                    at: checkout.path) else { return [] }
            return inWindow(parseLog(out), since: since)
        }
    }
}
