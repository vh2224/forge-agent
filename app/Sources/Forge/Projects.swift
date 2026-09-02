// Projects — the workspaces Forge watches, and their live state.
//
// Until now a "project" was just a path in a JSON array with a + button hidden
// in the sidebar footer. This makes it a first-class object: what is running in
// it, what it is waiting on, and where to act.
//
// Per-project state comes from `forge-status.js --json`, which already knows
// how to read runs, the focused milestone and warnings. That call spawns node,
// so it is refreshed on demand and cached — unlike gates and runs, which are
// plain file reads and can be polled.

import SwiftUI
import AppKit
import ForgeKit

// MARK: - Status payload

struct ProjectStatus: Codable {
    let cwd: String?
    let runs: Runs?
    let milestone: Milestone?
    let warnings: [String]?

    struct Runs: Codable {
        let active: [ActiveRun]?
        let focused: String?
        let note: String?
    }

    struct ActiveRun: Codable {
        let id: String?
        let worker: String?
    }

    struct Milestone: Codable {
        let id: String?
        let title: String?
        let phase: String?
        let slice: String?
        let progress: String?
    }
}

// MARK: - Folder appearance

/// Finder's own view of a folder: its icon and its colour tags.
///
/// `tagColors` is still what project cards use for the dots beside the name —
/// a tag is information the operator put there deliberately. `icon` no longer
/// feeds the project card, which now draws what the project is built with
/// (see `ProjectCard.projectIcon`); it remains for the worktree rows, which
/// are plain folders with nothing to detect.
enum FolderLook {
    static func icon(for path: String) -> NSImage {
        let img = NSWorkspace.shared.icon(forFile: path)
        img.size = NSSize(width: 32, height: 32)
        return img
    }

    /// Finder tag names, mapped to their standard colours.
    static func tagColors(for path: String) -> [Color] {
        let url = URL(fileURLWithPath: path)
        guard let values = try? url.resourceValues(forKeys: [.tagNamesKey]),
              let names = values.tagNames else { return [] }
        return names.compactMap { color(named: $0) }
    }

    private static func color(named raw: String) -> Color? {
        switch raw.lowercased() {
        case "red", "vermelho":       return .red
        case "orange", "laranja":     return .orange
        case "yellow", "amarelo":     return .yellow
        case "green", "verde":        return .green
        case "blue", "azul":          return .blue
        case "purple", "roxo":        return .purple
        case "gray", "grey", "cinza": return .gray
        default:                      return nil
        }
    }
}

// MARK: - View

struct ProjectsView: View {
    @ObservedObject var state: AppState
    @State private var discovered: [String] = []
    @State private var scanning = false
    @State private var showDiscovery = false
    @State private var dropTargeted = false
    /// Evidence rows for `state.touchedWorkspaces`, refreshed only when that
    /// list changes — see `touchedNotice` for why this is not computed in
    /// `body`.
    @State private var touchedRows: [TouchedRow] = []
    @AppStorage("projectsGrouping") private var groupingRaw = ProjectGrouping.byFolder.rawValue
    /// Which folders are closed, across launches. Newline-joined paths — the
    /// codec is `CollapseStore`, in ForgeKit, so it can be tested; the raw
    /// string lives here because `@AppStorage` cannot hold a `Set`.
    @AppStorage("projectsCollapsed") private var collapsedRaw = ""

    private var collapsed: Binding<Set<String>> {
        Binding(get: { CollapseStore.decode(collapsedRaw) },
                set: { collapsedRaw = CollapseStore.encode($0) })
    }

    private var grouping: ProjectGrouping {
        ProjectGrouping(rawValue: groupingRaw) ?? .byFolder
    }

    /// Live signals for one project. Cheap by construction: both fields come
    /// from lists `reloadCheap` already read. `dirty` is left unmeasured — git
    /// costs ~102 ms per project (`ProjectDigest`) and this runs for every node
    /// on every reorder; the cards fill their own git off the reload path.
    private func attention(_ path: String) -> ProjectAttention {
        ProjectAttention(questions: state.pending.filter { $0.cwd == path }.count,
                         runs: state.liveRuns.filter { $0.cwd == path }.count,
                         dirty: nil)
    }

    /// Projects needing attention first: questions, then active runs, then name.
    /// The order answers "where do I go now?" without reading every card — and
    /// is the SAME comparator the tree sorts with, so flipping the segmented
    /// control cannot change which project is first.
    private func ordered(_ list: [String]) -> [String] {
        ProjectTreeAttention.ordered(paths: list, attention: attention)
    }

    private var containment: [String: Int] {
        ProjectOrganiser.containment(state.workspaces)
    }

    private var home: String {
        FileManager.default.homeDirectoryForCurrentUser.path
    }

