// Stores — observable state backing the UI.
//
// Refresh costs differ by an order of magnitude, so the cadences do too:
//   gates/runs → local JSON reads, polled every 2s
//   accounts   → one CLI call, refreshed on demand
//   usage      → a real API request per account (~9 tokens each), so it is
//                manual/cached only. Polling it on a timer would quietly spend
//                the user's quota just to keep a progress bar warm.

import SwiftUI
import Foundation
import ForgeKit

// MARK: - Workspaces

/// Which projects to watch. Editable by hand, in either of two shapes — the
/// legacy flat array of paths, or the versioned object with roots, typed entries
/// and quarantine. All shape knowledge lives in `WorkspaceRegistry` (ForgeKit,
/// hence testable); this enum is the file I/O around it and nothing more.
enum Workspaces {
    static var home: String { FileManager.default.homeDirectoryForCurrentUser.path }

    static var file: String { "\(home)/.claude/\(WorkspaceRegistry.filename)" }

    static func load() -> [String] { loadOutcome().visible }

    /// Same read as `load()`, but keeps "the file could not be parsed" apart
    /// from "the file parsed and declares nothing" — the distinction I-20260802223042
    /// exists to put back on screen. `load()` delegates here so every other
    /// caller keeps seeing a plain `[String]`.
    static func loadOutcome() -> (visible: [String], unreadable: Bool) {
        guard let data = FileManager.default.contents(atPath: file) else {
            // `contents(atPath:)` returns nil both when the file is absent and
            // when it exists but could not be read (EACCES, I/O error). Those
            // are different events — a present-but-unreadable file must fire
            // the same notice as an unparseable one (R2 review fix, S02-REVIEW),
            // not render like a fresh install with nothing registered yet.
            let unreadable = FileManager.default.fileExists(atPath: file)
            if unreadable {
                FileHandle.standardError.write(Data(
                    "Forge: \(file) não pôde ser lido — a lista de projetos NÃO foi alterada. Corrija o arquivo (há backup .bak ao lado após a migração).\n".utf8))
            }
            return ([], unreadable)
        }
        guard let r = WorkspaceRegistry.resolution(from: data, home: home) else {
            // Not `[]`. An unreadable registry is an event: returning an empty
            // list here is what used to make a corrupt file and a fresh install
            // look identical on screen.
            FileHandle.standardError.write(Data(
                "Forge: \(file) não pôde ser lido — a lista de projetos NÃO foi alterada. Corrija o arquivo (há backup .bak ao lado após a migração).\n".utf8))
            return ([], true)
        }
        // "Does not resolve" and "was deleted" both remove a card, so they are
        // reported apart — only the second is the operator's own doing.
        for bad in r.rejected {
            FileHandle.standardError.write(Data(
                "Forge: entrada ignorada em \(WorkspaceRegistry.filename): \"\(bad.stored)\" — \(bad.reason)\n".utf8))
        }
        return (r.paths.filter { FileManager.default.fileExists(atPath: $0) }, false)
    }

    /// Absolute roots the registry declares, resolved against `home` — what
    /// discovery should scan (see `ProjectDiscovery.scan(declaredRoots:)`).
    /// `[]` on an absent file, a legacy shape, or an unreadable file — the
    /// caller falls back to the hardcoded name-list scan in every one of
    /// those cases, so the unreadable/empty distinction is not needed here.
    static func declaredRoots() -> [String] {
        guard let data = FileManager.default.contents(atPath: file) else { return [] }
        return WorkspaceRegistry.resolution(from: data, home: home)?.roots ?? []
    }

    /// Every record the registry resolves, whether or not its directory still
    /// exists on disk — the base `add`/`remove` build `newPaths` from, never
    /// `load()`.
    ///
    /// `load()` is filtered to what is visible on screen (R2 review fix,
    /// S01-REVIEW): a directory that is unmounted or briefly moved still
    /// resolves fine and simply is not offered by the fileExists filter. Any
    /// unrelated `save()` recomputes the file from `newPaths` — so building
    /// `newPaths` from the filtered list would silently delete every record
    /// currently absent from disk, migration `quarantine[]` included, as a
    /// side effect of adding or removing something else entirely. The
    /// `fileExists` check must stay display-only; it must never feed a write.
    ///
    /// I-20260803132250: this used to be a comment alone. `add`/`remove` now
    /// route their mutation through `WorkspaceRegistry.mutatedPaths(allResolved:)`
    /// (ForgeKit, pure, no `visible` parameter to accidentally pass) — that
    /// function, not this one, is what `ForgeKitTests` exercises to assert the
    /// invariant at the call site, since `ForgeKitTests` cannot import this
    /// `Forge` executable target.
    /// Paths the registry declares `kind: workspace` — see
    /// `ProjectOrganiser.containmentHazards`, the only consumer. `[]` on an
    /// absent, legacy or unreadable file, which is the same conservative answer
    /// in all three cases: nothing is declared, so nothing is suppressed.
    static func declaredWorkspaces() -> Set<String> {
        guard let data = FileManager.default.contents(atPath: file) else { return [] }
        return WorkspaceRegistry.resolution(from: data, home: home)?.declaredWorkspaces ?? []
    }

    /// How many repos each active entry declares, keyed by absolute path.
    /// A path is absent when its `repos[]` is empty — "never measured", never
    /// "owns zero"; `WorkspaceRegistry.repoCounts` documents why that
    /// distinction is load-bearing. `[:]` on an absent, legacy or unreadable
    /// file, all three of which mean the same thing here: nothing measured.
    static func repoCounts() -> [String: Int] {
        guard let data = FileManager.default.contents(atPath: file) else { return [:] }
        return WorkspaceRegistry.resolution(from: data, home: home)?.repoCounts ?? [:]
    }

