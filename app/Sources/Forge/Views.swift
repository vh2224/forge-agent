// Views — the app's surfaces.
//
// VISUAL RULES (deliberate, and worth keeping):
//   1. One accent colour FOR ATTENTION. Orange means "needs you". If nothing is
//      orange, nothing is waiting. Cost, progress and tokens stay grey.
//      REVISED — see `Design.swift`: phase and engine now carry their own
//      encodings, because an identity is not an alert. Orange's monopoly is on
//      urgency, not on colour.
//   2. Hierarchy comes from type size and whitespace, not borders. Cards use a
//      material fill and no stroke.
//      REVISED — see `Design.swift`: cards now draw a `ForgeSurface`, which is
//      a fill plus a hairline edge and a top highlight. The hierarchy claim
//      still holds; the "no stroke" clause does not.
//   3. Native BEHAVIOUR, deliberate surfaces. REVISED — see `Design.swift`:
//      `.regularMaterial` everywhere was the absence of a decision, not a
//      decision. Surfaces now come from `SurfaceLevel`.
//   4. Big numbers only where a decision hangs on them.

import SwiftUI
import AppKit
import ForgeKit

// MARK: - Shell

/// One-shot flags for things that happen per LAUNCH rather than per window.
@MainActor
enum LaunchOnce {
    static var curtainPending = true
}

enum Section: String, CaseIterable, Identifiable {
    // "Início" was removed, not renamed. It had no content of its own left:
    // the composer moved into Terminal (where sessions are actually started),
    // the run strips were a thinner RunsView, and the gate banner — the one
    // thing that WAS unique — moved to Terminal too. A screen whose every part
    // is a worse copy of another screen is a screen to delete. `Stores.swift`
    // falls back to `.terminal`, so anyone whose saved section was "Início"
    // lands on the screen that absorbed it rather than nowhere.
    case terminal = "Terminal"
    case projects = "Projetos"
    case items = "Itens"
    case runs = "Runs"
    case accounts = "Contas"
    case metrics = "Métricas"
    case models = "Modelos"
    case secrets = "Segredos"
    case prefs = "Preferências"
    case history = "Histórico"
    case updates = "Atualizações"
    case examples = "Exemplos"

    var id: String { rawValue }

    /// What the sidebar shows. Split from `rawValue`, which is the **persistence
    /// key**: `Stores.swift` writes `section?.rawValue` into
    /// `UserDefaults("lastSection")` and validates the restore against
    /// `Section.allCases.map(\.rawValue)`, so renaming a `rawValue` silently
    /// invalidates the stored value and drops every user back to the fallback
    /// section (MEM004 — the exact reason guard D31 pins the ordered list).
    ///
    /// With the two separated, renaming a label costs nothing: `items` still
    /// persists as `"Itens"` forever while reading "Tarefas" on screen.
    var title: String {
        switch self {
        case .items: return "Tarefas"
        default: return rawValue
        }
    }

    /// Configuration, not work.
    ///
    /// Six of the twelve sections were places you go to SET something up, and
    /// they sat in the same list as the places you go to WATCH work happen. A
    /// sidebar that mixes the two is a settings drawer wearing navigation: every
    /// app the operator compares this one to puts configuration behind ⌘, and
    /// keeps the sidebar for the user's own material.
    ///
    /// They keep their cases. `rawValue` is the persistence key (see `title`),
    /// `SettingsScene` addresses them by case, and deleting them would break
    /// both for no gain — what changed is only where they are reachable from.
    var isSettings: Bool {
        switch self {
        case .accounts, .models, .secrets, .prefs, .updates, .examples: return true
        default: return false
        }
    }

    /// What the sidebar lists: work only.
    static var workCases: [Section] { allCases.filter { !$0.isSettings } }

    var icon: String {
        switch self {
        case .terminal: return "terminal"
        case .projects: return "folder"
        case .items:    return "tray.full"
        case .runs:     return "play.circle"
        case .accounts: return "person.2"
        case .metrics:  return "chart.bar.xaxis"
        case .models:   return "cpu"
        case .secrets:  return "lock.shield"
        case .prefs:    return "slider.horizontal.3"
        case .history:  return "clock.arrow.circlepath"
        case .updates:  return "arrow.down.circle"
        case .examples: return "sparkles"
        }
    }
}

struct RootView: View {
    @ObservedObject var state: AppState

    /// The sidebar observes the update store (D32).
    ///
    /// Not polish: `UpdateStore` is a singleton that publishes asynchronously
    /// (`checkOnLaunch` finishes seconds after the window opens), and without an
    /// observation here SwiftUI never re-renders the sidebar when it does. The
    /// consumer is `sidebarFooter` below: `updates.repoDescribe` is filled by
    /// `load()`, and `updates.updateAvailable` by the launch check, so without
    /// this the version line would be born empty and stay empty — worse than
    /// absent. It is also why removing this line breaks the footer silently
    /// rather than loudly, which is what the comment is for.
    ///
    /// The reference sits in a property initializer on purpose. `StateObject`'s
    /// `init(wrappedValue:)` is `@MainActor` and takes an autoclosure, so
    /// `shared` is touched on the main actor. Writing it as a default argument of
    /// an explicit `init` instead is what costs a concurrency warning — that
    /// expression is evaluated in a nonisolated context (learned in chunk 1).
    @StateObject private var updates = UpdateStore.shared

    /// The launch animation, and whether the shell has arrived behind it.
    ///
    /// Seeded from a process-wide one-shot rather than from `true`: `WindowGroup`
    /// can build a second `RootView` (⌘N, or reopening from the Dock), and a
    /// splash screen that replays every time a window opens is the exact thing
    /// that turns charm into an obstacle.
    @State private var showPalette = false
    /// The palette can change the terminal layout, which lives in
    /// `TerminalsView`'s `@AppStorage`. Mirrored here rather than passed down:
    /// `@AppStorage` on the same key is the same storage, so both views see the
    /// change without either owning the other.
    @AppStorage(TerminalLayout.defaultsKey) private var paletteLayout = TerminalLayout.tabs.rawValue
    @State private var curtain = LaunchOnce.curtainPending
    @State private var entered = !LaunchOnce.curtainPending

