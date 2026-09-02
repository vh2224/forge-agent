// ItemsView — the backlog board, in the app.
//
// Same rule as everywhere else in Forge.app: the store never reimplements
// status semantics. Every read and every mutation shells out to
// scripts/forge-items.js; Swift only labels (ItemStatus.label) and groups
// (ItemBoard.columns) what the engine already decided (ROADMAP Note 5).

import SwiftUI
import ForgeKit

// MARK: - Store

@MainActor
final class ItemsStore: ObservableObject {
    @Published private(set) var items: [Item] = []
    @Published private(set) var loading = false
    @Published var error: String?

    /// Guards against out-of-order loads (R1 of the S05 dialectic review):
    /// each call to `forge-items.js` shells out and has no ordering
    /// guarantee, so a slow load for a project the user has since switched
    /// away from must not be allowed to overwrite a later, faster one.
    private var generation = LoadGeneration()

    /// Which project each item came from, keyed by item id.
    ///
    /// The board can now show every project at once, and an item only carries
    /// its own id — not where it lives. Every mutation shells out with a
    /// `--cwd`, so without this map a status change on the all-projects board
    /// would be written to whichever project happened to be selected.
    @Published private(set) var projectOf: [String: String] = [:]

    /// Missing `.gsd/items/` is not an error — the engine already returns an
    /// empty array for a project that has never created an item, so the
    /// board shows an empty state rather than a failure banner.
    func load(project: String) { load(projects: [project]) }

    /// Loads one project or all of them. One shell-out per project, sequential:
    /// `forge-items.js` is fast per call and the count here is the number of
    /// workspaces the operator registered, not an unbounded fan-out.
    func load(projects: [String]) {
        let targets = projects.filter { !$0.isEmpty }
        guard !targets.isEmpty else {
            _ = generation.start()
            items = []; projectOf = [:]; loading = false
            return
        }
        loading = true
        error = nil
        let gen = generation.start()
        Task.detached(priority: .utility) {
            var all: [Item] = []
            var owner: [String: String] = [:]
            for p in targets {
                let list = ForgeCore.runJSON([Item].self, "forge-items.js",
                                              ["--list", "--json", "--cwd", p]) ?? []
                for it in list { owner[it.id] = p }
                all.append(contentsOf: list)
            }
            await MainActor.run {
                guard self.generation.isCurrent(gen) else { return }
                self.items = all
                self.projectOf = owner
                self.loading = false
            }
        }
    }

    /// `origin: human` because this item was typed by a person in the UI —
    /// `auto` origin (with its provenance requirements) is for items the
    /// engine itself creates, and the engine is who validates that split.
    func create(title: String, body: String, project: String) async -> Bool {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, !project.isEmpty else { return false }

        var payload: [String: String] = ["title": t, "origin": "human"]
        let b = body.trimmingCharacters(in: .whitespacesAndNewlines)
        if !b.isEmpty { payload["body"] = b }

        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return false }

        return await Task.detached(priority: .utility) { [weak self] () -> Bool in
            let r = ForgeCore.runWithInput("forge-items.js", ["--add", "--cwd", project],
                                           input: json)
            await MainActor.run {
                if !r.ok { self?.error = r.stderr.isEmpty ? "falha ao criar item" : r.stderr }
            }
            return r.ok
        }.value.also { ok in
            if ok { self.load(project: project) }
        }
    }

    /// `status` is a closed set the engine owns (`inbox → triaged → doing →
    /// done|dropped`); a rejection here is the engine's validation speaking,
    /// so it is surfaced verbatim rather than re-derived in Swift.
    func setStatus(_ id: String, to status: ItemStatus, project: String) {
        Task.detached(priority: .utility) { [weak self] in
            let r = ForgeCore.run("forge-items.js",
                                  ["--set-status", id, status.rawValue, "--cwd", project])
            await MainActor.run {
                if !r.ok { self?.error = r.stderr.isEmpty ? "falha ao mudar status" : r.stderr }
            }
            if r.ok {
                await MainActor.run { self?.load(project: project) }
            }
        }
    }
}

/// Swift has no built-in "do something with a value and return it" combinator
/// for a plain (non-Optional) type; this keeps `create(...)` a single
/// expression instead of a mutable local.
private extension Bool {
    func also(_ body: (Bool) -> Void) -> Bool { body(self); return self }
}

// MARK: - View

struct ItemsView: View {
    @ObservedObject var state: AppState
    @StateObject private var store = ItemsStore()
    @State private var project: String = ""
    @State private var adding = false
    /// The item whose detail sheet is open. `Item` is already `Identifiable`,
    /// so `.sheet(item:)` handles presentation and dismissal from this one
    /// value — no parallel `isPresented` flag to keep in sync.
    @State private var detail: Item?

    /// The label filter query (S05/T02). The rule itself lives in
    /// `ItemLabelFilter` (S05/T01) — this view only holds the text the
    /// operator typed.
    /// Free text — title, id or label, substring.
    @State private var searchQuery: String = ""
    /// One exact label, or empty for "any". Separate from `searchQuery` on
    /// purpose: they answer different questions and compose (AND). Folding them
    /// into one box is what made `ui` match `ui-bug` a real risk — the exact
    /// rule criterion #5 pins against `jq` only survives if something still
    /// applies it exactly.
    @State private var labelFilter: String = ""

    /// Transient confirmation for actions that leave no trace on the board.
    /// Copying an id changes nothing on screen; starting a session opens a tab
    /// in a different section. Without a receipt the operator cannot tell
    /// success from a misclick, and re-clicking "Começar" opens a second tab.
    @State private var toast: ItemToast?
    @State private var toastDismiss: Task<Void, Never>?

    /// The single list every part of the board reads from (D-S05-2, LOCKED):
    /// both `ItemBoard.columns` and `ItemBoard.unknown` derive from this, not
    /// from `store.items` directly. Filtering after the split would let the
    /// "Desconhecido" column disagree with the CLI count — the exact
    /// divergence criterion #5 forbids.
    /// `ItemSearch`, not `ItemLabelFilter`: the field searches title, id and
    /// labels. The exact label rule still exists and is still proved against
    /// `jq` by the shared fixture — it just is not what a search box should do
    /// when most boards carry no labels at all.
    private var visibleItems: [Item] {
        ItemSearch.apply(ItemLabelFilter.apply(store.items, query: labelFilter), query: searchQuery)
    }