    static func loadAllResolved() -> [String] {
        guard let data = FileManager.default.contents(atPath: file) else { return [] }
        return WorkspaceRegistry.resolution(from: data, home: home)?.paths ?? []
    }

    static func save(_ list: [String]) {
        let original = FileManager.default.contents(atPath: file)
        // A nil here is a refusal, not a failure to encode: the file on disk is
        // in a shape we could not parse, and overwriting it would trade the
        // operator's roots and quarantine for one click.
        guard let data = WorkspaceRegistry.updatedData(
            original: original, newPaths: list, home: home) else {
            FileHandle.standardError.write(Data(
                "Forge: \(file) está ilegível — recusando sobrescrever para não perder roots/quarentena.\n".utf8))
            return
        }
        try? FileManager.default.createDirectory(
            atPath: (file as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true)
        try? data.write(to: URL(fileURLWithPath: file), options: .atomic)
    }

    static func add(_ p: String)    { save(WorkspaceRegistry.mutatedPaths(allResolved: loadAllResolved(), adding: p)) }
    static func remove(_ p: String) { save(WorkspaceRegistry.mutatedPaths(allResolved: loadAllResolved(), removing: p)) }
}

// MARK: - App state

@MainActor
final class AppState: ObservableObject {
    static let shared = AppState()

    /// Posted after every cheap reload so the Dock badge can follow along
    /// without running a second timer of its own.
    static let didChange = Notification.Name("ForgeAppStateDidChange")

    @Published private(set) var gates: [Gate] = []
    @Published private(set) var runs: [Run] = []
    @Published private(set) var accounts: [Account] = []
    @Published private(set) var activeAccount: String?

    /// Where `activeAccount` came from. Never collapsed into the name: a label
    /// that cannot say why it believes something is a label that cannot be
    /// checked.
    enum AccountSource { case environment, registry, unknown }
    @Published private(set) var activeAccountSource: AccountSource = .unknown
    @Published private(set) var usage: [String: AccountUsage] = [:]
    @Published private(set) var workspaces: [String] = []

    /// Registered paths that hold a `.gsd/` but no work — repos a run reached
    /// into, which our tooling enrolled as a side effect. Surfaced rather than
    /// filtered away: a misclassification has to cost a click, never a project.
    @Published private(set) var touchedWorkspaces: [String] = []

    /// Paths the registry declares `kind: workspace`. A workspace containing
    /// its own members is the normal case, so the containment hazard must not
    /// accuse it (I-20260803154521).
    @Published private(set) var declaredWorkspaces: Set<String> = []

    /// Declared repo count per project, for the card's `"workspace · 33 repos"`
    /// line. A missing key means unmeasured and the card stays silent about
    /// repos — see `WorkspaceRegistry.repoCounts`.
    @Published private(set) var repoCounts: [String: Int] = [:]

    /// True exactly when the registry file exists but could not be parsed —
    /// set by `reloadCheap()` from `Workspaces.loadOutcome()`. The Projects
    /// screen renders a notice while this is true instead of a silently
    /// blank list (closes I-20260802223042).
    @Published private(set) var registryUnreadable = false

    /// Raw values of the two `app.*` prefs, read once at init and on explicit
    /// reload only — see `loadAppDefaults()`.
    @Published private(set) var defaultWorkspacePref = ""
    @Published private(set) var sessionRootDir = ""

    @Published var usageLoading = false
    @Published var usageCheckedAt: Date?
    @Published var toast: Toast?

    /// Live terminal sessions hosted inside the app.
    @Published private(set) var sessions: [TerminalSession] = []

    /// Descriptors loaded from `~/.claude/forge-sessions.json` at launch —
    /// the offer T04 renders, never opened automatically. Loading this never
    /// starts a session: doing so would spend the operator's account before
    /// they asked for anything.
    @Published private(set) var restorable: [SessionDescriptor] = []

    /// The account name and `setup-token` session currently in flight, set by
    /// `startAccountSetup(name:)` and cleared by `finishAccountSetup()`. `nil`
    /// means no registration is in progress — T04 uses this to render (or
    /// hide) the "registro em curso" banner.
    @Published private(set) var pendingAccountSetup: (name: String, session: TerminalSession)?

    /// Which sidebar section is showing. Owned here rather than as RootView
    /// `@State` because opening a session has to be able to take the operator
    /// to the terminal — the composer that creates it lives on another screen.
    ///
    /// Persisted on every change, and restored on every launch — not just after
    /// a self-update relaunch. One code path, same storage as `lastWorkspace`.
    /// An unknown raw value (a renamed sidebar label invalidates what was saved)
    /// falls back explicitly; see `SectionRestore`.
    @Published var section: Section? = Section(rawValue: SectionRestore.resolve(
        rawValue: UserDefaults.standard.string(forKey: "lastSection"),
        // Work sections only. A settings section restored here would select a
        // sidebar row that no longer exists, leaving the window on a screen with
        // nothing highlighted — the state D31's guard exists to prevent, now
        // reachable from a saved value rather than from a rename.
        valid: Section.workCases.map(\.rawValue),
        fallback: Section.terminal.rawValue)) ?? .terminal {
        didSet {
            UserDefaults.standard.set(section?.rawValue ?? "", forKey: "lastSection")
        }
    }

    /// Which session the terminal screen shows. Same reason: the creating code
    /// path needs to name it, and the terminal screen may not be on screen yet.
    @Published var focusedSession: UUID?

    /// A line for the composer to adopt, set by something outside it.
    ///
    /// Published rather than a binding on the composer's own `text`: the
    /// composer owns what is typed (it parses `/` and `@` against the caret as
    /// it goes), and handing that state out would give two writers to one
    /// string. A seed is a one-shot request — the composer takes it and clears
    /// it — which is a different thing from shared ownership.
    @Published var composerSeed: String?