    // Section selection lives in AppState, not in `@State`: opening a session
    // from the composer has to move the operator to the terminal, and only
    // shared state can be driven from there.
    var body: some View {
        NavigationSplitView {
            sidebarList
        } detail: {
            Group {
                switch state.section ?? .terminal {
                case .terminal: TerminalsView(state: state)
                case .projects: ProjectsView(state: state)
                case .items:    ItemsView(state: state)
                case .runs:     RunsView(state: state)
                case .accounts: AccountsView(state: state)
                case .metrics:  MetricsView(state: state)
                case .models:   ModelsView(state: state)
                case .secrets:  SecretsView(state: state)
                case .prefs:    PrefsView(state: state)
                case .history:  HistoryView(state: state)
                case .updates:  UpdatesView(state: state)
                case .examples: ExamplesView(state: state)
                }
            }
            .frame(minWidth: 460, minHeight: 380)
        }
        .overlay(alignment: .bottom) { toast }
        // ⌘K. An overlay and not a sheet: a sheet would dim and block the window
        // behind it, and half of what the palette is for is glancing at a run
        // while you jump somewhere else.
        .overlay(alignment: .top) {
            if showPalette {
                CommandPalette(state: state, isPresented: $showPalette,
                               layoutRaw: $paletteLayout)
                    .padding(.top, 64)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .background {
                        Button("") { showPalette = false }
                            .keyboardShortcut(.cancelAction).opacity(0)
                    }
            }
        }
        .background {
            Button("") { withAnimation(.easeOut(duration: 0.14)) { showPalette.toggle() } }
                .keyboardShortcut("k", modifiers: .command)
                .opacity(0)
        }
        #if DEBUG
        // Replays the launch animation. DEBUG only, and it exists for one
        // reason: tuning a 900ms sequence by relaunching the app means fighting
        // window focus for every single frame, and the frames that matter are
        // the ones you cannot screenshot that way. Never compiled into a
        // release, so it cannot become a shortcut anybody depends on.
        .background {
            Button("") { curtain = true; entered = false }
                .keyboardShortcut("l", modifiers: [.command, .option])
                .opacity(0)
        }
        #endif
        .animation(.easeInOut(duration: 0.18), value: state.pending.count)
        // The shell is mounted and live UNDER the curtain from frame one — the
        // animation never delays a session, it only covers the moment before
        // anyone could have read the screen anyway. `entered` then rises the
        // content the last few points, so the app arrives instead of appearing.
        .opacity(entered ? 1 : 0)
        .offset(y: entered ? 0 : 6)
        .overlay {
            if curtain {
                LaunchCurtain {
                    LaunchOnce.curtainPending = false
                    curtain = false
                    withAnimation(.easeOut(duration: 0.34)) { entered = true }
                }
                .transition(.opacity)
            }
        }
        .onAppear {
            // Already-seen curtain (a second window): arrive immediately rather
            // than sitting invisible waiting for an animation that will not run.
            if !curtain { entered = true }
        }
    }

