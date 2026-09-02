// Cockpit — a operação inteira numa tela só.
//
// WHY A WALL AND NOT MORE TABS
// ----------------------------
// Tabs answer "which session am I reading?". With one agent that is the whole
// question. With seven — the number this machine actually runs — it is the
// wrong one: the thing you need to know is which of them stopped, which is
// asking something, which has been printing the same spinner for ten minutes.
// A tab strip can only ever answer that one tab at a time, so the operator
// becomes the polling loop. The wall renders every live PTY at once (they are
// already mounted — `TerminalsView` kept them alive in a ZStack precisely so
// switching would not kill them), which turns "check each tab" into "look".
//
// WHY THE RUN RAIL SITS NEXT TO THE TERMINAL AND NOT ON ITS OWN SCREEN
// --------------------------------------------------------------------
// The milestone → slice → task tree already existed, rendered by `RunCard` on
// the Runs screen. That is one navigation away from the terminal where the run
// is happening, which is the one place the tree is worth reading: the terminal
// tells you what the worker is SAYING, the tree tells you where it IS. Split
// across two screens, the operator holds the join in their head — the exact
// job this app exists to take over.
//
// Data only. Nothing here starts, stops or mutates a session: focus and
// layout are view state, and every action routes back through `AppState`.

import SwiftUI
import AppKit
import ForgeKit

// MARK: - Layout mode

/// How the terminal screen arranges its sessions.
///
/// Persisted by `rawValue` (`TerminalsView`'s `@AppStorage`), so these strings
/// are storage keys and not labels — same split as `Section.title`, and for
/// the same reason: renaming what the operator reads must not silently reset
/// what the operator chose.
enum TerminalLayout: String, CaseIterable, Identifiable {
    case tabs
    case grid
    case board

    var id: String { rawValue }

    static let defaultsKey = "terminalLayout"

    var title: String {
        switch self {
        case .tabs:  return "Abas"
        case .grid:  return "Mural"
        case .board: return "Quadro"
        }
    }

    var icon: String {
        switch self {
        case .tabs:  return "rectangle.stack"
        case .grid:  return "square.grid.2x2"
        case .board: return "point.3.connected.trianglepath.dotted"
        }
    }

    var help: String {
        switch self {
        case .tabs:  return "Uma sessão por vez (⌃⌘1)"
        case .grid:  return "Todas as sessões ao mesmo tempo (⌃⌘2)"
        case .board: return "Quadro: mover e conectar terminais (⌃⌘3)"
        }
    }

    /// Columns for `n` panes.
    ///
    /// The ceiling is the readable width of a Claude Code line, not a taste
    /// about grids: at 4 columns on a 1512pt display each pane is ~350pt, which
    /// is under 60 columns of monospace — narrow enough that Claude Code's own
    /// wrapping starts to hide structure. Beyond 12 sessions the wall stops
    /// being the right tool and the tab strip is; `TerminalsView` falls back.
    static func columns(for n: Int) -> Int {
        switch n {
        case ...1:  return 1
        case 2...4: return 2
        case 5...9: return 3
        default:    return 4
        }
    }

    /// Rows of panes, left to right, top to bottom. Returned as chunks rather
    /// than as a `LazyVGrid` because lazy is exactly wrong here: a pane that
    /// scrolls out of view would be unmounted, and an unmounted pane is a
    /// terminal you are no longer watching — the one thing the wall is for.
    static func rows<T>(_ items: [T], columns: Int) -> [[T]] {
        guard columns > 0, !items.isEmpty else { return [] }
        return stride(from: 0, to: items.count, by: columns).map {
            Array(items[$0..<min($0 + columns, items.count)])
        }
    }
}

// MARK: - The wall

struct SessionWall: View {
    @ObservedObject var state: AppState
    @ObservedObject private var routes: RouteStore = .shared
    let focused: UUID?

    private var columns: Int { TerminalLayout.columns(for: state.sessions.count) }

