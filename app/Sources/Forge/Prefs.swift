// Prefs — preferences editor generated from forge-prefs.schema.json.
//
// The fields are NOT hardcoded. The schema already carries type, enum, default
// and a pt-BR description for all ~95 knobs, so the UI is derived from it: when
// Forge adds a preference, the app shows it with no change here. Hardcoding the
// list would guarantee the editor silently drifts behind the engine.
//
// Reading goes through `forge-prefs.js --resolved` (the real cascade:
// global → local, last wins). Writing edits ~/.claude/forge-agent-prefs.jsonc,
// touching only the keys the user changed and leaving everything else — comments
// included — byte-identical.

import SwiftUI
import Foundation
import ForgeKit

// MARK: - Schema model

struct PrefField: Identifiable, Hashable {
    let key: String              // "review.challenger"
    let group: String            // "review"
    let leaf: String             // "challenger"
    let types: [String]          // schema type(s) — may be a union
    let enumValues: [String]
    let defaultValue: JSONValue?
    let description: String
    let kind: PrefKind

    var id: String { key }
}

// MARK: - Store

@MainActor
final class PrefsStore: ObservableObject {
    @Published private(set) var fields: [PrefField] = []
    @Published private(set) var values: [String: JSONValue] = [:]   // resolved (effective)
    @Published private(set) var overrides: [String: JSONValue] = [:] // what the file sets
    @Published private(set) var globalFile: String?
    @Published private(set) var localFile: String?
    @Published private(set) var loadError: String?
    @Published var dirty = false

    /// Edits held until the user saves, so a mistyped value never lands on disk.
    @Published var pendingEdits: [String: JSONValue] = [:]

    var groups: [String] {
        Array(Set(fields.map(\.group))).sorted { a, b in
            if a == "geral" { return true }
            if b == "geral" { return false }
            return a < b
        }
    }

    func fields(in group: String) -> [PrefField] {
        fields.filter { $0.group == group }.sorted { $0.leaf < $1.leaf }
    }

    /// How many knobs in this group differ from the schema default — so the
    /// group list answers "where did I change things?" without opening each one.
    func changedCount(in group: String) -> Int {
        fields(in: group).filter { isOverridden($0) }.count
    }

    /// Which layer set this key. The cascade is global → local (last wins), and
    /// showing only "definido" would hide that a local file is overriding the
    /// shared one.
    func origin(of f: PrefField) -> String? {
        if pendingEdits[f.key] != nil { return "não salvo" }
        guard overrides[f.key] != nil else { return nil }
        if let local = localFile, definesKey(f, in: local) { return "local" }
        return "global"
    }

