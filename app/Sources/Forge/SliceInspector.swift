// SliceInspector — the host that makes a slice's soft artefacts reachable.
//
// Four things a slice produces are never on screen anywhere until this file:
// the review dialogue, the diff of what the slice touched, the verification
// table and the file-audit cross-reference. Three parsers already turn the
// first three into typed values (`ReviewParser`, `UnifiedDiff`,
// `VerificationReport`) and a fourth (`FileAuditReport`) reads the last
// straight out of a `S##-SUMMARY.md`. This file adds nothing to that layer —
// it finds the text, runs the one read-only git command that produces the
// diff, and lays the result out behind the run rail's `SliceRow`.
//
// Everything that touches disk or spawns git happens off `body`, in a single
// `.task` that hands work to `Task.detached` — `Git.invoke`'s own doc-comment
// is explicit that the cooperative pool has one thread per core and a
// synchronous call inside `body` would park one of them. `body` only ever
// reads already-resolved state.

import SwiftUI
import ForgeKit

// MARK: - SliceInspector

struct SliceInspector: View {
    let run: Run
    let slice: SliceStatus

    enum Segment: String, CaseIterable, Identifiable {
        case review = "Review"
        case diff = "Diff"
        case audit = "Auditoria"
        var id: String { rawValue }
    }

    /// Everything the background read resolved to, captured once so `body`
    /// never re-reads a file or re-runs git on redraw. `milestoneDirInferred`
    /// and `diffRangeSource` are what let the header say WHERE a fact came
    /// from instead of asserting it as if it were simply known — an inferred
    /// path that presents itself as fact is how you read the wrong slice
    /// without noticing (S05-PLAN § Resolução do diretório).
    struct Resolved {
        var milestoneDir: String
        var milestoneDirInferred: Bool
        var diffRange: String
        var diffRangeSource: String
        var reviewText: String?
        var diffText: String
        var verificationText: String?
        var summaryText: String?
    }