    private let columns = [GridItem(.adaptive(minimum: 300), spacing: 14)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if state.registryUnreadable { unreadableNotice }

                if !state.workspaces.isEmpty { hazardNotice }

                switch grouping {
                case .flat:
                    let roles = ProjectMarker.roles(state.workspaces)
                    LazyVGrid(columns: columns, alignment: .leading, spacing: 14) {
                        ForEach(ordered(state.workspaces), id: \.self) { ws in
                            ProjectCard(path: ws, state: state,
                                        contains: containment[ws] ?? 0,
                                        role: roles[ws] ?? .project)
                        }
                    }
                case .byFolder:
                    let allTree = ProjectTree.build(projects: state.workspaces,
                                                    roots: Workspaces.declaredRoots(),
                                                    home: home)
                    // Ordered by what each node HIDES, not by its own path: a
                    // folder with a question three levels down outranks a quiet
                    // one whose name sorts earlier.
                    let tree = ProjectTreeAttention.ordered(allTree, attention: attention)
                    ForEach(tree) { node in
                        ProjectTreeRow(node: node, depth: 0, state: state,
                                      containment: containment, attention: attention,
                                      collapsed: collapsed, columns: columns)
                    }
                }

                if state.workspaces.isEmpty && state.touchedWorkspaces.isEmpty { empty }

                if !state.touchedWorkspaces.isEmpty { touchedNotice }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
        }
        .navigationTitle("Projetos")
        .task(id: state.touchedWorkspaces) {
            let paths = state.touchedWorkspaces
            let h = home
            let rows = await Task.detached(priority: .utility) {
                TouchedRow.load(paths: paths, home: h)
            }.value
            touchedRows = rows
        }
        .overlay {
            if dropTargeted {
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(Color.accentOrange, style: StrokeStyle(lineWidth: 2, dash: [6]))
                    .padding(8)
                    .overlay(Text("Solte para adicionar").font(.callout).bold())
            }
        }
        .onDrop(of: ["public.file-url"], isTargeted: $dropTargeted) { providers in
            for p in providers {
                _ = p.loadObject(ofClass: URL.self) { url, _ in
                    guard let url else { return }
                    var isDir: ObjCBool = false
                    guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir),
                          isDir.boolValue else { return }
                    Task { @MainActor in state.addWorkspace(url.path) }
                }
            }
            return true
        }
        .sheet(isPresented: $showDiscovery) {
            DiscoverySheet(state: state, found: discovered, isPresented: $showDiscovery)
        }
        .toolbar {
            ToolbarItem {
                Picker("", selection: $groupingRaw) {
                    ForEach(ProjectGrouping.allCases, id: \.rawValue) { g in
                        Text(g.rawValue).tag(g.rawValue)
                    }
                }
                .pickerStyle(.segmented).labelsHidden().frame(width: 160)
            }
            ToolbarItem {
                Button { scan() } label: {
                    if scanning { ProgressView().controlSize(.small) }
                    else { Label("Procurar", systemImage: "sparkle.magnifyingglass") }
                }
                .disabled(scanning)
                .help("Procurar projetos com .gsd/ no seu Mac")
            }
            ToolbarItem {
                Button { pickWorkspace(state) } label: {
                    Label("Adicionar", systemImage: "plus")
                }
            }
        }
    }

    // MARK: Unreadable registry

    /// The registry file exists but could not be parsed. The list below is
    /// whatever it was before this reload — never silently emptied — but that
    /// fact has to be on screen, or a corrupt file and a fresh install look
    /// identical (I-20260802223042).
    @ViewBuilder private var unreadableNotice: some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: "exclamationmark.triangle.fill")
                .forgeIcon(.small).foregroundStyle(Color.accentOrange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Registro de projetos não pôde ser lido")
                    .font(.callout).bold()
                Text("A lista abaixo NÃO foi alterada. Corrija ~/.claude/forge-gate-workspaces.json — há um backup .bak ao lado após a migração.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentOrange.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10)
            .strokeBorder(Color.accentOrange.opacity(0.3)))
    }

    // MARK: Hazard

    /// An *undeclared* project containing most of the others is nearly always a
    /// stray .gsd/ at the top of a code folder.
    ///
    /// A declared workspace containing its members is the normal case and is
    /// never flagged — before that exception existed this notice pointed at
    /// `lookchina`, the workspace this milestone had just promoted, and told
    /// the operator to delete it (I-20260803154521). The predicate lives in
    /// `ProjectOrganiser.containmentHazards`, where it can be tested.
    ///
    /// The action is deliberately not destructive. It used to be "Remover da
    /// lista" as the notice's only, primary button — one click from the top of
    /// the screen to the removal that cost two registry entries in S05. Removal
    /// is still offered where it belongs: on the card for that project, marked
    /// `role: .destructive`, behind its menu. An advisory's job is to get the
    /// operator looking at the folder, which is what this button now does.
    @ViewBuilder private var hazardNotice: some View {
        let suspects = ProjectOrganiser.containmentHazards(
            state.workspaces, declaredWorkspaces: state.declaredWorkspaces)
        if let worst = suspects.first {
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .forgeIcon(.small).foregroundStyle(Color.accentOrange)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(ProjectOrganiser.name(worst.path)) contém \(worst.count) dos outros projetos")
                        .font(.callout)
                    Text("Um .gsd/ na raiz de uma pasta de código engole tudo abaixo dela. Se for proposital, promova a pasta a workspace; se não, remova-a pelo menu do card.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Ver pasta") { ForgeCore.reveal(worst.path) }
                    .controlSize(.small)
            }
            .padding(13)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.accentOrange.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Color.accentOrange.opacity(0.3)))
        }
    }

    // MARK: Touched

    /// Registered directories holding a `.gsd/` with no work inside.
    ///
    /// Listed rather than quietly dropped. The predicate is a heuristic, and
    /// the operator is the one who knows whether a repo is a project that lost
    /// its artifacts or a repo a run merely walked through — hiding these would
    /// look exactly like a detector that had broken.
    ///
    /// Each row now carries the EVIDENCE for the decision it asks for — what is
    /// inside the `.gsd/`, when it was last touched, whether it is a repository
    /// — composed in `TouchedRow` (ForgeKit) so the wording and the states are
    /// testable. This view only lays them out.
    ///
    /// `touchedRows` is `@State` filled by the `.task` below rather than
    /// computed here: `body` re-evaluates on every 15 s reload and on every
    /// FSEvent, and `TouchedRow.load` does real syscalls per entry. Cheap is
    /// not free, and this screen has a standing rule about the reload path.
    @ViewBuilder private var touchedNotice: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 6) {
                Image(systemName: TouchedRow.sectionSymbol)
                    .forgeIcon(.micro).foregroundStyle(.secondary)
                Text(TouchedRow.sectionTitle).font(.callout).bold()
                Text("\(state.touchedWorkspaces.count)")
                    .font(.caption2).monospacedDigit()
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Color.secondary.opacity(0.15), in: Capsule())
                    .foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(TouchedRow.sectionSummary)
                Text(TouchedRow.sectionWhy).foregroundStyle(.tertiary)
            }
            .font(.caption).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)

            VStack(spacing: 0) {
                ForEach(Array(touchedRows.enumerated()), id: \.element.id) { i, row in
                    if i > 0 { Divider().opacity(0.4) }
                    touchedRowView(row)
                }
            }
            .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))

            Text(TouchedRow.removeFootnote)
                .font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10)
            .strokeBorder(Color.secondary.opacity(0.18)))
    }

    /// One touched directory: name, where it lives, the evidence, the action.
    ///
    /// The button is `role: .destructive` — SwiftUI's own destructive treatment,
    /// not a hand-rolled red — and `.tint(.red)` is what carries that colour
    /// into a borderless control, where the role alone does not tint. Its label
    /// says "lista", never "excluir": `removeWorkspace` drops a registry entry
    /// and touches no file. See `TouchedRow` for why there is no confirmation.
    @ViewBuilder private func touchedRowView(_ row: TouchedRow) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: "folder")
                .forgeIcon(.small).foregroundStyle(.tertiary)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text(row.name).font(.callout).lineLimit(1)
                Text(row.location)
                    .font(.caption2).foregroundStyle(.tertiary)
                    .lineLimit(1).truncationMode(.head)
                HStack(spacing: 10) {
                    ForEach(row.facts, id: \.kind) { fact in
                        HStack(spacing: 3) {
                            Image(systemName: fact.symbol).forgeIcon(.micro)
                            Text(fact.text).lineLimit(1)
                        }
                        .font(.caption2)
                        .foregroundStyle(fact.measured ? AnyShapeStyle(.secondary)
                                                       : AnyShapeStyle(.tertiary))
                    }
                }
                .padding(.top, 1)
            }
            Spacer(minLength: 10)
            Button(role: .destructive) {
                state.removeWorkspace(row.path)
            } label: {
                Label(TouchedRow.removeLabel, systemImage: TouchedRow.removeSymbol)
            }
            .controlSize(.small).buttonStyle(.borderless).tint(.red)
            .help(TouchedRow.removeHelp(row.name))
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
    }

    private func scan() {
        scanning = true
        let declared = Workspaces.declaredRoots()
        Task.detached(priority: .userInitiated) {
            let hits = declared.isEmpty
                ? ProjectDiscovery.scan()
                : ProjectDiscovery.scan(declaredRoots: declared)
            await MainActor.run {
                // Touched paths count as known: they are registered, so
                // re-offering one that gained a milestone would duplicate it.
                let known = Set(state.workspaces).union(state.touchedWorkspaces)
                discovered = hits.filter { !known.contains($0) }
                scanning = false
                if discovered.isEmpty { state.show("Nenhum projeto novo encontrado") }
                else { showDiscovery = true }
            }
        }
    }

    private var empty: some View {
        VStack(spacing: 12) {
            Image(systemName: "folder.badge.plus")
                .forgeIcon(.hero).foregroundStyle(.tertiary)
            Text("Nenhum projeto").font(.headline)
            Text("Adicione a pasta de um projeto que use o Forge (com .gsd/).")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("Procurar no Mac") { scan() }
                Button("Escolher pasta…") { pickWorkspace(state) }
            }
            Text("Ou arraste uma pasta para cá.")
                .font(.caption2).foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity).padding(.top, 40)
    }
}

