// TerminalsView — the terminal screen: tabs, floating controls, empty state.
//
// WHY THE CONTROLS FLOAT
// ----------------------
// The first cut put the zoom control in the toolbar. It was technically
// present and practically useless: a control pinned above the content is not
// where your attention is when you are reading a terminal, and it gave no
// feedback about the thing it changed. Everything that reacts to what happens
// IN the terminal now lives over the terminal — zoom feedback, attached
// images, the command bar — and appears only when it has something to say.
//
// WHY THERE IS NO "WHAT DO YOU WANT TO DO?" SHEET ANY MORE
// -------------------------------------------------------
// Opening a terminal used to require answering a modal first. The answer was
// almost always "just give me a terminal". The inline command bar inverts it:
// Enter on an empty line opens a shell, and anything you type — `/forge-auto`,
// `claude`, a plain question — becomes the session instead. The sheet is still
// there for the one thing the bar cannot express (picking among several active
// runs), one keystroke away at ⌘⇧N.
//
// View chrome only. Session lifetime lives in TerminalSession.swift and the
// emulator in ForgeTerminalView.swift; nothing here may end a process.

import SwiftUI
import AppKit
import ForgeKit

struct TerminalsView: View {
    @ObservedObject var state: AppState
    @ObservedObject private var terminals: TerminalViewStore = .shared

    /// Zoom HUD visibility, plus a token so a rapid ⌘=⌘=⌘= does not have its
    /// first dismissal hide the HUD the third one just raised.
    @State private var showZoomHud = false
    @State private var zoomFlash = 0

    /// Wall or tabs, and whether the run rail is open. `@AppStorage` and not
    /// `@State`: both are answers to "how do I like to work", and re-answering
    /// them at every launch is the kind of small tax that makes a setting feel
    /// like it was never saved.
    @AppStorage(TerminalLayout.defaultsKey) private var layoutRaw = TerminalLayout.tabs.rawValue
    @AppStorage("runRailVisible") private var railVisible = true

    private var layout: TerminalLayout { TerminalLayout(rawValue: layoutRaw) ?? .tabs }

    /// The wall needs at least two sessions to be a wall. Above twelve it stops
    /// being readable (see `TerminalLayout.columns`) and the tab strip is the
    /// honest answer — falling back is not a downgrade, it is the layout that
    /// still works at that count.
    private var wallApplies: Bool {
        layout == .grid && state.sessions.count > 1 && state.sessions.count <= 12
    }

    /// The board takes over as soon as it is chosen, at any session count: with
    /// one node it is still the screen where you place it and wire the next one
    /// in. That is the difference between a LAYOUT (which needs several things
    /// to lay out) and a WORKSPACE.
    private var boardApplies: Bool { layout == .board && !state.sessions.isEmpty }