    /// The sidebar list, extracted from `body` so a canvas can render the whole
    /// column at the 180pt minimum width without a window around it — the width
    /// where a `Divider`, or anything added to the footer, has to earn its place.
    private var sidebarList: some View {
        List(selection: $state.section) {
            ForEach(Section.workCases) { s in
                Label {
                    HStack {
                        // `.title`, never `.rawValue` — see `Section.title`.
                        Text(s.title)
                        Spacer()
                        if let n = badge(for: s) {
                            // Orange meant "this is asking you something", not
                            // "this is the first row". It followed the gate
                            // count out of Início and into Terminal instead of
                            // staying behind as decoration on whichever row
                            // happened to be at the top.
                            let urgent = isUrgent(s)
                            Text("\(n)")
                                .font(.caption2).monospacedDigit()
                                .foregroundStyle(urgent ? .white : .secondary)
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .background(urgent ? AnyShapeStyle(Color.accentOrange)
                                                   : AnyShapeStyle(.quaternary),
                                            in: Capsule())
                        }
                    }
                } icon: {
                    Image(systemName: s.icon)
                        .forgeIcon(.small)
                        .foregroundStyle(isUrgent(s) ? Color.accentOrange : Color.secondary)
                }
                .tag(s)

                // D29 — one rule between the sections you work in and the ones
                // you configure. 1pt of hierarchy instead of the ~60pt of chrome
                // that real `List` sections would cost (D33).
                //
                // Emitted inside the same `ForEach` deliberately: splitting
                // `Section.allCases` into two arrays would put a second source of
                // truth next to `Stores.swift`, which feeds `SectionRestore`'s
                // validator from `allCases` (D31).
                if s == .runs { Divider() }
            }

            // Live terminal sessions, in the sidebar rather than buried in
            // Terminal's own tab strip. Grouping and ordering are
            // `SessionOrganiser`'s job (T01) — this view only resolves `home`
            // (never reads the environment itself) and draws what comes back.
            let groups = sessionGroups
            if !groups.isEmpty {
                SwiftUI.Section {
                    ForEach(groups) { group in
                        if group.sessions.count == 1, let only = group.sessions.first {
                            SidebarSessionRow(snapshot: only, state: state)
                        } else {
                            Text(group.title)
                                .font(ForgeType.caption)
                                .foregroundStyle(.tertiary)
                                .padding(.top, 2)
                            ForEach(group.sessions) { snap in
                                SidebarSessionRow(snapshot: snap, state: state)
                                    .padding(.leading, 10)
                            }
                        }
                    }
                } header: {
                    Text("Sessões")
                        .font(ForgeType.micro)
                        .foregroundStyle(.tertiary)
                }
            } else if !state.restorable.isEmpty {
                // No live session, but something is recoverable from the last
                // launch (T01/T03). The row's label says "sessão anterior" —
                // it must not read as a live tab, and nothing here opens one
                // until the row's own `Button` is clicked.
                SwiftUI.Section {
                    ForEach(state.restorable, id: \.self) { descriptor in
                        SidebarRestorableRow(descriptor: descriptor, state: state)
                    }
                } header: {
                    Text("Sessões")
                        .font(ForgeType.micro)
                        .foregroundStyle(.tertiary)
                }
            }

            // What is running, in the sidebar rather than on the home —
            // nested under whichever registered project owns each run's
            // `cwd`, the same ownership `WorkTree.build` (T02) already
            // derives for `Projects.swift`'s tree. A flat list here would be
            // the second copy of one rule; this section draws only what the
            // forest returns.
            //
            // It lived on the home, which is the one screen you cannot see once
            // you are working — so the list of live runs was visible exactly
            // when there were none of your own to look at. Here it is visible
            // from every screen, which is what a work list is for. This is the
            // second half of the sidebar becoming the operator's material
            // instead of the app's table of contents.
            let forest = workForest
            if !forest.roots.isEmpty || !forest.unowned.isEmpty {
                SwiftUI.Section {
                    ForEach(forest.roots.filter { !$0.runs.isEmpty || $0.runCount > 0 }) { node in
                        WorkNodeRows(node: node, depth: 0, state: state)
                    }
                    // A run whose `cwd` matched no registered project is not
                    // dropped — silent loss is indistinguishable from a
                    // broken detector (`WorkTree.swift`'s own words).
                    if !forest.unowned.isEmpty {
                        Text("Sem projeto")
                            .font(ForgeType.caption)
                            .foregroundStyle(.tertiary)
                            .padding(.top, 2)
                        ForEach(forest.unowned) { run in
                            SidebarRunRow(run: run, state: state)
                                .padding(.leading, 10)
                        }
                    }
                } header: {
                    Text("Rodando")
                        .font(ForgeType.micro)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .safeAreaInset(edge: .bottom) { sidebarFooter }
        .navigationSplitViewColumnWidth(min: 200, ideal: 232, max: 300)
    }

    /// `state.sessions` reduced to the DTO `SessionOrganiser` groups, and
    /// grouped/ordered by it — the view contains no ordering rule of its own.
    private var sessionGroups: [SessionGroup] {
        let snaps = state.sessions.map {
            SessionSnapshot(id: $0.id.uuidString, cwd: $0.cwd, title: $0.title,
                            runId: $0.runId, account: $0.account)
        }
        return SessionOrganiser.groups(snaps, home: NSHomeDirectory())
    }

    /// Registered projects with every live run nested under whichever
    /// project owns its `cwd` — the same trio of arguments `Projects.swift`
    /// already passes to `ProjectTree.build`.
    private var workForest: WorkForest {
        WorkTree.build(projects: state.workspaces, runs: state.liveRuns,
                       roots: Workspaces.declaredRoots(), home: NSHomeDirectory())
    }

    /// Counts only, and only where a count means something.
    ///
    /// Updates has no case here (D27): the numeral it used to show was always
    /// `1`, so it counted nothing — it was a dot wearing a number. One signal
    /// belongs in one place, and that place is the footer, next to the version.
    /// Whether this row's badge is counting something that wants an answer.
    private func isUrgent(_ s: Section) -> Bool {
        s == .terminal && !state.pending.isEmpty
    }

    private func badge(for s: Section) -> Int? {
        switch s {
        case .runs:     return state.liveRuns.isEmpty ? nil : state.liveRuns.count
        // Two things can be counted here and urgency wins: a pending gate is
        // asking you something, a running session merely exists. The count only
        // ever means "gates" while there are gates, and the banner at the top of
        // the screen says which — the badge is never the only telling.
        case .terminal:
            if !state.pending.isEmpty { return state.pending.count }
            return state.sessions.isEmpty ? nil : state.sessions.count
        case .projects: return state.workspaces.isEmpty ? nil : state.workspaces.count
        // Open only (`ItemBoard.openCount`): a badge counting done and dropped
        // would grow forever and stop meaning "there is work here".
        case .items:    return state.openItemCount == 0 ? nil : state.openItemCount
        default:        return nil
        }
    }

    /// Two rows, not one (D26).
    ///
    /// The version gets a line of its own because the measurement closes the door
    /// on sharing: 152pt usable at the 180pt minimum column width, of which
    /// "Adicionar projeto" already takes ~100pt. Putting the version beside it is
    /// the arrangement that truncates, and a truncated version string hides
    /// exactly the second number R9 says must be legible. A footer one line
    /// taller costs nothing — `safeAreaInset` just yields the height and the
    /// `List` scrolls if it ever has to.
    private var sidebarFooter: some View {
        VStack(spacing: 0) {
            Divider()
            // "Adicionar projeto" left this footer: the same action already
            // lives in the app menu, in the Projects toolbar and in the Projects
            // empty state. Three doors to one room, and this was the one nobody
            // was looking at — it was here only because the footer had space,
            // and it was crowding the one thing that genuinely belongs in a
            // footer: which build you are running.
            VStack(alignment: .leading, spacing: 4) {
                SidebarVersionLabel(
                    running: updates.running,
                    repo: updates.repoDescribe,
                    updateAvailable: updates.updateAvailable,
                    onTap: { SettingsWindow.open(.updates) })
            }
            .padding(.horizontal, 8).padding(.vertical, 8)
        }
    }

    @ViewBuilder private var toast: some View {
        if let t = state.toast {
            Label(t.text, systemImage: t.isError
                  ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .font(.caption)
                .foregroundStyle(t.isError ? .orange : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .forgeSurface(.panel, in: Capsule())
                .overlay(Capsule().strokeBorder(.quaternary))
                .padding(.bottom, 14)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}

#if DEBUG
extension RootView {
    /// The sidebar footer on its own, so a canvas can render it at the 180pt
    /// minimum column width — the tight case, where a second line or an extra
    /// glyph truncates. A preview of the whole `RootView` would show the footer
    /// at whatever width the canvas happens to be, which is exactly the width
    /// that hides the problem.
    ///
    /// Same file because `sidebarFooter` is `private`, and a preview is not a
    /// reason to open it to the rest of the module.
    var previewSidebarFooter: some View { sidebarFooter }

    /// The whole sidebar column, for the same reason and by the same means: a
    /// preview of `RootView` would render a full split view at whatever width
    /// the canvas has, and the `Divider` (D29) is judged against the column, not
    /// against a window.
    var previewSidebarList: some View { sidebarList }
}
#endif

/// The version in the sidebar footer: what is running, and one click to the
/// section that can do something about it (D25 UI side, D26).
///
/// Every value arrives as a parameter — no store, no `Bundle`, no git. That is
/// what makes the four states previewable at a fixed 180pt on a machine with no
/// Xcode and no stamped bundle, which is the only width where the interesting
/// question about this view exists.
/// One live run in the sidebar.
///
/// Deliberately not a `Label` with a badge like the section rows above it: a run
/// is not a destination, it is a thing that is happening, and it needs to say
/// which unit and whether it still has a heartbeat. Clicking opens or focuses
/// its terminal, which is the only thing anyone wants from it here.
struct SidebarRunRow: View {
    let run: Run
    @ObservedObject var state: AppState

    var body: some View {
        Button {
            state.section = .terminal
            state.resume(run)
        } label: {
            HStack(spacing: 7) {
                PulseDot(tone: run.isStale ? .slate : .mint,
                         alive: !run.isStale, size: 5)
                VStack(alignment: .leading, spacing: 1) {
                    Text(run.projectName)
                        .font(ForgeType.body)
                        .lineLimit(1)
                    if let w = run.workerParts {
                        Text(w.id.isEmpty ? w.unit : "\(w.unit) \(w.id)")
                            .font(ForgeType.caption)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Abrir o terminal desta run")
    }
}

/// One node of the work forest and everything below it: a header (when the
/// node owns direct runs or has any descendant that does) followed by its
/// runs, then the same recursively for each child that owns work —
/// `WorkNode` is a tree for the same reason `ProjectTreeNode` is, and
/// `ProjectTreeRow` (`Projects.swift`) walks it the same way.
///
/// A `folder` node — synthesised, not a registered project — never owns
/// `runs` directly (`WorkTree.swift`'s own invariant), but it still renders a
/// header whenever it has descendant work, so the indentation below always
/// has a labelled ancestor. Siblings are filtered the same way one level up,
/// so the predicate here mirrors that filter.
struct WorkNodeRows: View {
    let node: WorkNode
    let depth: Int
    @ObservedObject var state: AppState

    var body: some View {
        Group {
            if !node.runs.isEmpty || node.runCount > 0 {
                Text(node.title)
                    .font(ForgeType.caption)
                    .foregroundStyle(.tertiary)
                    .padding(.leading, CGFloat(depth) * 10)
                    .padding(.top, 2)
            }
            if !node.runs.isEmpty {
                ForEach(node.runs) { run in
                    SidebarRunRow(run: run, state: state)
                        .padding(.leading, CGFloat(depth + 1) * 10)
                }
            }
            ForEach(node.children.filter { !$0.runs.isEmpty || $0.runCount > 0 }) { child in
                WorkNodeRows(node: child, depth: depth + 1, state: state)
            }
        }
    }
}

/// One live session in the sidebar's work list.
///
/// Deliberately not a `Label` with a badge like the section rows above it,
/// same reasoning as `SidebarRunRow`: a session is a place to go back to, not
/// a destination with a count. Clicking goes through `state.focus(_:)` —
/// the same path every other creation route uses, so "created but nothing
/// visibly happened" cannot come back through the sidebar either.
struct SidebarSessionRow: View {
    let snapshot: SessionSnapshot
    @ObservedObject var state: AppState

    var body: some View {
        Button {
            if let session = state.sessions.first(where: { $0.id.uuidString == snapshot.id }) {
                state.focus(session)
            }
        } label: {
            HStack(spacing: 7) {
                Image(systemName: "terminal")
                    .forgeIcon(.small)
                VStack(alignment: .leading, spacing: 1) {
                    Text(snapshot.title)
                        .font(ForgeType.body)
                        .lineLimit(1)
                    Text(snapshot.runId ?? ProjectOrganiser.abbreviate(snapshot.cwd, home: NSHomeDirectory()))
                        .font(ForgeType.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Ir para esta sessão")
    }
}

/// The "Sessões" section when nothing is live but something is recoverable
/// (T01/T03). Same visual as `SidebarSessionRow` — typography, icon
/// treatment, click-to-focus shape — but the label says "sessão anterior" so
/// the section never pretends a closed session is still open, and a
/// descriptor whose engine cannot resume gets its engine tag instead of a
/// live-looking row.
struct SidebarRestorableRow: View {
    let descriptor: SessionDescriptor
    @ObservedObject var state: AppState

    private var resumable: Bool { SessionResume.plan(for: descriptor) != nil }

    var body: some View {
        Group {
            if resumable {
                // The ONLY call site of `resumeSession` in this file — a
                // `Button` action, never `onAppear`/`init`/`task`.
                Button { state.resumeSession(descriptor) } label: { rowLabel }
                    .buttonStyle(.plain)
                    .help("Retomar sessão anterior")
            } else {
                rowLabel
                    .help("\(descriptor.engine) ainda não retoma sessão")
            }
        }
    }

    private var rowLabel: some View {
        HStack(spacing: 7) {
            Image(systemName: "clock.arrow.circlepath")
                .forgeIcon(.small)
                .foregroundStyle(.tertiary)
            VStack(alignment: .leading, spacing: 1) {
                Text(descriptor.title)
                    .font(ForgeType.body)
                    .lineLimit(1)
                Text(ProjectOrganiser.abbreviate(descriptor.cwd, home: NSHomeDirectory()))
                    .font(ForgeType.caption)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if !resumable {
                Text(ForgeEngine(descriptor.engine).tag)
                    .font(ForgeType.mono)
                    .foregroundStyle(.tertiary)
            }
        }
        .contentShape(Rectangle())
    }
}

struct SidebarVersionLabel: View {
    let running: String?
    let repo: String?
    let updateAvailable: Bool
    let onTap: () -> Void

    @State private var hovering = false

    var body: some View {
        let display = VersionFooter.display(running: running, repo: repo)
        return Button {
            onTap()
        } label: {
            HStack(spacing: 8) {
                // Static glyph, deliberately NOT tinted by update state: VISUAL
                // RULE 1 says orange means "needs you", and D27 put that signal
                // in one place. An icon that also changed colour would be a
                // second signal saying the same thing — which is how a rule that
                // says "one place" quietly becomes two.
                Image(systemName: "hammer.fill")
                    .forgeIcon(.micro)
                    .foregroundStyle(.tertiary)
                    .frame(width: 14)

                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 5) {
                        Text("Forge")
                            .font(.caption).fontWeight(.medium)
                            .foregroundStyle(.secondary)
                        // Developer mode: this binary was compiled by
                        // `app/build.sh --debug`, which is what the operator
                        // runs while working on the app itself.
                        //
                        // `#if DEBUG` and not a describe heuristic: "has commits
                        // beyond the tag" is TRUE for a release cut mid-cycle and
                        // FALSE for a debug build of a clean tag, so it answers a
                        // different question than the one being asked. The
                        // compile flag is the only thing that actually knows how
                        // this binary was built.
                        //
                        // Not orange, and not a dot: VISUAL RULE 1 reserves both
                        // for "needs you", and running a dev build is a fact
                        // about the binary, not a call to action. The two states
                        // coexist — a dev build with an update pending shows the
                        // badge AND the orange dot, which is exactly the case
                        // this footer has to survive.
                        #if DEBUG
                        Text("dev")
                            .font(ForgeType.micro)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 4).padding(.vertical, 1)
                            .background(.quaternary, in: Capsule())
                            .help("Build de desenvolvimento (app/build.sh --debug)")
                        #endif
                    }
                    Text(display.text)
                        .font(.caption2)
                        .foregroundStyle(updateAvailable
                                         ? AnyShapeStyle(Color.accentOrange)
                                         : AnyShapeStyle(.tertiary))
                        .multilineTextAlignment(.leading)
                        // Wrap, never truncate. A `Text` in a tight row
                        // ellipsises by default, and the first thing an ellipsis
                        // eats here is the second version — the one the reader
                        // came for. No `lineLimit(1)` anywhere, on purpose.
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 4)

                // VISUAL RULE 1: orange means "needs you". The dot is the whole
                // update signal (D26/D27) — one signal, one place. 5pt because a
                // dot next to 10pt `.caption` reads as punctuation, and anything
                // bigger reads as a bullet.
                if updateAvailable {
                    Image(systemName: "circle.fill")
                        .forgeIcon(.dot)
                        .foregroundStyle(Color.accentOrange)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            // The footer was flat text that happened to be tappable — nothing
            // said so until you clicked it. A hover fill is the cheapest way to
            // say "this goes somewhere", and it costs no resting ink.
            .background(hovering ? AnyShapeStyle(.quaternary.opacity(0.4))
                                 : AnyShapeStyle(.clear),
                        in: RoundedRectangle(cornerRadius: 7))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(.easeInOut(duration: 0.1), value: hovering)
        // R9 is paid twice over: the short text labels the second number `repo`,
        // and the tooltip says the whole sentence.
        .help(display.detail ?? display.text)
    }
}

@MainActor
func pickWorkspace(_ state: AppState) {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.prompt = "Observar"
    panel.message = "Escolha a pasta de um projeto que usa o Forge (.gsd/)"
    NSApp.activate(ignoringOtherApps: true)
    if panel.runModal() == .OK, let url = panel.url { state.addWorkspace(url.path) }
}

// MARK: - Agora

/// The home screen. A place to START work, not an inbox.
///
/// It used to lead with the pending-question queue, which framed the app as
/// somewhere you go to answer things — but questions are the exception and
/// starting work is the rule. Pending gates are still surfaced, as a banner
/// that cannot be missed, above the thing you actually came to do.
///
/// The composer works like the Claude Code prompt rather than a form: one line,
/// `/` completes Forge commands, `@` completes projects. Dropdowns for mode and
/// project were a translation of the terminal into a form; this is the terminal.
struct GateCard: View {
    let gate: Gate
    @ObservedObject var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "bolt.fill")
                    .forgeIcon(.micro).foregroundStyle(Color.accentOrange)
                Text(gate.projectName).font(.caption).bold()
                if !gate.subtitle.isEmpty {
                    Text(gate.subtitle).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if let left = gate.timeLeft {
                    // Ignoring a gate is a real outcome, not the absence of one:
                    // the run WILL proceed with `default`. Hiding that would
                    // make the app lie by omission.
                    Text("⏳ \(left) → \(gate.defaultLabel)")
                        .font(.caption2).foregroundStyle(.secondary)
                        .help("Sem resposta, o Forge segue com \"\(gate.defaultLabel)\"")
                }
            }

            Text(gate.question).font(.body)

            if let ctx = gate.context, !ctx.isEmpty {
                Text(ctx)
                    .font(.caption).foregroundStyle(.secondary)
                    .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary.opacity(0.35),
                                in: RoundedRectangle(cornerRadius: 8))
            }

            // Options sit side by side while there is room and stack when the
            // window narrows, instead of squeezing labels into ellipses.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) { optionButtons }
                VStack(spacing: 6) { optionButtons }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .forgeSurface(.raised)
        .overlay(RoundedRectangle(cornerRadius: 12)
            .strokeBorder(Color.accentOrange.opacity(0.35), lineWidth: 1))
    }

    @ViewBuilder private var optionButtons: some View {
        Group {
                ForEach(gate.options) { opt in
                    Button { state.answer(gate, choice: opt.key) } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(opt.label).bold()
                            if !opt.description.isEmpty {
                                Text(opt.description)
                                    .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            }
                            Spacer()
                            if opt.key == gate.default {
                                Text("padrão").font(.caption2).foregroundStyle(.tertiary)
                            }
                        }
                        .contentShape(Rectangle()).padding(.vertical, 3)
                    }
                    .buttonStyle(.bordered).frame(maxWidth: .infinity)
                }
        }
    }
}

// MARK: - Runs

struct RunsView: View {
    @ObservedObject var state: AppState
    @State private var showLauncher = false

    /// Runs that stopped recently. A finished milestone is not noise — it is
    /// the answer to "did that thing I started overnight actually land?".
    private var recent: [Run] {
        state.runs.filter { !$0.active }
            .sorted { ($0.last_heartbeat ?? 0) > ($1.last_heartbeat ?? 0) }
            .prefix(4).map { $0 }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if state.liveRuns.isEmpty {
                    emptyState
                } else {
                    ForEach(state.liveRuns) { r in
                        RunCard(run: r, status: state.status[r.cwd], state: state)
                    }
                }

                if !recent.isEmpty {
                    SectionTitle("Encerrados recentemente")
                    ForEach(recent) { r in FinishedRunRow(run: r) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
        }
        .navigationTitle("Runs")
        .sheet(isPresented: $showLauncher) {
            LauncherSheet(state: state, isPresented: $showLauncher)
        }
        .toolbar {
            ToolbarItem {
                Button { state.refreshStatus(force: true) } label: {
                    Label("Atualizar", systemImage: "arrow.clockwise")
                }
                .help("Recarrega o progresso de cada projeto")
            }
            ToolbarItem {
                Button { showLauncher = true } label: {
                    Label("Nova sessão", systemImage: "plus")
                }
            }
        }
        .onAppear { state.refreshStatus(force: true) }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Nenhum run ativo.").font(.callout).foregroundStyle(.secondary)
            Text("Um run aparece aqui assim que o /forge-auto começa — no terminal do app ou fora dele.")
                .font(.caption).foregroundStyle(.tertiary)
            Button("Abrir sessão…") { showLauncher = true }.controlSize(.small)
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct RunCard: View {
    let run: Run
    let status: StatusPayload?
    @ObservedObject var state: AppState
    @State private var showSlices = false

    private var milestone: MilestoneStatus? {
        // Only trust the milestone block when it belongs to THIS run: a project
        // with several runs reports one focused milestone, and attributing it to
        // the wrong card would show someone else's progress.
        guard let m = status?.milestone, m.id == run.id else { return nil }
        return m
    }

    private var gatesHere: [Gate] {
        state.pending.filter { $0.cwd == run.cwd && ($0.run_id == run.id || $0.run_id == nil) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            header
            if let m = milestone { progressBlock(m) } else { noStatusYet }
            liveRow
            if !gatesHere.isEmpty { gateRow }
            if let m = milestone, let slices = m.slices, !slices.isEmpty {
                sliceDisclosure(m, slices)
            }
            Divider().padding(.vertical, 1)
            actions
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .forgeSurface(.raised)
        .overlay(RoundedRectangle(cornerRadius: 12)
            .strokeBorder(gatesHere.isEmpty ? .clear : Color.accentOrange.opacity(0.4), lineWidth: 1))
    }

    private var header: some View {
        HStack(spacing: 8) {
            Circle().fill(run.isStale ? Color.orange : Color.green)
                .frame(width: 7, height: 7)
                .help(run.isStale ? "Sem heartbeat há mais de 15min" : "Ativo")
            Text(run.projectName).font(.headline)
            if let title = milestone?.displayTitle {
                Text(title).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            if milestone?.auto_mode == "on" {
                Label("auto", systemImage: "play.circle.fill")
                    .font(.caption2).foregroundStyle(.secondary)
                    .help("forge-auto está conduzindo este run")
            }
            if state.isPaused(run) {
                Label("pausa pedida", systemImage: "pause.circle.fill")
                    .font(.caption2).foregroundStyle(Color.accentOrange)
            }
        }
    }

    @ViewBuilder private func progressBlock(_ m: MilestoneStatus) -> some View {
        if let p = m.progress, p.total > 0 {
            VStack(alignment: .leading, spacing: 4) {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(.quaternary).frame(height: 6)
                        Capsule().fill(Color.accentOrange.opacity(0.75))
                            .frame(width: max(3, geo.size.width * p.fraction), height: 6)
                    }
                    .frame(maxHeight: .infinity, alignment: .center)
                }
                .frame(height: 8)
                HStack(spacing: 6) {
                    Text("\(p.done) de \(p.total) slices")
                        .font(.caption).monospacedDigit()
                    Text("· \(p.percent)%").font(.caption).foregroundStyle(.tertiary)
                    Spacer()
                    Text(run.id).font(ForgeType.monoSmall)
                        .foregroundStyle(.tertiary).textSelection(.enabled)
                }
            }
        }
    }

    private var noStatusYet: some View {
        HStack(spacing: 6) {
            Text(run.id).font(ForgeType.mono)
                .foregroundStyle(.tertiary).textSelection(.enabled)
            Spacer()
        }
    }

    /// What is happening right now, and what comes next — the two questions a
    /// running milestone actually raises.
    private var liveRow: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .top, spacing: 8) {
                Text("agora").font(.caption2).foregroundStyle(.tertiary)
                    .frame(width: 48, alignment: .leading)
                if let w = run.workerParts {
                    HStack(spacing: 5) {
                        Text(w.unit).font(.caption).bold()
                        if !w.id.isEmpty {
                            Text(w.id).font(.caption).foregroundStyle(.secondary)
                        }
                        if let e = run.workerElapsed {
                            Text("· \(e)").font(.caption).foregroundStyle(.tertiary)
                        }
                    }
                } else if let phase = milestone?.phase {
                    Text(phase).font(.caption).bold()
                } else {
                    Text("entre unidades").font(.caption).foregroundStyle(.tertiary)
                }
                Spacer()
            }
            if let next = milestone?.next_action, !next.isEmpty {
                HStack(alignment: .top, spacing: 8) {
                    Text("próximo").font(.caption2).foregroundStyle(.tertiary)
                        .frame(width: 48, alignment: .leading)
                    Text(next).font(.caption).foregroundStyle(.secondary)
                        .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    /// A run blocked on a question is the one thing here that needs acting on.
    private var gateRow: some View {
        HStack(spacing: 6) {
            Image(systemName: "bolt.fill").forgeIcon(.micro).foregroundStyle(Color.accentOrange)
            Text(gatesHere.count == 1 ? "1 pergunta esperando" : "\(gatesHere.count) perguntas esperando")
                .font(.caption).foregroundStyle(Color.accentOrange)
            Spacer()
        }
    }

    @ViewBuilder private func sliceDisclosure(_ m: MilestoneStatus, _ slices: [SliceStatus]) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { showSlices.toggle() }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: showSlices ? "chevron.down" : "chevron.right")
                        .forgeIcon(.micro)
                    Text("Slices").font(.caption)
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(.secondary)

            if showSlices {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(slices) { sl in
                        HStack(spacing: 6) {
                            Image(systemName: sl.isDone ? "checkmark.circle.fill"
                                  : (sl.id == m.active_slice ? "play.circle.fill" : "circle"))
                                .forgeIcon(.micro)
                                .foregroundStyle(sl.isDone ? AnyShapeStyle(Color.green)
                                                 : (sl.id == m.active_slice
                                                    ? AnyShapeStyle(Color.accentOrange)
                                                    : AnyShapeStyle(.tertiary)))
                            Text(sl.id).font(ForgeType.mono)
                                .foregroundStyle(.secondary).frame(width: 26, alignment: .leading)
                            Text(sl.title ?? "").font(.caption2).lineLimit(1)
                            if sl.isHighRisk && !sl.isDone {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .forgeIcon(.micro).foregroundStyle(.orange)
                                    .help("Slice de risco alto")
                            }
                            Spacer()
                            if sl.totalTasks > 0 {
                                Text("\(sl.doneTasks)/\(sl.totalTasks)")
                                    .font(ForgeType.monoSmall)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
                .padding(8)
                .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 6))
            }
        }
    }

    private var actions: some View {
        HStack(spacing: 8) {
            let paused = state.isPaused(run)
            Button(paused ? "Retomar" : "Pausar") { state.togglePause(run) }
                .controlSize(.small)
                .help(paused ? "Remove o pedido de pausa"
                             : "Para ao fim da unidade atual, não no meio")
            if let here = state.session(for: run) {
                Button("Ir para o terminal") { state.focus(here) }
                    .controlSize(.small)
                    .help("Esta run já tem uma aba aberta no app")
            } else {
                Button("Abrir aqui") { state.resume(run) }
                    .controlSize(.small)
                    .help("Abre uma aba com /forge-auto \(run.id) neste projeto")
            }
            Button("Ver pasta") { ForgeCore.reveal(run.cwd) }
                .controlSize(.small)
            Spacer()
            if state.session(for: run) == nil {
                Text("sem terminal aqui").font(.caption2).foregroundStyle(.tertiary)
                    .help("A run está viva no disco — o processo que a conduz não é uma aba deste app")
            }
            if let iso = run.isolation_mode {
                Text(iso).font(.caption2).foregroundStyle(.tertiary)
                    .help("Modo de isolamento deste run")
            }
            if let acct = run.account, !acct.isEmpty {
                Text(acct).font(.caption2).foregroundStyle(.tertiary)
            }
        }
    }
}

/// A run that has stopped. Shows why, because "encerrado" alone does not say
/// whether it finished or died.
struct FinishedRunRow: View {
    let run: Run

    private var reason: String {
        switch run.deactivated_reason {
        case "complete-milestone": return "milestone concluída"
        case "complete-task":      return "task concluída"
        case "handoff":            return "troca de conta"
        case "pause":              return "pausado"
        case .some(let r):         return r
        case .none:                return "encerrado"
        }
    }

    private var isClean: Bool {
        (run.deactivated_reason ?? "").hasPrefix("complete")
    }

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: isClean ? "checkmark.circle" : "stop.circle")
                .forgeIcon(.micro).foregroundStyle(isClean ? AnyShapeStyle(Color.green)
                                                        : AnyShapeStyle(.tertiary))
            Text(run.projectName).font(.callout)
            Text(run.id).font(ForgeType.monoSmall).foregroundStyle(.tertiary)
                .lineLimit(1).truncationMode(.middle)
            Spacer()
            Text(reason).font(.caption2).foregroundStyle(.secondary)
            if let hb = run.last_heartbeat, let ago = Duration.short(ms: Date.nowMs - hb) {
                Text(ago).font(.caption2).foregroundStyle(.tertiary)
                    .frame(width: 44, alignment: .trailing)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.2), in: RoundedRectangle(cornerRadius: 9))
    }
}

/// Condensed run row for the "Agora" screen.
struct RunStrip: View {
    let run: Run
    @ObservedObject var state: AppState

    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(run.isStale ? Color.orange : Color.green)
                .frame(width: 6, height: 6)
            Text(run.projectName).font(.callout)
            Text(run.id).font(.caption).foregroundStyle(.secondary)
            if let w = run.workerParts {
                Text("· \(w.unit) \(w.id)").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Text(run.elapsed).font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 10))
    }
}

// MARK: - Contas

struct AccountsView: View {
    @ObservedObject var state: AppState

    /// Only meaningful once usage has actually been polled — ordering by
    /// last_used would look confident while knowing nothing about capacity.
    private var recommended: String? {
        guard state.usage.count > 1 else { return nil }
        return state.accountsByHeadroom.first { $0.has_token && state.usage[$0.name] != nil }?.name
    }

    /// Capacity across every polled account: the answer to "do I have fuel?"
    /// before the answer to "which account".
    private var totalHeadroom: Double? {
        let known = state.accounts.compactMap { state.usage[$0.name]?.headroom }
        guard !known.isEmpty else { return nil }
        return known.reduce(0, +) / Double(known.count)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                summary
                if state.accounts.isEmpty { empty }
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 330), spacing: 14)],
                    alignment: .leading, spacing: 14
                ) {
                    ForEach(state.accountsByHeadroom) { a in
                        AccountCard(account: a, usage: state.usage[a.name],
                                    isRecommended: a.name == recommended, state: state)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
        }
        .navigationTitle("Contas")
        .onAppear { state.loadAccounts() }
        .toolbar {
            ToolbarItem {
                Button {
                    state.refreshUsage()
                } label: {
                    if state.usageLoading { ProgressView().controlSize(.small) }
                    else { Label("Consultar uso", systemImage: "arrow.clockwise") }
                }
                .disabled(state.usageLoading)
                .help("Consulta a API de cada conta — gasta ~9 tokens por conta")
            }
        }
    }

    private var summary: some View {
        HStack(spacing: 16) {
            if let total = totalHeadroom {
                Gauge(value: total, tint: Meter.tint(headroom: total), size: 54, lineWidth: 6) {
                    VStack(spacing: -1) {
                        Text("\(Int(total))%").font(ForgeType.title)
                            .monospacedDigit()
                        Text("livre").font(ForgeType.micro).foregroundStyle(.secondary)
                    }
                }
            } else {
                Image(systemName: "chart.pie")
                    .forgeIcon(.hero).foregroundStyle(.tertiary)
                    .frame(width: 54, height: 54)
            }

            VStack(alignment: .leading, spacing: 3) {
                if let r = recommended {
                    HStack(spacing: 5) {
                        Image(systemName: "sparkles").forgeIcon(.small).foregroundStyle(Color.accentOrange)
                        Text("Use \(r)").font(.headline)
                    }
                    Text("Maior folga semanal entre as contas consultadas.")
                        .font(.caption).foregroundStyle(.secondary)
                } else if state.usageCheckedAt == nil {
                    Text("Capacidade desconhecida").font(.headline)
                    Text("Consulte o uso para saber qual conta tem folga.")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("\(state.accounts.count) conta(s)").font(.headline)
                }
            }
            Spacer()
            if let at = state.usageCheckedAt {
                VStack(alignment: .trailing, spacing: 1) {
                    Text(at.formatted(date: .omitted, time: .shortened))
                        .font(.caption2).monospacedDigit().foregroundStyle(.secondary)
                    Text("consultado").font(ForgeType.micro).foregroundStyle(.tertiary)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 14))
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: 9) {
            Label("Nenhuma conta registrada", systemImage: "person.crop.circle.badge.questionmark")
                .font(.callout)
            // Registration needs a real TTY: `claude setup-token` opens a browser
            // login, which the app cannot host.
            Text("Registrar exige um terminal de verdade — o login abre o navegador.")
                .font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 6) {
                Text("forge-accounts add <nome>")
                    .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                Button {
                    state.copyToPasteboard("forge-accounts add ", label: "Comando")
                } label: { Image(systemName: "doc.on.doc").forgeIcon(.micro) }
                .buttonStyle(.plain).foregroundStyle(.tertiary)
            }
            .padding(8)
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 6))
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 12))
    }
}


/// An icon-only menu button.
///
/// SwiftUI's Menu draws a disclosure chevron beside its label by default, which
/// on an icon label reads as a glyph with something stuck to it. Hiding the
/// indicator and giving the button a real hit area (rather than the width of
/// the glyph) is what makes it look intentional.
struct IconMenu<Content: View>: View {
    var icon: String = "ellipsis"
    var help: String = "Mais opções"
    @ViewBuilder var content: () -> Content