    private func definesKey(_ f: PrefField, in path: String) -> Bool {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return false }
        return text.components(separatedBy: "\n")
            .contains { PrefsEdit.isAssignment($0, key: f.leaf) }
    }

    /// Effective value: pending edit → file override → resolved → schema default.
    func value(for f: PrefField) -> JSONValue? {
        pendingEdits[f.key] ?? values[f.key] ?? f.defaultValue
    }

    func isOverridden(_ f: PrefField) -> Bool {
        pendingEdits[f.key] != nil || overrides[f.key] != nil
    }

    func set(_ f: PrefField, _ v: JSONValue) {
        pendingEdits[f.key] = v
        dirty = true
    }

    func revert(_ f: PrefField) {
        pendingEdits.removeValue(forKey: f.key)
        // Clearing an override means "go back to the default" — represented by
        // removing the key from the file on save.
        if overrides[f.key] != nil { pendingEdits[f.key] = .null }
        dirty = !pendingEdits.isEmpty
    }

    func discard() {
        pendingEdits.removeAll()
        dirty = false
    }

    // MARK: Load

    func load() {
        loadError = nil
        guard let schemaPath = Self.schemaPath(),
              let data = FileManager.default.contents(atPath: schemaPath) else {
            loadError = "forge-prefs.schema.json não encontrado — rode ./install.sh"
            return
        }
        guard let root = try? JSONDecoder().decode(SchemaRoot.self, from: data) else {
            loadError = "schema de preferências ilegível"
            return
        }
        fields = Self.flatten(root.properties)

        // Resolved values (the real cascade) come from the engine, never from a
        // reimplementation of the layering rules.
        if let payload = ForgeCore.runJSON(ResolvedPayload.self,
                                           "forge-prefs.js", ["--resolved"]) {
            values = Self.flattenValues(payload.prefs)
            overrides = values
            globalFile = payload.layers?.global?.files?.first
            localFile = payload.layers?.local?.files?.first
        }
        if globalFile == nil {
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            globalFile = "\(home)/.claude/forge-agent-prefs.jsonc"
        }
    }

    static func schemaPath() -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let installed = "\(home)/.claude/forge-prefs.schema.json"
        if FileManager.default.fileExists(atPath: installed) { return installed }
        if let repo = ForgeCore.repoPath {
            let p = "\(repo)/forge-prefs.schema.json"
            if FileManager.default.fileExists(atPath: p) { return p }
        }
        return nil
    }

    // MARK: Save

    /// Rewrites only the changed keys. The prefs file is JSONC with explanatory
    /// comments the user (and the scaffold) rely on, so it is edited line-wise
    /// rather than re-serialised — a round-trip through JSONSerialization would
    /// drop every comment.
    func save() -> String? {
        guard let path = globalFile else { return "arquivo de preferências desconhecido" }
        guard !pendingEdits.isEmpty else { return nil }

        var text = (try? String(contentsOfFile: path, encoding: .utf8)) ?? "{\n}\n"

        for (key, value) in pendingEdits {
            // Only top-level and one-level-nested keys are edited here; deeper
            // structures are left to the file itself (the app links to it).
            let parts = key.split(separator: ".").map(String.init)
            guard parts.count <= 2 else { continue }
            text = PrefsEdit.upsert(text, path: parts, value: value)
        }

        do {
            try text.write(toFile: path, atomically: true, encoding: .utf8)
            pendingEdits.removeAll()
            dirty = false
            load()
            // The resolver caches per launch on the premise that this screen
            // invalidates it on save — otherwise the pre-save route keeps
            // being served until restart.
            RouteResolver.shared.invalidate()
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    // MARK: Schema flattening

    private struct SchemaRoot: Codable { let properties: [String: SchemaNode] }

    private struct SchemaNode: Codable {
        let type: JSONValue?
        let `enum`: [JSONValue]?
        let `default`: JSONValue?
        let description: String?
        let properties: [String: SchemaNode]?
        let items: Items?

        struct Items: Codable { let type: JSONValue? }
    }

    private struct ResolvedPayload: Codable {
        let prefs: [String: JSONValue]?
        let layers: Layers?
        struct Layers: Codable {
            let global: Layer?
            let local: Layer?
            struct Layer: Codable { let source: String?; let files: [String]? }
        }
    }

    /// One level of nesting only. Deeper structures (arrays of objects) stay in
    /// the file — the app surfaces a link rather than pretending to edit them.
    private static func flatten(_ props: [String: SchemaNode]) -> [PrefField] {
        var out: [PrefField] = []
        for (key, node) in props {
            if key == "$schema" { continue }
            if let children = node.properties, !children.isEmpty {
                for (ck, cn) in children where cn.properties == nil {
                    out.append(field(group: key, leaf: ck, node: cn))
                }
            } else {
                out.append(field(group: "geral", leaf: key, node: node))
            }
        }
        return out
    }

    private static func field(group: String, leaf: String, node: SchemaNode) -> PrefField {
        // `type` may be a single string or a union array — both are valid JSON
        // Schema and both appear in this file (tier_models is string|array).
        var types: [String] = []
        switch node.type {
        case .string(let t): types = [t]
        case .array(let list): types = list.compactMap(\.asString)
        default: types = ["string"]
        }
        let enums = (node.enum ?? []).compactMap(\.asString)
        let itemsAreStrings = node.items?.type?.asString == "string"

        return PrefField(
            key: group == "geral" ? leaf : "\(group).\(leaf)",
            group: group,
            leaf: leaf,
            types: types,
            enumValues: enums,
            defaultValue: node.default,
            description: node.description ?? "",
            kind: PrefKind.from(group: group, leaf: leaf, types: types,
                                hasEnum: !enums.isEmpty, itemsAreStrings: itemsAreStrings))
    }

    private static func flattenValues(_ prefs: [String: JSONValue]?) -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        for (k, v) in prefs ?? [:] {
            if case .object(let child) = v {
                for (ck, cv) in child { out["\(k).\(ck)"] = cv }
            } else {
                out[k] = v
            }
        }
        return out
    }
}