    var body: some View {
        Group {
            if state.workspaces.isEmpty {
                noWorkspaces
            } else {
                board
            }
        }
        .navigationTitle("Tarefas")
        .onAppear {
            project = state.preselection.workspace ?? ""
            reload()
        }
        // Header order is fixed by the operator: SEARCH → PROJECT → NEW.
        //
        // That order is why `.searchable` is gone. The native modifier renders
        // its field at the trailing edge of the toolbar, always AFTER the other
        // items, so with it the row read project → new → search. Declaring all
        // three as explicit `ToolbarItem`s is the only way to control the
        // sequence — the cost, stated: no ⌘F and no native `.searchSuggestions`.
        // The field itself still uses a platform style (`.roundedBorder`), not
        // a box drawn by hand.
        //
        // Reading order matches the question: WHAT am I looking for, WHERE, and
        // only then the one control that CHANGES something.
        .navigationSubtitle("\(visibleItems.count) cards")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                // SwiftUI's macOS `TextField` has no built-in leading icon —
                // `.searchable` is the only native path to one, and that is the
                // modifier we traded away to fix the header order. So the glyph
                // is ours, and so is its inset: the OS container hugs whatever
                // it wraps, leaving the magnifier flush against the edge.
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .forgeIcon(.small)
                        .foregroundStyle(.secondary)
                    TextField("buscar por título ou id", text: $searchQuery)
                        .textFieldStyle(.plain)
                    if searchQuery.isEmpty {
                        // Reserve the clear button's slot so the text does not
                        // shift the instant the first character lands.
                        Image(systemName: "xmark.circle.fill").forgeIcon(.small).foregroundStyle(.clear)
                    } else {
                        Button { searchQuery = "" } label: {
                            Image(systemName: "xmark.circle.fill").forgeIcon(.small).foregroundStyle(.tertiary)
                        }
                        .buttonStyle(.borderless)
                        .help("limpar busca")
                    }
                }
                .padding(.horizontal, 6)
                .toolbarField(width: 230)
            }
            ToolbarItem(placement: .primaryAction) {
                // Its own control, not a suggestion inside the search box: the
                // label filter is EXACT (criterion #5's parity against `jq`),
                // and the search box is substring. One box doing both would
                // have to pick one semantics and quietly break the other.
                Menu {
                    Button("Todos os labels") { labelFilter = "" }
                    Divider()
                    ForEach(ItemLabelFilter.availableLabels(store.items), id: \.self) { label in
                        Button {
                            labelFilter = label
                        } label: {
                            Label(label, systemImage: labelFilter == label ? "checkmark" : "tag")
                        }
                    }
                } label: {
                    Label(labelFilter.isEmpty ? "labels" : labelFilter, systemImage: "tag")
                }
                .fixedSize()
                .disabled(ItemLabelFilter.availableLabels(store.items).isEmpty)
                .help(ItemLabelFilter.availableLabels(store.items).isEmpty
                      ? "Nenhum label nos itens deste board"
                      : "Filtrar por um label exato")
            }
            ToolbarItem(placement: .primaryAction) {
                ProjectPicker(workspaces: state.workspaces, selection: $project)
                    .onChange(of: project) { _ in reload() }
            }
            ToolbarItem(placement: .primaryAction) {
                Button { adding = true } label: {
                    Label("Nova tarefa", systemImage: "plus")
                }
                // Prominent: it is the only control in this row that CREATES
                // something. Rendered like the others it was a grey glyph
                // indistinguishable from the filters beside it.
                .buttonStyle(.borderedProminent)
                // Creating needs a concrete destination: on the all-projects
                // board there is no answer to "in which project", and guessing
                // one is exactly the silent fallback S04 removed.
                .disabled(project.isEmpty)
                .help(project.isEmpty ? "Escolha um projeto para criar uma tarefa" : "Nova tarefa")
            }
        }
        .sheet(isPresented: $adding) {
            NewItemSheet(store: store, project: project, isPresented: $adding)
        }
        .sheet(item: $detail) { item in
            ItemDetailSheet(item: item, detail: $detail,
                             onStart: { startWork(item) },
                             onMove: { store.setStatus(item.id, to: $0, project: project) })
        }
    }

    private func reload() {
        store.load(projects: project.isEmpty ? state.workspaces : [project])
    }

    /// The badge a card shows for its project — `nil` while a single project is
    /// selected, because then every card would repeat the same word.
    private func projectBadge(for item: Item) -> String? {
        guard project.isEmpty, let p = store.projectOf[item.id] else { return nil }
        return ProjectOrganiser.name(p)
    }

    /// Where an item lives. On the all-projects board the selected `project` is
    /// empty, so every write has to ask the map instead of assuming.
    private func projectFor(_ item: Item) -> String {
        store.projectOf[item.id] ?? project
    }

    // MARK: Empty (no project)

    /// S04 made `AppState.preselection` the single owner of "which project" —
    /// a second, silent fallback here (e.g. `workspaces.first`) would just
    /// reintroduce the ambiguity that removal fixed. Nothing chosen means
    /// nothing shown, with an explanation instead of a guess.
    private var noWorkspaces: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Nenhum projeto registrado", systemImage: "tray.full")
                .font(.callout)
            Text("Adicione um projeto na seção Projetos para ver o board de tarefas.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(16).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }

    // MARK: Board

    private var board: some View {
        // The filter used to sit here in a full-width band of its own, which
        // cost ~44pt of vertical space on every screen and pushed the columns
        // down for a control the operator touches occasionally. It lives in the
        // toolbar now, beside the project picker — same row, same reading order:
        // WHICH project, WHICH labels, HOW MANY cards.
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 12) {
                ForEach(ItemBoard.columns(visibleItems)) { column in
                    columnView(column)
                }
                let unknown = ItemBoard.unknown(visibleItems)
                if !unknown.isEmpty {
                    unknownColumn(unknown)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
        // Without this the board hugs its content and the parent centres it
        // vertically — the columns float in the middle of the window instead of
        // starting under the toolbar. `noProjectSelected` right above declares
        // its own `.center` alignment for the same reason; the board simply
        // never declared the opposite.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .overlay(alignment: .bottom) {
            if let toast {
                Label(toast.text, systemImage: toast.symbol)
                    .font(.callout)
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .forgeSurface(.panel, in: Capsule())
                    .overlay(Capsule().strokeBorder(.quaternary, lineWidth: 1))
                    .shadow(radius: 8, y: 2)
                    .padding(.bottom, 18)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: toast)
        .onChange(of: toast) { t in
            toastDismiss?.cancel()
            guard t != nil else { return }
            toastDismiss = Task { @MainActor in
                try? await Task.sleep(nanoseconds: 1_800_000_000)
                guard !Task.isCancelled else { return }
                toast = nil
            }
        }
        .overlay(alignment: .top) {
            if let e = store.error {
                Label(e, systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.orange)
                    .padding(10).forgeSurface(.panel)
                    .padding(.top, 8)
            }
        }
    }

    private func columnView(_ column: ItemBoard.Column) -> some View {
        BoardColumnView(title: column.status.label,
                        symbol: column.status.symbolName,
                        tint: column.status.tint,
                        dropTarget: column.status,
                        items: column.items,
                        otherStatuses: ItemStatus.allCases.filter { $0 != column.status },
                        onMove: { store.setStatus($0.id, to: $1, project: projectFor($0)) },
                        onOpenDetail: { detail = $0 },
                        onStart: { startWork($0) },
                        notify: { toast = ItemToast(text: $0, symbol: $1) },
                        projectLabel: { projectBadge(for: $0) })
    }

    private func unknownColumn(_ items: [Item]) -> some View {
        // No `dropTarget`: "Desconhecido" is where items with a status the
        // engine does not recognise land. There is nothing to move an item
        // *into* here, so the column shows cards but refuses drops instead of
        // pretending to accept one and silently doing nothing.
        BoardColumnView(title: "Desconhecido",
                        symbol: "questionmark.circle",
                        tint: .red,
                        dropTarget: nil,
                        items: items,
                        otherStatuses: ItemStatus.allCases,
                        onMove: { store.setStatus($0.id, to: $1, project: projectFor($0)) },
                        onOpenDetail: { detail = $0 },
                        onStart: { startWork($0) },
                        notify: { toast = ItemToast(text: $0, symbol: $1) },
                        projectLabel: { projectBadge(for: $0) })
    }

    /// The ONE place on the board that opens a tab (D9/F7, LOCKED). Moving a
    /// card never reaches here — `onMove:` goes straight to `store.setStatus`.
    /// The decision of WHETHER to launch is entirely `ItemLaunch`'s (D-S06-1):
    /// this function only executes a non-nil result, never inspects `item`
    /// itself.
    private func startWork(_ item: Item) {
        guard let req = ItemLaunch.decide(.start(item)) else { return }
        let cwd = projectFor(item)
        guard !cwd.isEmpty else { return }
        state.newSession(cwd: cwd, mode: .task, text: req.taskArgument, account: "")
        state.rememberWorkspace(cwd)
    }
}

/// One kanban column, drawn as a panel rather than a bare stack.
///
/// A `View` and not a `func` because the column owns state a function cannot
/// hold: `dropTargeted`, the highlight that tells the operator *this* column
/// will receive the card they are dragging.
///
/// Three things this shape fixes, all absent before:
/// - **The division is visible.** Columns were `VStack`s with nothing
///   delimiting them, so the board read as loose piles rather than a kanban.
/// - **Each column scrolls on its own.** One outer scroll meant a long column
///   dragged every other column's height with it.
/// - **Empty columns still read as columns**, because the panel stretches to
///   full height instead of collapsing to its (zero) content.
struct BoardColumnView: View {
    let title: String
    let symbol: String
    let tint: ItemTint
    /// `nil` for the "Desconhecido" column — see `unknownColumn`.
    let dropTarget: ItemStatus?
    let items: [Item]
    let otherStatuses: [ItemStatus]
    let onMove: (Item, ItemStatus) -> Void
    let onOpenDetail: (Item) -> Void
    let onStart: (Item) -> Void
    let notify: (String, String) -> Void
    /// `nil` when a single project is selected — see `ItemCard.projectLabel`.
    let projectLabel: (Item) -> String?

    @State private var dropTargeted = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                // Symbol first, and every status gets a distinct one (asserted
                // in ForgeKitTests): the shape alone has to separate the columns
                // for anyone who cannot rely on the tone.
                Image(systemName: symbol)
                    .forgeIcon(.micro)
                    .foregroundStyle(tint.color)
                Text(title)
                    .font(.subheadline).bold()
                    .foregroundStyle(tint == .neutral ? AnyShapeStyle(.primary) : AnyShapeStyle(tint.color))
                Text("\(items.count)")
                    .font(.caption2).monospacedDigit().foregroundStyle(.secondary)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(.quaternary, in: Capsule())
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.top, 10)

            ScrollView(.vertical, showsIndicators: false) {
                LazyVStack(spacing: 8) {
                    ForEach(items) { item in
                        ItemCard(item: item,
                                 otherStatuses: otherStatuses,
                                 onMove: { onMove(item, $0) },
                                 onOpenDetail: { onOpenDetail(item) },
                                 onStart: { onStart(item) },
                                 notify: notify,
                                 projectLabel: projectLabel(item))
                    }
                }
                .padding(.horizontal, 10)
                .padding(.bottom, 10)
            }
        }
        // 220 was the width that forced S04-c to cap label chips at three. The
        // cap stays (a tested rule in ForgeKit, not a layout accident), but the
        // column no longer squeezes the card into it.
        .frame(width: 268)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(dropTargeted ? AnyShapeStyle(Color.accentColor.opacity(0.12))
                                 : AnyShapeStyle(.quaternary.opacity(0.18)),
                    in: RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(Color.accentColor, lineWidth: dropTargeted ? 2 : 0)
        )
        .animation(.easeInOut(duration: 0.12), value: dropTargeted)
        .dropDestination(for: String.self) { ids, _ in
            guard let to = dropTarget else { return false }
            var moved = false
            for id in ids {
                guard let item = items.first(where: { $0.id == id }) ?? droppedItem(id) else { continue }
                // Same call the menu makes. The drag path reaches `onMove` and
                // nothing else — `ItemLaunch.decide(.drag(...))` returns nil, so
                // the contra-criterion D9/F7 holds for this gesture too.
                onMove(item, to)
                moved = true
            }
            return moved
        } isTargeted: { hovering in
            // Only light up when this column can actually receive the card.
            dropTargeted = hovering && dropTarget != nil
        }
    }

    /// A card dragged **from another column** is not in this column's `items`,
    /// so the id has to be resolved against the whole board. `onMove` only needs
    /// the id, so a stub carrying it is enough — and keeps the engine as the one
    /// place that knows the rest of the record.
    private func droppedItem(_ id: String) -> Item? {
        id.isEmpty ? nil : Item(id: id, title: nil, status: nil)
    }
}

