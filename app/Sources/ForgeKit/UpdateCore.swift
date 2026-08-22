// UpdateCore — reading the installer's output, and when it is safe to relaunch.
//
// The bugs this file exists to prevent, both of which were invisible:
//
//   1. A progress bar that stops moving. The update runs `install.sh --update
//      --with-app`, and the longest single step by wall clock is `swift build`
//      inside app/build.sh — minutes of raw SwiftPM output that follows none of
//      the installer's formatting conventions. Classify that output as "no
//      phase" and the label freezes on whatever came before it, which looks
//      exactly like a hung process. Worse, build.sh marks its own steps with
//      `▸ ` and NO indentation, so the rule derived from install.sh alone
//      (`info() { echo "  $1"; }`) misses precisely the step that matters most.
//      And after the final `✓ … instalado com sucesso!` the installer prints six
//      "Próximos passos" lines indented with two spaces — each of which would
//      otherwise become a phase, leaving the last label the operator sees as
//      "Ajuda a qualquer momento: /forge-help".
//
//   2. A relaunch button that appears while the installer is still running.
//      The old `runUpdate()` set `needsRelaunch = true` as soon as a Terminal
//      window had been opened, so clicking it killed the installer mid-build.
//      The decision belongs to the process exit code and nowhere else.
//
// Everything here is pure so ForgeKitTests can cover it: the app target owns
// `Process`, SwiftUI and NSApplication, and cannot be imported by a test target.

import Foundation

// MARK: - Classifying a line of installer output

/// What one line of installer output means to the progress UI.
public enum InstallerLine: Equatable {
    /// A step worth showing as the current label.
    case phase(String)
    /// Everything else: raw compiler output, sub-items, onboarding text.
    case detail(String)
    /// The installer announced success; no later line may claim the label.
    case finished(String)
}

/// Turns the installer's stdout into phase transitions.
///
/// Stateful for one reason only: `finished` is terminal. Once the success line
/// has been seen, every following line is a detail — that is what keeps the six
/// onboarding lines out of the label.
public struct InstallerPhaseTracker {
    /// The three markers actually emitted. `✓`/`⚠` come from install.sh:35-36,
    /// `▸` from app/build.sh — a different script with a different convention,
    /// invoked by the first one.
    private static let markers = ["✓ ", "⚠ ", "▸ "]

    private var finished = false

    public init() {}

    public mutating func consume(_ raw: String) -> InstallerLine {
        let line = Self.normalize(raw)
        if line.trimmingCharacters(in: .whitespaces).isEmpty { return .detail("") }
        if finished { return .detail(line) }

        // A marker beats indentation: `success "  hooks sincronizados"` prints
        // `✓   hooks…` — marker at column 0, detail-level indentation after it.
        let leading = String(line.drop(while: { $0 == " " || $0 == "\t" }))
        if let marker = Self.markers.first(where: { leading.hasPrefix($0) }) {
            let phrase = String(leading.dropFirst(marker.count))
                .trimmingCharacters(in: .whitespaces)
            if marker == "✓ ", phrase.lowercased().contains("instalado com sucesso") {
                finished = true
                return .finished("concluído")
            }
            return .phase(phrase)
        }

        // `info()` indents by exactly two; a sub-item (`info "  text"`) lands on
        // four, and raw tool output on zero. Only the first is a phase.
        if Self.isTwoSpaceIndented(line) {
            return .phase(line.trimmingCharacters(in: .whitespaces))
        }
        return .detail(line)
    }

    /// Strip carriage returns and one trailing newline. Progress-style output
    /// uses `\r` freely and it would otherwise end up inside the label.
    static func normalize(_ raw: String) -> String {
        var s = raw.replacingOccurrences(of: "\r", with: "")
        if s.hasSuffix("\n") { s.removeLast() }
        return s
    }

    /// `^ {2}\S` — exactly two spaces of indentation, then content.
    static func isTwoSpaceIndented(_ line: String) -> Bool {
        let chars = Array(line)
        guard chars.count > 2 else { return false }
        return chars[0] == " " && chars[1] == " " && chars[2] != " " && chars[2] != "\t"
    }
}

