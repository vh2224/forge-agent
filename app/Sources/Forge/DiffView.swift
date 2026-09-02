// DiffView — the surface that reads a unified-diff string and shows hunks with Splash-highlighted
// text, added/removed lines told apart by background rather than by their leading character.
//
// Zero parsing lives here: `UnifiedDiff.parse` (ForgeKit/T02) already turned the raw string into
// typed `[DiffFile]`/`DiffHunk`/`DiffLine`, and zero git lives here either — the host (T06) is the
// only place that runs `Git.run(["diff", …])` and hands this view the resulting text.
//
// Two axes, deliberately kept apart (S05-PLAN § Forma da tela): the background says WHAT the line
// is (added/removed/context), Splash says HOW the code reads (syntax). If the Splash theme were
// allowed to paint the background too, the two would collide and the type of the line would
// disappear under whatever colour the token happened to get. `Theme.sundellsColors` supplies the
// text colour only; the background is applied on the row, outside the highlighter's output.

import SwiftUI
import AppKit
import ForgeKit
import Splash

// MARK: - DiffView

struct DiffView: View {
    private let files: [DiffFile]

    /// Parses `diffText` once at init — the view never re-parses on redraw, and never calls git
    /// or touches disk. `UnifiedDiff.parse("")` already returns `[]`, which routes to the named
    /// empty state below rather than to zero silent rows.
    init(diffText: String) {
        files = UnifiedDiff.parse(diffText)
    }

    private var totals: (added: Int, deleted: Int) {
        files.reduce((0, 0)) { acc, f in (acc.0 + f.added, acc.1 + f.deleted) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if files.isEmpty {
                    DiffEmptyState()
                } else {
                    DiffHeaderRow(fileCount: files.count, totals: totals)
                    ForEach(Array(files.enumerated()), id: \.offset) { _, file in
                        DiffFileCard(file: file)
                    }
                }
            }
            .padding(20)
        }
        .background(Color.forgeGround)
    }
}

// MARK: - Header

private struct DiffHeaderRow: View {
    let fileCount: Int
    let totals: (added: Int, deleted: Int)

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.left.arrow.right")
                .forgeIcon(.medium)
                .foregroundStyle(.secondary)
            Text("\(fileCount) arquivo\(fileCount == 1 ? "" : "s")")
                .font(ForgeType.title)
            Spacer()
            Text("+\(totals.added)")
                .font(ForgeType.mono)
                .foregroundStyle(Color.tone(.mint))
            Text("−\(totals.deleted)")
                .font(ForgeType.mono)
                .foregroundStyle(Color.tone(.rose))
        }
        .padding(14)
        .forgeSurface(.panel)
    }
}

// MARK: - One file

private struct DiffFileCard: View {
    let file: DiffFile

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(file.displayPath)
                    .font(ForgeType.mono)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.head)

                if file.isRename {
                    DiffFileTag(text: "RENAME", tone: .violet)
                }
                if file.oldPath == "/dev/null" {
                    DiffFileTag(text: "NOVO", tone: .mint)
                } else if file.newPath == "/dev/null" {
                    DiffFileTag(text: "REMOVIDO", tone: .rose)
                }

                Spacer()

                if !file.isBinary {
                    Text("+\(file.added)")
                        .font(ForgeType.monoSmall)
                        .foregroundStyle(Color.tone(.mint))
                    Text("−\(file.deleted)")
                        .font(ForgeType.monoSmall)
                        .foregroundStyle(Color.tone(.rose))
                }
            }

            if file.isBinary {
                HStack(spacing: 6) {
                    Image(systemName: "doc.fill")
                        .forgeIcon(.small)
                    Text("Arquivo binário — sem hunks de texto")
                        .font(ForgeType.caption)
                }
                .foregroundStyle(.secondary)
            } else if file.hunks.isEmpty {
                Text("Sem alterações de conteúdo (rename puro)")
                    .font(ForgeType.caption)
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(file.hunks.enumerated()), id: \.offset) { _, hunk in
                        DiffHunkView(hunk: hunk)
                    }
                }
            }
        }
        .padding(14)
        .forgeSurface(.raised)
    }
}

private struct DiffFileTag: View {
    let text: String
    let tone: ForgeTone

    var body: some View {
        Text(text)
            .font(ForgeType.micro)
            .foregroundStyle(Color.tone(tone))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .forgeSurface(.raised, in: Capsule(), tint: tone, tintStrength: 0.6)
    }
}

// MARK: - One hunk

private struct DiffHunkView: View {
    let hunk: DiffHunk

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("@@ -\(hunk.oldStart),\(hunk.oldCount) +\(hunk.newStart),\(hunk.newCount) @@\(hunk.header.isEmpty ? "" : " \(hunk.header)")")
                .font(ForgeType.monoSmall)
                .foregroundStyle(.tertiary)

            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(hunk.lines.enumerated()), id: \.offset) { _, line in
                    DiffLineRow(line: line)
                }
            }
        }
    }
}

// MARK: - One line — background says the type, Splash says the syntax

private struct DiffLineRow: View {
    let line: DiffLine

    var body: some View {
        switch line {
        case .context(let text):
            row(text: text, background: nil)
        case .added(let text):
            row(text: text, background: .mint)
        case .removed(let text):
            row(text: text, background: .rose)
        case .noNewline:
            Text("\\ No newline at end of file")
                .font(ForgeType.monoSmall)
                .foregroundStyle(.tertiary)
        }
    }

    private func row(text: String, background: ForgeTone?) -> some View {
        Text(DiffHighlighter.attributedString(for: text))
            .font(ForgeType.mono)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 4)
            .background(background.map { Color.tone($0).opacity(0.16) })
    }
}

// MARK: - Splash, instantiated once

/// One highlighter for the whole view hierarchy, not one per line. `SyntaxHighlighter` rebuilds
/// its theme on `init`; doing that inside every `DiffLineRow.body` would redo the setup on every
/// scroll frame of a diff with hundreds of lines (S05-PLAN § Forma da tela).
///
/// Splash highlights Swift. A non-Swift line simply comes back with no colour spans — the text
/// still renders, in the mono font, unhighlighted; it never disappears and never errors.
enum DiffHighlighter {
    private static let highlighter = SyntaxHighlighter(
        format: AttributedStringOutputFormat(
            theme: Theme.sundellsColors(withFont: Splash.Font(size: 11))
        )
    )

    static func attributedString(for line: String) -> AttributedString {
        let ns = highlighter.highlight(line)
        return (try? AttributedString(ns, including: AttributeScopes.AppKitAttributes.self))
            ?? AttributedString(line)
    }
}

// MARK: - Empty state

private struct DiffEmptyState: View {
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "checkmark.circle")
                .forgeIcon(.hero)
                .foregroundStyle(.secondary)
            Text("Sem mudanças neste range")
                .font(ForgeType.title)
            Text("O diff não trouxe nenhum arquivo alterado.")
                .font(ForgeType.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(28)
        .forgeSurface(.panel)
    }
}
