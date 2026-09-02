// ReviewView — the surface that reads an `S##-REVIEW.md` and shows it as a dialogue.
//
// Zero parsing lives here: `ReviewParser.parse` (ForgeKit/T01) already turned the artefact into
// typed turns, and `SliceArtifacts.paths` (ForgeKit/T03) already knows where the file lives.
// This view's whole job is: find the text, resolve it into one of four named states, and lay
// the result out — challenger objections and advocate answers, in the order the artefact
// recorded them, with the prose rendered through MarkdownUI instead of a raw `Text`.
//
// Two forms of the artefact are real (S05-PLAN § Medido no planning): headed objections with
// named bullets (Abertas/Concedidas), and plain bullets with no fields (Resolvidas). The parser
// already normalised both into the same `ReviewObjection.turns` — this view never has to know
// which form produced a given card.

import SwiftUI
import ForgeKit
import MarkdownUI

// MARK: - ReviewView

struct ReviewView: View {
    /// The four things this screen can be showing. Named and distinct on purpose: a missing
    /// artefact and a review with zero objections look nothing alike to a reader, and collapsing
    /// them into one "nothing here" case would make the empty board (S02: zero objections, a
    /// real and legitimate outcome) indistinguishable from a broken path.
    enum ContentState {
        case missing(String)
        case unreadable(String)
        case empty(ReviewHeader)
        case loaded(ReviewDoc)
    }

    private let state: ContentState

    /// Resolves the artefact's path via `SliceArtifacts.paths(milestoneDir:slice:)` and reads it
    /// from disk. The only initialiser that touches the filesystem.
    init(milestoneDir: String, slice: String) {
        let path = SliceArtifacts.paths(milestoneDir: milestoneDir, slice: slice).review
        guard FileManager.default.fileExists(atPath: path) else {
            state = .missing(path)
            return
        }
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            state = .unreadable(path)
            return
        }
        state = ReviewView.resolve(text)
    }

    /// Builds directly from already-loaded text — what makes the screen previewable and
    /// testable-by-eye without disk I/O, and what a host that already read the artefact
    /// (e.g. for the `## File Audit` cross-reference) should use instead of re-reading it.
    init(text: String) {
        state = ReviewView.resolve(text)
    }

    private static func resolve(_ text: String) -> ContentState {
        let doc = ReviewParser.parse(text)
        return doc.objections.isEmpty ? .empty(doc.header) : .loaded(doc)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                switch state {
                case .missing(let path):
                    ReviewEmptyState(
                        systemName: "doc.badge.questionmark",
                        title: "Nenhum review neste slice",
                        detail: "Esperava um artefato em `\(path)` e não encontrei nada lá.")
                case .unreadable(let path):
                    ReviewEmptyState(
                        systemName: "exclamationmark.triangle",
                        title: "Review ilegível",
                        detail: "O artefato existe em `\(path)`, mas não consegui lê-lo.")
                case .empty(let header):
                    ReviewHeaderCard(header: header, counts: (0, 0, 0))
                    ReviewEmptyState(
                        systemName: "checkmark.circle",
                        title: "Sem objeções nesta rodada",
                        detail: "A rodada de review não achou item para registrar.")
                case .loaded(let doc):
                    ReviewHeaderCard(header: doc.header, counts: counts(doc))
                    ForEach([ReviewStatus.open, .conceded, .resolved], id: \.self) { status in
                        let group = doc.objections(status)
                        if !group.isEmpty {
                            ReviewStatusSection(status: status, objections: group)
                        }
                    }
                }
            }
            .padding(20)
        }
        .background(Color.forgeGround)
    }

    private func counts(_ doc: ReviewDoc) -> (open: Int, conceded: Int, resolved: Int) {
        (doc.objections(.open).count, doc.objections(.conceded).count, doc.objections(.resolved).count)
    }
}

// MARK: - Status → tone, in one place

/// The single mapping from a review status (or turn kind) to a `ForgeTone`. Every place in this
/// file that needs a colour for a status or a turn calls through here — there is no second
/// switch anywhere else that could drift out of sync with this one.
///
/// `open` is deliberately `.ember`: the CONTEXT of this milestone reserves ember for
/// attention/gate, and an open objection is exactly that — a decision still waiting on a human.
/// Nothing else on this screen uses ember.
enum ReviewTone {
    static func forStatus(_ status: ReviewStatus) -> ForgeTone {
        switch status {
        case .open:     return .ember
        case .conceded: return .amber
        case .resolved: return .mint
        }
    }

    static func forTurn(_ turn: ReviewTurn) -> ForgeTone {
        switch turn {
        case .challenger: return .rose
        case .advocate:   return .slate
        case .open:       return .ember
        }
    }

    static func label(for turn: ReviewTurn) -> String {
        switch turn {
        case .challenger: return "CHALLENGER"
        case .advocate:   return "ADVOCATE"
        case .open:       return "DECISÃO"
        }
    }

    static func text(of turn: ReviewTurn) -> String {
        switch turn {
        case .challenger(let s), .advocate(let s), .open(let s): return s
        }
    }