// MARK: - View

struct PrefsView: View {
    @StateObject private var store = PrefsStore()
    @ObservedObject var state: AppState
    @State private var group: String?
    @State private var search = ""
    @State private var showDiff = false
    @State private var onlyChanged = false

    var body: some View {
        VStack(spacing: 0) {
            if let err = store.loadError {
                Label(err, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.orange).padding(12)
            }

            HSplitView {
                List(selection: $group) {
                    ForEach(store.groups, id: \.self) { g in
                        HStack(spacing: 7) {
                            Image(systemName: PrefLabels.group(g).icon)
                                .font(.caption).foregroundStyle(.secondary)
                                .frame(width: 16)
                            Text(PrefLabels.group(g).title)
                            Spacer()
                            // A count per group answers "where did I change
                            // things?" without opening all 22 of them.
                            let n = store.changedCount(in: g)
                            if n > 0 {
                                Text("\(n)")
                                    .font(.caption2).monospacedDigit()
                                    .foregroundStyle(Color.accentOrange)
                            }
                        }
                        .tag(g)
                    }
                }
                .frame(minWidth: 160, maxWidth: 200)

                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if search.isEmpty, let g = group ?? store.groups.first {
                            groupHeader(g)
                        }
                        ForEach(visibleFields) { f in
                            PrefRow(field: f, store: store)
                        }
                        if visibleFields.isEmpty {
                            Text("Nada aqui.").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .padding(16)
                }
            }

            Divider()
            footer
        }
        .searchable(text: $search, prompt: "Buscar preferência")
        .navigationTitle("Preferências")
        .sheet(isPresented: $showDiff) {
            PrefsDiffSheet(store: store, isPresented: $showDiff) {
                if let err = store.save() { state.show(err, error: true) }
                else { state.show("Preferências salvas") }
            }
        }
        .onAppear {
            store.load()
            if group == nil { group = store.groups.first }
        }
    }

    @ViewBuilder private func groupHeader(_ g: String) -> some View {
        let label = PrefLabels.group(g)
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Image(systemName: label.icon).foregroundStyle(Color.accentOrange)
                Text(label.title).font(.title3).bold()
                Text(g).font(.caption2).foregroundStyle(.tertiary)
                    .textSelection(.enabled)
                    .help("Nome da seção no arquivo de preferências")
            }
            if !label.blurb.isEmpty {
                Text(label.blurb)
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.bottom, 4)
    }

    private var visibleFields: [PrefField] {
        var base = search.isEmpty
            ? store.fields(in: group ?? store.groups.first ?? "geral")
            : store.fields.filter {
                $0.key.localizedCaseInsensitiveContains(search) ||
                $0.description.localizedCaseInsensitiveContains(search) ||
                PrefLabels.humanise($0.leaf).localizedCaseInsensitiveContains(search) ||
                PrefLabels.group($0.group).title.localizedCaseInsensitiveContains(search)
            }.sorted { $0.key < $1.key }
        if onlyChanged { base = base.filter { store.isOverridden($0) } }
        return base
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Toggle("Só modificadas", isOn: $onlyChanged)
                .toggleStyle(.checkbox).font(.caption2)
            if let f = store.globalFile {
                Button {
                    ForgeCore.reveal(f)
                } label: {
                    Label(URL(fileURLWithPath: f).lastPathComponent, systemImage: "doc.text")
                        .font(.caption2)
                }
                .buttonStyle(.plain).foregroundStyle(.secondary)
                .help(f)
            }
            Spacer()
            if store.dirty {
                Text("\(store.pendingEdits.count) alteração(ões)")
                    .font(.caption2).foregroundStyle(.secondary)
                Button("Descartar") { store.discard() }.controlSize(.small)
                Button("Revisar e salvar") { showDiff = true }
                    .controlSize(.small).keyboardShortcut("s", modifiers: .command)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
    }
}