    var body: some View {
        Group {
            if state.sessions.isEmpty {
                HomeView(state: state)
            } else {
                sessionsPane
            }
        }
        .navigationTitle("Terminal")
        // The native inspector, replacing a hand-rolled trailing column.
        // AppKit gives what the HStack could not: a draggable divider the
        // operator can size, the standard show/hide animation, and a width the
        // window remembers. `isPresented` is derived rather than bound straight
        // to `railVisible` so the rail cannot open over the home screen, where
        // it would have nothing to report but would still take 268pt.
        .inspector(isPresented: Binding(
            get: { railVisible && !state.sessions.isEmpty },
            set: { railVisible = $0 })
        ) {
            RunRail(state: state, session: state.visibleSession)
                .inspectorColumnWidth(min: 240, ideal: 280, max: 380)
        }
        .sheet(isPresented: $state.showLauncherSheet) {
            LauncherSheet(state: state, isPresented: $state.showLauncherSheet)
        }
        .toolbar {
            // Layout and rail only exist once there is something to lay out.
            // Shown on an empty screen they would be two controls that change
            // nothing, which teaches the operator to ignore that corner.
            if !state.sessions.isEmpty {
                ToolbarItem {
                    Picker("", selection: $layoutRaw) {
                        ForEach(TerminalLayout.allCases) { l in
                            Image(systemName: l.icon).forgeIcon(.small).help(l.help).tag(l.rawValue)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .help("Abas ou mural")
                }
                ToolbarItem {
                    Button { railVisible.toggle() } label: {
                        Label("Trilho da run",
                              systemImage: railVisible ? "sidebar.right" : "sidebar.trailing")
                    }
                    .help(railVisible ? "Esconder o trilho da run (⌘⇧R)"
                                      : "Mostrar o trilho da run (⌘⇧R)")
                }
            }
            ToolbarItem {
                Button { state.showComposer = true } label: {
                    Label("Nova sessão", systemImage: "plus")
                }
                .help("Nova sessão (⌘T)")
            }
        }
        // Shortcuts, not menu items: they steer this screen and only this
        // screen, so a global CommandMenu entry would be enabled on Métricas.
        .background {
            Group {
                Button("") { layoutRaw = TerminalLayout.tabs.rawValue }
                    .keyboardShortcut("1", modifiers: [.control, .command])
                Button("") { layoutRaw = TerminalLayout.grid.rawValue }
                    .keyboardShortcut("2", modifiers: [.control, .command])
                Button("") { layoutRaw = TerminalLayout.board.rawValue }
                    .keyboardShortcut("3", modifiers: [.control, .command])
                Button("") { railVisible.toggle() }
                    .keyboardShortcut("r", modifiers: [.command, .shift])
            }
            .opacity(0)
        }
        .onChange(of: terminals.fontSize) { _ in flashZoomHud() }
        .onAppear {
            if state.focusedSession == nil { state.focusedSession = state.sessions.first?.id }
        }
    }

    // MARK: - Panes

    /// No sessions: the command bar IS the screen. Nothing to dismiss, nothing
    /// to answer first.
    private var emptyPane: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if !state.pending.isEmpty { gateBanner }
                // The composer shows even with no projects registered: a
                // shell in the session root is a legal session, and hiding the
                // input until a project exists would have been the app
                // refusing to open a terminal because it does not know which
                // repo you meant — when you meant none.
                if state.workspaces.isEmpty { noWorkspaces }
                do {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("O que rodar?").font(.headline)
                        SessionComposer(
                            state: state,
                            allowsEmptyShell: true,
                            placeholder: "/forge-auto, claude, um comando — ou Enter para só o shell",
                            editorMaxHeight: 72,
                            onSubmitted: { state.showComposer = false })
                        Text("Enter vazio abre só o shell · sem projeto, abre no root · ⌘⇧N para escolher run e conta")
                            .font(.caption2).foregroundStyle(.tertiary)
                    }
                    // The screen used to be a command bar floating in a dark
                    // void. What belongs next to "what do you run?" is what is
                    // already running — a run alive on disk with no terminal
                    // here is precisely the thing you came to this screen to
                    // pick up, and it lived one click away on another tab.
                    // Recoverable sessions from a previous launch. Shown ABOVE
                    // "Rodando agora" — a restorable session is one click from
                    // being what "Rodando agora" is about, and the reopen
                    // offer belongs closest to the composer that opens
                    // sessions. Nothing here starts a process by itself: every
                    // descriptor renders a row, and only a tap opens one
                    // (`AppState.resumeSession`, called from a `Button` action
                    // only — see `S06-SUMMARY.md` for the grep that proves it).
                    if !state.restorable.isEmpty { restorableOffer }
                    if !state.liveRuns.isEmpty { runsHere }
                    hints
                }
            }
            .frame(maxWidth: 640, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 24).padding(.vertical, 28)
        }
    }

    private var runsHere: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("Rodando agora").font(.subheadline).bold()
                Text("\(state.liveRuns.count)")
                    .font(.caption2).monospacedDigit().foregroundStyle(.secondary)
                Spacer()
                Button("Ver todas") { state.section = .runs }
                    .buttonStyle(.plain).font(.caption)
                    .foregroundStyle(Color.accentOrange)
            }
            ForEach(state.liveRuns) { run in RunLaunchRow(run: run, state: state) }
        }
    }

    /// Sessions recoverable from `~/.claude/forge-sessions.json` (T01), for
    /// when there is nothing live to show instead. Retention (8 per distinct
    /// `cwd`) already happened when the descriptors were written — this view
    /// renders `state.restorable` as-is, in the order it arrives.
    private var restorableOffer: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("Retomar onde parou").font(.subheadline).bold()
                Text("\(state.restorable.count)")
                    .font(.caption2).monospacedDigit().foregroundStyle(.secondary)
                Spacer()
            }
            ForEach(state.restorable, id: \.self) { descriptor in
                RestorableSessionRow(descriptor: descriptor, state: state)
            }
        }
    }

    /// Inherited from the deleted Início screen — the one thing it had that
    /// lived nowhere else. A run stuck on a question is the most urgent state
    /// the app can be in, so it sits above the terminal rather than behind a
    /// tab you have to remember to visit.
    private var gateBanner: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "bolt.fill").forgeIcon(.micro).foregroundStyle(Color.accentOrange)
                Text(state.pending.count == 1
                     ? "1 run está esperando você"
                     : "\(state.pending.count) runs estão esperando você")
                    .font(.callout).bold()
                Spacer()
            }
            ForEach(state.pending) { gate in GateCard(gate: gate, state: state) }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentOrange.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14)
            .strokeBorder(Color.accentOrange.opacity(0.3)))
    }

    /// Also inherited. Without a project the composer cannot submit anything,
    /// so offering an input that refuses every Enter would be worse than
    /// saying what is missing.
    private var noWorkspaces: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Nenhum projeto observado", systemImage: "folder.badge.questionmark")
                .font(.callout)
            Text("Adicione a pasta de um projeto que usa o Forge para começar.")
                .font(.caption).foregroundStyle(.secondary)
            Button("Adicionar projeto…") { pickWorkspace(state) }.controlSize(.small)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 12))
    }

    /// The terminal screen with sessions open: chrome on top, the terminals
    /// themselves in the middle, and — when it is open — the run rail down the
    /// trailing edge.
    private var sessionsPane: some View {
        VStack(spacing: 0) {
            // Gates ride above the tabs, not inside a tab: the run that is
            // asking may not be the one you are looking at.
            if !state.pending.isEmpty {
                gateBanner.padding(.horizontal, 12).padding(.top, 10)
            }
            // One session needs no tab strip — a slim header with a real
            // "Encerrar" button reads better than a lone tab with a tiny x.
            // Several sessions need to be comparable at a glance, so they
            // become tabs. On the wall each pane carries its own header, so
            // a strip above them would name every session twice.
            if state.sessions.count == 1, let only = state.sessions.first, !boardApplies {
                SingleSessionHeader(session: only, state: state)
                Divider()
            } else if !wallApplies && !boardApplies {
                tabStrip
                Divider()
            }

            terminalsPane
                // The floating layer. Ordered back-to-front: images sit at
                // the bottom edge, the HUD in the corner, the command bar on
                // top of both because it is modal in intent even though it
                // is not a sheet.
                .overlay(alignment: .bottomTrailing) { imageStrip }
                .overlay(alignment: .topTrailing) { zoomHud }
                .overlay(alignment: .top) { floatingComposer }
        }
        // Weaker than the home: this one sits behind live terminals, and a
        // background competing with what an agent is printing is a background
        // that will be turned off.
        .background(ForgeBackground(intensity: 0.45, embers: false))
    }

    /// Wall or stack. Both keep every session mounted — the wall by drawing all
    /// of them, the stack by hiding rather than unmounting — because losing a
    /// mount is losing the PTY's scrollback.
    @ViewBuilder private var terminalsPane: some View {
        if boardApplies {
            BoardView(state: state, focused: currentID)
                // The board's own drag gestures are declared in this space, so
                // a wire dropped at the far edge of a panned canvas still lands
                // on the node that is drawn there.
                .coordinateSpace(name: "boardCanvas")
        } else if wallApplies {
            SessionWall(state: state, focused: currentID)
        } else {
            ZStack {
                ForEach(state.sessions) { s in
                    TerminalHost(session: s)
                        .opacity(s.id == currentID ? 1 : 0)
                        .allowsHitTesting(s.id == currentID)
                }
            }
        }
    }

    // MARK: - Floating parts

    @ViewBuilder private var floatingComposer: some View {
        if state.showComposer {
            VStack(alignment: .leading, spacing: 8) {
                composer
                HStack(spacing: 10) {
                    Text("esc fecha").font(.caption2).foregroundStyle(.tertiary)
                    Button("Escolher run e conta…") {
                        state.showComposer = false
                        state.showLauncherSheet = true
                    }
                    .buttonStyle(.plain)
                    .font(.caption2)
                    .foregroundStyle(Color.accentOrange)
                }
            }
            .frame(maxWidth: 620)
            .padding(14)
            .forgeSurface(.floating)
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(.quaternary))
            .shadow(radius: 22, y: 8)
            .padding(.top, 14)
            .transition(.move(edge: .top).combined(with: .opacity))
            // The escape hatch. A floating panel with no visible way out is
            // worse than the sheet it replaced.
            .background {
                Button("") { state.showComposer = false }
                    .keyboardShortcut(.cancelAction)
                    .opacity(0)
            }
        }
    }

    /// The ⌘T panel: same input, no project chips — over a live terminal the
    /// extra row costs more screen than the `@` it saves.
    private var composer: some View {
        SessionComposer(
            state: state,
            allowsEmptyShell: true,
            placeholder: "/forge-auto, claude, um comando — ou Enter para só o shell",
            editorMaxHeight: 72,
            onSubmitted: { state.showComposer = false })
    }

    /// Zoom feedback where the eyes are, then gone. A permanent read-out would
    /// be one more thing on screen that is right 100% of the time and useful
    /// for about one second of it.
    @ViewBuilder private var zoomHud: some View {
        if showZoomHud {
            Text(TerminalZoom.label(terminals.fontSize))
                .font(ForgeType.mono)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .forgeSurface(.floating, in: Capsule())
                .overlay(Capsule().strokeBorder(.quaternary))
                .padding(12)
                .transition(.opacity)
                .allowsHitTesting(false)
        }
    }

    @ViewBuilder private var imageStrip: some View {
        if let session = state.visibleSession {
            AttachedImages(session: session)
        }
    }

    private func flashZoomHud() {
        zoomFlash += 1
        let token = zoomFlash
        withAnimation(.easeOut(duration: 0.12)) { showZoomHud = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.3) {
            guard token == zoomFlash else { return }
            withAnimation(.easeIn(duration: 0.35)) { showZoomHud = false }
        }
    }

    /// Said once, where there is room to say it — the two gestures that are not
    /// guessable from looking at a terminal.
    private var hints: some View {
        HStack(spacing: 16) {
            Label("arraste imagens para dentro", systemImage: "photo.on.rectangle.angled")
            Label("⌘V cola print", systemImage: "doc.on.clipboard")
            Label("⌘F busca", systemImage: "magnifyingglass")
            Label("⌘= ⌘− zoom", systemImage: "textformat.size")
        }
        .font(.caption2).foregroundStyle(.tertiary)
        .labelStyle(.titleAndIcon)
        .padding(.top, 4)
    }

    // MARK: - Tabs

    /// Selection lives in AppState, not in `@State`: creating a session has to
    /// be able to point the operator at it, and this view may not even be on
    /// screen at that moment.
    private var currentID: UUID? {
        TerminalFocus.resolve(selection: state.focusedSession, among: state.sessions.map(\.id))
    }

    /// Up to four tabs share the width evenly; beyond that they keep a readable
    /// minimum and the strip scrolls, so tabs never shrink into unreadable slivers.
    private var tabStrip: some View {
        let evenly = state.sessions.count <= 4
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Array(state.sessions.enumerated()), id: \.element.id) { idx, s in
                    TerminalTab(
                        session: s,
                        index: idx,
                        isActive: s.id == currentID,
                        onSelect: { state.focusedSession = s.id },
                        onClose: { close(s) })
                    .frame(minWidth: 150, maxWidth: evenly ? .infinity : 230)
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 7)
            .frame(maxWidth: evenly ? .infinity : nil, alignment: .leading)
        }
        .scrollDisabled(evenly)
    }

    private func close(_ s: TerminalSession) {
        _ = state.closeSession(s, confirm: true)
    }
}