// MARK: - Tree row

/// One node of the *Por pasta* tree, drawn recursively. SwiftUI cannot recurse
/// directly inside a `@ViewBuilder` without type erasure, so this is a named
/// `View` rather than a helper method.
///
/// The card-or-header decision is `node.role.isRegistrable` — never a path
/// heuristic. A `folder` node draws a collapsible header and never instantiates
/// `ProjectCard`; a registrable node draws the card and, if it has children
/// (a workspace containing other projects), draws them recursively beneath it.
struct ProjectTreeRow: View {
    let node: ProjectTreeNode
    let depth: Int
    @ObservedObject var state: AppState
    let containment: [String: Int]
    let attention: (String) -> ProjectAttention
    @Binding var collapsed: Set<String>
    let columns: [GridItem]

    private var isCollapsed: Bool { collapsed.contains(node.path) }

    /// What this folder is hiding, transitively. Computed for the header only,
    /// and only from state the reload already holds.
    private var rollup: ProjectRollup {
        ProjectTreeAttention.rollup(node, attention: attention)
    }

    private var weight: ProjectWeight {
        ProjectWeight.of(role: node.role, depth: depth)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if node.role.isRegistrable {
                ProjectCard(path: node.path, state: state,
                           contains: containment[node.path] ?? 0,
                           role: node.role, weight: weight)
                    .padding(.leading, CGFloat(depth) * 14)
            } else {
                header
            }

            if !node.children.isEmpty && !isCollapsed {
                ForEach(ProjectTreeAttention.ordered(node.children, attention: attention)) { child in
                    ProjectTreeRow(node: child, depth: depth + 1, state: state,
                                  containment: containment, attention: attention,
                                  collapsed: $collapsed, columns: columns)
                }
            }
        }
        .padding(.bottom, node.role.isRegistrable ? 0 : 4)
    }

    /// A folder header, drawn light — it is a path component, not a
    /// destination. `ProjectWeight` decides how light; the row does not infer
    /// prominence from its own indentation.
    @ViewBuilder private var header: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.15)) {
                if isCollapsed { collapsed.remove(node.path) }
                else { collapsed.insert(node.path) }
            }
        } label: {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                        .forgeIcon(.micro)
                    Image(systemName: "folder").forgeIcon(.micro)
                    Text(node.title)
                        .font(.system(size: weight.titleSize,
                                      weight: weight.isBold ? .bold : .regular))
                    // How much this folder stands for, open or closed. Dropped
                    // in the rewrite — `apps` rendered bare where it used to
                    // read `apps 5` — and a folder that does not say how much
                    // it holds is exactly the roll-up this screen exists for.
                    // While closed the fuller `rollup.summary` below says it in
                    // words; this is the count that must never disappear.
                    if rollup.projects > 0 {
                        Text("\(rollup.projects)")
                            .font(.caption2).monospacedDigit()
                            .foregroundStyle(.tertiary)
                            .help(rollup.projects == 1 ? "1 projeto aqui dentro"
                                                       : "\(rollup.projects) projetos aqui dentro")
                    }
                    // Attention rolls up transitively: a collapsed folder still
                    // says whether something inside — at any depth — needs you.
                    // A run underneath used to disappear entirely on collapse.
                    if rollup.questions > 0 {
                        Text("\(rollup.questions)")
                            .font(.caption2).monospacedDigit()
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Color.accentOrange.opacity(0.22), in: Capsule())
                            .foregroundStyle(Color.accentOrange)
                    }
                    if rollup.runs > 0 {
                        Circle().fill(Color.green).frame(width: 6, height: 6)
                            .help("\(rollup.runs) run(s) em execução aqui dentro")
                    }
                    Spacer()
                }
                // The contents, spelled out. Shown while collapsed because that
                // is when the folder is the only thing on screen standing for
                // them; while open the cards themselves say it.
                if isCollapsed {
                    Text(rollup.summary)
                        .font(.caption2).foregroundStyle(.tertiary)
                        .padding(.leading, 21)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .opacity(weight.opacity)
        .padding(.leading, CGFloat(depth) * 14)
    }
}