struct PrefRow: View {
    let field: PrefField
    @ObservedObject var store: PrefsStore
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(PrefLabels.humanise(field.leaf)).font(.callout).bold()
                    // The machine name stays visible: it is what lands in the
                    // file, what the docs use, and what you type when editing
                    // by hand. Replacing it would give the app and the file two
                    // names for the same knob.
                    Text(field.leaf)
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(.tertiary).textSelection(.enabled)
                }
                if let origin = store.origin(of: field) {
                    Text(origin)
                        .font(.caption2)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(origin == "não salvo" ? AnyShapeStyle(Color.accentOrange.opacity(0.22))
                                                          : AnyShapeStyle(.quaternary),
                                    in: Capsule())
                        .foregroundStyle(origin == "não salvo" ? Color.accentOrange : .secondary)
                        .help(originHelp(origin))
                }
                Spacer()
                control
                if store.isOverridden(field) {
                    Button {
                        store.revert(field)
                    } label: {
                        Image(systemName: "arrow.uturn.backward").font(.caption2)
                    }
                    .buttonStyle(.plain).foregroundStyle(.tertiary)
                    .help("Voltar ao padrão (remove a chave do arquivo)")
                }
            }

            if !field.description.isEmpty {
                Text(field.description)
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            switch field.kind {
            case .stringList: listEditor
            case .modelChain: chainEditor
            case .closedSet:  closedSetEditor
            case .routing:    routingView
            default:          EmptyView()
            }

            HStack(spacing: 10) {
                if let v = store.value(for: field),
                   let human = PrefLabels.humanValue(key: field.leaf, value: v) {
                    // 1800000 is correct on disk and unreadable on screen.
                    Label(human, systemImage: "equal.circle")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                if let d = field.defaultValue {
                    let humanDefault = PrefLabels.humanValue(key: field.leaf, value: d)
                    Text("padrão: \(humanDefault ?? d.display)")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(store.isOverridden(field) ? AnyShapeStyle(.quaternary.opacity(0.42))
                                              : AnyShapeStyle(.quaternary.opacity(0.2)),
                    in: RoundedRectangle(cornerRadius: 9))
    }

    private func originHelp(_ o: String) -> String {
        switch o {
        case "local":     return "Definido no arquivo local (não commitado) — sobrepõe o global"
        case "global":    return "Definido no arquivo global"
        case "não salvo": return "Alteração pendente — clique em Salvar"
        default:          return o
        }
    }

    @ViewBuilder private var control: some View {
        switch field.kind {
        case .toggle:
            Toggle("", isOn: Binding(
                get: { store.value(for: field)?.asBool ?? false },
                set: { store.set(field, .bool($0)) }))
            .labelsHidden()

        case .choice:
            Picker("", selection: Binding(
                get: { store.value(for: field)?.asString ?? field.enumValues.first ?? "" },
                set: { store.set(field, .string($0)) })) {
                ForEach(field.enumValues, id: \.self) { Text($0).tag($0) }
            }
            .labelsHidden().frame(maxWidth: 180)

        case .number:
            TextField("", value: Binding(
                get: { store.value(for: field)?.asDouble ?? 0 },
                set: { store.set(field, .number($0)) }), format: .number)
            .textFieldStyle(.roundedBorder).frame(width: 100)

        case .text:
            TextField("", text: Binding(
                get: { store.value(for: field)?.asString ?? "" },
                set: { store.set(field, .string($0)) }))
            .textFieldStyle(.roundedBorder).frame(width: 200)

        case .stringList:
            Text("\(currentList.count) item(ns)")
                .font(.caption2).foregroundStyle(.secondary)

        case .scalarUnion:
            // A number OR a sentinel word (compact_after: 5 | "unlimited").
            // Typed text is parsed back into whichever shape it actually is, so
            // the sentinel survives a round-trip.
            TextField("", text: Binding(
                get: { store.value(for: field)?.display ?? "" },
                set: { store.set(field, PrefsEdit.scalar(from: $0, allowsNumber: true)) }))
            .textFieldStyle(.roundedBorder).frame(width: 140)

        case .modelChain:
            if let chain = ModelChain.from(store.value(for: field)) {
                Text(chain.ids.count == 1 ? ModelCatalog.label(for: chain.ids[0])
                                          : "\(chain.ids.count) na cadeia")
                    .font(.caption2).foregroundStyle(.secondary)
            }

        case .closedSet:
            Text("\(currentList.count) de \(ClosedSets.options(forLeaf: field.leaf)?.count ?? 0)")
                .font(.caption2).foregroundStyle(.secondary)

        case .routing:
            Text("\(RoutingReader.rows(from: store.value(for: field)).count) regra(s)")
                .font(.caption2).foregroundStyle(.secondary)

        case .opaque:
            // Editing a nested object as text would rewrite it in the wrong
            // shape. Show it and point at the file.
            HStack(spacing: 6) {
                Text(store.value(for: field)?.display ?? "—")
                    .font(.caption).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.tail).frame(maxWidth: 190, alignment: .trailing)
                Image(systemName: "lock").font(.caption2).foregroundStyle(.tertiary)
                    .help("Estrutura aninhada — edite no arquivo para não corromper o formato")
            }
        }
    }

    // MARK: Model chain

    /// A tier is either one model or an ordered fallback chain, and both shapes
    /// are valid on disk. The editor keeps whichever is there: adding a second
    /// entry turns it into a chain, deleting back to one collapses to a scalar.
    private var chainEditor: some View {
        let chain = ModelChain.from(store.value(for: field)) ?? .single("")
        return VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(chain.ids.enumerated()), id: \.offset) { idx, id in
                HStack(spacing: 6) {
                    if chain.ids.count > 1 {
                        Text("\(idx + 1)")
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundStyle(.tertiary).frame(width: 12)
                            .help(idx == 0 ? "Primeira escolha" : "Usado se o anterior falhar")
                    }
                    ModelField(id: id) { newID in
                        store.set(field, chain.replacing(at: idx, with: newID).toValue())
                    }
                    if chain.ids.count > 1 {
                        Button {
                            store.set(field, chain.removing(at: idx).toValue())
                        } label: { Image(systemName: "minus.circle").font(.caption) }
                        .buttonStyle(.plain).foregroundStyle(.tertiary)
                    }
                }
            }
            HStack(spacing: 10) {
                Button {
                    store.set(field, chain.appending("").toValue())
                } label: {
                    Label("Adicionar fallback", systemImage: "plus").font(.caption2)
                }
                .buttonStyle(.plain).foregroundStyle(.secondary)
                .help("Modelo usado quando o anterior falha")

                if let d = ModelCatalog.defaultFor(tier: field.leaf),
                   chain.ids != [d] {
                    Button {
                        store.set(field, .string(d))
                    } label: {
                        Label("Usar \(ModelCatalog.label(for: d))", systemImage: "arrow.uturn.backward")
                            .font(.caption2)
                    }
                    .buttonStyle(.plain).foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.top, 2)
    }

    // MARK: Closed set

    /// Members come from a fixed vocabulary, so checkboxes beat a free list:
    /// a typo in free text is a value the engine silently ignores.
    private var closedSetEditor: some View {
        let options = ClosedSets.options(forLeaf: field.leaf) ?? []
        let selected = Set(currentList)
        return VStack(alignment: .leading, spacing: 2) {
            ForEach(options, id: \.self) { opt in
                Toggle(isOn: Binding(
                    get: { selected.contains(opt) },
                    set: { on in
                        // Preserve the vocabulary's order rather than click order,
                        // so the file stays stable across edits.
                        var next = selected
                        if on { next.insert(opt) } else { next.remove(opt) }
                        let ordered = options.filter { next.contains($0) }
                        store.set(field, .array(ordered.map { .string($0) }))
                    })) {
                    Text(opt).font(.caption)
                }
                .toggleStyle(.checkbox)
            }
        }
        .padding(.top, 2)
    }

    // MARK: Routing

    /// Rendered, not edited: routing nests domain → phase → tier with open keys,
    /// and a wrong write reroutes real work. Reading it is the valuable part.
    @ViewBuilder private var routingView: some View {
        let rows = RoutingReader.rows(from: store.value(for: field))
        if rows.isEmpty {
            Text("Nenhuma regra — todo trabalho resolve por tier_models.")
                .font(.caption2).foregroundStyle(.tertiary)
        } else {
            VStack(alignment: .leading, spacing: 3) {
                ForEach(rows) { r in
                    HStack(alignment: .top, spacing: 6) {
                        Text(r.domain)
                            .font(.system(size: 10, design: .monospaced)).bold()
                            .frame(width: 74, alignment: .leading)
                        Text("\(r.phase) · \(r.tier)")
                            .font(.system(size: 10)).foregroundStyle(.secondary)
                            .frame(width: 108, alignment: .leading)
                        Text(r.chain.map { ModelCatalog.label(for: $0) }.joined(separator: " → "))
                            .font(.system(size: 10)).foregroundStyle(.primary)
                            .lineLimit(1).truncationMode(.middle)
                        Spacer()
                    }
                }
                Text("Edite no arquivo — a estrutura é aninhada e aberta demais para um editor genérico.")
                    .font(.system(size: 9)).foregroundStyle(.tertiary).padding(.top, 2)
            }
            .padding(8)
            .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 6))
        }
    }

    // MARK: List editor

    private var currentList: [String] {
        store.value(for: field)?.asStringArray ?? []
    }

    /// Lists are edited as lists. Round-tripping them through a text field is
    /// what used to turn ["dist/**"] into the string "dist/**".
    private var listEditor: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(currentList.enumerated()), id: \.offset) { idx, item in
                HStack(spacing: 6) {
                    Text("•").foregroundStyle(.tertiary)
                    TextField("", text: Binding(
                        get: { item },
                        set: { newValue in
                            var list = currentList
                            guard idx < list.count else { return }
                            list[idx] = newValue
                            store.set(field, .array(list.map { .string($0) }))
                        }))
                    .textFieldStyle(.roundedBorder)
                    Button {
                        var list = currentList
                        guard idx < list.count else { return }
                        list.remove(at: idx)
                        store.set(field, .array(list.map { .string($0) }))
                    } label: {
                        Image(systemName: "minus.circle").font(.caption)
                    }
                    .buttonStyle(.plain).foregroundStyle(.tertiary)
                }
            }
            Button {
                store.set(field, .array((currentList + [""]).map { .string($0) }))
            } label: {
                Label("Adicionar", systemImage: "plus").font(.caption2)
            }
            .buttonStyle(.plain).foregroundStyle(.secondary)
        }
        .padding(.top, 2)
    }
}