    var body: some View {
        let rows = TerminalLayout.rows(state.sessions, columns: columns)
        VStack(spacing: 8) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 8) {
                    ForEach(row) { session in
                        SessionPane(
                            session: session,
                            phase: phase(for: session),
                            engine: routes.route(for: session.cwd)?.forgeEngine,
                            isFocused: session.id == focused,
                            onFocus: { state.focusedSession = session.id },
                            onClose: { state.closeSession(session, confirm: true) })
                    }
                    // Keeps the last row's panes the same width as every other
                    // row's. Without it a lone trailing pane stretches across
                    // the window and reads as "this one is different".
                    if row.count < columns {
                        ForEach(0..<(columns - row.count), id: \.self) { _ in
                            Color.clear.frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                    }
                }
            }
        }
        .padding(8)
        .background(ForgeBackground(intensity: 0.4, embers: false))
        .onAppear { probeRoutes() }
        .onChange(of: state.sessions.count) { _ in probeRoutes() }
        // Phase is already live via `liveRuns`; the route badge is not — refresh
        // it on the same run-store signal that already fires on every phase
        // change, so a dispatch inside an already-open session isn't stuck
        // showing the pre-dispatch engine/tier badge.
        .onChange(of: state.runs) { _ in probeRoutes() }
    }

    /// The phase a pane belongs to: the run it drives if it drives one, else
    /// whatever the project last dispatched. A plain shell in a project that is
    /// mid-execute is still, visually, part of that execute — which is the true
    /// statement and also the useful one.
    private func phase(for session: TerminalSession) -> ForgePhase {
        if let rid = session.runId,
           let run = state.runs.first(where: { $0.id == rid }),
           let unit = run.workerParts?.unit {
            return ForgePhase(unit: unit)
        }
        if session.runId == nil,
           let run = state.liveRuns.first(where: { $0.cwd == session.cwd }),
           let unit = run.workerParts?.unit {
            return ForgePhase(unit: unit)
        }
        return routes.route(for: session.cwd)?.forgePhase ?? .unknown
    }

    private func probeRoutes() {
        for cwd in Set(state.sessions.map(\.cwd)) { routes.refresh(cwd: cwd) }
    }
}

/// One pane of the wall: a chrome strip that says whose terminal this is, and
/// the live terminal under it.
struct SessionPane: View {
    @ObservedObject var session: TerminalSession
    let phase: ForgePhase
    let engine: ForgeEngine?
    let isFocused: Bool
    let onFocus: () -> Void
    let onClose: () -> Void

    /// Set by the board; nil on the wall.
    ///
    /// The board needs a grip and the pane already has the only strip that is
    /// not a live terminal — its header. Handing the gesture in beats giving a
    /// board node its own title bar above the pane's, which is two rows of
    /// chrome saying the same name.
    var onHeaderDrag: ((CGSize) -> Void)? = nil
    var onHeaderDragEnded: (() -> Void)? = nil

    @State private var hovering = false

    /// The pane's own tone: the phase's, except while it is focused. Focus is
    /// attention and attention is ember — the one reservation in the palette,
    /// and the reason a wall of six phases still has exactly one pane shouting.
    private var tone: ForgeTone { isFocused ? .ember : phase.tone }