/// Results of a scan, pre-selected — the common case is "add them all".
struct DiscoverySheet: View {
    @ObservedObject var state: AppState
    let found: [String]
    @Binding var isPresented: Bool
    @State private var selected: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Projetos encontrados").font(.headline)
            Text("\(found.count) pasta(s) com .gsd/ que ainda não estão na lista.")
                .font(.caption).foregroundStyle(.secondary)

            List(found, id: \.self) { p in
                Toggle(isOn: Binding(
                    get: { selected.contains(p) },
                    set: { on in if on { selected.insert(p) } else { selected.remove(p) } }
                )) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(ProjectOrganiser.name(p)).font(.callout)
                        Text(ProjectOrganiser.abbreviate(
                            p, home: FileManager.default.homeDirectoryForCurrentUser.path))
                            .font(.caption2).foregroundStyle(.tertiary)
                    }
                }
            }
            .frame(height: 240)

            HStack {
                Button(selected.count == found.count ? "Desmarcar todos" : "Marcar todos") {
                    selected = selected.count == found.count ? [] : Set(found)
                }
                .controlSize(.small)
                Spacer()
                Button("Cancelar") { isPresented = false }.keyboardShortcut(.cancelAction)
                Button("Adicionar \(selected.count)") {
                    for p in selected { state.addWorkspace(p) }
                    isPresented = false
                }
                .keyboardShortcut(.defaultAction).disabled(selected.isEmpty)
            }
        }
        .padding(20).frame(width: 520)
        .onAppear { selected = Set(found) }
    }
}

struct ProjectCard: View {
    let path: String
    @ObservedObject var state: AppState
    /// How many other registered projects live inside this one.
    var contains: Int = 0
    /// What this directory IS, from `ProjectMarker.roles` / the tree — never
    /// inferred here from the path.
    var role: ProjectRole = .project
    var weight: ProjectWeight = .project

    @State private var status: ProjectStatus?
    @State private var checkouts: [Checkout] = []
    @State private var openItems = 0
    /// Everything the card says about the project except git — loaded with
    /// `git: .none`, which `ProjectDigest` measured at 0.77 ms/card.
    @State private var digest: ProjectDigest?
    /// Git, staged OFF the reload path. `nil` here means "not measured yet" and
    /// is rendered as exactly that; a blank line would be indistinguishable
    /// from a repo with no branch.
    @State private var gitField: DigestGitField?
    /// What the project is built with — the icon's meaning. Held in `@State`
    /// rather than computed in `body` because `hovering` is also `@State`, so
    /// the body re-renders on every mouse-over; a `detect()` call there would
    /// put a filesystem walk behind cursor movement. Measured at 0.27-0.46 ms,
    /// it is cheap enough for the reload path but not for the pointer.
    @State private var stack: StackDetection?
    @State private var loading = false
    @State private var showLauncher = false
    @State private var launchTarget: String?
    @State private var hovering = false
    @State private var expanded = false