// MARK: - Labelling a phase in Portuguese

/// Known installer phrases get a short Portuguese label; unknown ones are shown
/// verbatim.
///
/// Degrading to the raw phrase is deliberate. The alternative — mapping only
/// recognised phrases and dropping the rest — means a renamed string in
/// install.sh silently stops advancing the bar, and nobody finds out until an
/// update looks hung. Showing English is a smaller failure than showing nothing.
public enum InstallerLabels {
    /// Matched case-insensitively, by `contains`, in order: the first entry that
    /// matches wins, so more specific needles come first.
    private static let table: [(needle: String, label: String)] = [
        ("Backup saved", "fazendo backup"),
        ("Cleaning up legacy", "limpando arquivos legados"),
        ("Installing agents", "copiando agentes"),
        ("Installing dispatch", "copiando templates de dispatch"),
        ("Verificando disponibilidade", "verificando modelos"),
        ("Installing commands", "copiando comandos"),
        ("Installing scripts", "copiando scripts"),
        ("Installing skills", "copiando skills"),
        ("Installing preferences", "instalando preferências"),
        ("Installing shared", "copiando referências compartilhadas"),
        ("Statusline", "instalando statusline e hooks"),
        ("hooks", "instalando statusline e hooks"),
        ("MCP", "configurando MCPs"),
        ("Limpando build", "limpando build anterior"),
        ("Building the macOS app", "compilando o app"),
        ("Compilando", "compilando o app"),
        ("Gerando ícone", "gerando ícone"),
        ("Assinando", "assinando"),
        ("Forge.app instalado", "app instalado"),
        ("Instalando em /Applications", "instalando em /Applications"),
    ]

    public static func label(for phrase: String) -> String {
        let hay = phrase.lowercased()
        for entry in table where hay.contains(entry.needle.lowercased()) {
            return entry.label
        }
        return phrase
    }
}

// MARK: - Deciding whether the update succeeded

/// Exit code in, decision out. The only source of truth for "may relaunch".
public enum UpdateOutcome {
    public static func canRelaunch(exitCode: Int32) -> Bool { exitCode == 0 }

    /// A failure the operator can act on: the code, plus the tail of the output
    /// where the real reason lives (`set -euo pipefail` means the last lines are
    /// usually the error).
    public static func failureMessage(exitCode: Int32, lastLines: [String]) -> String {
        let head = "a atualização falhou (código \(exitCode))"
        let tail = lastLines
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .suffix(3)
        return tail.isEmpty ? head : head + "\n" + tail.joined(separator: "\n")
    }
}

// MARK: - Which bundle a relaunch would reopen

/// The relaunch reopens the RUNNING bundle, not necessarily the one the
/// installer just wrote to /Applications. Someone running a dev build outside
/// /Applications did that on purpose, so the target is not redirected — the
/// divergence is stated instead.
public enum RelaunchTarget {
    public static let canonical = "/Applications/Forge.app"

    public static func isCanonical(_ path: String) -> Bool {
        normalized(path) == normalized(canonical)
    }

    public static func divergenceNote(for path: String) -> String? {
        guard !isCanonical(path) else { return nil }
        return "vai reabrir este bundle em \(normalized(path)), "
            + "não o que o instalador acabou de instalar em \(canonical)"
    }

    private static func normalized(_ path: String) -> String {
        var s = path
        while s.count > 1 && s.hasSuffix("/") { s.removeLast() }
        return s
    }
}

// MARK: - What version is actually running