/// What a save will actually write. Preferences are edited rarely and the file
/// is shared with the engines, so showing the change beats trusting it.
struct PrefsDiffSheet: View {
    @ObservedObject var store: PrefsStore
    @Binding var isPresented: Bool
    let onConfirm: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Confirmar alterações").font(.headline)
            Text(store.globalFile.map { "Serão gravadas em \(($0 as NSString).lastPathComponent)" }
                 ?? "Arquivo de preferências")
                .font(.caption).foregroundStyle(.secondary)

            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(store.pendingEdits.keys.sorted(), id: \.self) { key in
                        let newValue = store.pendingEdits[key]!
                        HStack(alignment: .top, spacing: 8) {
                            VStack(alignment: .leading, spacing: 0) {
                                Text(PrefLabels.humanise(key.components(separatedBy: ".").last ?? key))
                                    .font(.caption).bold()
                                Text(key).font(.system(size: 9, design: .monospaced))
                                    .foregroundStyle(.tertiary)
                            }
                            .frame(width: 190, alignment: .leading)
                            VStack(alignment: .leading, spacing: 1) {
                                if case .null = newValue {
                                    Text("removido — volta ao padrão")
                                        .font(.caption).foregroundStyle(.orange)
                                } else {
                                    let leaf = key.components(separatedBy: ".").last ?? key
                                    Text(PrefLabels.humanValue(key: leaf, value: newValue)
                                         ?? newValue.display).font(.caption)
                                }
                                if let old = store.values[key] {
                                    Text("antes: \(old.display)")
                                        .font(.caption2).foregroundStyle(.tertiary)
                                }
                            }
                            Spacer()
                        }
                        .padding(8)
                        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 7))
                    }
                }
            }
            .frame(maxHeight: 280)

            HStack {
                Button("Cancelar") { isPresented = false }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Gravar") { onConfirm(); isPresented = false }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20).frame(width: 520)
    }
}