// MARK: - Attached images

/// The strip of images pasted or dropped into this session.
///
/// This is the answer to "⌘V pastes a path and I cannot see the image". The
/// path is what Claude Code needs; the thumbnail is what the operator needs,
/// and the terminal grid cannot hold one — Claude Code repaints over anything
/// drawn into it. So it floats above.
struct AttachedImages: View {
    @ObservedObject var session: TerminalSession

    var body: some View {
        if !session.images.isEmpty {
            HStack(alignment: .bottom, spacing: 8) {
                ForEach(session.images) { image in
                    AttachedImageChip(image: image) { session.forget(image) }
                }
            }
            .padding(12)
            .transition(.opacity)
        }
    }
}

struct AttachedImageChip: View {
    let image: SessionImage
    let onDismiss: () -> Void

    @State private var thumbnail: NSImage?
    @State private var hovering = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Button {
                NSWorkspace.shared.open(image.url)
            } label: {
                Group {
                    if let thumbnail {
                        Image(nsImage: thumbnail).resizable().scaledToFill()
                    } else {
                        // Never a blank box: a chip that shows nothing is
                        // indistinguishable from an attachment that failed.
                        Image(systemName: "photo")
                            .forgeIcon(.large)
                            .foregroundStyle(.tertiary)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
                .frame(width: 86, height: 60)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.quaternary))
                .forgeSurface(.panel)
                .shadow(radius: hovering ? 10 : 4, y: 2)
            }
            .buttonStyle(.plain)
            .help("\(image.name) — clique para abrir")

