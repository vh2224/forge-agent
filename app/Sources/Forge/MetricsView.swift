// MetricsView — what the runs cost and where the work went.
//
// Reads .gsd/forge/events.jsonl, which the orchestrator has been appending to
// on every dispatch since M002. Nothing new is instrumented; the numbers were
// already on disk.

import SwiftUI
import Charts
import ForgeKit

@MainActor
final class MetricsStore: ObservableObject {
    @Published private(set) var summary = MetricsSummary()
    @Published private(set) var loading = false
    @Published private(set) var scope: String = "todos"
    @Published var window: Window = .week

    enum Window: String, CaseIterable, Identifiable {
        case day = "24h"
        case week = "7 dias"
        case month = "30 dias"
        case all = "tudo"
        var id: String { rawValue }

        var since: Date? {
            switch self {
            case .day:   return Date().addingTimeInterval(-86_400)
            case .week:  return Date().addingTimeInterval(-7 * 86_400)
            case .month: return Date().addingTimeInterval(-30 * 86_400)
            case .all:   return nil
            }
        }
    }

    func load(workspaces: [String], only: String? = nil) {
        guard !loading else { return }
        loading = true
        let targets = only.map { [$0] } ?? workspaces
        scope = only.map { ProjectOrganiser.name($0) } ?? "todos os projetos"
        let since = window.since

        Task.detached(priority: .utility) {
            var all: [DispatchEvent] = []
            var counts: [String: Int] = [:]
            for ws in targets {
                let path = "\(ws)/.gsd/forge/events.jsonl"
                guard let text = try? String(contentsOfFile: path, encoding: .utf8)
                else { continue }
                let (d, e) = MetricsEngine.parse(text)
                all += d
                for (k, v) in e { counts[k, default: 0] += v }
            }
            let s = MetricsEngine.summarise(all, events: counts, since: since)
            await MainActor.run {
                self.summary = s
                self.loading = false
            }
        }
    }
}

extension MetricsStore.Window {
    /// 1:1 mapping into ForgeKit's `ProgressWindow` (DS3-3). Exhaustive
    /// `switch` on purpose — no `default:` — so a future case added to
    /// `Window` fails the build instead of silently falling into the wrong
    /// window.
    var progressWindow: ProgressWindow {
        switch self {
        case .day:   return .day24h
        case .week:  return .week
        case .month: return .month
        case .all:   return .all
        }
    }
}

/// Data layer for the progress panel (S03). Same shape as `MetricsStore`
/// above and `ItemsStore` (ItemsView.swift): `@MainActor` store,
/// `Task.detached` for the shell-out, `await MainActor.run` back.
///
/// Reads items only through `forge-items.js --list --json` (ForgeCore) —
/// every count comes out of `ProgressEngine.load` (ForgeKit/S02); nothing
/// here reimplements status or closing semantics.
@MainActor
final class ProgressStore: ObservableObject {
    @Published private(set) var summary: ProgressSummary?
    @Published private(set) var loading = false

    /// Guards against out-of-order loads the same way `ItemsStore` does (no
    /// `guard !loading` — that would drop a newer request without advancing
    /// the generation, letting an in-flight older request win the race):
    /// every call bumps the generation, and only the request whose
    /// generation is still current is allowed to write `summary`/`loading`.
    private var generation = LoadGeneration()

    /// `project.isEmpty` is "Todos os projetos" (DS3-1) — the panel does not
    /// aggregate across projects, so no load happens and `summary` is
    /// cleared rather than left stale. The generation must still advance
    /// here so an in-flight load for the previous project can't land after
    /// the switch to "Todos os projetos".
    func load(project: String, window: MetricsStore.Window) {
        guard !project.isEmpty else {
            _ = generation.start()
            summary = nil
            loading = false
            return
        }
        loading = true
        let pw = window.progressWindow
        let gen = generation.start()

        Task.detached(priority: .utility) {
            let items = ForgeCore.runJSON([Item].self, "forge-items.js",
                                          ["--list", "--json", "--cwd", project]) ?? []
            // ignoreGlobs: nil (DS3-2) — the drift between ForgeKit's default
            // list and the completer's resolved list is already guarded by
            // scripts/forge-app-progress.test.js; reading
            // file_audit.ignore_list here would be new scope the app's
            // ResolvedPrefs does not carry.
            let s = ProgressEngine.load(workspace: project, items: items, window: pw)
            await MainActor.run {
                guard self.generation.isCurrent(gen) else { return }
                self.summary = s
                self.loading = false
            }
        }
    }
}