    @State private var hovering = false

    var body: some View {
        Menu {
            content()
        } label: {
            Image(systemName: icon)
                .forgeIcon(.small, weight: .medium)
                .frame(width: 26, height: 22)
                .background(hovering ? AnyShapeStyle(.quaternary)
                                     : AnyShapeStyle(.clear),
                            in: RoundedRectangle(cornerRadius: 6))
                .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .foregroundStyle(hovering ? .primary : .secondary)
        .onHover { hovering = $0 }
        .help(help)
    }
}

// MARK: - Meter primitives

enum Meter {
    /// Neutral while healthy; colour only once it demands a decision — the same
    /// discipline as the rest of the app, so a coloured ring always means
    /// something. 70% used is the handoff threshold, 90% is nearly spent.
    static func tint(headroom: Double) -> Color {
        if headroom <= 10 { return .red }
        if headroom <= 30 { return Color.accentOrange }
        return Color.secondary.opacity(0.75)
    }
}

/// A ring gauge. Reads capacity faster than a bar and costs far less width,
/// which is what makes room for the identity line beside it.
struct Gauge<Label: View>: View {
    let value: Double          // 0...100, the portion that is FREE
    let tint: Color
    var size: CGFloat = 46
    var lineWidth: CGFloat = 5
    @ViewBuilder var label: () -> Label