/// The sidebar footer's text, and the decision of whether there are two numbers
/// to show instead of one.
///
/// The bug this exists to prevent is a footer that lies. Before D25 the only
/// version the app knew was `git describe` in the repo — read live, at display
/// time. Pull without rebuilding and the UI announces the new version while the
/// process running it is the old one, which is the exact opposite of the answer
/// a version footer exists to give.
///
/// So the running version comes from a key stamped into the bundle at build
/// time, and the repo's describe is a SECOND, separate number. When they differ,
/// both are shown — the divergence is the information ("you committed but did
/// not rebuild"), not an error to hide.
///
/// THE SENTINEL, and why it is not `"0.1.0"`.
///   A build that was never stamped has no `ForgeGitDescribe` key at all, and
///   under `swift run` there is no bundle, so `Bundle.main.infoDictionary` is an
///   EMPTY dictionary and every key reads `nil`. "Unknown" is therefore the
///   ABSENCE of the custom key — see `stamped(_:)`. Filtering the value `0.1.0`
///   (the placeholder in the versioned `Info.plist`) would be a trap: `0.1.0` is
///   a perfectly legitimate version string, and the day someone ships it the
///   footer would go blank for no reason anyone could find.
public enum VersionFooter {
    /// Interpret a raw Info.plist value as "the version this binary is".
    ///
    /// `nil` in, `nil` out; empty or whitespace-only in, `nil` out — a key
    /// stamped from a failed `git describe` is absent information wearing a
    /// present key. Any other value is taken at face value, INCLUDING `0.1.0`
    /// (see the note above).
    public static func stamped(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return s.isEmpty ? nil : s
    }

    /// `git describe` shortened for a 152pt column: `v3.1.4-6-g63af17e` →
    /// `v3.1.4+6`; `v3.1.4` → `v3.1.4` unchanged.
    ///
    /// Only the DISPLAY is shortened. Divergence is decided on the full describe
    /// against the full describe, because two describes can share a tag and a
    /// commit count while pointing at different commits, and dropping the sha
    /// before comparing is how "committed but did not rebuild" becomes invisible.
    ///
    /// Anything that does not match git's `<tag>-<n>-g<sha>` shape is returned
    /// verbatim rather than guessed at. That is what keeps a pre-release tag
    /// (`v3.0.0-beta`, two components, no count) from being mangled into garbage:
    /// only a trailing numeric count plus a `g`-prefixed hex sha is treated as a
    /// suffix, so `v3.0.0-beta-6-gabc1234` shortens to `v3.0.0-beta+6` and
    /// `v3.0.0-beta` is left alone.
    public static func short(_ describe: String) -> String {
        let s = describe.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = s.components(separatedBy: "-")
        guard parts.count >= 3 else { return s }
        let sha = parts[parts.count - 1]
        let ahead = parts[parts.count - 2]
        guard sha.count >= 2, sha.hasPrefix("g"),
              sha.dropFirst().allSatisfy({ $0.isHexDigit }),
              !ahead.isEmpty, ahead.allSatisfy({ $0.isNumber })
        else { return s }
        let tag = parts[0..<(parts.count - 2)].joined(separator: "-")
        guard !tag.isEmpty else { return s }
        return "\(tag)+\(ahead)"
    }

    /// What the footer shows, plus everything the caller needs to style it.
    public struct Display: Equatable {
        /// The short text for the column. Never empty.
        public let text: String
        /// The whole sentence, for a `.help()` tooltip — this is where R9 ("say
        /// which number is which") is paid without spending width. `nil` when
        /// `text` already says everything.
        public let detail: String?
        /// The running binary and the repo are at different commits.
        public let diverged: Bool
        /// The running version is known at all (i.e. this build was stamped).
        public let known: Bool
    }

    /// The four states, given the stamped describe and the repo's describe.
    ///
    /// The second token is labelled `repo` rather than left bare: two unlabelled
    /// numbers in a footer are worse than one, because the reader cannot tell
    /// which is the thing they are looking at (R9).
    public static func display(running: String?, repo: String?) -> Display {
        let run = stamped(running)
        let rep = stamped(repo)

        switch (run, rep) {
        case (nil, nil):
            return Display(
                text: "versão desconhecida",
                detail: "não sei qual versão está em execução: este build não carrega a "
                    + "chave ForgeGitDescribe, e não consegui ler a tag do repositório",
                diverged: false,
                known: false)

        case (nil, let r?):
            return Display(
                text: "repo \(short(r))",
                detail: "não sei qual versão está em execução (este build não foi "
                    + "estampado); o repositório está em \(short(r))",
                diverged: false,
                known: false)

        case (let r?, nil):
            return Display(
                text: short(r),
                detail: "rodando \(short(r)); não consegui ler a tag do repositório",
                diverged: false,
                known: true)

        case (let r?, let p?) where r == p:
            return Display(text: short(r), detail: nil, diverged: false, known: true)

        case (let r?, let p?):
            return Display(
                text: "\(short(r)) · repo \(short(p))",
                detail: "rodando \(short(r)); o repositório está em \(short(p))",
                diverged: true,
                known: true)
        }
    }
}