/// The one place a ForgeKit visual token becomes a SwiftUI colour.
///
/// ForgeKit decides *which* tone each status, priority and label gets (and
/// `ForgeKitTests` asserts it); this extension only says what the tone looks
/// like. Keeping the mapping here is what lets the rule stay testable on a
/// machine with no screen.
extension ItemTint {
    var color: Color {
        switch self {
        case .neutral: return .secondary
        case .blue: return .blue
        case .purple: return .purple
        case .orange: return .orange
        case .green: return .green
        case .red: return .red
        case .teal: return .teal
        case .pink: return .pink
        case .indigo: return .indigo
        case .yellow: return .yellow
        }
    }
}

/// A card that reads like an issue, at rest showing only what a glance needs.
///
/// Not one of the elements is decided here — including the title. What counts
/// as "no title" (missing, or whitespace-only) is decided once by
/// `ItemCardPresentation.displayTitle` in ForgeKit; how many chips are drawn,
/// which tone the age takes and whether a closing date exists at all are
/// answered the same way. That split is not stylistic: `Forge` is not
/// importable from a test target on this machine, so a rule written here would
/// be verifiable only by looking at a screen, and "show the date when it is
/// done" written here would also mean a raw status literal in this file, which
/// `scripts/forge-app-items.test.js` forbids outright.
struct ItemCard: View {
    let item: Item
    let otherStatuses: [ItemStatus]
    let onMove: (ItemStatus) -> Void
    let onOpenDetail: () -> Void
    /// Executes what `ItemLaunch.decide(.start(item))` already decided
    /// (D-S06-1) — this view draws the affordance and forwards the tap, it
    /// never asks "should this item start?" itself.
    let onStart: () -> Void
    /// Confirms an action that leaves no visible trace on the board. Copying an
    /// id changes nothing on screen, so without this the operator cannot tell a
    /// successful copy from a misclick.
    let notify: (String, String) -> Void
    /// Project name, and ONLY when the board is showing more than one. With a
    /// project selected every card would carry the same badge, which is noise;
    /// on the all-projects board its absence is what would be ambiguous.
    let projectLabel: String?