    var body: some View {
        ZStack {
            Circle()
                .stroke(.quaternary, lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: max(0.01, min(1, value / 100)))
                .stroke(tint, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
            label()
        }
        .frame(width: size, height: size)
        .animation(.easeOut(duration: 0.35), value: value)
    }
}

// MARK: - Account card

struct AccountCard: View {
    let account: Account
    let usage: AccountUsage?
    let isRecommended: Bool
    @ObservedObject var state: AppState

    @State private var confirmingRemove = false
    @State private var renaming = false
    @State private var draftName = ""

    /// Two different notions of "current". Conflating them is how you end up
    /// believing a terminal runs on an account it does not:
    ///   padrão — what a bare `claude` attaches to
    ///   em uso — what this app's sessions were launched with
    private var isDefault: Bool { state.activeAccount == account.name }
    private var sessionCount: Int { state.sessions.filter { $0.account == account.name }.count }
    private var weeklyFree: Double? { usage?.seven_day.map { 100 - $0.pct } }

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            ring
            VStack(alignment: .leading, spacing: 7) {
                titleRow
                identityRow
                if usage != nil { windows } else { unknownUsage }
                footer
            }
        }
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .forgeSurface(.raised)
        .overlay(RoundedRectangle(cornerRadius: 14)
            .strokeBorder(isRecommended ? Color.accentOrange.opacity(0.45) : .clear, lineWidth: 1.5))
        .confirmationDialog("Remover \(account.name)?",
                            isPresented: $confirmingRemove, titleVisibility: .visible) {
            Button("Remover", role: .destructive) { state.removeAccount(account.name) }
            Button("Cancelar", role: .cancel) {}
        } message: {
            Text("Apaga a conta do registro e o token do Keychain. A conta na Anthropic não é afetada.")
        }
        .sheet(isPresented: $renaming) {
            RenameSheet(current: account.name, draft: $draftName, isPresented: $renaming) { new in
                state.renameAccount(account.name, to: new)
            }
        }
    }