    /// Show a session: select it and go to the terminal. Every creation path
    /// ends here, so "created but nothing visibly happened" cannot come back.
    func focus(_ s: TerminalSession?) {
        if let s { focusedSession = s.id }
        section = .terminal
    }

    /// Whether the inline command bar is floating over the terminal.
    ///
    /// ⌘T raises it instead of opening a modal sheet. The old sheet asked
    /// "what do you want to do?" before letting you do anything, and the
    /// answer was almost always "just give me a terminal" — which is now
    /// Enter on an empty line.
    @Published var showComposer = false

    /// The advanced sheet (⌘⇧N). Still the only place that can pick among
    /// several active runs, which the one-line command bar cannot express.
    @Published var showLauncherSheet = false

    /// The session the terminal screen is actually showing, resolved the same
    /// way the view resolves it — so a shortcut can never act on a session the
    /// operator is not looking at.
    var visibleSession: TerminalSession? {
        let id = TerminalFocus.resolve(selection: focusedSession, among: sessions.map(\.id))
        return sessions.first { $0.id == id }
    }

    /// ⌘W. Confirms exactly like the button does — a keystroke must not be a
    /// cheaper way to kill a running unit than clicking.
    func closeVisibleSession() {
        guard let s = visibleSession else { return }
        _ = closeSession(s, confirm: true)
    }

    /// ⌘1…⌘9. Out-of-range is a no-op, not a clamp: ⌘5 with three tabs open
    /// means nothing, and jumping to the last one would be a surprise.
    func focusSession(at index: Int) {
        guard sessions.indices.contains(index) else { return }
        focusedSession = sessions[index].id
    }

    /// ⌘⇧[ / ⌘⇧]. Wraps, like every tabbed app.
    func cycleSession(by delta: Int) {
        guard !sessions.isEmpty,
              let current = visibleSession,
              let idx = sessions.firstIndex(where: { $0.id == current.id }) else { return }
        let next = (idx + delta + sessions.count) % sessions.count
        focusedSession = sessions[next].id
    }

    /// Rich per-project status from forge-status.js, keyed by cwd. Spawns node,
    /// so it is refreshed on a slow cadence — unlike the gate/run files, which
    /// are plain reads driven by FSEvents.
    @Published private(set) var status: [String: StatusPayload] = [:]
    private var statusLoading: Set<String> = []

    private var timer: Timer?
    private var watcher: Watcher?

    struct Toast: Identifiable, Equatable {
        let id = UUID()
        let text: String
        let isError: Bool
    }

    var pending: [Gate] { gates.filter(\.isPending).sorted { $0.created_at < $1.created_at } }

    var recent: [Gate] {
        gates.filter { !$0.isPending }
            .sorted { $0.created_at > $1.created_at }
            .prefix(20).map { $0 }
    }

    var liveRuns: [Run] { runs.filter { $0.active }.sorted { $0.started_at > $1.started_at } }

    /// Accounts ordered by real weekly headroom when known, so the one to use
    /// next is simply the one on top. Falls back to name order.
    var accountsByHeadroom: [Account] {
        accounts.sorted { a, b in
            let ua = usage[a.name]?.headroom
            let ub = usage[b.name]?.headroom
            if let ua, let ub, ua != ub { return ua > ub }
            if ua != nil, ub == nil { return true }
            if ua == nil, ub != nil { return false }
            return a.name < b.name
        }
    }

    init() {
        restorable = SessionStore.load(path: SessionStore.path(home: NSHomeDirectory()))
        reloadCheap()
        loadAccounts()
        loadAppDefaults()

        // FSEvents drives updates; the timer is only a safety net. It also
        // covers the one change no filesystem can report: a gate reaching its
        // expiry, which is a clock event, not a write.
        watcher = Watcher { [weak self] in
            Task { @MainActor in self?.reloadCheap() }
        }
        watcher?.watch(workspaces)

        timer = Timer.scheduledTimer(withTimeInterval: 15.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.reloadCheap()
                // Progress only changes when a unit finishes, so a slow cadence
                // is plenty — and each call spawns node.
                self?.refreshStatus()
            }
        }
        refreshStatus()
    }

#if DEBUG
    /// An inert state for canvas previews. `init()` reads the operator's real
    /// `.gsd`, spawns node for the per-project status, installs an FSEvents
    /// watcher and starts a 15s timer — in a canvas that runs on every redraw,
    /// which makes the preview slow, machine-dependent and noisy. This does none
    /// of it, so the views render from whatever the preview stages.
    ///
    /// Not a `convenience init` in an extension: that would have to call
    /// `init()`, which is the work being avoided.
    init(preview: Void) {}
#endif

    deinit { timer?.invalidate() }

    // MARK: Cheap reload (files only)