    @State private var segment: Segment = .review
    @State private var resolved: Resolved?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            content
        }
        .frame(minWidth: 640, idealWidth: 760, minHeight: 480, idealHeight: 620)
        .background(Color.forgeGround)
        .task { await load() }
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(slice.id).font(ForgeType.title)
                if let title = slice.title, !title.isEmpty {
                    Text(title).font(ForgeType.body).foregroundStyle(.secondary)
                }
                Spacer()
            }
            if let resolved {
                Text("diff \(resolved.diffRange) — \(resolved.diffRangeSource)")
                    .font(ForgeType.mono)
                    .foregroundStyle(.secondary)
                if resolved.milestoneDirInferred {
                    Text("caminho do milestone inferido (Run.milestone_dir ausente): \(resolved.milestoneDir)")
                        .font(ForgeType.caption)
                        .foregroundStyle(Color.tone(.amber))
                }
            } else {
                Text("resolvendo caminho e diff…")
                    .font(ForgeType.caption)
                    .foregroundStyle(.tertiary)
            }
            Picker("", selection: $segment) {
                ForEach(Segment.allCases) { s in Text(s.rawValue).tag(s) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        }
        .padding(16)
        .forgeSurface(.panel)
    }

    // MARK: Body content

    @ViewBuilder
    private var content: some View {
        if let resolved {
            switch segment {
            case .review:
                if let text = resolved.reviewText {
                    ReviewView(text: text)
                } else {
                    InspectorEmptyState(
                        systemName: "doc.badge.questionmark",
                        title: "Review indisponível",
                        detail: "Nenhum `S##-REVIEW.md` legível em \(resolved.milestoneDir)/slices/\(slice.id).")
                }
            case .diff:
                DiffView(diffText: resolved.diffText)
            case .audit:
                auditSegment(resolved)
            }
        } else {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func auditSegment(_ resolved: Resolved) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                verificationBlock(resolved.verificationText)
                fileAuditBlock(resolved.summaryText)
            }
            .padding(20)
        }
    }

    private func verificationBlock(_ text: String?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Verificação").font(ForgeType.title)
            verificationBody(text)
        }
    }

    @ViewBuilder
    private func verificationBody(_ text: String?) -> some View {
        if let text {
            let report = VerificationReport.parse(text)
            if report.rows.isEmpty {
                Text("Nenhuma linha de verificação encontrada no artefato.")
                    .font(ForgeType.caption).foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(report.rows.count) artefato\(report.rows.count == 1 ? "" : "s") · \(report.failures.count) falha\(report.failures.count == 1 ? "" : "s")")
                        .font(ForgeType.caption).foregroundStyle(.secondary)
                    ForEach(report.rows, id: \.self) { row in
                        VerificationRowView(row: row)
                    }
                }
            }
        } else {
            Text("`S##-VERIFICATION.md` ausente ou ilegível para este slice.")
                .font(ForgeType.caption).foregroundStyle(.secondary)
        }
    }

    private func fileAuditBlock(_ summaryText: String?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("File Audit").font(ForgeType.title)
            fileAuditBody(summaryText)
        }
    }

    /// The three states this section can be in, kept apart on purpose (the
    /// must-have this task exists to satisfy): a `SUMMARY` that could not be
    /// read at all, a `SUMMARY` with no `## File Audit` section (never
    /// audited), and a section present with nothing flagged (audited and
    /// clean). Collapsing any two of these into the same text would make an
    /// audit that never ran look identical to one that ran and found nothing.
    @ViewBuilder
    private func fileAuditBody(_ summaryText: String?) -> some View {
        if let summaryText {
            if let report = FileAuditReport.parse(summaryText) {
                if report.unexpected.isEmpty && report.missing.isEmpty {
                    Text("auditoria limpa — \(report.compared ?? "nenhum detalhe de contagem")")
                        .font(ForgeType.caption).foregroundStyle(Color.tone(.mint))
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        if let compared = report.compared {
                            Text(compared).font(ForgeType.caption).foregroundStyle(.secondary)
                        }
                        if !report.unexpected.isEmpty {
                            AuditList(title: "Inesperados", tone: .amber, paths: report.unexpected)
                        }
                        if !report.missing.isEmpty {
                            AuditList(title: "Ausentes", tone: .rose, paths: report.missing)
                        }
                    }
                }
            } else {
                Text("sem auditoria neste SUMMARY")
                    .font(ForgeType.caption).foregroundStyle(.secondary)
            }
        } else {
            Text("`S##-SUMMARY.md` ausente ou ilegível para este slice.")
                .font(ForgeType.caption).foregroundStyle(.secondary)
        }
    }

    // MARK: Loading

    /// The one place this view touches disk or spawns a process. Runs off
    /// `body` (`.task` → `Task.detached`); `resolved` is written back on the
    /// main actor once, never streamed field by field.
    private func load() async {
        let cwd = run.cwd
        let runId = run.id
        let milestoneDirRaw = run.milestone_dir
        let sliceId = slice.id

        let value = await Task.detached(priority: .userInitiated) { () -> Resolved in
            let inferred = milestoneDirRaw == nil
            let milestoneDir = milestoneDirRaw ?? "\(cwd)/.gsd/milestones/\(runId)"
            let paths = SliceArtifacts.paths(milestoneDir: milestoneDir, slice: sliceId)

            let reviewText = SliceInspector.readIfExists(paths.review)
            let verificationText = SliceInspector.readIfExists(paths.verification)
            let summaryText = SliceInspector.readIfExists(paths.summary)
            let planText = SliceInspector.readIfExists(paths.plan)

            let (range, source) = SliceInspector.resolveDiffRange(planText: planText)
            // Read-only by construction — `diff` is the only subcommand this
            // host ever passes to `Git.run`, never anything that writes.
            let diffText = Git.run(["diff", range], at: cwd) ?? ""

            return Resolved(
                milestoneDir: milestoneDir,
                milestoneDirInferred: inferred,
                diffRange: range,
                diffRangeSource: source,
                reviewText: reviewText,
                diffText: diffText,
                verificationText: verificationText,
                summaryText: summaryText
            )
        }.value

        resolved = value
    }

    private nonisolated static func readIfExists(_ path: String) -> String? {
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        return try? String(contentsOfFile: path, encoding: .utf8)
    }

    /// `slice_base_sha:` first, `base_sha:` on the fallback, both read from
    /// the slice's own `S##-PLAN.md` frontmatter — same order `S05-PLAN.md`
    /// documents. No PLAN, or neither key present, falls to `HEAD~1..HEAD`.
    /// The word that comes back with the range (`source`) is what the header
    /// shows — a range with no stated origin is indistinguishable from an
    /// empty diff being the wrong one.
    static nonisolated func resolveDiffRange(planText: String?) -> (range: String, source: String) {
        guard let planText else { return ("HEAD~1..HEAD", "fallback (PLAN ausente)") }
        if let sha = firstFrontmatterValue(in: planText, key: "slice_base_sha") {
            return ("\(sha)..HEAD", "do PLAN (slice_base_sha)")
        }
        if let sha = firstFrontmatterValue(in: planText, key: "base_sha") {
            return ("\(sha)..HEAD", "do PLAN (base_sha)")
        }
        return ("HEAD~1..HEAD", "fallback (sem slice_base_sha/base_sha no PLAN)")
    }

    private nonisolated static func firstFrontmatterValue(in text: String, key: String) -> String? {
        for line in text.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("\(key):") else { continue }
            let value = trimmed.dropFirst(key.count + 1)
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: "\""))
            return value.isEmpty ? nil : value
        }
        return nil
    }
}

// MARK: - Small pieces

private struct InspectorEmptyState: View {
    let systemName: String
    let title: String
    let detail: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: systemName)
                .forgeIcon(.large)
                .foregroundStyle(.tertiary)
            Text(title).font(ForgeType.title)
            Text(detail)
                .font(ForgeType.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: 420)
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct VerificationRowView: View {
    let row: VerificationRow

    var body: some View {
        HStack(spacing: 8) {
            mark(row.exists)
            mark(row.substantive)
            mark(row.wired)
            Text(row.path)
                .font(ForgeType.mono)
                .lineLimit(1)
                .truncationMode(.middle)
            if !row.flags.isEmpty {
                Text(row.flags.joined(separator: ", "))
                    .font(ForgeType.caption)
                    .foregroundStyle(Color.tone(.amber))
            }
            Spacer(minLength: 0)
        }
        .padding(6)
        .forgeSurface(.raised)
    }

    private func mark(_ m: VerificationMark) -> some View {
        let tone: ForgeTone = m == .pass ? .mint : (m == .fail ? .rose : .slate)
        return Circle().fill(Color.tone(tone)).frame(width: 7, height: 7)
    }
}

private struct AuditList: View {
    let title: String
    let tone: ForgeTone
    let paths: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("\(title) (\(paths.count))")
                .font(ForgeType.label)
                .foregroundStyle(Color.tone(tone))
            ForEach(paths, id: \.self) { p in
                Text(p).font(ForgeType.mono).foregroundStyle(.secondary)
            }
        }
    }
}