// MARK: - Resolving the stable server release

public enum RemoteRelease {
    /// Parse `git ls-remote --tags` without consulting a local clone. Only
    /// final `vMAJOR.MINOR.PATCH` tags participate; annotated-tag peel rows are
    /// naturally deduplicated.
    public static func latestTag(from output: String?) -> String? {
        var latest: String?
        for line in (output ?? "").components(separatedBy: .newlines) {
            guard let marker = line.range(of: "refs/tags/v") else { continue }
            var raw = String(line[marker.upperBound...])
            if raw.hasSuffix("^{}") { raw.removeLast(3) }
            let pieces = raw.split(separator: ".", omittingEmptySubsequences: false)
            guard pieces.count == 3,
                  pieces.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isNumber) }) else { continue }
            let tag = "v" + raw
            if latest == nil || Version.isNewer(tag, than: latest!) { latest = tag }
        }
        return latest
    }
}

// MARK: - Which release notes are on screen at rest

/// The window of `ReleaseCard`s the update screen shows before anyone asks for
/// more (D30).
///
/// D30 is an OPERATOR OVERRIDE of the brainstorm, which recommended not doing
/// this: the whole list already scrolled, and a cut risks hiding the very notes a
/// sibling task just shipped. The constraint that came with the override is what
/// this type exists to enforce mechanically: THE CUT IS THE HISTORICAL TAIL,
/// NEVER THE TOP. The entry for the version you are running, the entry for the
/// version you could move to, and anything still unreleased are never behind
/// "show more".
///
/// THE INVARIANT IS CONDITIONAL, and that is not a weakening.
///   `installed` comes from `git describe --tags --abbrev=0`, while the entries
///   come from `CHANGELOG.md`, and the two disagree in the real repo: `v3.1.4` is
///   the installed tag and has NO changelog entry at all. So the guarantee can
///   only be "IF an entry for `installed` exists, it is visible" — written as
///   "the installed version's card is always visible" it would be unsatisfiable
///   here, and a test asserting it would fail against this repo's own file. When
///   the entry does not exist the invariant holds vacuously and nothing is
///   pinned: absence is a legitimate state, not a case to paper over.
///
/// FILE ORDER IS NOT VERSION ORDER. `v1.35.0` precedes `v1.36.0` in this repo's
/// CHANGELOG. Nothing here sorts, and nothing here promises "the 5 most recent":
/// the promise is "the first 5 in the file, plus the pins". Windowing logic that
/// assumed a sorted file would pin and cut the wrong cards, silently.
///
/// DEDUPE LIVES HERE, not only in the file. `Release.id` is the version string,
/// so two entries sharing a version are two identical ids in a `ForEach`, which
/// is undefined behaviour in SwiftUI. A sibling chunk fixed the two
/// `## Unreleased` headings in this repo's file; this fixes the PROGRAM, which
/// also has to survive a fork, a hand-edit and a merge.
public enum ReleaseWindow {
    /// How many cards the list shows at rest.
    ///
    /// One named value on purpose: the number itself was never validated against
    /// a live list — nobody has answered "looking at it, is 5 too few?" — so
    /// changing it has to be a one-line edit, not a hunt through a view body.
    public static let restingLimit = 5

    public struct Window: Equatable {
        /// The cards to render, in file order, deduped.
        public let visible: [Release]
        /// How many deduped entries `visible` leaves out. `0` means there is
        /// nothing to reveal and no reason to draw a control.
        public let hiddenCount: Int
    }