    func reloadCheap() {
        // Registered ≠ project. Our own scripts used to write `.gsd/` into any
        // repo they touched, so the registry accumulated directories that never
        // held work (see `ProjectMarker`). Splitting here rather than in the
        // Projects screen fixes every consumer at once: the composer, the
        // pickers and the metrics screen stop offering a repo nobody planned
        // work in — which is the wrong-repo dispatch hazard `WorkspaceDefaults`
        // exists to prevent.
        let outcome = Workspaces.loadOutcome()
        registryUnreadable = outcome.unreadable
        // The notice (and its doc comment above) promises the list below was
        // NOT changed. `WorkspaceReloadDecision.split` (ForgeKit, hence
        // testable) is what makes that literally true: on `unreadable` it
        // returns the previous split untouched rather than rebuilding from
        // `outcome.visible`, which is always `[]` on that path — R1 review fix,
        // S02-REVIEW.
        let split = WorkspaceReloadDecision.split(
            previous: .init(workspaces: workspaces, touchedWorkspaces: touchedWorkspaces),
            outcome: outcome,
            isProject: { ProjectMarker.classify($0).kind == .project })
        workspaces = split.workspaces
        touchedWorkspaces = split.touchedWorkspaces
        // Held over on `unreadable` for the same reason the split is: the
        // notice promises the list below was not changed, and dropping the
        // declarations would re-accuse a workspace still on screen.
        if !outcome.unreadable {
            declaredWorkspaces = Workspaces.declaredWorkspaces()
            repoCounts = Workspaces.repoCounts()
        }
        if outcome.unreadable {
            watcher?.watch(workspaces)
            NotificationCenter.default.post(name: Self.didChange, object: nil)
            return
        }

        var g: [Gate] = [], r: [Run] = []
        for ws in workspaces {
            g += Self.decodeDir("\(ws)/.gsd/forge/gates", as: Gate.self)
            r += Self.decodeDir("\(ws)/.gsd/forge/runs", as: Run.self)
        }
        gates = g
        runs = r
        // Follow projects being added or removed.
        watcher?.watch(workspaces)
        Notifier.shared.sync(pending: pending)
        NotificationCenter.default.post(name: Self.didChange, object: nil)
    }