    @ViewBuilder private var ring: some View {
        if let free = weeklyFree {
            Gauge(value: free, tint: Meter.tint(headroom: free), size: 62, lineWidth: 7) {
                VStack(spacing: -2) {
                    Text("\(Int(free))").font(.system(size: 19, weight: .semibold)).monospacedDigit()
                    Text("% livre").font(ForgeType.micro).foregroundStyle(.secondary)
                }
            }
        } else {
            ZStack {
                Circle().stroke(.quaternary, lineWidth: 7)
                Image(systemName: "questionmark")
                    .forgeIcon(.medium).foregroundStyle(.tertiary)
            }
            .frame(width: 62, height: 62)
        }
    }

    private var titleRow: some View {
        HStack(spacing: 6) {
            Text(account.name).font(.headline).lineLimit(1)
            if isRecommended {
                Image(systemName: "sparkles").forgeIcon(.micro)
                    .foregroundStyle(Color.accentOrange)
                    .help("Maior folga semanal")
            }
            if isDefault {
                Image(systemName: "checkmark.circle.fill").forgeIcon(.micro)
                    .foregroundStyle(.secondary)
                    .help("Conta padrão — um `claude` sem argumentos entra nela")
            }
            if sessionCount > 0 {
                Image(systemName: "terminal.fill").forgeIcon(.micro)
                    .foregroundStyle(.secondary)
                    .help("\(sessionCount) sessão(ões) do app nesta conta")
            }
            Spacer()
            IconMenu(help: "Opções da conta") {
                if !isDefault && account.has_token {
                    Button("Tornar padrão") { state.setDefaultAccount(account.name) }
                }
                Button("Renomear…") { draftName = account.name; renaming = true }
                Button("Registrar identidade desta sessão") {
                    state.captureAccountIdentity(account.name)
                }
                Divider()
                Button("Copiar comando de launch") { state.copyLaunchCommand(account.name) }
                if let email = account.email, !email.isEmpty {
                    Button("Copiar e-mail") { state.copyToPasteboard(email, label: "E-mail") }
                }
                if let uuid = account.account_uuid, !uuid.isEmpty {
                    Button("Copiar UUID") { state.copyToPasteboard(uuid, label: "UUID") }
                }
                Divider()
                Button("Remover…", role: .destructive) { confirmingRemove = true }
            }
        }
    }