    /// Two versions naming the same release. `installed` is a git tag and the
    /// entries are markdown headings written by hand, so a stray `v` or a
    /// different case should not decide whether a card can be hidden.
    private static func same(_ a: String, _ b: String) -> Bool {
        func key(_ s: String) -> String {
            var t = s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if t.hasPrefix("v") { t.removeFirst() }
            return t
        }
        return key(a) == key(b)
    }

    /// The window, given the whole parsed list.
    ///
    /// Order of operations matters and is asserted by tests: dedupe first (so a
    /// duplicate can never be pinned into the window twice), then pin, then take
    /// the prefix, then union — preserving file order throughout.
    ///
    /// `limit` at or above the deduped count returns everything with
    /// `hiddenCount == 0`; the expanded state passes `.max`. A `limit` of zero or
    /// less still returns the pins, because hiding the version you are running is
    /// the one outcome D30 forbids.
    public static func visible(releases: [Release],
                               installed: String?,
                               latest: String?,
                               limit: Int) -> Window {
        var deduped: [Release] = []
        var seen = Set<String>()
        for r in releases where !seen.contains(r.id) {
            seen.insert(r.id)
            deduped.append(r)
        }

        func isPinned(_ r: Release) -> Bool {
            if r.isUnreleased { return true }
            if let installed, same(r.version, installed) { return true }
            if let latest, same(r.version, latest) { return true }
            return false
        }

        let head = max(0, min(limit, deduped.count))
        var keep = Set<Int>(0..<head)
        for (i, r) in deduped.enumerated() where isPinned(r) { keep.insert(i) }

        let visible = deduped.enumerated().filter { keep.contains($0.offset) }.map(\.element)
        return Window(visible: visible, hiddenCount: deduped.count - visible.count)
    }

    /// The label for the control that reveals the tail.
    ///
    /// Here rather than in the view because the plural is a real branch and a
    /// view body is where "1 versões" ships unnoticed.
    public static func moreLabel(hiddenCount: Int) -> String {
        hiddenCount == 1 ? "Mostrar mais 1 versão" : "Mostrar mais \(hiddenCount) versões"
    }

    /// The label for collapsing back.
    public static let lessLabel = "Mostrar menos"
}

// MARK: - Restoring the last selected section

/// Which sidebar section to show at launch.
///
/// The stored value is a section's `rawValue`, which is also its visible label —
/// so renaming a sidebar item invalidates whatever was persisted. That has to
/// fall back explicitly instead of resolving to nothing.
public enum SectionRestore {
    public static func resolve(rawValue: String?, valid: [String], fallback: String) -> String {
        guard let rawValue, !rawValue.isEmpty, valid.contains(rawValue) else { return fallback }
        return rawValue
    }
}

// MARK: - Legacy local-repository diagnostics

/// Retained for diagnostics of explicitly local workflows. Normal updates no
/// longer pull or install from this repository: forge-update resolves and pins
/// the server release in a temporary checkout.
///
/// The refusal applies ONLY to a caller that explicitly pulls. With no pull there is no
/// `--ff-only` that can fail and no working tree that can be moved aside, so the
/// damage this check prevents does not exist — and neither does the symptom
/// ("watching a bar for something that could never have begun"). That is why
/// `pulls` has no default value: every call site states which mode it is.
public enum UpdatePrecheck {
    public enum Blocker: String {
        case dirtyTree
        case diverged
    }

    public static func evaluate(dirty: Bool, ahead: Int, pulls: Bool) -> Blocker? {
        guard pulls else { return nil }
        if dirty { return .dirtyTree }
        if ahead > 0 { return .diverged }
        return nil
    }

    public static func message(for blocker: Blocker) -> String {
        switch blocker {
        case .dirtyTree:
            return "não vou atualizar com mudanças não commitadas no repo do Forge. "
                + "O update roda `git pull --ff-only`, e mexer na sua árvore de trabalho "
                + "para abrir caminho seria perder trabalho seu. Resolva você e tente de novo."
        case .diverged:
            return "o seu branch tem commits que o remoto não tem, então o `--ff-only` "
                + "não passa. Não toco no seu histórico: publique ou mova esses commits "
                + "como preferir e tente de novo."
        }
    }

