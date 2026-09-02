import Foundation

/// Os dois parsers restantes do ROADMAP mais o localizador puro dos quatro
/// artefatos de um slice.
///
/// `VerificationReport` lê a tabela de `S##-VERIFICATION.md` (gerada por
/// `scripts/forge-verifier.js`) **por nome de coluna**, nunca por posição: o
/// gerador já mudou de versão uma vez (`v1.1` acrescentou Test-quality ao
/// doc-comment do arquivo) e um parser posicional quebraria silenciosamente
/// na próxima. Coluna esperada e ausente vira `.skipped`, nunca `.pass` — a
/// ausência de dado não pode se disfarçar de sucesso.
///
/// `FileAuditReport` lê a seção `## File Audit` de um `S##-SUMMARY.md`
/// inteiro, parando no próximo heading `## ` — inclusive `## File Audit
/// (cross-run)`, que é outra seção e não pode vazar conteúdo para esta. A
/// distinção que mais importa aqui: **seção ausente (`nil`) ≠ listas vazias
/// (`[]`)**. Um SUMMARY sem `## File Audit` nunca passou por auditoria; um
/// SUMMARY com a seção mas sem itens listados passou e não achou nada. Devolver
/// um relatório vazio para o primeiro caso é a definição de verde por vácuo.
///
/// `SliceArtifacts.paths` é composição pura de `String` — nunca toca disco.
/// Quem lê o arquivo (existência, conteúdo) é a view/host, não este tipo.

// MARK: - VerificationReport

public enum VerificationMark: String, Hashable {
    case pass, fail, skipped

    /// Lê uma célula de tabela (`✓`, `✗`, `—`) já trimada. Qualquer outra
    /// coisa — incluindo célula vazia ou coluna ausente — vira `.skipped`,
    /// nunca `.pass`: ausência de dado não é sucesso.
    static func from(cell: String?) -> VerificationMark {
        guard let cell = cell?.trimmingCharacters(in: .whitespaces) else { return .skipped }
        switch cell {
        case "✓": return .pass
        case "✗": return .fail
        default: return .skipped
        }
    }
}

public struct VerificationRow: Hashable {
    public let source: String
    public let path: String
    public let exists: VerificationMark
    public let substantive: VerificationMark
    public let wired: VerificationMark
    public let flags: [String]
}

public struct VerificationReport: Hashable {
    public let rows: [VerificationRow]

    public var failures: [VerificationRow] {
        rows.filter { $0.exists == .fail || $0.substantive == .fail || $0.wired == .fail }
    }

    public static func parse(_ text: String) -> VerificationReport {
        let lines = text.components(separatedBy: "\n")
        guard let headerIndex = lines.firstIndex(where: { isTableHeader($0) }) else {
            return VerificationReport(rows: [])
        }
        let headerCells = splitRow(lines[headerIndex])
        // `uniquingKeysWith` — a duplicated column heading must not crash this
        // parser: the first occurrence wins and every other column keeps its
        // documented contract (missing/changed column → `.skipped`, never a trap).
        let columnIndex = Dictionary(headerCells.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })

        var rows: [VerificationRow] = []
        var i = headerIndex + 1
        // linha separadora `|---|---|...|` — pula se presente
        if i < lines.count, isSeparatorRow(lines[i]) { i += 1 }

        while i < lines.count {
            let raw = lines[i]
            let trimmed = raw.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("|") else { break }
            let cells = splitRow(raw)
            guard cells.count >= 2, !isSeparatorRow(raw) else { i += 1; continue }

            func cell(_ column: String) -> String? {
                guard let idx = columnIndex[column], idx < cells.count else { return nil }
                return cells[idx]
            }

            let source = cell("Source") ?? ""
            let path = cell("Artifact") ?? ""
            let exists = VerificationMark.from(cell: cell("Exists"))
            let substantive = VerificationMark.from(cell: cell("Substantive"))
            let wired = VerificationMark.from(cell: cell("Wired"))
            let flags = extractBacktickedFlags(cell("Flags"))

            rows.append(VerificationRow(
                source: source, path: path, exists: exists,
                substantive: substantive, wired: wired, flags: flags
            ))
            i += 1
        }
        return VerificationReport(rows: rows)
    }

    private static func isTableHeader(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.hasPrefix("| Source") || trimmed.hasPrefix("|Source")
    }

    private static func isSeparatorRow(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("|") else { return false }
        let stripped = trimmed.replacingOccurrences(of: "|", with: "")
            .replacingOccurrences(of: "-", with: "")
            .replacingOccurrences(of: ":", with: "")
            .trimmingCharacters(in: .whitespaces)
        return stripped.isEmpty
    }

    /// Divide uma linha de tabela markdown `| a | b | c |` em células trimadas,
    /// descartando os elementos vazios que sobram das barras externas.
    private static func splitRow(_ line: String) -> [String] {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        var body = trimmed
        if body.hasPrefix("|") { body.removeFirst() }
        if body.hasSuffix("|") { body.removeLast() }
        return body.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// Extrai o conteúdo entre crases de uma célula `Flags` (`` `wired: non_js_ts` ``
    /// → `"wired: non_js_ts"`). Célula vazia ou sem crases → `[]`.
    private static func extractBacktickedFlags(_ cell: String?) -> [String] {
        guard let cell = cell, !cell.isEmpty else { return [] }
        var flags: [String] = []
        var current = ""
        var inBackticks = false
        for ch in cell {
            if ch == "`" {
                if inBackticks {
                    flags.append(current)
                    current = ""
                }
                inBackticks.toggle()
            } else if inBackticks {
                current.append(ch)
            }
        }
        return flags
    }
}