    @ViewBuilder private var identityRow: some View {
        if let email = account.email, !email.isEmpty {
            Text(email)
                .font(.caption).foregroundStyle(.secondary)
                .lineLimit(1).truncationMode(.middle).textSelection(.enabled)
        } else {
            Text("identidade não registrada")
                .font(.caption).foregroundStyle(.tertiary)
                .help("Sem isso a statusline não nomeia um login direto do Keychain")
        }
    }

    private var windows: some View {
        VStack(spacing: 4) {
            MiniWindow(label: "5h", window: usage?.five_hour)
            MiniWindow(label: "7d", window: usage?.seven_day)
        }
    }

    private var unknownUsage: some View {
        Text("uso não consultado")
            .font(.caption2).foregroundStyle(.tertiary)
    }

    private var footer: some View {
        HStack(spacing: 10) {
            if let d = account.days_left {
                Label("\(d)d", systemImage: account.tokenExpiringSoon ? "key.slash" : "key")
                    .font(.caption2)
                    .foregroundStyle(account.tokenExpiringSoon
                                     ? AnyShapeStyle(Color.orange) : AnyShapeStyle(.tertiary))
                    .help(account.tokenExpiringSoon
                          ? "Token expira em \(d) dias — renove com forge-accounts add \(account.name)"
                          : "Token válido por \(d) dias")
            }
            if !account.has_token {
                Label("sem token", systemImage: "exclamationmark.triangle")
                    .font(.caption2).foregroundStyle(.orange)
            }
            if let used = account.last_used, let when = Self.relative(used) {
                Label(when, systemImage: "clock")
                    .font(.caption2).foregroundStyle(.tertiary)
                    .help("Último uso registrado")
            }
            Spacer()
        }
    }