/// Renders a `ProgressSummary` as a segment inside `MetricsView` (S03/T02):
/// three separate, labelled counts — closed items, ledger deliveries,
/// commits — never one combined number (D2, critério #7). Coverage is glued
/// to the first count only; the divergence sentence renders exclusively via
/// optional binding, with no fallback text when it is nil (D3, critério #9).
///
/// `summary`/`hasProject` are injected, not read from disk (DS3-5) — the same
/// shape as `ItemCard`/`ItemDetailSheet` (S04), so it stages from a fixture
/// in `Previews.swift` (T04) without touching disk.
struct ProgressPanel: View {
    let summary: ProgressSummary?
    let hasProject: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionTitle("Progresso")
            if !hasProject {
                Text("Escolha um projeto para ver o progresso.")
                    .font(.callout).foregroundStyle(.secondary)
            } else if let summary {
                HStack(alignment: .top, spacing: 22) {
                    progressStat("\(summary.closedItems.closed)", "itens fechados",
                                 caption: summary.closedItems.coverageLabel)
                    Divider().frame(height: 34)
                    progressStat("\(summary.ledger.count)", "entregas",
                                 caption: ledgerCaption(summary.ledger))
                    Divider().frame(height: 34)
                    progressStat("\(summary.gitCommits)", "commits",
                                 caption: "+\(summary.gitAdded) / −\(summary.gitDeleted) linhas — movimento")
                    Spacer()
                }
                // Optional binding only — no `?? "tudo em ordem"` fallback
                // (D3). When `divergence` is nil, no view occupies its place.
                if let d = summary.divergence {
                    Label(d, systemImage: "arrow.triangle.branch")
                        .font(.callout).foregroundStyle(.secondary)
                }
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 14))
    }

    /// `ledger.windowLabel` ("hoje" for the 24h window, nil otherwise) and the
    /// undated-fragment caveat combined into one caption — both are secondary
    /// detail on the deliveries count, never folded into `ledger.count`
    /// itself.
    private func ledgerCaption(_ ledger: LedgerCount) -> String? {
        var parts: [String] = []
        if let w = ledger.windowLabel { parts.append(w) }
        if ledger.undated > 0 { parts.append("\(ledger.undated) sem data") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// A three-line stat block: value, label, and an optional secondary
    /// caption (coverage / window / movement) — the sibling `T02-PLAN.md`
    /// steps asked for, since the existing `stat(_:_:)` in `MetricsView` has
    /// no room for a third line.
    private func progressStat(_ value: String, _ label: String,
                              caption: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value)
                .font(ForgeType.display).monospacedDigit()
            Text(label).font(.caption2).foregroundStyle(.secondary)
            if let caption {
                Text(caption).font(.caption2).foregroundStyle(.tertiary)
            }
        }
    }
}