    /// `expanded` is NOT `hovering`. The summary opens only after the pointer
    /// has rested for `ItemCardPresentation.hoverExpandDelaySeconds`; without
    /// the dwell, sweeping the pointer down a column reflows every card it
    /// crosses and the whole board ripples while the operator is merely
    /// travelling.
    @State private var expanded = false
    /// The pending dwell. Cancelled the moment the pointer leaves, so a card
    /// the operator passed over never expands a second later behind their back.
    @State private var dwell: Task<Void, Never>?
    /// Hover per control, so each icon's colour — and the `.tint` of the
    /// `Button`/`Menu` wrapping it — follow the pointer independently.
    @State private var copyHover = false
    @State private var moveHover = false

    /// Accent tone: priority when the item has one, otherwise its status. The
    /// bar is the card's only always-visible colour, so it carries whichever
    /// signal is more actionable — "how urgent" beats "which column", and the
    /// column already says the second one.
    private var accent: ItemTint {
        ItemPriority.parse(item.priority)?.tint ?? item.parsedStatus?.tint ?? .neutral
    }

    var body: some View {
        HStack(spacing: 0) {
            Rectangle()
                .fill(accent.color)
                .frame(width: 3)

            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    // The card says which column it belongs to on its own. That
                    // matters once cards can be dragged: mid-drag the card is
                    // detached from every column, and after a drop the operator
                    // needs to confirm where it landed without hunting for the
                    // header. Symbol comes from `ItemStatus` in ForgeKit — a
                    // status literal written here would break the S04 guard.
                    if let st = item.parsedStatus {
                        Image(systemName: st.symbolName)
                            .forgeIcon(.micro)
                            .foregroundStyle(st.tint.color)
                            .help("Coluna: \(st.label)")
                    }
                    Text(ItemCardPresentation.displayTitle(item))
                        .font(ForgeType.body)
                        .lineLimit(2)
                    Spacer(minLength: 4)
                    // Start lives UP HERE, apart from copy and move.
                    //
                    // It is the expensive control on the card: it spawns a
                    // terminal session in another section of the app, and the
                    // cost of hitting it by accident is not symmetric with the
                    // cost of hitting "copy id" by accident. Three icons packed
                    // shoulder to shoulder in a 268pt row made the whole cluster
                    // one mis-click surface; distance is the cheapest fix.
                    //
                    // `.buttonStyle(.borderless)` is NOT cosmetic (D-S06-5): the
                    // card's whole surface carries `.onTapGesture(perform: onOpenDetail)`
                    // below, and a plain `Button` inside a container with its own
                    // tap gesture fires BOTH handlers — starting would also pop
                    // the sheet. `.disabled`/`.help` come straight from the pure
                    // layer (`ItemLaunch`), never from a status check written here.
                    Button {
                        onStart()
                        notify("Sessão aberta · veja a seção Terminal", "terminal")
                    } label: {
                        IconAction(tint: .green,
                                   help: ItemLaunch.refusal(for: item)
                                         ?? "Começar — abre uma aba de terminal com /forge-task",
                                   enabled: ItemLaunch.canStart(item)) {
                            Image(systemName: "terminal").forgeIcon(.micro)
                        }
                    }
                    .buttonStyle(.borderless)
                    .tint(ItemTint.green.color)
                    .disabled(!ItemLaunch.canStart(item))
                }

                let chips = ItemCardPresentation.labelChips(item.labels)
                let priority = ItemPriority.parse(item.priority)
                HStack(spacing: 4) {
                    if let projectLabel {
                        // `folder` is the same glyph the sidebar uses for the
                        // Projects section — a card on the all-projects board
                        // should point at a place the operator already knows.
                        Label(projectLabel, systemImage: "folder")
                            .metaBadge()
                            .help("Projeto: \(projectLabel)")
                    }
                    if let chips {
                        ForEach(chips.shown, id: \.self) { chip in
                            // Colour is derived from the text itself, so `ui` is
                            // the same tone on every card and every launch —
                            // that is what lets the operator scan the board by
                            // colour instead of reading each chip.
                            LabelChip(text: chip, tint: ItemCardPresentation.labelTint(chip))
                        }
                        if chips.overflow > 0 {
                            LabelChip(text: "+\(chips.overflow)")
                        }
                    }
                    Spacer(minLength: 0)
                    // Blocked badge: the loudest thing a backlog card can say,
                    // because it means "no amount of effort here moves this".
                    // Red on purpose, and only ever on an open item — see
                    // `ItemCardPresentation.blockedCount`.
                    if let blocked = ItemCardPresentation.blockedCount(item) {
                        Label("\(blocked)", systemImage: "lock")
                            .metaBadge(.red)
                            .help(blocked == 1 ? "bloqueada por 1 tarefa" : "bloqueada por \(blocked) tarefas")
                    }
                    if let list = MarkdownDoc.checklist(item.body) {
                        Label("\(list.done)/\(list.total)", systemImage: "checklist")
                            .metaBadge(list.done == list.total ? .green : .neutral)
                            .help("\(list.done) de \(list.total) itens marcados no corpo")
                    }
                    if let age = ItemCardPresentation.age(for: item) {
                        // Pill, not tinted text: thin coloured type is hard to
                        // read at caption2, and the label chips beside it are
                        // already pills — matching them keeps the row one
                        // vocabulary instead of two.
                        let ageTone = ItemCardPresentation.ageTint(for: item)
                        Label(age, systemImage: "clock")
                            .monospacedDigit()
                            .metaBadge(ageTone)
                            .help("criado há \(age)")
                    }
                    // Copy sits with the date because both are provenance
                    // utilities, not actions on the work itself. It is also the
                    // only place the id is still reachable from the card now
                    // that hover expands the summary instead of showing data.
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(item.id, forType: .string)
                        notify("Id copiado · \(ItemCardPresentation.shortID(item.id))", "doc.on.doc")
                    } label: {
                        IconAction(tint: .orange, help: "Copiar id — \(item.id)",
                                   tintOnHover: true, hovering: copyHover) {
                            Image(systemName: "doc.on.doc").forgeIcon(.micro)
                        }
                    }
                    // `.borderless` is the VERIFIED mitigation for D-S06-5 — a
                    // plain Button inside a container with its own tap gesture
                    // fires both handlers. `.tint` carries the colour so the
                    // style never has to be traded away for it.
                    .buttonStyle(.borderless)
                    .tint(copyHover ? ItemTint.orange.color : ItemTint.neutral.color)
                    .onHover { copyHover = $0 }

                    if let priority {
                        // Symbol + mark: the chevron family reads as a scale for
                        // whoever cannot rely on the tone, and `P0..P3` stays for
                        // whoever already knows the vocabulary.
                        Label(priority.mark, systemImage: priority.symbolName)
                            .monospacedDigit()
                            .metaBadge(priority.tint)
                            .help("urgência: \(priority.label)")
                    }

                    // Low-stakes utilities only: copy and move. "Começar" lives
                    // in the title row instead — see the comment there. Icon-only,
                    // with the word in the tooltip; LAST in the row, and the hover
                    // expansion opens BELOW them so revealing the summary never
                    // shifts a control out from under the pointer.
                    Menu {
                        ForEach(otherStatuses, id: \.self) { st in
                            Button {
                                onMove(st)
                                notify("«\(ItemCardPresentation.shortTitle(item))» → \(st.label)", st.symbolName)
                            } label: {
                                Label(st.label, systemImage: st.symbolName)
                            }
                        }
                    } label: {
                        IconAction(tint: .teal, help: "Mover para outra coluna",
                                   tintOnHover: true, hovering: moveHover) {
                            // `.imageScale(.small)` HERE and not in `IconAction`:
                            // the Menu renders its label with metrics of its own,
                            // so this glyph came out larger than the two plain
                            // Buttons beside it even sharing font and frame.
                            // Putting the lever in `IconAction` shrank all three
                            // — it fixed the odd one out by making everything
                            // odd. Scoped to the control that actually deviates.
                            Image(systemName: "arrow.left.arrow.right")
                                .forgeIcon(.micro)
                                .imageScale(.small)
                        }
                    }
                    // `.menuStyle(.borderlessButton)` renders the label with the
                    // MENU's own metrics and tint, so neither the fixed box nor
                    // the colour reached it. `.button` routes the label through
                    // the same button styling the other two already use.
                    .menuStyle(.button)
                    .buttonStyle(.borderless)
                    .tint(moveHover ? ItemTint.teal.color : ItemTint.neutral.color)
                    .onHover { moveHover = $0 }
                    .fixedSize()
                    .menuIndicator(.hidden)
                }