// MARK: - FileAuditReport

public struct FileAuditReport: Hashable {
    /// A linha `**Compared:** …` crua — o número dela é a única prova de que
    /// houve comparação.
    public let compared: String?
    public let unexpected: [String]
    public let missing: [String]

    /// Extrai apenas a seção `## File Audit` (heading exato — não casa
    /// `## File Audit (cross-run)`) de um `S##-SUMMARY.md` inteiro, parando
    /// no próximo heading `## `. `nil` quando a seção não existe: ausência de
    /// seção não é auditoria limpa.
    public static func parse(_ summaryText: String) -> FileAuditReport? {
        let lines = summaryText.components(separatedBy: "\n")
        guard let start = lines.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "## File Audit" }) else {
            return nil
        }

        var end = lines.count
        var i = start + 1
        while i < lines.count {
            let trimmed = lines[i].trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("## ") { end = i; break }
            i += 1
        }
        let section = lines[start..<end]

        var compared: String?
        var unexpected: [String] = []
        var missing: [String] = []
        var currentList: Int = 0   // 0 = none, 1 = unexpected, 2 = missing

        for line in section {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("**Compared:**") {
                compared = trimmed
                currentList = 0
                continue
            }
            if trimmed.hasPrefix("**Unexpected") {
                currentList = 1
                continue
            }
            if trimmed.hasPrefix("**Missing") {
                currentList = 2
                continue
            }
            // Any other bold label (`**Housekeeping commits…:**`) or Markdown
            // heading ends the Unexpected/Missing block — only bullets that sit
            // directly under one of those two labels may be collected. Without
            // this, a later unrelated bullet list inside `## File Audit` gets
            // appended to whichever list was last opened, and a clean audit
            // (`**Missing…:** None.` followed by an unrelated bulleted list)
            // renders as failures.
            if trimmed.hasPrefix("**") || trimmed.hasPrefix("#") {
                currentList = 0
                continue
            }
            if trimmed.hasPrefix("- ") {
                let path = extractBacktickedPath(trimmed) ?? String(trimmed.dropFirst(2))
                if currentList == 1 { unexpected.append(path) }
                else if currentList == 2 { missing.append(path) }
                continue
            }
            if trimmed.isEmpty { continue }
        }

        return FileAuditReport(compared: compared, unexpected: unexpected, missing: missing)
    }

    /// Extrai o caminho entre crases de um item de lista
    /// (`` - `path/to/file.swift` (comentário) `` → `"path/to/file.swift"`),
    /// descartando o comentário entre parênteses. `nil` se não houver crases.
    private static func extractBacktickedPath(_ line: String) -> String? {
        guard let firstTick = line.firstIndex(of: "`") else { return nil }
        let rest = line[line.index(after: firstTick)...]
        guard let secondTick = rest.firstIndex(of: "`") else { return nil }
        return String(rest[rest.startIndex..<secondTick])
    }
}

// MARK: - SliceArtifacts

public enum SliceArtifacts {
    public struct Paths: Hashable {
        public let review: String
        public let verification: String
        public let summary: String
        public let plan: String
    }

    /// Composição pura de String: `<milestoneDir>/slices/<slice>/<slice>-{REVIEW,VERIFICATION,SUMMARY,PLAN}.md`.
    /// Nunca toca disco — quem verifica existência é o chamador.
    public static func paths(milestoneDir: String, slice: String) -> Paths {
        let base = "\(milestoneDir)/slices/\(slice)/\(slice)"
        return Paths(
            review: "\(base)-REVIEW.md",
            verification: "\(base)-VERIFICATION.md",
            summary: "\(base)-SUMMARY.md",
            plan: "\(base)-PLAN.md"
        )
    }
}