    private var name: String { URL(fileURLWithPath: path).lastPathComponent }

    private var abbreviatedPath: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
    }

    /// Runs and gates are attributed by cwd, and with worktree isolation that
    /// cwd is the WORKTREE, not the folder in the list. Matching only the
    /// project path would show zero activity while a milestone is running.
    private var ownedPaths: Set<String> {
        Set([path] + checkouts.map(\.path))
    }

    private var runsHere: [Run] { state.liveRuns.filter { ownedPaths.contains($0.cwd) } }
    private var gatesHere: [Gate] { state.pending.filter { $0.cwd.map(ownedPaths.contains) ?? false } }
    private var sessionsHere: [TerminalSession] { state.sessions.filter { ownedPaths.contains($0.cwd) } }

    private var extraCheckouts: [Checkout] { checkouts.filter { !$0.isPrimary } }

    private var hasGsd: Bool {
        FileManager.default.fileExists(atPath: "\(path)/.gsd")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header

            if !hasGsd {
                Label("Sem .gsd/ — o Forge ainda não foi iniciado aqui",
                      systemImage: "exclamationmark.triangle")
                    .font(.caption2).foregroundStyle(.orange)
            }

            digestLines

            signals

            if let m = status?.milestone, let id = m.id {
                VStack(alignment: .leading, spacing: 2) {
                    Text(m.title ?? id).font(.caption).lineLimit(1)
                    HStack(spacing: 6) {
                        Text(id).font(.caption2).foregroundStyle(.tertiary)
                        if let p = m.phase { Text("· \(p)").font(.caption2).foregroundStyle(.tertiary) }
                        if let sl = m.slice { Text("· \(sl)").font(.caption2).foregroundStyle(.tertiary) }
                    }
                }
            }

            if let w = status?.warnings, !w.isEmpty {
                ForEach(w.prefix(2), id: \.self) { line in
                    Label(line, systemImage: "exclamationmark.circle")
                        .font(.caption2).foregroundStyle(.orange).lineLimit(2)
                }
            }

            if !extraCheckouts.isEmpty { worktreeSection }

            Divider().padding(.vertical, 1)
            actions
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .forgeSurface(.raised)
        .overlay(RoundedRectangle(cornerRadius: 12)
            .strokeBorder(gatesHere.isEmpty ? Color.clear
                                            : Color.accentOrange.opacity(0.35), lineWidth: 1))
        .onHover { hovering = $0 }
        .sheet(isPresented: $showLauncher) {
            LauncherSheet(state: state, isPresented: $showLauncher,
                          initialWorkspace: launchTarget ?? path)
        }
        .task(id: path) { await refresh() }
    }

    private var header: some View {
        HStack(spacing: 10) {
            projectIcon

            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 5) {
                    Text(name)
                        .font(.system(size: weight.titleSize,
                                      weight: weight.isBold ? .bold : .semibold))
                        .lineLimit(1)
                    // A run in progress, said with a dot instead of "1 run".
                    if !runsHere.isEmpty {
                        Circle().fill(Color.green).frame(width: 6, height: 6)
                            .help(runsHere.count == 1 ? "1 run em execução"
                                                      : "\(runsHere.count) runs em execução")
                    }
                    if contains > 0 {
                        Text("⊃ \(contains)")
                            .font(ForgeType.micro).foregroundStyle(Color.accentOrange)
                            .help("Contém \(contains) outro(s) projeto(s) registrado(s)")
                    }
                    ForEach(Array(FolderLook.tagColors(for: path).enumerated()), id: \.offset) { _, c in
                        Circle().fill(c).frame(width: 7, height: 7)
                    }
                }
                HStack(spacing: 5) {
                    // "workspace · 33 repos", or just "workspace" when the
                    // registry never measured the repos — `roleLine` is silent
                    // rather than printing a measured-looking zero for the most
                    // repo-dense project registered.
                    Text(digest?.roleLine ?? role.label)
                        .font(ForgeType.micro).foregroundStyle(.secondary)
                    Text(abbreviatedPath).font(ForgeType.micro)
                        .foregroundStyle(.tertiary).lineLimit(1).truncationMode(.head)
                }
            }
            Spacer()
            if loading { ProgressView().controlSize(.small).scaleEffect(0.7) }
            if hovering && !loading {
                Button { Task { await refresh() } } label: {
                    Image(systemName: "arrow.clockwise").forgeIcon(.micro)
                }
                .buttonStyle(.plain).foregroundStyle(.tertiary)
                .help("Atualizar estado")
            }
        }
    }

    /// The icon, which now says what the project is BUILT WITH.
    ///
    /// It used to be `FolderLook.icon(for:)` — the folder's real Finder icon,
    /// which is the right call for a folder that HAS a custom icon. Measured
    /// on the operator's registry: none of the 14 registered projects does, so
    /// `NSWorkspace` returned the same generic blue folder fourteen times and
    /// the largest element on every card carried no information whatsoever.
    ///
    /// DECLARED COST of the swap, since it is a real loss and not a free win:
    /// a folder with a custom Finder icon will no longer show it here. That
    /// path is not preserved because it currently applies to zero projects,
    /// and guarding it would mean shipping a branch that nothing on this
    /// machine can exercise. If the operator ever sets one, restoring it is a
    /// one-line `if` in front of this view — and `FolderLook.icon` is kept for
    /// the worktree rows below, which are still plain folders.
    ///
    /// Finder colour TAGS are untouched and still render as dots beside the
    /// name: those carry real information whenever the operator has set them,
    /// which is exactly what the folder icon did not.
    ///
    /// THE MARK, WHEN THERE IS ONE. The stack is now drawn with the stack's
    /// REAL mark (Simple Icons, vendored — see `BrandMark`), because the SF
    /// Symbols this shipped with were shapes that resemble marks rather than
    /// the marks themselves, and measured on the operator's registry twelve of
    /// fourteen cards landed on just two of those shapes. `brandOrSymbol` keeps
    /// the SF Symbol as the fallback, so a build whose resource bundle did not
    /// ship draws last week's icon and never an empty slot.
    @ViewBuilder private var projectIcon: some View {
        let glyph = stack.map { StackGlyph.of($0, role: role) }
        brandOrSymbol(glyph?.mark, symbol: glyph?.symbol ?? "circle.dashed",
                     size: CGFloat(ForgeIconSize.large.points))
            .forgeIcon(.large)
            .symbolRenderingMode(.hierarchical)
            // Three tones for three kinds of claim, so the glyph's confidence
            // is legible before the tooltip is read: a measured stack is
            // stated plainly, a role fallback is quieter, and the state before
            // detection has finished is quieter still rather than absent.
            .foregroundStyle(glyph == nil ? AnyShapeStyle(.quaternary)
                             : glyph!.isStack ? AnyShapeStyle(Color.accentColor)
                                              : AnyShapeStyle(.tertiary))
            .frame(width: 30, height: 30)
            .help(glyph?.help ?? "detectando stack…")
            .accessibilityLabel(glyph?.help ?? "detectando stack")
    }

    /// A vendored brand mark, or the SF Symbol it falls back to.
    ///
    /// THE FALLBACK IS THE WHOLE REASON THIS IS A FUNCTION rather than two call
    /// sites. `BrandArt.image` returns `nil` when the resource bundle did not
    /// make it into the `.app` — a condition that is invisible in tests, because
    /// `swift run` finds the bundle next to the executable and only the
    /// assembled bundle can be missing it. Degrading to the symbol means that
    /// failure costs the icon that shipped last week; drawing the mark
    /// unconditionally would cost a blank square, which is the exact failure
    /// this line of work exists to remove.
    ///
    /// Template rendering (`BrandArt` sets `isTemplate`, and `.template` here
    /// says so to SwiftUI) is what lets the caller's `.foregroundStyle` tint the
    /// mark — so it follows dark mode and the accent colour exactly as the
    /// symbol did. Nothing else about the mark is altered.
    @ViewBuilder
    private func brandOrSymbol(_ mark: BrandMark?, symbol: String, size: CGFloat) -> some View {
        if let mark, let img = BrandArt.image(mark) {
            Image(nsImage: img)
                .renderingMode(.template)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .frame(width: size, height: size)
        } else {
            Image(systemName: symbol)
        }
    }

    /// What the project IS, what it last delivered, and where its tree stands.
    ///
    /// This replaced four counters — questions, runs, sessions, items — that on
    /// the operator's real machine read "0 · 0 · 0 · 0" for every project on
    /// screen. Correct and useless: the card spent its whole area asserting
    /// absence. The live signal it dropped is not gone, it moved to `signals`
    /// and to the run dot in `header`, where it costs nothing when there is
    /// nothing to say.
    ///
    /// Every absence is a sentence, never a blank line — `DigestText` /
    /// `DigestActivityField` carry their own wording so the card cannot invent
    /// a different one. The only state this view names itself is git-not-yet-
    /// measured, which the digest cannot know about because it is the caller
    /// who decided to defer it.
    @ViewBuilder private var digestLines: some View {
        VStack(alignment: .leading, spacing: 3) {
            if let d = digest {
                Text(d.identity.display)
                    .font(.caption)
                    .foregroundStyle(d.identity.isPresent ? .secondary : .tertiary)
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)

                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Image(systemName: "arrow.turn.down.right").forgeIcon(.micro)
                        .foregroundStyle(.tertiary)
                    switch d.activity {
                    case .entry(let e):
                        Text(e.title).font(.caption2).foregroundStyle(.secondary)
                            .lineLimit(1).truncationMode(.tail)
                        Spacer(minLength: 6)
                        // An inferred date is a weaker claim than one the
                        // ledger stated, and says so instead of passing for it.
                        Text(e.ageInferred ? "~\(e.age)" : e.age)
                            .font(.caption2).monospacedDigit().foregroundStyle(.tertiary)
                            .help(e.ageInferred
                                  ? "Data inferida do arquivo — o fragmento não tem completed_at"
                                  : "Do completed_at do ledger")
                    case .absent(let why):
                        Text(why).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                        Spacer(minLength: 6)
                    }
                }

                gitLine
            } else {
                Text("lendo…").font(.caption2).foregroundStyle(.tertiary)
            }
        }
    }

    /// The git row. Which glyph, which words and which tone are decided by
    /// `GitGlyph.of` in ForgeKit — where `ForgeKitTests` can reach them —
    /// exactly as `projectIcon` defers to `StackGlyph.of`. This view only maps
    /// the tone token to a colour.
    ///
    /// The branch mark appears if and only if `tone` is `.clean` or `.dirty`,
    /// i.e. only when git was measured and found a repository. A card that is
    /// not a repository, and a card whose git has not been measured, therefore
    /// cannot draw a branch — the distinction the three-case `DigestGitField`
    /// exists to protect is carried by the glyph too, not only by the wording.
    /// The default-branch mark rides in the TRAILING column, after a `Spacer`,
    /// rather than as one more `·` segment of `g.text`. Two reasons, both
    /// measured on this card: the row already carries a branch name that can be
    /// 27 characters (`feat/projects-screen-richer`) under `lineLimit(1)`, and
    /// appending there makes the divergence the first thing truncated away; and
    /// the trailing column is the grammar this card already speaks — the
    /// delivery row above puts its age in exactly that position.
    @ViewBuilder private var gitLine: some View {
        let g = GitGlyph.of(gitField, origin: digest?.origin)
        HStack(spacing: 4) {
            // The host mark leads the row, and appears if and only if the
            // remote was MEASURED to be a host a mark exists for. A repository
            // with no remote, an unreadable config, and a host with no vendored
            // mark all draw nothing here and say which one they are in the
            // tooltip — a logo is a claim, and this row has already shipped one
            // false claim about the operator's disk.
            if g.segments.isEmpty {
                if let hm = g.host.mark, let img = BrandArt.image(hm) {
                    Image(nsImage: img)
                        .renderingMode(.template).resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 9, height: 9)
                        .foregroundStyle(.tertiary)
                        .help(g.host.help)
                        .accessibilityLabel(g.host.help)
                }
                if let symbol = g.symbol {
                    brandOrSymbol(g.mark, symbol: symbol, size: CGFloat(ForgeIconSize.micro.points))
                        .forgeIcon(.micro)
                        .symbolRenderingMode(.hierarchical)
                }
                Text(g.text).font(ForgeType.caption).monospaced()
                    .lineLimit(1).truncationMode(.middle)
                    .foregroundStyle(gitStyle(g.tone))
            } else {
                ForEach(g.segments, id: \.kind) { seg in
                    HStack(spacing: 3) {
                        if let symbol = seg.symbol {
                            brandOrSymbol(seg.mark, symbol: symbol, size: CGFloat(ForgeIconSize.micro.points))
                                .forgeIcon(.micro)
                                .symbolRenderingMode(.hierarchical)
                        }
                        Text(seg.text).font(ForgeType.caption).monospaced()
                            .lineLimit(1).truncationMode(.middle)
                    }
                    .foregroundStyle(gitStyle(seg.tone))
                    .help(seg.help)
                    .accessibilityLabel(seg.help)
                    // The branch name is the only segment allowed to give up
                    // room: the others are short and fixed, and squeezing a
                    // repository name or a divergence count is how a row loses
                    // the fact it exists to state.
                    .layoutPriority(seg.kind == .branch ? 0 : 1)
                }
            }
            if let b = g.baseline {
                Spacer(minLength: 6)
                HStack(spacing: 2) {
                    if let symbol = b.symbol {
                        Image(systemName: symbol).forgeIcon(.micro)
                            .symbolRenderingMode(.hierarchical)
                    }
                    Text(b.text).font(ForgeType.micro).monospacedDigit().lineLimit(1)
                }
                .foregroundStyle(gitStyle(b.tone))
                .help(b.help)
                .accessibilityLabel(b.help)
            }
        }
        .help(g.help)
        .accessibilityLabel(g.help)
    }

    /// Tone token → colour. The one place the view is allowed an opinion about
    /// git, and it has no access to the field to second-guess the token with.
    ///
    /// The divergence tones stay inside the ONE-ACCENT rule this app is built on
    /// (`Color.accentOrange`, "everything else stays neutral on purpose"), so
    /// they encode URGENCY, not direction — direction is what the arrow glyph is
    /// for. Being ahead of the default is ordinary work in progress and reads
    /// neutral; being BEHIND it is the actionable one and takes the accent,
    /// because a branch that quietly fell behind is precisely what produced a
    /// worktree 13 commits stale. Diverged takes the accent at full strength.
    private func gitStyle(_ tone: GitTone) -> AnyShapeStyle {
        switch tone {
        case .dirty: return AnyShapeStyle(Color.accentOrange)
        case .clean: return AnyShapeStyle(Color.secondary.opacity(0.7))
        case .absent, .failed: return AnyShapeStyle(.tertiary)
        case .pending: return AnyShapeStyle(.quaternary)
        case .level: return AnyShapeStyle(.tertiary)
        case .ahead: return AnyShapeStyle(Color.secondary.opacity(0.85))
        case .behind: return AnyShapeStyle(Color.accentOrange.opacity(0.85))
        case .diverged: return AnyShapeStyle(Color.accentOrange)
        case .undetermined: return AnyShapeStyle(.tertiary)
        }
    }

    /// Live counts, and ONLY when there are any.
    ///
    /// The zero is the thing being removed here, not the count. A project with
    /// two open questions still shouts; a quiet one draws nothing at all
    /// instead of four greyed zeros. Runs are not in this row — an active run
    /// is the green dot in `header`, which is legible without reading a number.
    @ViewBuilder private var signals: some View {
        if !gatesHere.isEmpty || openItems > 0 || !sessionsHere.isEmpty {
            HStack(spacing: 14) {
                if !gatesHere.isEmpty {
                    Stat(value: gatesHere.count, label: "pergunta", accent: true)
                }
                if !sessionsHere.isEmpty {
                    Stat(value: sessionsHere.count, label: "sessão", accent: false)
                }
                if openItems > 0 {
                    Stat(value: openItems, label: "item", pluralLabel: "itens", accent: false)
                }
            }
        }
    }

    /// Worktrees are where isolated milestones actually run, so they are
    /// navigable: open a session directly in one, or reveal it.
    private var worktreeSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .forgeIcon(.micro)
                    Image(systemName: "arrow.triangle.branch").forgeIcon(.micro)
                    Text(extraCheckouts.count == 1 ? "1 worktree"
                                                   : "\(extraCheckouts.count) worktrees")
                        .font(.caption)
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(.secondary)

            if expanded {
                ForEach(extraCheckouts) { c in
                    HStack(spacing: 7) {
                        Image(nsImage: FolderLook.icon(for: c.path))
                            .resizable().frame(width: 15, height: 15)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(c.name).font(.caption2).lineLimit(1)
                            if let b = c.branch {
                                Text(b).font(ForgeType.micro)
                                    .foregroundStyle(.tertiary).lineLimit(1)
                            }
                        }
                        Spacer()
                        if state.liveRuns.contains(where: { $0.cwd == c.path }) {
                            Circle().fill(Color.green).frame(width: 5, height: 5)
                        }
                        Button {
                            launchTarget = c.path
                            state.addWorkspaceQuietly(c.path)
                            showLauncher = true
                        } label: {
                            Image(systemName: "terminal").forgeIcon(.micro)
                        }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                        .help("Abrir sessão nesta worktree")
                        Button { ForgeCore.reveal(c.path) } label: {
                            Image(systemName: "folder").forgeIcon(.micro)
                        }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                        .help("Ver no Finder")
                    }
                    .padding(.leading, 12)
                }
            }
        }
    }

    private var actions: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) { buttons }
            VStack(alignment: .leading, spacing: 6) { buttons }
        }
    }

    @ViewBuilder private var buttons: some View {
        Button("Abrir sessão") { launchTarget = path; showLauncher = true }
            .controlSize(.small)
        Button("Ver pasta") { ForgeCore.reveal(path) }
            .controlSize(.small)
        IconMenu(help: path) {
            Button("Copiar caminho") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(path, forType: .string)
            }
            Button("Abrir no Finder") { ForgeCore.reveal(path) }
            Divider()
            Button("Remover da lista", role: .destructive) {
                state.removeWorkspace(path)
            }
        }
    }

    private func refresh() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        let p = path
        let r = role
        let repos = state.repoCounts[p]

        // The cheap half of the digest first: file reads only, measured at
        // 0.77 ms/card with `git: .none`. Painted before anything spawns a
        // process, so the card says what the project IS immediately.
        // Stack rides the same cheap pass: measured at 0.27-0.46 ms/card across
        // the operator's real 14 (3.7-6.5 ms for the whole screen), which at its
        // worst is ~6% of ONE git probe, so it needs no staging of its own. It is
        // off the main actor purely because it touches the filesystem.
        let both = await Task.detached(priority: .userInitiated) {
            (ProjectDigest.load(path: p, role: r, repos: repos, git: .none),
             ProjectStack.detect(path: p))
        }.value
        digest = both.0
        stack = both.1

        // git is cheap; forge-status spawns node, so both go off the main actor.
        let trees = await Task.detached(priority: .utility) { Git.checkouts(at: p) }.value
        checkouts = trees

        // Git is ~102 ms per card and the screen reloads every 15 s plus on
        // FSEvents — 20 projects would be ~2 s of blocking git per reload. So
        // it is filled in AFTER the cheap fields are on screen and never on
        // `reloadCheap`'s path. Not cached either: the mtimes that would key a
        // cache (.git/HEAD, .git/index) do not move when an untracked file
        // appears, so a cached "limpo" can be wrong about a dirty tree.
        //
        // Retried once, and only when git failed to answer at all: that state
        // is transient by nature (contention, a lock held for an instant) and
        // leaving it on screen until the next reload would show a card that
        // knows nothing about its own repository for 15 s. A `.absent` or a
        // `.state` is a measurement and is never re-asked.
        for attempt in 0..<2 {
            gitField = await Task.detached(priority: .utility) {
                ProjectDigest.loadGit(path: p, probe: .system)
            }.value
            guard gitField?.isUnavailable == true, attempt == 0 else { break }
            try? await Task.sleep(nanoseconds: 700_000_000)
        }

        guard hasGsd else { return }
        status = await Task.detached(priority: .utility) {
            ForgeCore.runJSON(ProjectStatus.self, "forge-status.js", ["--json", "--cwd", p])
        }.value
        let items = await Task.detached(priority: .utility) {
            ForgeCore.runJSON([Item].self, "forge-items.js", ["--list", "--json", "--cwd", p])
        }.value
        openItems = ItemBoard.openCount(items ?? [])
    }
}

struct Stat: View {
    let value: Int
    let label: String
    /// Explicit plural label for cases where mechanical "+s" pluralization
    /// would be wrong (e.g. pt-BR "item" -> "itens", not "items").
    var pluralLabel: String?
    let accent: Bool

    init(value: Int, label: String, pluralLabel: String? = nil, accent: Bool) {
        self.value = value
        self.label = label
        self.pluralLabel = pluralLabel
        self.accent = accent
    }

    var body: some View {
        HStack(spacing: 4) {
            Text("\(value)")
                .font(.title3).monospacedDigit()
                .foregroundStyle(accent ? Color.accentOrange : .primary)
            Text(value == 1 ? label : (pluralLabel ?? label + "s"))
                .font(.caption2).foregroundStyle(.secondary)
        }
        .opacity(value == 0 ? 0.45 : 1)
    }
}