    /// Decode every *.json in a directory, skipping anything unreadable —
    /// a half-written or corrupt file must never take the whole list down.
    private static func decodeDir<T: Decodable>(_ dir: String, as: T.Type) -> [T] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir)
        else { return [] }
        let dec = JSONDecoder()
        return names.filter { $0.hasSuffix(".json") }.compactMap { n in
            guard let d = FileManager.default.contents(atPath: "\(dir)/\(n)") else { return nil }
            return try? dec.decode(T.self, from: d)
        }
    }

    /// Open tasks across every registered project, for the sidebar badge.
    ///
    /// Aggregated here rather than in `ItemsView` because the badge has to be
    /// right while the operator is looking at some other section — a count that
    /// only exists while its own screen is open is not a badge, it is a label.
    @Published private(set) var openItemCount = 0

    /// Recount open items across all workspaces. One shell-out per project,
    /// riding the same cadence as `refreshStatus` instead of adding a poll.
    func refreshItemCount() {
        let targets = workspaces
        guard !targets.isEmpty else { openItemCount = 0; return }
        Task.detached(priority: .utility) {
            var total = 0
            for cwd in targets {
                let items = ForgeCore.runJSON([Item].self, "forge-items.js",
                                               ["--list", "--json", "--cwd", cwd]) ?? []
                total += ItemBoard.openCount(items)
            }
            await MainActor.run { self.openItemCount = total }
        }
    }

    /// Fetch status for the projects that have a live run — the only ones whose
    /// progress can change while you watch.
    func refreshStatus(force: Bool = false) {
        refreshItemCount()
        let targets = Set(liveRuns.map(\.cwd)).union(force ? Set(workspaces) : [])
        for cwd in targets where !statusLoading.contains(cwd) {
            statusLoading.insert(cwd)
            Task.detached(priority: .utility) {
                let payload = ForgeCore.runJSON(StatusPayload.self, "forge-status.js",
                                                ["--json", "--cwd", cwd])
                await MainActor.run {
                    self.statusLoading.remove(cwd)
                    if let payload { self.status[cwd] = payload }
                }
            }
        }
    }

    // MARK: Workspace defaults

    /// Reads `app.default_workspace` and `app.session_root_dir` once at init
    /// plus on explicit reload — this must never join `reloadCheap`/the 15s
    /// timer. Those two knobs only change when the operator edits prefs by
    /// hand, so polling them on a timer would spawn node every couple of
    /// seconds for nothing.
    func loadAppDefaults() {
        // `--global-only` (R3 fix, S04 review): `app.*` is a per-operator
        // setting, never per-project. Without this flag, ForgeCore.runJSON
        // inherits the app process's cwd — which can carry a project-local
        // .gsd/forge-prefs.jsonc (e.g. `swift run` inside this very repo) —
        // and that local layer would silently override the operator's
        // global default. This must always resolve the global layer alone.
        let resolved = ForgeCore.runJSON(
            ModelsStore.ResolvedPrefs.self, "forge-prefs.js", ["--resolved", "--global-only"])
        if case .object(let app)? = resolved?.prefs?["app"] {
            defaultWorkspacePref = app["default_workspace"]?.asString ?? ""
            sessionRootDir = app["session_root_dir"]?.asString ?? ""
        } else {
            defaultWorkspacePref = ""
            sessionRootDir = ""
        }
        // A misconfigured default must be visible, not silently dropped.
        if let warning = preselection.warning {
            show(warning, error: true)
        }
        if let warning = sessionRootResolution.warning {
            show(warning, error: true)
        }
    }

    /// The last project a session was opened in, persisted the same way the
    /// rest of the app persists small per-user state (`Updates.swift:29`,
    /// `Projects.swift:86`) — no new file next to `forge-gate-workspaces.json`.
    var lastUsedWorkspace: String {
        UserDefaults.standard.string(forKey: "lastWorkspace") ?? ""
    }

    func rememberWorkspace(_ path: String) {
        guard !path.isEmpty else { return }
        UserDefaults.standard.set(path, forKey: "lastWorkspace")
    }

    /// The single entry point every call site uses to ask "which project
    /// should this start in?" — pref wins, then a still-registered
    /// last-used, then nothing. Never `workspaces.first`; see
    /// `WorkspaceDefaults` for why.
    var preselection: Preselection {
        WorkspaceDefaults.preselect(
            configuredDefault: defaultWorkspacePref,
            lastUsed: lastUsedWorkspace,
            known: workspaces)
    }

    /// Full resolution (path + optional warning) for the session root —
    /// computed once so `resolvedSessionRoot` and the `loadAppDefaults()`
    /// toast agree on the exact same check.
    private var sessionRootResolution: WorkspaceDefaults.SessionRootResolution {
        WorkspaceDefaults.sessionRoot(
            configured: sessionRootDir,
            home: FileManager.default.homeDirectoryForCurrentUser.path)
    }

    /// Where project-less `shell`/`chat` sessions open — the only sanctioned
    /// non-project cwd. Falls back to `$HOME` (with a toast, see
    /// `loadAppDefaults()`) when the configured directory does not exist.
    var resolvedSessionRoot: String { sessionRootResolution.path }

    // MARK: Accounts

    func loadAccounts() {
        guard let payload = ForgeCore.runJSON(
            AccountsPayload.self, "forge-accounts.js", ["--list", "--json"])
        else { return }
        accounts = payload.accounts
        resolveActiveAccount(env: payload.env_active, registry: payload.active)
    }

    /// Resolves `activeAccount`/`activeAccountSource` from the two candidates
    /// a `--list --json` payload can carry. Shared by `loadAccounts()` and
    /// `finishAccountSetup()` (S07) so the two call sites can never disagree
    /// on which one wins — the exact duplication trap S07/D1 names.
    ///
    /// Two different facts wear the same name, and which one it is changes
    /// what the operator should do about it:
    ///
    ///   env_active — this app process carries FORGE_ACCOUNT and (crucially)
    ///     ANTHROPIC_AUTH_TOKEN, inherited from whatever launched it. The
    ///     shell-init `claude()` function goes INERT when a token is already
    ///     set without `--account`, so every bare `claude` in a session
    ///     spawned here runs on that account, outranking the registry.
    ///   active — the forge-accounts default, which is what applies when the
    ///     app was launched clean (from the Dock, say).
    ///
    /// env wins because it is what actually happens. Recording WHICH it was
    /// is the point: "vh, herdada do ambiente" and "vh, padrão do registro"
    /// look identical on screen and mean different things when the default
    /// says lookchina.
    private func resolveActiveAccount(env: String?, registry: String?) {
        if let env {
            activeAccount = env
            activeAccountSource = .environment
        } else if let reg = registry {
            activeAccount = reg
            activeAccountSource = .registry
        } else {
            activeAccount = nil
            activeAccountSource = .unknown
        }
    }

    /// Opens `forge-accounts.js --add <name> --setup` inside the app's
    /// embedded terminal, via the same argv→bootstrap→session path
    /// `resumeSession` already uses — no bare subprocess spawn, no
    /// hand-assembled command string.
    ///
    /// The session this creates is `persistable: false` (S07/D5): it is the
    /// one place in the whole app where an operator-typed Claude token
    /// passes through the PTY, and it must never reach
    /// `~/.claude/forge-sessions.json`, not even as an unopened resumable
    /// offer with no token content in it.
    ///
    /// Only reachable from a button action (D11) — nothing in
    /// `onAppear`/`init`/`task` calls this.
    func startAccountSetup(name: String) {
        guard AccountName.isValid(name) else {
            show(AccountName.rejection(name) ?? "nome de conta inválido", error: true)
            return
        }
        guard let node = ForgeCore.nodePath else {
            show(ForgeCore.nodeError, error: true)
            return
        }
        guard let script = ForgeCore.engine("forge-accounts.js") else {
            show("forge-accounts.js não encontrado", error: true)
            return
        }
        guard let argv = AccountAdd.argv(node: node, script: script, name: name) else {
            show(AccountName.rejection(name) ?? "nome de conta inválido", error: true)
            return
        }
        let boot = argv.map(shq).joined(separator: " ")
        let session = TerminalSession(
            cwd: resolvedSessionRoot, title: "Registrar \(name)", bootstrap: boot,
            engine: "claude", persistable: false)
        sessions.append(session)
        focus(session)
        pendingAccountSetup = (name: name, session: session)
        // Deliberately no persistSessions() here: the session is
        // non-persistable by construction, and writing now would just
        // re-save the file without it — a no-op that costs a disk write.
    }

    /// Relists accounts, reconciles the result against what `startAccountSetup`
    /// last knew, and decides whether the registration succeeded by reading
    /// `has_token` off the reconciled list — never the shell's exit code
    /// (D6): the setup command runs inside a login shell whose own exit code
    /// is reported by `TerminalHost`, not the setup command's.
    ///
    /// Idempotent: a second call with no pending setup is a no-op.
    func finishAccountSetup() {
        guard let pending = pendingAccountSetup else { return }
        guard let payload = ForgeCore.runJSON(
            AccountsPayload.self, "forge-accounts.js", ["--list", "--json"])
        else {
            // Read failed — keep `pendingAccountSetup` rather than asserting
            // a failure this call never actually measured.
            show("não consegui confirmar o registro — tente novamente", error: true)
            return
        }
        let merged = AccountMerge.reconcile(previous: accounts, incoming: payload)
        accounts = merged.accounts
        resolveActiveAccount(env: payload.env_active, registry: payload.active)

        switch AccountMerge.outcome(for: pending.name, in: merged) {
        case .registered:
            show("\(pending.name) registrada com sucesso")
        case .registeredWithoutToken:
            show("\(pending.name) registrada, mas ainda sem token", error: true)
        case .missingFromRegistry:
            show("\(pending.name) não encontrada no registro", error: true)
        }
        pendingAccountSetup = nil
    }

    /// Costs a real API call per account — only ever on explicit request.
    func refreshUsage() {
        guard !usageLoading else { return }
        usageLoading = true
        Task.detached(priority: .userInitiated) {
            let rows = ForgeCore.runJSON([AccountUsage].self, "forge-usage.js", ["--json"]) ?? []
            await MainActor.run {
                for row in rows { self.usage[row.name] = row }
                self.usageLoading = false
                self.usageCheckedAt = Date()
                if rows.isEmpty {
                    self.show("Não consegui ler o uso das contas", error: true)
                }
            }
        }
    }

    // MARK: Actions

    func answer(_ gate: Gate, choice: String) {
        guard let cwd = gate.cwd else { return show("gate sem cwd", error: true) }
        answer(gateID: gate.id, cwd: cwd, choice: choice)
    }

    /// Answering by id, so a notification action can resolve a gate without the
    /// decoded object in hand.
    func answer(gateID: String, cwd: String, choice: String) {
        let r = ForgeCore.run("forge-gate.js",
                              ["--answer", gateID, "--choice", choice, "--cwd", cwd])
        // The common failure here is benign: the gate expired or was answered
        // elsewhere between render and click.
        if !r.ok {
            show(r.stderr.isEmpty ? "não foi possível responder" : r.stderr, error: true)
        }
        Notifier.shared.forget(gateID)
        reloadCheap()
    }

    func togglePause(_ run: Run) {
        let paused = ForgeCore.isPaused(cwd: run.cwd, runId: run.id)
        if let err = ForgeCore.setPaused(!paused, cwd: run.cwd, runId: run.id) {
            show(err, error: true)
        } else {
            show(paused ? "Retomado — segue na próxima unidade"
                        : "Pausa pedida — para ao fim da unidade atual")
        }
        reloadCheap()
    }

    func isPaused(_ run: Run) -> Bool {
        ForgeCore.isPaused(cwd: run.cwd, runId: run.id)
    }

    // MARK: Terminal sessions

    /// Writes the current session list to `~/.claude/forge-sessions.json`,
    /// applying the 8-most-recent-deduplicated-by-`cwd` retention rule before
    /// saving.
    ///
    /// `sessions.reversed()` is deliberate: `append` puts the newest session
    /// last, but `SessionStore.retained` trusts "first occurrence wins" as
    /// most-recent-first (T01) — reversing here is what makes "the 8 most
    /// recent per distinct cwd" mean what it says instead of keeping the 8
    /// oldest.
    ///
    /// `restorable` (the launch-time snapshot of descriptors not yet resumed)
    /// is appended AFTER the live descriptors, never before: live sessions are
    /// the more recent activity, and `retained` keeps the first occurrence per
    /// `cwd`, so live must win a `cwd` collision. This is what keeps
    /// unconsumed restorable offers from being dropped by a save triggered by
    /// resuming or closing an unrelated session (R1, S06 review).
    private func persistSessions() {
        // Filtered by `persistable` (S07/D5) BEFORE mapping to descriptors —
        // the setup-token session AppState.startAccountSetup opens sets
        // `persistable: false`, so it never becomes a SessionDescriptor and
        // never reaches this file, regardless of its title or bootstrap.
        let live = sessions.reversed().filter(\.persistable).map {
            SessionDescriptor(cwd: $0.cwd, title: $0.title, engine: $0.engine,
                               account: $0.account, runId: $0.runId)
        }
        SessionStore.save(SessionStore.retained(Array(live) + restorable),
                           to: SessionStore.path(home: NSHomeDirectory()))
    }

    /// Turns a persisted `SessionDescriptor` (T01) into a live terminal
    /// session — the only place a restorable descriptor is allowed to become
    /// a real process, and only because this is called from a button action
    /// (never `onAppear`/`init`/`task`; see `TerminalsView.restorableOffer`
    /// and `SidebarSessionRow`-style rows in `Views.swift`).
    ///
    /// `SessionResume.plan(for:)` (T02) is the only thing that builds the
    /// argv; this function never assembles a command by hand. A `nil` plan
    /// means the descriptor's engine cannot resume (only `claude` can) — that
    /// is surfaced as a message, not a silent no-op, so a click never reads as
    /// dead.
    ///
    /// `descriptor.account`, like `cwd`, came off disk
    /// (`~/.claude/forge-sessions.json`). It sits in a VALUE position after
    /// `--account` in the plan's argv, which is a weaker hazard than an
    /// interpolated flag but the same family the S05 review flagged: a
    /// malformed value can still be misread as another option by a CLI arg
    /// parser. So the shape is checked here against `AccountName.isValid(_:)`
    /// (ForgeKit) — the single validator S07 promoted this field to, so the
    /// read path (here) and the write path (account creation) can never
    /// disagree on what "legal" means — and a malformed account is dropped
    /// from the resume argv (not sanitised, not silently kept) — the session
    /// still opens, without `--account`.
    func resumeSession(_ descriptor: SessionDescriptor) {
        guard let plan = SessionResume.plan(for: descriptor) else {
            show("\(descriptor.engine) ainda não retoma sessão — abra um terminal novo", error: true)
            return
        }
        var argv = plan.argv
        var account = descriptor.account
        if let name = account, !AccountName.isValid(name) {
            account = nil
            if let idx = argv.firstIndex(of: "--account"), idx + 1 < argv.count {
                argv.removeSubrange(idx...(idx + 1))
            }
        }
        let boot = argv.map(shq).joined(separator: " ")
        sessions.append(TerminalSession(
            cwd: plan.cwd, title: descriptor.title, bootstrap: boot,
            runId: descriptor.runId, account: account, engine: descriptor.engine))
        focus(sessions.last)
        // Consumed: it is now a live session, not an unresumed offer — leaving
        // it in `restorable` would let `persistSessions()` keep re-saving it
        // as if it were still waiting to be picked up.
        restorable.removeAll { $0 == descriptor }
        persistSessions()
    }

    /// Open a terminal inside the app. The account is selected with
    /// `claude --account <name>`, the flag the shell-init hook understands —
    /// never by exporting a token, which would leak it into the environment.
    ///
    /// `runId` matters for real: Forge refuses a bare `/forge-auto` once two or
    /// more runs are active in a workspace (multi_run.refused_when_active_count),
    /// which is exactly the case when several milestones share a project.
    func newSession(cwd: String, mode: LauncherSheet.Mode, text: String,
                    account: String, runId: String = "") {
        let desc = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let claudeArgs = account.isEmpty ? "" : " --account \(shq(account))"

        var boot: String?
        var attachedRun: String?

        switch mode {
        case .shell:
            boot = nil
        case .chat:
            boot = "claude\(claudeArgs)"
        case .auto:
            let slash = runId.isEmpty ? "/forge-auto" : "/forge-auto \(runId)"
            attachedRun = runId.isEmpty ? nil : runId
            boot = "claude\(claudeArgs) \(shq(slash))"
        case .newMilestone:
            let slash = desc.isEmpty ? "/forge-new-milestone" : "/forge-new-milestone \(desc)"
            boot = "claude\(claudeArgs) \(shq(slash))"
        case .task:
            guard !desc.isEmpty else { return show("descreva a task", error: true) }
            boot = "claude\(claudeArgs) \(shq("/forge-task \(desc)"))"
        }

        let project = URL(fileURLWithPath: cwd).lastPathComponent
        let title = mode == .shell ? project : "\(project) · \(mode.shortLabel)"
        sessions.append(TerminalSession(
            cwd: cwd, title: title, bootstrap: boot,
            runId: attachedRun, account: account.isEmpty ? nil : account, engine: "claude"))
        focus(sessions.last)
        persistSessions()
    }

    /// Open a session from a free-form line. A leading slash command is passed
    /// through verbatim — whatever Forge gains tomorrow works here with no code
    /// change — and plain text becomes a conversation.
    /// `engine` is the CLI a plain question opens.
    ///
    /// A SLASH COMMAND ALWAYS OPENS CLAUDE, whatever the picker says, and that
    /// is not a limitation — it is the routing contract. `/forge-auto` hands the
    /// work to the orchestrator, which resolves `{engine, model, tier}` per unit
    /// from prefs; starting that loop inside Codex would not "run the milestone
    /// on Codex", it would run it nowhere. The picker governs conversations,
    /// which is the only thing on this screen that is the operator's to choose.
    /// `model` is the alias a CONVERSATION opens with (`sonnet`, `opus`, …).
    ///
    /// Like `engine`, it is dropped for a slash command, and for the same
    /// reason: a run resolves its model per unit from the tier tables, so
    /// pinning one on the command line would override the router for every unit
    /// the loop dispatches — the exact bypass `CLAUDE.md` forbids. Empty means
    /// "whatever the CLI defaults to", which is not the same as a choice.
    func newSessionRaw(cwd: String, prompt: String, account: String,
                       engine: String = "claude", model: String = "") {
        let (cmd, _) = ComposerParser.split(prompt)
        let effective = cmd == nil ? engine : "claude"
        // `--account` is a Claude wrapper flag; passing it to another CLI would
        // be an unrecognised argument, not a no-op.
        let accountArgs = (effective == "claude" && !account.isEmpty)
            ? " --account \(shq(account))" : ""
        // `--model` only where it is a command a slash command did not claim,
        // and only for Claude — the other CLIs take a different flag, and
        // guessing one is how a session opens on an unrecognised argument.
        let modelArgs = (effective == "claude" && cmd == nil && !model.isEmpty)
            ? " --model \(shq(model))" : ""
        let boot = "\(effective)\(accountArgs)\(modelArgs) \(shq(prompt))"
        let project = URL(fileURLWithPath: cwd).lastPathComponent
        let title = cmd.map { "\(project) · \($0.replacingOccurrences(of: "forge-", with: ""))" }
            ?? "\(project) · \(effective == "claude" ? "chat" : effective)"
        sessions.append(TerminalSession(
            cwd: cwd, title: title, bootstrap: boot,
            runId: nil, account: effective == "claude" && !account.isEmpty ? account : nil,
            engine: effective))
        focus(sessions.last)
        persistSessions()
    }

    @discardableResult
    func closeSession(_ s: TerminalSession, confirm: Bool = false) -> Bool {
        if confirm && s.isRunning {
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = "Encerrar \(s.tabLabel)?"
            alert.informativeText = s.runId != nil
                ? "A run continua salva em disco — você retoma com “Continuar milestone”. A unidade em andamento é interrompida."
                : "A sessão será encerrada."
            alert.addButton(withTitle: "Encerrar")
            alert.addButton(withTitle: "Cancelar")
            NSApp.activate(ignoringOtherApps: true)
            guard alert.runModal() == .alertFirstButtonReturn else { return false }
        }
        sessions.removeAll { $0.id == s.id }
        // The only place a PTY is allowed to die. The view layer keeps it
        // alive across navigation, so nothing else reclaims it — and skipping
        // this would leak one shell per closed session.
        TerminalViewStore.shared.closeSession(s.id)
        focusedSession = TerminalFocus.afterClosing(
            s.id, selection: focusedSession, remaining: sessions.map(\.id))
        persistSessions()
        return true
    }

    private func shq(_ s: String) -> String { ForgeCore.shellQuote(s) }

    /// Set the persistent default — what a bare `claude` attaches to. Distinct
    /// from launching: several terminals can run on different accounts without
    /// any of them changing this.
    func setDefaultAccount(_ name: String) {
        let r = ForgeCore.run("forge-accounts.js", ["--default", name])
        if r.ok { show("\(name) agora é a conta padrão"); loadAccounts() }
        else { show(r.stderr.isEmpty ? "falha ao definir padrão" : r.stderr, error: true) }
    }

    /// Record which Anthropic identity this account is, so the status line can
    /// name it. Captures the CURRENT session's identity — the engine refuses to
    /// clobber an existing one, and capturing automatically would risk stamping
    /// the wrong account.
    func captureAccountIdentity(_ name: String) {
        let r = ForgeCore.run("forge-accounts.js", ["--set-email", name])
        if r.ok { show("Identidade registrada em \(name)"); loadAccounts() }
        else { show(r.stderr.isEmpty ? "não consegui registrar" : r.stderr, error: true) }
    }

    func renameAccount(_ old: String, to new: String) {
        let clean = new.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, clean != old else { return }
        let r = ForgeCore.run("forge-accounts.js", ["--rename", old, "--to", clean])
        if r.ok {
            show("\(old) → \(clean)")
            loadAccounts()
            // Usage is keyed by name; the old entry would linger as a ghost row.
            if let u = usage.removeValue(forKey: old) { usage[clean] = u }
        } else {
            show(r.stderr.isEmpty ? "falha ao renomear" : r.stderr, error: true)
        }
    }

    /// The relaunch command, for pasting into a terminal the app did not open.
    func copyLaunchCommand(_ name: String) {
        let r = ForgeCore.run("forge-accounts.js", ["--launch-cmd", name])
        let cmd = r.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        guard r.ok, !cmd.isEmpty else {
            return show(r.stderr.isEmpty ? "não consegui gerar o comando" : r.stderr, error: true)
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(cmd, forType: .string)
        show("Comando copiado")
    }

    func copyToPasteboard(_ text: String, label: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        show("\(label) copiado")
    }

    func removeAccount(_ name: String) {
        let r = ForgeCore.run("forge-accounts.js", ["--remove", name])
        if r.ok { show("\(name) removida"); loadAccounts() }
        else { show(r.stderr.isEmpty ? "falha ao remover" : r.stderr, error: true) }
    }

    /// Open a terminal on another account, in-app. No `workspaces.first`
    /// fallback: it dispatched into the wrong repo indistinguishably from a
    /// correct dispatch (`b992edf`). A `.chat` session carries no project
    /// semantics, so an unresolved preselection lands in the configured
    /// session root dir instead — never a guess among registered projects.
    func launch(account: String) {
        let cwd = preselection.workspace ?? resolvedSessionRoot
        newSession(cwd: cwd, mode: .chat, text: "", account: account)
        sessions.last.map { _ in
            show("Sessão aberta na conta \(account) — \(URL(fileURLWithPath: cwd).lastPathComponent)")
        }
    }

    func openTerminal(at cwd: String, command: String, title: String) {
        let r = ForgeCore.openTerminal(cwd: cwd, command: command, title: title)
        if r.ok { show(title) } else { show(r.stderr, error: true) }
    }

    /// Resume an existing run in an in-app terminal. /forge-auto takes the run
    /// id and picks up from disk state.
    func resume(_ run: Run) {
        // `--account` was missing here while the session was still LABELLED
        // with the run's account: the tab named one account and the shell ran
        // on whatever the default was. Every other creation path passes the
        // flag; this one is the odd one out, and the label made the mismatch
        // invisible.
        let acct = run.account ?? ""
        let claudeArgs = acct.isEmpty ? "" : " --account \(shq(acct))"
        sessions.append(TerminalSession(
            cwd: run.cwd, title: "\(run.projectName) · auto",
            bootstrap: "claude\(claudeArgs) \(shq("/forge-auto \(run.id)"))",
            runId: run.id, account: run.account, engine: "claude"))
        focus(sessions.last)
        persistSessions()
    }

    /// The session in THIS app driving `run`, if there is one.
    ///
    /// Runs live on disk and outlive every process: one started in Terminal.app,
    /// by `bin/forge-run` headless, or before this app was last quit is active
    /// and has no session here. That is the normal case, not the exception —
    /// which is why "open a terminal for it" and "go to its terminal" are two
    /// different actions rather than one button that sometimes opens a second
    /// session onto the same run.
    func session(for run: Run) -> TerminalSession? {
        sessions.first { $0.runId == run.id && $0.cwd == run.cwd }
    }

    /// The sandbox is registered like any other project so examples show up
    /// everywhere real work does — same screens, same code paths.
    func registerSandbox() {
        guard !workspaces.contains(Sandbox.path) else { return }
        Workspaces.add(Sandbox.path)
        reloadCheap()
    }

    func destroySandbox() {
        Workspaces.remove(Sandbox.path)
        // Close any session living in the sandbox first — removing the folder
        // under a running shell leaves it in a directory that no longer exists.
        for s in sessions where s.cwd == Sandbox.path { closeSession(s) }
        do {
            try Sandbox.destroy()
            show("Sandbox removido")
        } catch {
            show("não consegui remover: \(error.localizedDescription)", error: true)
        }
        reloadCheap()
    }

    func addWorkspace(_ p: String)    { Workspaces.add(p); reloadCheap() }

    /// Register a path without surfacing it as a project card — used for
    /// worktrees, which belong to a project already in the list and should not
    /// appear as separate entries.
    func addWorkspaceQuietly(_ p: String) {
        guard !workspaces.contains(p) else { return }
        Workspaces.add(p)
        reloadCheap()
    }
    func removeWorkspace(_ p: String) { Workspaces.remove(p); reloadCheap() }

    func show(_ text: String, error: Bool = false) {
        toast = Toast(text: text, isError: error)
        let shown = toast
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            if self.toast == shown { self.toast = nil }
        }
    }
}