struct MetricsView: View {
    @StateObject private var store = MetricsStore()
    @StateObject private var progress = ProgressStore()
    @ObservedObject var state: AppState
    @State private var project: String = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                headline
                // Progress and dispatches are independent sources (S03): a
                // project with zero dispatches can still have closed items,
                // so this sits outside the `dispatches == 0` branch below.
                ProgressPanel(summary: progress.summary, hasProject: !project.isEmpty)
                if store.summary.dispatches == 0 {
                    empty
                } else {
                    breakdown("Por modelo", store.summary.byModel, showFamily: true)
                    breakdown("Por engine", store.summary.byEngine, showFamily: false)
                    breakdown("Por fase", store.summary.byUnit, showFamily: false)
                    if !store.summary.byDomain.isEmpty {
                        breakdown("Por domínio", store.summary.byDomain, showFamily: false)
                    }
                    activityCard
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
        }
        .navigationTitle("Métricas")
        .onAppear { reload() }
        .onChange(of: store.window) { _ in reload() }
        .toolbar {
            ToolbarItem {
                Picker("", selection: $project) {
                    Text("Todos os projetos").tag("")
                    ForEach(state.workspaces, id: \.self) { ws in
                        Text(ProjectOrganiser.name(ws)).tag(ws)
                    }
                }
                .labelsHidden().frame(width: 170)
                .onChange(of: project) { _ in reload() }
            }
            ToolbarItem {
                Picker("", selection: $store.window) {
                    ForEach(MetricsStore.Window.allCases) { w in Text(w.rawValue).tag(w) }
                }
                .pickerStyle(.segmented).labelsHidden().frame(width: 230)
            }
        }
    }

    private func reload() {
        store.load(workspaces: state.workspaces, only: project.isEmpty ? nil : project)
        progress.load(project: project, window: store.window)
    }

    // MARK: Headline

    private var headline: some View {
        let s = store.summary
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 22) {
                stat(MetricsEngine.money(s.cost), "custo estimado",
                     accent: true, caveat: s.costIncomplete)
                Divider().frame(height: 34)
                stat(MetricsEngine.tokens(s.totalTokens), "tokens")
                Divider().frame(height: 34)
                stat("\(s.dispatches)", "dispatches")
                Spacer()
                if store.loading { ProgressView().controlSize(.small) }
            }

            // Output is 5x the price of input across the table, so the split
            // explains a bill that the total alone does not.
            if s.totalTokens > 0 {
                VStack(alignment: .leading, spacing: 3) {
                    Chart {
                        BarMark(x: .value("tokens", s.inputTokens))
                            .foregroundStyle(Color.secondary.opacity(0.45))
                        BarMark(x: .value("tokens", s.outputTokens))
                            .foregroundStyle(Color.accentOrange.opacity(0.75))
                    }
                    .chartXAxis(.hidden).chartYAxis(.hidden).chartLegend(.hidden)
                    .chartXScale(domain: 0...max(1, s.totalTokens))
                    .frame(height: 8)
                    HStack(spacing: 12) {
                        legend(Color.secondary.opacity(0.45),
                               "entrada \(MetricsEngine.tokens(s.inputTokens))")
                        legend(Color.accentOrange.opacity(0.75),
                               "saída \(MetricsEngine.tokens(s.outputTokens))")
                        Text("saída custa ~5x mais por token")
                            .font(.caption2).foregroundStyle(.tertiary)
                        Spacer()
                    }
                }
            }

            if s.costIncomplete {
                Label("Engines externos (codex, gemini) são cobrados fora da Anthropic — os tokens contam, o custo não.",
                      systemImage: "info.circle")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 14))
    }

    private func stat(_ value: String, _ label: String,
                      accent: Bool = false, caveat: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 3) {
                Text(value)
                    .font(ForgeType.display).monospacedDigit()
                    .foregroundStyle(accent ? Color.accentOrange : .primary)
                if caveat {
                    Text("+").font(.caption).foregroundStyle(.tertiary)
                        .help("Parcial — há dispatches sem preço conhecido")
                }
            }
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func legend(_ color: Color, _ text: String) -> some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(text).font(.caption2).foregroundStyle(.secondary)
        }
    }

    // MARK: Breakdown

    private func breakdown(_ title: String, _ buckets: [MetricsBucket],
                           showFamily: Bool) -> some View {
        // Scale against the largest token count, not the first bucket: the list
        // is ordered by SPEND, so a cheap high-volume model can sit below a
        // pricey one and would otherwise render past its track.
        let peak = MetricsEngine.maxTokens(buckets)
        let totalCost = buckets.reduce(0) { $0 + $1.cost }

        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                SectionTitle(title)
                Spacer()
                Text("\(buckets.count)")
                    .font(.caption2).monospacedDigit().foregroundStyle(.tertiary)
            }
            VStack(spacing: 0) {
                ForEach(Array(buckets.prefix(10).enumerated()), id: \.element.id) { idx, b in
                    if idx > 0 { Divider().opacity(0.4) }
                    breakdownRow(b, peak: peak, totalCost: totalCost, showFamily: showFamily)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .forgeSurface(.raised)
        }
    }

    /// One row. The numeric columns keep fixed widths so they line up down the
    /// list; only the bar flexes, which is what keeps this readable as the
    /// window resizes.
    private func breakdownRow(_ b: MetricsBucket, peak: Int, totalCost: Double,
                              showFamily: Bool) -> some View {
        let fam = ModelCatalog.family(of: b.key)
        let share = totalCost > 0 ? b.cost / totalCost : 0

        return HStack(spacing: 10) {
            if showFamily {
                Image(systemName: fam.icon)
                    .forgeIcon(.small).foregroundStyle(fam.color)
                    .frame(width: 16)
            }

            Text(showFamily ? ModelCatalog.label(for: b.key) : b.key)
                .font(ForgeType.label).lineLimit(1).truncationMode(.middle)
                .frame(minWidth: 90, idealWidth: 130, maxWidth: 170, alignment: .leading)

            Chart {
                BarMark(x: .value("tokens", b.totalTokens), y: .value("bucket", ""))
                    .foregroundStyle(barColor(b, showFamily: showFamily))
                    .cornerRadius(3)
            }
            .chartXScale(domain: 0...max(1, peak))
            .chartXAxis(.hidden).chartYAxis(.hidden).chartLegend(.hidden)
            .chartPlotStyle { $0.background(.quaternary, in: Capsule()) }
            .frame(minWidth: 60, maxHeight: 22)

            Text(MetricsEngine.tokens(b.totalTokens))
                .font(ForgeType.label).monospacedDigit().foregroundStyle(.secondary)
                .frame(width: 58, alignment: .trailing)

            VStack(alignment: .trailing, spacing: 0) {
                Text(b.cost > 0 ? MetricsEngine.money(b.cost) : "—")
                    .font(ForgeType.label).monospacedDigit()
                    .foregroundStyle(b.cost > 0 ? AnyShapeStyle(.primary)
                                                : AnyShapeStyle(.tertiary))
                if share >= 0.01 {
                    Text("\(Int(share * 100))%")
                        .font(ForgeType.micro).monospacedDigit().foregroundStyle(.tertiary)
                }
            }
            .frame(width: 64, alignment: .trailing)
            .help(b.costIncomplete && b.cost == 0
                  ? "Cobrado fora da Anthropic" : "Custo estimado")

            Text("\(b.dispatches)×")
                .font(ForgeType.label).monospacedDigit().foregroundStyle(.tertiary)
                .frame(width: 40, alignment: .trailing)
        }
        .padding(.vertical, 7)
    }

    private func barColor(_ b: MetricsBucket, showFamily: Bool) -> Color {
        showFamily ? ModelCatalog.family(of: b.key).color : Color.accentOrange.opacity(0.6)
    }

    // MARK: Activity

    /// Non-dispatch events: how much reviewing, retrying and repairing actually
    /// happened. A high retry count is the kind of thing that never surfaces
    /// while you watch a single run.
    private var activityCard: some View {
        let interesting = ["review", "review-fix", "verify", "plan_check",
                           "retry", "repair", "symbol_check", "review-triage"]
        let rows = interesting.compactMap { k -> (String, Int)? in
            guard let v = store.summary.eventCounts[k], v > 0 else { return nil }
            return (k, v)
        }
        return Group {
            if !rows.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    SectionTitle("Atividade")
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: 10)],
                              alignment: .leading, spacing: 10) {
                        ForEach(rows, id: \.0) { name, count in
                            VStack(alignment: .leading, spacing: 1) {
                                Text("\(count)")
                                    .font(ForgeType.title).monospacedDigit()
                                    .foregroundStyle(name == "retry" && count > 10
                                                     ? AnyShapeStyle(Color.orange)
                                                     : AnyShapeStyle(.primary))
                                Text(name).font(.caption2).foregroundStyle(.secondary)
                            }
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.quaternary.opacity(0.25),
                                        in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
            }
        }
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Sem eventos nesta janela", systemImage: "chart.bar")
                .font(.callout)
            Text("As métricas vêm de .gsd/forge/events.jsonl, escrito a cada dispatch. Amplie o período ou rode um milestone.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 12))
    }
}