                // Hover expands the summary instead of firing a data tooltip.
                // The dense card stays dense at rest; putting the pointer on it
                // is the cheapest possible "tell me more", and it costs no
                // permanent height. Rendered BELOW the action row on purpose —
                // growing above it would move the buttons out from under the
                // cursor that is hovering them.
                if expanded, let preview = ItemCardPresentation.bodyPreview(item.body) {
                    Text(preview.truncated ? preview.text + "…" : preview.text)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(ItemCardPresentation.bodyLineLimit)
                        .fixedSize(horizontal: false, vertical: true)
                        .transition(.opacity)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .forgeSurface(.raised)
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.quaternary, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .contentShape(Rectangle())
        .onHover { inside in
            dwell?.cancel()
            guard inside else { expanded = false; return }
            dwell = Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(ItemCardPresentation.hoverExpandDelaySeconds * 1_000_000_000))
                guard !Task.isCancelled else { return }
                expanded = true
            }
        }
        .onDisappear { dwell?.cancel() }
        // Arrastar é organizar, exatamente como o menu "Mover para": o payload é
        // só o id, e quem decide o que fazer com ele é o `dropDestination` da
        // coluna. `ItemLaunch.decide(.drag(...))` devolve nil sem olhar o item,
        // então o contra-critério D9/F7 vale para este gesto — provado no
        // fixture de gestos, não presumido por herança do `.move`.
        .draggable(item.id)
        .animation(.easeInOut(duration: 0.12), value: expanded)
        // Keyboard: Tab/arrows reach the card, Enter opens it, ⌘Enter starts it.
        // `.focusable` also gives the focus ring, which is what tells the
        // operator where the keyboard is — without it the shortcuts below would
        // fire on an invisible selection.
        .focusable()
        .onKeyPress(.return) { onOpenDetail(); return .handled }
        .onKeyPress(keys: [.return], phases: .down) { press in
            guard press.modifiers.contains(.command) else { return .ignored }
            guard ItemLaunch.canStart(item) else { return .handled }
            onStart()
            return .handled
        }
        .onTapGesture(perform: onOpenDetail)
        .contextMenu {
            Button("Começar") { onStart() }
                .disabled(!ItemLaunch.canStart(item))
            Button("Ver detalhe") { onOpenDetail() }
            Menu("Mover para") {
                ForEach(otherStatuses, id: \.self) { s in
                    Button(s.label) { onMove(s) }
                }
            }
        }
    }
}