    static func statusLabel(_ status: ReviewStatus) -> String {
        switch status {
        case .open:     return "Abertas"
        case .conceded: return "Concedidas"
        case .resolved: return "Resolvidas"
        }
    }
}

// MARK: - Header

private struct ReviewHeaderCard: View {
    let header: ReviewHeader
    let counts: (open: Int, conceded: Int, resolved: Int)

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(header.sliceId ?? "Review")
                .font(ForgeType.display)
                .foregroundStyle(.primary)

            HStack(spacing: 12) {
                if let challenger = header.challenger {
                    metaRow(icon: "flag.checkered", text: "Challenger: \(challenger)")
                }
                if let defender = header.defender {
                    metaRow(icon: "shield", text: "Defender: \(defender)")
                }
                if let rounds = header.rounds {
                    metaRow(icon: "arrow.triangle.2.circlepath", text: "\(rounds) round\(rounds == 1 ? "" : "s")")
                }
            }

            if let diffScope = header.diffScope {
                Text(diffScope)
                    .font(ForgeType.monoSmall)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            HStack(spacing: 8) {
                chip(count: counts.open, label: "abertas", tone: .ember)
                chip(count: counts.conceded, label: "concedidas", tone: .amber)
                chip(count: counts.resolved, label: "resolvidas", tone: .mint)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .forgeSurface(.panel)
    }

    private func metaRow(icon: String, text: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon).forgeIcon(.small)
            Text(text).font(ForgeType.label)
        }
        .foregroundStyle(.secondary)
    }

    private func chip(count: Int, label: String, tone: ForgeTone) -> some View {
        HStack(spacing: 4) {
            Text("\(count)").font(ForgeType.label)
            Text(label).font(ForgeType.caption)
        }
        .foregroundStyle(Color.tone(tone))
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .forgeSurface(.raised, in: Capsule(), tint: tone, tintStrength: 0.5)
    }
}

// MARK: - One status section

private struct ReviewStatusSection: View {
    let status: ReviewStatus
    let objections: [ReviewObjection]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "circle.fill")
                    .forgeIcon(.dot)
                    .foregroundStyle(Color.tone(ReviewTone.forStatus(status)))
                Text(ReviewTone.statusLabel(status))
                    .font(ForgeType.title)
                Text("\(objections.count)")
                    .font(ForgeType.caption)
                    .foregroundStyle(.secondary)
            }

            ForEach(objections, id: \.id) { objection in
                ObjectionCard(objection: objection)
            }
        }
    }
}

// MARK: - One objection card

private struct ObjectionCard: View {
    let objection: ReviewObjection

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(objection.id)
                    .font(ForgeType.mono)
                    .foregroundStyle(Color.tone(ReviewTone.forStatus(objection.status)))
                if let path = objection.path {
                    Text(objection.line.map { "\(path):\($0)" } ?? path)
                        .font(ForgeType.monoSmall)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                if let severity = objection.severity {
                    Text(severity.uppercased())
                        .font(ForgeType.micro)
                        .foregroundStyle(.secondary)
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(objection.turns.enumerated()), id: \.offset) { _, turn in
                    TurnRow(turn: turn)
                }
            }
        }
        .padding(14)
        .forgeSurface(.raised)
    }
}

// MARK: - One turn — rendered through MarkdownUI, not `Text`

private struct TurnRow: View {
    let turn: ReviewTurn

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(ReviewTone.label(for: turn))
                .font(ForgeType.micro)
                .foregroundStyle(Color.tone(ReviewTone.forTurn(turn)))
            Markdown(ReviewTone.text(of: turn))
                .font(ForgeType.body)
                .foregroundStyle(.primary)
                .markdownImageProvider(ReviewNoRemoteImageProvider())
        }
    }
}

/// Neutralises MarkdownUI's default image provider (T04-SECURITY.md § Also verify item 1):
/// review prose is text a model wrote, sometimes from an external challenger process, and
/// `.default` fetches any `![...](https://…)` it finds the moment the screen renders — opening a
/// review tab would turn into an unrequested network call. This provider never resolves a URL;
/// it draws a static placeholder glyph instead, so a card with an image line is inert to look at,
/// not a silent fetch.
private struct ReviewNoRemoteImageProvider: ImageProvider {
    func makeImage(url: URL?) -> some View {
        Image(systemName: "photo")
            .forgeIcon(.small)
            .foregroundStyle(.secondary)
    }
}

// MARK: - Empty / missing / unreadable states

/// The one named "nothing to show" surface, parameterised by what exactly is missing. Used for
/// both the disk-level failures (missing artefact, unreadable artefact) and, with a different
/// icon and copy, for the legitimate zero-objections outcome — three call sites, one layout.
private struct ReviewEmptyState: View {
    let systemName: String
    let title: String
    let detail: String

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: systemName)
                .forgeIcon(.hero)
                .foregroundStyle(.secondary)
            Text(title)
                .font(ForgeType.title)
            Text(detail)
                .font(ForgeType.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(28)
        .forgeSurface(.panel)
    }
}