            if hovering {
                Button(action: onDismiss) {
                    Image(systemName: "xmark.circle.fill")
                        .forgeIcon(.medium)
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(.white, .black.opacity(0.65))
                }
                .buttonStyle(.plain)
                .offset(x: 5, y: -5)
                .help("Tirar da lista (o arquivo continua no disco)")
            }
        }
        .onHover { hovering = $0 }
        .task(id: image.url) { await load() }
    }

    /// Off the main actor: a screenshot from a Retina display is several
    /// megabytes, and decoding it where the UI runs stutters the terminal that
    /// is repainting right behind this chip.
    private func load() async {
        let url = image.url
        let decoded: NSImage? = await Task.detached(priority: .utility) {
            NSImage(contentsOf: url)
        }.value
        thumbnail = decoded
    }
}

/// Header shown when exactly one session is open.
struct SingleSessionHeader: View {
    @ObservedObject var session: TerminalSession
    @ObservedObject var state: AppState

    var body: some View {
        HStack(spacing: 9) {
            Circle().fill(session.isRunning ? Color.green : Color.secondary)
                .frame(width: 7, height: 7)
            Text(session.tabLabel).font(.callout).bold()
            Text(session.projectName).font(.caption).foregroundStyle(.secondary)
            if let a = session.account, !a.isEmpty {
                Text("· \(a)").font(.caption).foregroundStyle(.tertiary)
            }
            if let e = session.exitLabel {
                Text(e).font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer()
            Button(session.isRunning ? "Encerrar" : "Fechar") {
                _ = state.closeSession(session, confirm: true)
            }
            .controlSize(.small)
            .help("Encerrar sessão (⌘W)")
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
    }
}

/// One tab. The close control is a real 18pt hit target that appears on hover
/// (or whenever the tab is active), instead of a permanent 8pt glyph that is
/// both hard to hit and visually noisy across many tabs.
struct TerminalTab: View {
    @ObservedObject var session: TerminalSession
    let index: Int
    let isActive: Bool
    let onSelect: () -> Void
    let onClose: () -> Void

    @State private var hovering = false

    /// ⌘1…⌘9 exist; a tab that never says so is a shortcut nobody finds.
    private var shortcutHint: String? { index < 9 ? "⌘\(index + 1)" : nil }

    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(session.isRunning ? Color.green : Color.secondary)
                .frame(width: 6, height: 6)

            VStack(alignment: .leading, spacing: 1) {
                Text(session.tabLabel)
                    .font(.caption).lineLimit(1).truncationMode(.middle)
                HStack(spacing: 4) {
                    Text(session.projectName)
                    if let a = session.account, !a.isEmpty { Text("· \(a)") }
                }
                .font(ForgeType.micro).foregroundStyle(.tertiary).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if hovering || isActive {
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .forgeIcon(.micro, weight: .semibold)
                        .frame(width: 18, height: 18)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(hovering ? .primary : .tertiary)
                .help("Fechar sessão (⌘W)")
            } else if let shortcutHint {
                Text(shortcutHint)
                    .font(ForgeType.monoSmall)
                    .foregroundStyle(.quaternary)
                    .frame(width: 18)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(isActive ? AnyShapeStyle(.quaternary)
                             : AnyShapeStyle(hovering ? AnyShapeStyle(.quaternary.opacity(0.5))
                                                      : AnyShapeStyle(.clear)),
                    in: RoundedRectangle(cornerRadius: 7))
        .contentShape(Rectangle())
        .onTapGesture(perform: onSelect)
        .onHover { hovering = $0 }
    }
}

/// A live run, on the screen where sessions are started.
///
/// The row states the one thing the Runs tab could not: whether this run has a
/// terminal in THIS app. Runs are records on disk and outlive every process —
/// one started in Terminal.app, by `bin/forge-run`, or before the last quit is
/// active with no session here, and that is the ordinary case rather than the
/// exception. So the action is two actions, and the row says which one it is
/// instead of opening a second session onto the same run.
struct RunLaunchRow: View {
    let run: Run
    @ObservedObject var state: AppState
    @State private var hovering = false

    private var attached: TerminalSession? { state.session(for: run) }

    var body: some View {
        HStack(spacing: 9) {
            Circle().fill(run.isStale ? Color.orange : Color.green)
                .frame(width: 6, height: 6)
                .help(run.isStale ? "Sem heartbeat há mais de 15min" : "Ativo")

            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(run.projectName).font(.callout)
                    Text(run.id)
                        .font(ForgeType.mono)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1).truncationMode(.middle)
                }
                HStack(spacing: 5) {
                    if let w = run.workerParts { Text("\(w.unit) \(w.id)") }
                    if let acct = run.account, !acct.isEmpty { Text("· \(acct)") }
                    Text(attached == nil ? "· sem terminal aqui" : "· aberta neste app")
                }
                .font(ForgeType.caption).foregroundStyle(.tertiary).lineLimit(1)
            }

            Spacer(minLength: 8)

            if let attached {
                Button("Ir para") { state.focus(attached) }
                    .controlSize(.small)
                    .help("Esta run já tem uma aba aberta no app")
            } else {
                Button("Abrir aqui") { state.resume(run) }
                    .controlSize(.small)
                    .help("Abre uma aba com /forge-auto \(run.id) neste projeto")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .background(hovering ? AnyShapeStyle(.quaternary.opacity(0.45))
                             : AnyShapeStyle(.quaternary.opacity(0.22)),
                    in: RoundedRectangle(cornerRadius: 10))
        .onHover { hovering = $0 }
    }
}

/// One recoverable session from `state.restorable`. `resumable` mirrors what
/// `SessionResume.plan(for:)` (T02) decides — a descriptor whose engine
/// cannot resume gets its engine as a plain label and no button, never a
/// button that opens nothing: an opção morta is worse than no offer.
struct RestorableSessionRow: View {
    let descriptor: SessionDescriptor
    @ObservedObject var state: AppState
    @State private var hovering = false

    private var resumable: Bool { SessionResume.plan(for: descriptor) != nil }

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: "clock.arrow.circlepath")
                .forgeIcon(.small)
                .foregroundStyle(.tertiary)

            VStack(alignment: .leading, spacing: 1) {
                Text(descriptor.title).font(.callout).lineLimit(1)
                Text(ProjectOrganiser.abbreviate(descriptor.cwd, home: NSHomeDirectory()))
                    .font(ForgeType.caption)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1).truncationMode(.middle)
            }

            Spacer(minLength: 8)

            if resumable {
                // The ONLY place this row calls `resumeSession` — a `Button`
                // action, never `onAppear`/`init`/`task`.
                Button("Retomar") { state.resumeSession(descriptor) }
                    .controlSize(.small)
                    .help("Reabre esta sessão com claude --continue")
            } else {
                Text(ForgeEngine(descriptor.engine).tag)
                    .font(ForgeType.mono)
                    .foregroundStyle(.tertiary)
                    .help("\(descriptor.engine) ainda não retoma sessão")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .background(hovering ? AnyShapeStyle(.quaternary.opacity(0.45))
                             : AnyShapeStyle(.quaternary.opacity(0.22)),
                    in: RoundedRectangle(cornerRadius: 10))
        .onHover { hovering = $0 }
    }
}