    /// A command that only INSPECTS — deliberately nothing that rewrites state.
    public static func manualCommand(repo: String) -> String {
        "cd \(ShellQuote.posix(repo)) && git status && git log --oneline origin/HEAD..HEAD"
    }
}

// MARK: - Quoting a path for a shell command

/// A single-quote shell-escaping helper local to ForgeKit. ForgeKit cannot
/// import ForgeCore (the app target), so this cannot reuse `ForgeCore.shellQuote`
/// even though the two must behave identically — the same repo path is quoted
/// by both the command this file only DISPLAYS
/// (`UpdatePrecheck.manualCommand`) and the command the app actually executes,
/// which `InstallerCommand.build` below composes from this very helper. The two
/// implementations are byte-identical by inspection, and the shared use here is
/// what keeps them from drifting.
public enum ShellQuote {
    /// Wraps `s` in single quotes, escaping any embedded single quote as
    /// `'\''` — the standard POSIX-shell technique.
    public static func posix(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}

// MARK: - Building the installer command

/// The shell command each affordance runs — the ONE place either of them is
/// composed, so "what does this button do" has a single answer with unit tests.
///
/// `--with-app` is not optional here even though it is opt-in on the command
/// line. The app build is gated behind that flag, so an update launched FROM
/// the app that omitted it would refresh every agent, skill and script and
/// leave the one binary the user is looking at on the old version — the update
/// would appear to have worked while the app stayed exactly as it was.
///
/// Updating uses forge-update's default remote/stable source and never pulls
/// this clone. Reinstalling is the explicit escape hatch that reuses this local
/// source, including uncommitted dogfood work, without contacting the server.
/// Neither mode pulls, so neither can move the operator's working tree — the
/// property the old `--ff-only` refusal existed to protect now holds by
/// construction rather than by a precheck.
///
/// `nodePath` is the interpreter `NodeLocator` resolved, and it is not optional
/// decoration: the command runs through `bash -lc` from a GUI app, so it
/// inherits launchd's minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) — which
/// cannot contain a version-managed node, and a login bash does not read the
/// ~/.zshrc where nvm installs itself. `install.sh` then exited 127 and the app
/// reported "a atualização falhou (código 127)" with no way to act on it
/// (measured 2026-08-20, v4.18.0). Prefixing the assignment puts the already
/// resolved interpreter on PATH for the installer AND every child it spawns,
/// which is what `install.sh` and `app/build.sh` actually need.
///
/// The prefix lands on the installed updater, which is the shared head of both
/// modes. `.reinstall` is `.update` plus the explicit local-source suffix; only
/// that mode consumes the repository path.
public enum InstallerCommand {
    public enum Mode { case update, reinstall }

    /// - Parameter nodePath: absolute path to the node binary, or nil when
    ///   nothing resolved. Nil produces a bare `node` command and therefore uses
    ///   the environment available to the app's login shell.
    ///   No default value on purpose: a call site that forgets this is exactly
    ///   the regression this parameter exists to prevent.
    public static func build(repo: String, mode: Mode, nodePath: String?) -> String {
        let updater = nodeEnvPrefix(nodePath)
            + "node \"${FORGE_HOME:-$HOME/.forge-agent}/scripts/forge-update.js\" --apply --with-app"
        switch mode {
        case .update:    return updater
        case .reinstall: return updater + " --source local --repo " + ShellQuote.posix(repo)
        }
    }

    /// `PATH=<dir do node>:"$PATH" ` — a shell assignment prefix, so it scopes to
    /// the installer's environment and is inherited by its children. Empty when
    /// there is nothing to add.
    static func nodeEnvPrefix(_ nodePath: String?) -> String {
        guard let nodePath, !nodePath.isEmpty else { return "" }
        let dir = URL(fileURLWithPath: nodePath).deletingLastPathComponent().path
        guard !dir.isEmpty, dir != "/" else { return "" }
        return "PATH=\(ShellQuote.posix(dir)):\"$PATH\" "
    }
}
