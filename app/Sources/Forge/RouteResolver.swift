// RouteResolver — what the router WILL do, asked before it does it.
//
// WHY THE HOME DOES NOT LET YOU PICK AN ENGINE FOR A RUN
// -----------------------------------------------------
// Every AI app the operator compares this one to puts a model picker next to
// the composer, and copying that here would be wrong in a way that is worse
// than ugly: it would be a control that does not control anything.
//
// `CLAUDE.md` is unambiguous about it — "Quem decide qual engine executa uma
// unidade é o resolvedor do Forge", and picking by hand "não é decisão, é
// override". A run dispatches many units, and each one resolves its own
// `{engine, model, tier, effort}` from prefs at dispatch time. A picker set to
// "Codex" on this screen would be silently ignored by every one of them, and
// the operator would have no way to know: the screen would say Codex, the log
// would say Claude, and the log is the truth.
//
// So the home inverts it. For a RUN it asks `forge-dispatch-resolve.js` what
// the route actually is and SHOWS it — engine, model, tier, effort, and the
// reason the router gives — as a read-out rather than a control. For a CHAT it
// is the operator's own tool choice, nobody's contract is involved, and the
// picker is real.
//
// Same rule as everywhere else in this repo: the log is the proof, the UI is
// not allowed to narrate something else.

import Foundation
import ForgeKit

/// The subset of `forge-dispatch-resolve.js --json` this screen reads.
///
/// A struct and not `[String: Any]`: the resolver emits ~30 keys and grows
/// additively, and decoding only what is drawn means a new key upstream can
/// never break this screen. Everything is optional for the same reason.
struct ResolvedRoute: Decodable, Hashable {
    let engine: String?
    let model: String?
    let alias: String?
    let tier: String?
    let effort: String?
    let reason: String?
    let route_source: String?
    let dispatch_engine: String?
    let worker_reason_code: String?
    let dispatch_allowed: Bool?
    let prefs_ok: Bool?

    var forgeEngine: ForgeEngine { ForgeEngine(dispatch_engine ?? engine) }

    /// What the operator reads: "sonnet · standard · low".
    var summary: String {
        [alias ?? model, tier, effort].compactMap { $0 }.filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    /// Why the router chose it. `reason` is the unit-level cause
    /// ("unit-type:execute-task"); `route_source` is which pref table answered.
    var why: String {
        [reason, route_source].compactMap { $0 }.filter { !$0.isEmpty }
            .joined(separator: " · ")
    }
}

@MainActor
final class RouteResolver: ObservableObject {
    static let shared = RouteResolver()

    @Published private(set) var routes: [String: ResolvedRoute] = [:]
    @Published private(set) var failed: Set<String> = []

    private var inFlight: Set<String> = []

    /// Keyed by cwd + unit type: the same project resolves differently for
    /// `plan-slice` than for `execute-task`, which is the entire point of the
    /// tier tables and would be erased by caching on cwd alone.
    private func key(_ cwd: String, _ unit: String) -> String { "\(unit)@\(cwd)" }

    func route(cwd: String?, unitType: String = "execute-task") -> ResolvedRoute? {
        guard let cwd else { return nil }
        return routes[key(cwd, unitType)]
    }

    func didFail(cwd: String?, unitType: String = "execute-task") -> Bool {
        guard let cwd else { return false }
        return failed.contains(key(cwd, unitType))
    }

    /// Resolved once per (cwd, unit) per launch. The answer only changes when
    /// prefs change, and prefs change from a screen that can invalidate this
    /// itself — polling a spawned node process behind a composer would cost a
    /// subprocess per keystroke to answer a question with a stable answer.
    func resolve(cwd: String?, unitType: String = "execute-task") {
        guard let cwd else { return }
        let k = key(cwd, unitType)
        guard routes[k] == nil, !inFlight.contains(k) else { return }
        inFlight.insert(k)

        Task.detached(priority: .userInitiated) {
            let value = ForgeCore.runJSON(
                ResolvedRoute.self, "forge-dispatch-resolve.js",
                ["--unit-type", unitType, "--cwd", cwd, "--json"], cwd: cwd)
            await MainActor.run {
                self.inFlight.remove(k)
                if let value { self.routes[k] = value } else { self.failed.insert(k) }
            }
        }
    }

    /// Called when prefs are saved, so the read-out cannot go stale behind the
    /// screen that changed it.
    func invalidate() {
        routes.removeAll()
        failed.removeAll()
    }
}

// MARK: - What the operator is starting

/// The three things a composer line can be, and who decides the engine for each.
enum HomeIntent: String, CaseIterable, Identifiable {
    /// A conversation with an LLM. The operator picks the tool.
    case chat
    /// `/forge-auto`, `/forge-next` — the orchestrator dispatches units and the
    /// router picks the engine per unit.
    case run
    /// A plain login shell. No engine is involved at all.
    case shell

    var id: String { rawValue }

    var title: String {
        switch self {
        case .chat:  return "Conversar"
        case .run:   return "Rodar"
        case .shell: return "Shell"
        }
    }

    var icon: String {
        switch self {
        case .chat:  return "bubble.left.and.bubble.right"
        case .run:   return "play.circle"
        case .shell: return "terminal"
        }
    }

    /// Whether the engine is the operator's to choose on this screen.
    var enginePickable: Bool { self == .chat }

    var placeholder: String {
        switch self {
        case .chat:  return "Pergunte qualquer coisa…"
        case .run:   return "/forge-auto, /forge-next — ou o que rodar"
        case .shell: return "um comando — ou Enter para só o shell"
        }
    }
}

// MARK: - Is the CLI even installed

/// Which chat CLIs exist on this machine.
///
/// Probed, not assumed. Offering "Codex" on a Mac that has no `codex` binary
/// produces a session that opens and immediately prints `command not found` —
/// which is legible, but it is a dead option dressed as a live one, and the
/// whole reason the run mode shows a read-out instead of a picker is that this
/// app does not ship controls that do nothing.
@MainActor
final class EngineAvailability: ObservableObject {
    static let shared = EngineAvailability()

    @Published private(set) var installed: Set<String> = ["claude"]
    private var probed = false

    func probe() {
        guard !probed else { return }
        probed = true
        Task.detached(priority: .utility) {
            var found: Set<String> = []
            for name in ["claude", "codex", "agy"] {
                if EngineAvailability.onPath(name) { found.insert(name) }
            }
            await MainActor.run { self.installed = found }
        }
    }

    func has(_ engine: ForgeEngine) -> Bool { installed.contains(engine.rawValue) }

    /// A login shell, because the CLIs are installed by tools that write to
    /// `~/.zshrc` (nvm, mise, homebrew on Apple Silicon) and a GUI app's own
    /// PATH under launchd contains none of them — the same trap `NodeLocator`
    /// already documents for node.
    private nonisolated static func onPath(_ name: String) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo
            .environment["SHELL"] ?? "/bin/zsh")
        p.arguments = ["-lc", "command -v \(name)"]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = Pipe()
        do { try p.run() } catch { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0
    }
}