extension ModelFamily {
    var color: Color {
        switch colorName {
        case "green":  return .green
        case "blue":   return .blue
        case "purple": return .purple
        case "orange": return Color.accentOrange
        case "teal":   return .teal
        case "indigo": return .indigo
        default:       return .secondary
        }
    }
}

/// Pick a model.
///
/// A menu of known ids is the default path: typing one produces a value that
/// only fails at dispatch, deep inside a run, and a typo is indistinguishable
/// from a deliberate choice until then. Free text stays available behind
/// "Outro…", because a model released tomorrow must be usable today.
struct ModelField: View {
    let id: String
    var engine: ModelEngine = .claude
    let onChange: (String) -> Void

    @State private var custom = ""
    @State private var editingCustom = false

    private var choices: [ModelChoice] { ModelCatalog.suggestions(for: engine) }
    private var family: ModelFamily { ModelCatalog.family(of: id) }
    private var isKnown: Bool { choices.contains { $0.id == id } }

    var body: some View {
        HStack(spacing: 6) {
            if editingCustom {
                TextField("id do modelo", text: $custom)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 11, design: .monospaced))
                    .onSubmit { commitCustom() }
                Button("OK") { commitCustom() }.controlSize(.small)
                Button {
                    editingCustom = false
                } label: { Image(systemName: "xmark").font(.caption2) }
                .buttonStyle(.plain).foregroundStyle(.tertiary)
            } else {
                Menu {
                    ForEach(choices) { m in
                        Button {
                            onChange(m.id)
                        } label: {
                            if m.tier.isEmpty { Text(m.label) }
                            else { Text("\(m.label)  ·  \(m.tier)") }
                        }
                    }
                    Divider()
                    Button("Outro…") {
                        custom = id
                        editingCustom = true
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: family.icon)
                            .font(.system(size: 10)).foregroundStyle(family.color)
                        Text(id.isEmpty ? "escolher…" : ModelCatalog.label(for: id))
                            .font(.caption)
                            .foregroundStyle(id.isEmpty ? AnyShapeStyle(.tertiary)
                                                        : AnyShapeStyle(.primary))
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 7)).foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(family.color.opacity(id.isEmpty ? 0 : 0.12),
                                in: Capsule())
                    .overlay(Capsule().strokeBorder(.quaternary))
                    .contentShape(Capsule())
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .help(id.isEmpty ? "Escolher um modelo" : id)

                if !id.isEmpty && !isKnown {
                    // Not in the catalogue: could be new, could be a typo. Saying
                    // which is impossible, so it is flagged rather than blocked.
                    Image(systemName: "questionmark.circle")
                        .font(.caption2).foregroundStyle(.orange)
                        .help("Fora do catálogo — modelo novo ou erro de digitação")
                }
            }
        }
    }

    private func commitCustom() {
        let clean = custom.trimmingCharacters(in: .whitespaces)
        editingCustom = false
        guard !clean.isEmpty, clean != id else { return }
        onChange(clean)
    }
}