    var body: some View {
        VStack(spacing: 0) {
            header
            TerminalHost(session: session)
        }
        .clipShape(RoundedRectangle(cornerRadius: SurfaceLevel.raised.cornerRadius,
                                    style: .continuous))
        .forgeSurface(.raised, tint: tone, tintStrength: isFocused ? 0.9 : 0.35)
        .overlay {
            // The focus ring rides ON TOP of the surface's own edge rather than
            // replacing it, so gaining focus adds light instead of swapping one
            // rectangle for another — the difference between a pane that lights
            // up and a pane that redraws.
            if isFocused {
                RoundedRectangle(cornerRadius: SurfaceLevel.raised.cornerRadius,
                                 style: .continuous)
                    .strokeBorder(Color.tone(.ember).opacity(0.8), lineWidth: 1.5)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.easeOut(duration: 0.18), value: isFocused)
        // The whole pane, not just the header: clicking into a terminal to
        // type already makes it first responder, and the ring must agree with
        // where the keystrokes are going or it is worse than no ring at all.
        .onTapGesture(perform: onFocus)
    }

    private var header: some View {
        HStack(spacing: 5) {
            PulseDot(tone: tone, alive: session.isRunning, size: 6)
                .help(session.isRunning ? "Rodando" : (session.exitLabel ?? "encerrado"))

            Text(session.tabLabel)
                .font(.system(size: 11, weight: .semibold))
                .lineLimit(1).truncationMode(.middle)

            if session.runId != nil {
                Text(session.projectName)
                    .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
            }

            if phase != .unknown { PhaseChip(phase: phase, compact: true) }

            Spacer(minLength: 4)

            if let engine, engine != .unknown { EngineTag(engine: engine) }

            if let account = session.account {
                Text(account)
                    .font(.system(size: 9)).foregroundStyle(.tertiary)
                    .lineLimit(1)
            }

            // Revealed on hover. A close button on every pane, always visible,
            // is seven chances to end a run by aiming badly.
            if hovering {
                Button(action: onClose) {
                    Image(systemName: "xmark").font(.system(size: 8, weight: .bold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Encerrar sessão")
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background {
            // A tone wash under the header only. The terminal keeps its own
            // ground: tinting the surface a Claude session paints on would
            // fight every colour the session itself prints.
            LinearGradient(colors: [Color.tone(tone).opacity(isFocused ? 0.22 : 0.13),
                                    Color.tone(tone).opacity(0.02)],
                           startPoint: .top, endPoint: .bottom)
        }
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.tone(tone).opacity(0.35)).frame(height: 1)
        }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        // `simultaneousGesture` and not `gesture`: a plain drag here would
        // swallow the pane's tap-to-focus, and a node you can move but not
        // focus is worse than one you cannot move.
        .simultaneousGesture(
            DragGesture(minimumDistance: 3)
                .onChanged { onHeaderDrag?($0.translation) }
                .onEnded { _ in onHeaderDragEnded?() }
        )
    }
}

// MARK: - The run rail

/// The run that the visible session belongs to, shown beside it.
///
/// Reads the same two sources `RunCard` does (`AppState.runs` for the run,
/// `AppState.status[cwd]` for the milestone tree) rather than introducing a
/// third: a rail that disagreed with the Runs screen about what is happening
/// would be worse than a rail that is missing.
struct RunRail: View {
    @ObservedObject var state: AppState
    @ObservedObject private var routes: RouteStore = .shared
    let session: TerminalSession?

    /// The slice a `SliceRow` click asked to inspect. `.sheet(item:)` and not
    /// `.sheet(isPresented:)`: the sheet needs to know WHICH slice, and a
    /// second `@State` that could disagree with the first is exactly the kind
    /// of drift `RunRail`'s own doc-comment warns against.
    @State private var inspecting: SliceStatus?

    /// What is happening, as a phase. The worker string first (it is the live
    /// truth), the milestone's own `phase` second, the last dispatch last.
    private var phase: ForgePhase {
        if let unit = run?.workerParts?.unit { return ForgePhase(unit: unit) }
        if let p = milestone?.phase { return ForgePhase(unit: p) }
        return routes.route(for: session?.cwd)?.forgePhase ?? .unknown
    }

    private var route: DispatchEvent? { routes.route(for: session?.cwd) }

    /// Which run this session drives. `runId` first — with two milestones in
    /// one project the cwd cannot tell the two tabs apart, which is why
    /// `TerminalSession` carries the id at all.
    private var run: Run? {
        guard let session else { return nil }
        if let rid = session.runId, let r = state.runs.first(where: { $0.id == rid }) { return r }
        return state.liveRuns.first { $0.cwd == session.cwd }
    }

    /// Only trust the milestone block when it belongs to THIS run — same guard
    /// as `RunCard`, same reason: a project reports one focused milestone and
    /// attributing it to the wrong run shows someone else's progress.
    private var milestone: MilestoneStatus? {
        guard let run, let m = state.status[run.cwd]?.milestone, m.id == run.id else { return nil }
        return m
    }

    private var gates: [Gate] {
        guard let run else { return [] }
        return state.pending.filter { $0.cwd == run.cwd && ($0.run_id == run.id || $0.run_id == nil) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let run {
                    header(run)
                    if let m = milestone { progress(m) }
                    now(run)
                    if !gates.isEmpty { gateBlock }
                    if let slices = milestone?.slices, !slices.isEmpty { tree(slices) }
                    Divider()
                    actions(run)
                } else {
                    noRun
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        // No fixed width any more: the rail is an `.inspector` column now, and
        // `inspectorColumnWidth` is what sizes it. A hardcoded 268 here would
        // fight the divider the operator drags and win, which reads as a resize
        // handle that does nothing.
        .frame(maxWidth: .infinity)
        .background(Color.forgePanel)
        .overlay(alignment: .leading) {
            // The phase, stated as one vertical stroke down the rail's inner
            // edge. It is the largest piece of colour on the screen that costs
            // no layout at all — and at a glance across the window it is what
            // tells you the run moved from plan to execute without reading a
            // word.
            Rectangle()
                .fill(LinearGradient(
                    colors: [Color.tone(phase.tone).opacity(0.55),
                             Color.tone(phase.tone).opacity(0.08)],
                    startPoint: .top, endPoint: .bottom))
                .frame(width: 2)
        }
        .onAppear { routes.refresh(cwd: session?.cwd) }
        .onChange(of: session?.id) { _ in routes.refresh(cwd: session?.cwd) }
        // Phase is already live via `liveRuns`/`run`; the route badge is not —
        // refresh it on the same run-store signal that already fires on every
        // phase change.
        .onChange(of: state.runs) { _ in routes.refresh(cwd: session?.cwd) }
        // `run` is read here rather than captured at the `SliceRow` tap: the
        // click only carries WHICH slice, and the inspector needs the run
        // that owns it resolved at present time, not at click time.
        .sheet(item: $inspecting) { sl in
            if let run { SliceInspector(run: run, slice: sl) }
        }
    }

    // MARK: Blocks

    private func header(_ run: Run) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Circle().fill(run.isStale ? Color.orange : Color.green)
                    .frame(width: 6, height: 6)
                Text(run.projectName).font(.subheadline).bold()
                Spacer()
                if milestone?.auto_mode == "on" {
                    Image(systemName: "play.circle.fill")
                        .font(.caption2).foregroundStyle(.secondary)
                        .help("forge-auto está conduzindo este run")
                }
            }
            if let t = milestone?.displayTitle {
                Text(t).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 5) {
                Text(run.id)
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .textSelection(.enabled)
                    .lineLimit(1).truncationMode(.middle)
                if let route, route.forgeEngine != .unknown {
                    EngineTag(engine: route.forgeEngine)
                }
            }
        }
    }

    private func progress(_ m: MilestoneStatus) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            if let p = m.progress {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.forgeEdge.opacity(0.22))
                        Capsule()
                            .fill(LinearGradient(
                                colors: [Color.tone(phase.tone).opacity(0.7),
                                         Color.tone(phase.tone)],
                                startPoint: .leading, endPoint: .trailing))
                            .frame(width: max(2, geo.size.width * p.fraction))
                            .animation(.easeOut(duration: 0.4), value: p.fraction)
                    }
                }
                .frame(height: 4)
                HStack(spacing: 4) {
                    Text("\(p.done) de \(p.total) slices")
                        .font(.caption2).monospacedDigit().foregroundStyle(.secondary)
                    Text("· \(p.percent)%").font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
    }

    private func now(_ run: Run) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            RailLabel("agora")
            if let w = run.workerParts {
                HStack(spacing: 5) {
                    PulseDot(tone: phase.tone, alive: !run.isStale, size: 5)
                    Text(w.unit).font(.caption).bold()
                    if !w.id.isEmpty {
                        Text(w.id).font(.caption).foregroundStyle(.secondary)
                    }
                    if let e = run.workerElapsed {
                        Text("· \(e)").font(.caption2).foregroundStyle(.tertiary)
                    }
                }
                if let route {
                    Text(route.model)
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1).truncationMode(.middle)
                }
            } else if let p = milestone?.phase {
                PhaseChip(phase: ForgePhase(unit: p))
            } else {
                Text("entre unidades").font(.caption).foregroundStyle(.tertiary)
            }