    private static func relative(_ iso: String) -> String? {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = fmt.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return nil }
        let f = RelativeDateTimeFormatter()
        f.locale = Locale(identifier: "pt_BR")
        f.unitsStyle = .abbreviated
        return f.localizedString(for: date, relativeTo: Date())
    }
}

/// Compact window row. Thin, because the ring already carries the headline
/// number — this is the detail you read second.
struct MiniWindow: View {
    let label: String
    let window: UsageWindow?

    private var free: Double { 100 - min(100, max(0, window?.pct ?? 0)) }

    var body: some View {
        HStack(spacing: 7) {
            Text(label)
                .font(ForgeType.monoSmall)
                .foregroundStyle(.tertiary).frame(width: 15, alignment: .leading)

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(.quaternary).frame(height: 4)
                    Capsule().fill(Meter.tint(headroom: free))
                        .frame(width: max(2, geo.size.width * free / 100), height: 4)
                }
                .frame(maxHeight: .infinity, alignment: .center)
            }
            .frame(height: 8)

            Text("\(Int(free))%")
                .font(ForgeType.caption).monospacedDigit()
                .foregroundStyle(.secondary).frame(width: 30, alignment: .trailing)

            Text(window?.resetsIn ?? "—")
                .font(ForgeType.micro).foregroundStyle(.tertiary)
                .frame(width: 38, alignment: .trailing)
                .help("Tempo até esta janela zerar")
        }
    }
}

struct RenameSheet: View {
    let current: String
    @Binding var draft: String
    @Binding var isPresented: Bool
    let onRename: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Renomear conta").font(.headline)
            Text("O token continua o mesmo — só muda o nome no registro.")
                .font(.caption).foregroundStyle(.secondary)
            TextField("nome", text: $draft)
                .textFieldStyle(.roundedBorder).onSubmit { commit() }
            HStack {
                Button("Cancelar") { isPresented = false }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Renomear") { commit() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty || draft == current)
            }
        }
        .padding(20).frame(width: 360)
    }

    private func commit() {
        let clean = draft.trimmingCharacters(in: .whitespaces)
        guard !clean.isEmpty, clean != current else { return }
        onRename(clean)
        isPresented = false
    }
}

// MARK: - Histórico

struct HistoryView: View {
    @ObservedObject var state: AppState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if state.recent.isEmpty {
                    Text("Nada respondido ainda.")
                        .font(.callout).foregroundStyle(.secondary)
                } else {
                    ForEach(state.recent) { g in
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: icon(g.effectiveStatus))
                                .forgeIcon(.micro).foregroundStyle(color(g.effectiveStatus))
                                .frame(width: 16)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(g.question).font(.callout).lineLimit(2)
                                HStack(spacing: 6) {
                                    Text(g.projectName).font(.caption2).foregroundStyle(.tertiary)
                                    if !g.subtitle.isEmpty {
                                        Text(g.subtitle).font(.caption2).foregroundStyle(.tertiary)
                                    }
                                    if let a = g.answer {
                                        Text("→ \(a.label ?? "—")").font(.caption2)
                                            .foregroundStyle(.secondary)
                                        if a.source == "timeout-default" {
                                            Text("(por tempo)").font(.caption2)
                                                .foregroundStyle(.orange)
                                        }
                                    }
                                }
                            }
                            Spacer()
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.quaternary.opacity(0.25),
                                    in: RoundedRectangle(cornerRadius: 10))
                    }
                }
            }
            .padding(18)
        }
        .navigationTitle("Histórico")
    }

    private func icon(_ s: String) -> String {
        switch s {
        case "answered":  return "checkmark.circle.fill"
        case "expired":   return "clock.badge.exclamationmark"
        case "cancelled": return "xmark.circle"
        default:          return "circle"
        }
    }

    private func color(_ s: String) -> Color {
        switch s {
        case "answered": return .green
        case "expired":  return .orange
        default:         return .secondary
        }
    }
}

// MARK: - Shared bits

struct SectionTitle: View {
    let text: String
    init(_ t: String) { text = t }
    var body: some View {
        Text(text.uppercased())
            .font(.caption2).bold().foregroundStyle(.tertiary)
            .padding(.top, 4)
    }
}

// `Color.accentOrange` moved to `Design.swift`, which is now the one place a
// colour is spelled. It kept its name and its value: 75 call sites use it, and
// the accent did not change — what changed is that it is no longer the only
// colour the app has.