/// Width only — the shape belongs to the OS.
///
/// This used to paint a background and a 6pt stroke on each field. On macOS 26
/// the system already wraps every `ToolbarItem` in its own rounded container,
/// so those were a second box drawn inside the first: the search read as a
/// pill, the label menu as a circle, the project picker as a rounded rect, and
/// the `+` as a blue circle — four shapes in one row, none of them agreeing.
///
/// Same lesson as replacing the hand-rolled search box: when the platform
/// supplies the affordance, painting another one on top is what makes a control
/// look bolted on. All that is left here is the sizing the OS cannot guess.
private extension View {
    func toolbarField(width: CGFloat) -> some View {
        frame(width: width, alignment: .leading)
    }
}

/// The project filter: a button that opens a searchable list.
///
/// A plain `Picker` stops working the moment the operator registers more than a
/// handful of projects — it becomes a long scroll with no way in. Typing is the
/// way in, and the matching rule lives in `ProjectFilter` (ForgeKit) so it is
/// testable without a screen.
struct ProjectPicker: View {
    let workspaces: [String]
    @Binding var selection: String

    @State private var open = false
    @State private var query = ""

    private var matches: [String] { ProjectFilter.matches(workspaces, query: query) }

    var body: some View {
        Button { open = true } label: {
            HStack(spacing: 7) {
                Image(systemName: selection.isEmpty ? "square.stack.3d.up" : "folder")
                    .forgeIcon(.small)
                    .foregroundStyle(.secondary)
                Text(selection.isEmpty ? "Todos os projetos" : ProjectOrganiser.name(selection))
                    .lineLimit(1)
                Spacer(minLength: 2)
                Image(systemName: "chevron.up.chevron.down")
                    .forgeIcon(.micro).foregroundStyle(.tertiary)
            }
            // Same reason as the search field: the folder glyph would sit flush
            // against the system container without an inset of its own.
            .padding(.horizontal, 6)
            .toolbarField(width: 190)
            .contentShape(Rectangle())
        }
        // No hand-drawn background: in a toolbar the OS supplies the affordance,
        // and a custom one next to native controls is what made this look bolted
        // on rather than built in. Padding is ours to give, though.
        .buttonStyle(.borderless)
        .help(selection.isEmpty ? "Mostrando todos os projetos" : ProjectOrganiser.name(selection))
        .popover(isPresented: $open, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass").forgeIcon(.small).foregroundStyle(.secondary)
                    TextField("buscar projeto", text: $query)
                        .textFieldStyle(.plain)
                    if !query.isEmpty {
                        Button { query = "" } label: {
                            Image(systemName: "xmark.circle.fill").forgeIcon(.small).foregroundStyle(.tertiary)
                        }
                        .buttonStyle(.borderless)
                    }
                }
                .padding(.horizontal, 10).padding(.vertical, 8)
                Divider()

                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        // "Todos" only when it is not being searched away: it is
                        // an option like any other, and leaving it pinned while
                        // the query excludes everything else would be a lie
                        // about what the list is showing.
                        if query.trimmingCharacters(in: .whitespaces).isEmpty {
                            row(path: "", name: "Todos os projetos", symbol: "square.stack.3d.up")
                            Divider().padding(.vertical, 2)
                        }
                        ForEach(matches, id: \.self) { ws in
                            row(path: ws, name: ProjectOrganiser.name(ws), symbol: "folder")
                        }
                        if matches.isEmpty {
                            Text("nenhum projeto casa com \"\(query)\"")
                                .font(.caption).foregroundStyle(.secondary)
                                .padding(.horizontal, 10).padding(.vertical, 8)
                        }
                    }
                    .padding(.vertical, 4)
                }
                .frame(maxHeight: 260)
            }
            .frame(width: 280)
        }
    }

    private func row(path: String, name: String, symbol: String) -> some View {
        Button {
            selection = path
            query = ""
            open = false
        } label: {
            HStack(spacing: 7) {
                Image(systemName: symbol).forgeIcon(.small).foregroundStyle(.secondary).frame(width: 14)
                Text(name).lineLimit(1)
                Spacer(minLength: 4)
                if selection == path {
                    Image(systemName: "checkmark").forgeIcon(.micro).foregroundStyle(.tint)
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// An icon-only control that explains itself on hover.
///
/// `.help()` alone was not enough: the macOS tooltip takes about a second and
/// is easy to miss entirely, so an icon with no other affordance reads as
/// decoration. This fills the badge with the icon's own tint the moment the
/// pointer arrives — instant, unmissable "this is a control, and it is THIS
/// one" — and keeps the tooltip for the wording.
struct IconAction<Label: View>: View {
    let tint: ItemTint
    let help: String
    var enabled: Bool = true
    /// Grey at rest, `tint` only under the pointer.
    ///
    /// Colour on a control is a claim that it matters. Three permanently
    /// coloured icons on every card of a full board spend that claim on
    /// utilities — copy and move are cheap and reversible, and they were
    /// competing with the two things that genuinely encode state: the age ramp
    /// and the start action. Grey at rest, colour on approach: the affordance
    /// still announces itself the moment the pointer arrives.
    var tintOnHover: Bool = false
    /// Owned by the PARENT, not by this view: the `.tint(...)` that the
    /// surrounding `Button`/`Menu` needs sits outside this body, so both have to
    /// read the same hover state or the two disagree at the moment it changes.
    var hovering: Bool = false

    private var shown: ItemTint {
        guard enabled else { return .neutral }
        if !tintOnHover { return tint }
        return hovering ? tint : .neutral
    }

    var body: some View {
        label()
            // Every action glyph gets the SAME box. Without it the badges are as
            // wide as whatever symbol they hold, and `arrow.left.arrow.right`
            // (two arrows side by side) is visibly wider than `terminal` or
            // `doc.on.doc` at the identical font size — which reads as "that
            // one is bigger" rather than as "that symbol is wider". Fixing the
            // box means the glyph can be chosen for meaning instead of width.
            .font(.caption2)
            .frame(width: 13, height: 11)
            .metaBadge(shown, filled: hovering && enabled)
            .contentShape(Capsule())
            .animation(.easeInOut(duration: 0.1), value: hovering)
            .help(help)
    }

    @ViewBuilder var label: () -> Label
}

/// A transient receipt for an action with no visible consequence on the board.
///
/// Named `ItemToast` and not `Toast` because `AppState` already nests a `Toast`
/// of its own (`Stores.swift:109`). Two types one word apart in the same module,
/// one global and one nested, is a trap for whoever edits this next.
///
/// `Equatable` so `.onChange(of:)` can schedule the auto-dismiss, and carrying
/// its own symbol so the confirmation looks like the control that produced it —
/// the copy toast shows the copy glyph, a move shows the destination's.
struct ItemToast: Equatable {
    let text: String
    let symbol: String
}

/// The one metric every badge on the card's metadata row obeys.
///
/// They had drifted into three shapes: label chips and the age were capsules
/// with 5/1 padding, the checklist and priority were bare `Label`s with none,
/// and the icon buttons had no box at all — so a row that reads left-to-right
/// had three different heights in it. One modifier, applied to all of them,
/// makes "same size" a property of the code instead of a coincidence that the
/// next edit breaks.
private struct MetaBadge: ViewModifier {
    var tint: ItemTint = .neutral
    /// `false` for icon-only controls, which read as actions rather than as
    /// readouts — they still take the same padding, so the height matches.
    var filled: Bool = true

    func body(content: Content) -> some View {
        content
            .font(.caption2)
            .lineLimit(1)
            .foregroundStyle(tint == .neutral ? AnyShapeStyle(.secondary) : AnyShapeStyle(tint.color))
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(
                filled
                    ? (tint == .neutral ? AnyShapeStyle(.quaternary) : AnyShapeStyle(tint.color.opacity(0.18)))
                    : AnyShapeStyle(.clear),
                in: Capsule()
            )
    }
}

extension View {
    func metaBadge(_ tint: ItemTint = .neutral, filled: Bool = true) -> some View {
        modifier(MetaBadge(tint: tint, filled: filled))
    }
}

/// One label pill. Also used for the `+N` overflow chip, which is why it takes
/// a plain string rather than a label.
///
/// `tint` defaults to `.neutral` so the detail sheet's status/priority chips —
/// which carry their own meaning from position, not colour — keep the quiet
/// treatment, while board labels can be coloured by `ItemCardPresentation.labelTint`.
struct LabelChip: View {
    let text: String
    var tint: ItemTint = .neutral

    var body: some View {
        Text(text).metaBadge(tint)
    }
}

/// The whole item, read-only.
///
/// The card truncates on purpose (D8, LOCKED: truncated card plus a detail
/// panel — in-place expansion was refused); this is where the operator gets
/// the rest. Every field is shown in full here: the entire body, every label,
/// the pt-BR words behind the status and priority marks.
///
/// Read-only by design. Every write still goes through `forge-items.js`
/// (ROADMAP Note 5), and this sheet adds no write path.
struct ItemDetailSheet: View {
    let item: Item
    @Binding var detail: Item?
    /// Optional so previews and any future call site can present the sheet
    /// read-only. When absent the action simply is not offered — the sheet
    /// never invents a launch path of its own (D9/F7 stays with `ItemLaunch`).
    var onStart: (() -> Void)?
    var onMove: ((ItemStatus) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            ScrollView {
                MarkdownBody(source: item.body)
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(.quaternary.opacity(0.22))
            Divider()
            footer
        }
        .frame(width: 560, height: 520)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(ItemCardPresentation.displayTitle(item))
                    .font(.title3).bold()
                    .textSelection(.enabled)
                Spacer(minLength: 8)
                if let p = ItemPriority.parse(item.priority) {
                    Text(p.mark)
                        .font(.caption.monospaced().bold())
                        .foregroundStyle(p.tint.color)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(p.tint.color.opacity(0.18), in: Capsule())
                        .help(p.label)
                }
            }

            HStack(spacing: 6) {
                if let status = item.parsedStatus {
                    Label(status.label, systemImage: status.symbolName)
                        .font(.caption)
                        .foregroundStyle(status.tint == .neutral
                                         ? AnyShapeStyle(.secondary) : AnyShapeStyle(status.tint.color))
                }
                if let s = item.source, !s.isEmpty {
                    Text("·").foregroundStyle(.tertiary)
                    Text(s).font(.caption).foregroundStyle(.secondary)
                }
                if let closed = ItemCardPresentation.closedDay(item) {
                    Text("·").foregroundStyle(.tertiary)
                    Label(closed, systemImage: "calendar.badge.checkmark")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let blocked = ItemCardPresentation.blockedCount(item) {
                    Text("·").foregroundStyle(.tertiary)
                    Label(blocked == 1 ? "bloqueada por 1" : "bloqueada por \(blocked)",
                          systemImage: "lock")
                        .font(.caption).foregroundStyle(ItemTint.red.color)
                }
                Spacer(minLength: 0)
            }

            if let labels = item.labels, !labels.isEmpty {
                // All of them, not the first three: the cut belongs to the card,
                // which has 268pt; this panel does not. A horizontal scroll keeps
                // every chip at full, legible size rather than squeezing them
                // (S04 review R1) — `Layout`/`FlowLayout` wrapping would read
                // better but needs an API level above this package's
                // `.macOS(.v13)` floor.
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) {
                        ForEach(labels, id: \.self) {
                            LabelChip(text: $0, tint: ItemCardPresentation.labelTint($0))
                        }
                    }
                }
            }

            HStack(spacing: 6) {
                Text(item.id)
                    .font(.caption2.monospaced()).foregroundStyle(.tertiary)
                    .textSelection(.enabled)
                Button {
                    // The id is what every CLI command takes, and it is 40
                    // characters nobody retypes correctly.
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(item.id, forType: .string)
                } label: {
                    Image(systemName: "doc.on.doc").forgeIcon(.micro)
                }
                .buttonStyle(.borderless)
                .help("copiar o id")
                Spacer(minLength: 0)
            }
        }
        .padding(16)
    }

    private var footer: some View {
        HStack(spacing: 8) {
            if let onStart {
                Button {
                    onStart()
                    detail = nil
                } label: {
                    Label("Começar", systemImage: "terminal")
                }
                .disabled(!ItemLaunch.canStart(item))
                .help(ItemLaunch.refusal(for: item) ?? "Abre uma aba de terminal com /forge-task para esta tarefa")
            }
            if let onMove {
                Menu {
                    ForEach(ItemStatus.allCases.filter { $0 != item.parsedStatus }, id: \.self) { s in
                        Button {
                            onMove(s)
                            detail = nil
                        } label: {
                            Label(s.label, systemImage: s.symbolName)
                        }
                    }
                } label: {
                    Label("Mover para", systemImage: "arrow.left.arrow.right")
                }
                .fixedSize()
            }
            Spacer()
            Button("Fechar") { detail = nil }.keyboardShortcut(.cancelAction)
        }
        .padding(16)
    }
}

/// Renders an item body as markdown instead of as raw source.
///
/// The block structure comes from `MarkdownDoc` in ForgeKit (parsed and tested
/// headless); this view only decides what each block looks like. Inline markup
/// inside a block goes through `AttributedString(markdown:)`, which is the part
/// SwiftUI does give us — `Text` alone renders `##`, `-` and ``` literally,
/// which is what the sheet was showing before.
struct MarkdownBody: View {
    let source: String?

    var body: some View {
        let blocks = MarkdownDoc.blocks(source ?? "")
        if blocks.isEmpty {
            Text("(sem corpo)").font(.callout).foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                    view(for: block)
                }
            }
            .textSelection(.enabled)
        }
    }

    /// Inline markup only. A failed parse falls back to the raw string rather
    /// than dropping the text — an unparseable body must still be readable.
    private func inline(_ s: String) -> Text {
        if let a = try? AttributedString(markdown: s,
                                         options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            return Text(a)
        }
        return Text(s)
    }

    @ViewBuilder
    private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            inline(text)
                .font(level <= 1 ? .title3.bold() : level == 2 ? .headline : .subheadline.bold())
                .padding(.top, 2)

        case .paragraph(let text):
            inline(text).font(.callout)

        case .bullets(let items):
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, it in
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        Text("•").foregroundStyle(.secondary)
                        inline(it).font(.callout)
                    }
                }
            }
            .padding(.leading, 4)

        case .numbered(let items):
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(items.enumerated()), id: \.offset) { i, it in
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        Text("\(i + 1).").font(.callout.monospacedDigit()).foregroundStyle(.secondary)
                        inline(it).font(.callout)
                    }
                }
            }
            .padding(.leading, 4)

        case .code(let language, let text):
            VStack(alignment: .leading, spacing: 4) {
                if let language {
                    Text(language).font(.caption2).foregroundStyle(.tertiary)
                }
                // No inline pass: inside a fence `*` and `_` are literal.
                Text(text).font(ForgeType.mono)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(10)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))

        case .quote(let text):
            HStack(spacing: 8) {
                Rectangle().fill(.tertiary).frame(width: 3)
                inline(text).font(.callout).foregroundStyle(.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)

        case .rule:
            Divider()
        }
    }
}

private struct NewItemSheet: View {
    @ObservedObject var store: ItemsStore
    let project: String
    @Binding var isPresented: Bool

    @State private var title = ""
    @State private var body_ = ""
    @State private var creating = false

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            Text("Nova tarefa").font(.headline)

            TextField("título", text: $title).textFieldStyle(.roundedBorder)

            TextEditor(text: $body_)
                .font(ForgeType.body)
                .frame(height: 90)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.quaternary))

            HStack {
                Button("Cancelar") { isPresented = false }.keyboardShortcut(.cancelAction)
                Spacer()
                if creating { ProgressView().controlSize(.small) }
                Button("Criar") {
                    creating = true
                    Task {
                        let ok = await store.create(title: title, body: body_, project: project)
                        creating = false
                        if ok { isPresented = false }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || creating)
            }
        }
        .padding(20).frame(width: 420)
    }
}