            if let next = milestone?.next_action, !next.isEmpty {
                RailLabel("próximo").padding(.top, 4)
                Text(next).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var gateBlock: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                Image(systemName: "bolt.fill").font(.caption2)
                Text(gates.count == 1 ? "1 pergunta esperando"
                                      : "\(gates.count) perguntas esperando")
                    .font(.caption).bold()
            }
            .foregroundStyle(Color.accentOrange)

            // The question itself, not just the count. A rail that only says
            // "something is waiting" sends the operator back to the terminal
            // to find out what — which is the trip this whole panel exists to
            // save.
            ForEach(gates.prefix(2)) { g in
                Text(g.question)
                    .font(.caption2).foregroundStyle(.secondary)
                    .lineLimit(3).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentOrange.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
    }

    private func tree(_ slices: [SliceStatus]) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            RailLabel("slices")
            ForEach(slices) { sl in
                SliceRow(slice: sl,
                         isActive: sl.id == milestone?.active_slice,
                         activeTask: milestone?.active_task,
                         activeTone: phase.tone,
                         onOpen: { inspecting = sl })
            }
        }
    }

    private func actions(_ run: Run) -> some View {
        HStack(spacing: 8) {
            Button(state.isPaused(run) ? "Retomar" : "Pausar") { state.togglePause(run) }
                .controlSize(.small)
            Button("Pasta") { ForgeCore.reveal(run.cwd) }
                .controlSize(.small)
            Spacer()
        }
    }

    private var noRun: some View {
        VStack(alignment: .leading, spacing: 6) {
            RailLabel("sessão")
            Text(session?.projectName ?? "nenhuma sessão")
                .font(.subheadline).bold()
            Text("Esta sessão não está conduzindo um run do Forge. Rode `/forge-auto` ou `/forge-next` aqui para que o trilho passe a acompanhar.")
                .font(.caption2).foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// One slice, plus its tasks while it is the one being worked.
///
/// Only the active slice expands, and it does so without a disclosure control:
/// the tasks of a slice nobody is working are history, and history belongs on
/// the Runs screen where there is room for it.
private struct SliceRow: View {
    let slice: SliceStatus
    let isActive: Bool
    let activeTask: String?
    /// The tone of the phase the run is IN, so the slice being worked is drawn
    /// in the same colour as everything else that is about right now. A fixed
    /// colour here would have the spine disagree with the rail's own stroke.
    let activeTone: ForgeTone
    /// Opens the `SliceInspector` sheet for this row — the trilha da run
    /// becomes the entry point T06 exists to add, without this row needing
    /// to know anything about `SliceInspector` itself.
    var onOpen: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 5) {
                Image(systemName: glyph)
                    .font(.system(size: 9))
                    .foregroundStyle(tint)
                    .frame(width: 10)
                Text(slice.id)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(isActive ? .primary : .secondary)
                Text(slice.title ?? "")
                    .font(.caption2)
                    .foregroundStyle(slice.isDone ? .tertiary : .secondary)
                    .lineLimit(1)
                Spacer(minLength: 2)
                if slice.totalTasks > 0 {
                    Text("\(slice.doneTasks)/\(slice.totalTasks)")
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
            }

            if isActive, let tasks = slice.tasks, !tasks.isEmpty {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(tasks) { t in
                        HStack(spacing: 5) {
                            Image(systemName: t.isDone ? "checkmark" : "circle")
                                .font(.system(size: 7))
                                .foregroundStyle(t.id == activeTask
                                                 ? Color.tone(activeTone)
                                                 : (t.isDone ? Color.tone(.mint).opacity(0.7)
                                                             : Color.forgeEdge.opacity(0.7)))
                                .frame(width: 10)
                            Text(t.cleanTitle)
                                .font(.system(size: 10))
                                .foregroundStyle(t.id == activeTask ? .primary : .secondary)
                                .lineLimit(1)
                        }
                    }
                }
                .padding(.leading, 15)
            }
        }
        .padding(.vertical, isActive ? 4 : 1)
        .padding(.horizontal, isActive ? 6 : 0)
        .background {
            if isActive {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.tone(activeTone).opacity(0.10))
                    .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .strokeBorder(Color.tone(activeTone).opacity(0.22), lineWidth: 0.5))
            }
        }
        // `contentShape` first: without it a tap between the row's text and
        // its trailing edge — most of a row this thin — would miss, because
        // an unfilled `VStack` only hit-tests the pixels its children paint.
        .contentShape(Rectangle())
        .onTapGesture(perform: onOpen)
    }

    private var glyph: String {
        if slice.isDone { return "checkmark.circle.fill" }
        if isActive { return "circle.dotted" }
        return "circle"
    }

    private var tint: Color {
        if isActive { return Color.tone(activeTone) }
        if slice.isDone { return Color.tone(.mint).opacity(0.75) }
        return Color.forgeEdge.opacity(0.7)
    }
}

/// The rail's one-word section marks. Extracted because there are five of them
/// and a rail whose labels drift in size stops reading as one column.
private struct RailLabel: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 9, weight: .semibold))
            .tracking(0.5)
            .foregroundStyle(.tertiary)
    }
}
