import Foundation

/// Parser puro do artefato de review dialético/flags (`S##-REVIEW.md`).
///
/// O gerador (`shared/forge-review.md` § Step 6) produz DUAS formas de item, e
/// as duas são reais — não uma "forma canônica + variante rara":
///
///   - **Heading**, usada em `## Abertas` e `## Concedidas`: `### R8 — \`path:line\`
///     — **[severidade]**` seguido de bullets nomeados (`Objeção`, `Defesa`, …),
///     com continuação indentada quando o corpo passa de uma linha.
///   - **Bullet plano**, usada em `## Resolvidas no debate`: `- R1 \`path:line\`
///     — texto`, sem heading e sem campos nomeados — o texto inteiro é a
///     objeção e o único turno é do challenger.
///
/// Medido em `S05-PLAN.md § Medido no planning`: um parser que só entenda
/// `### R` devolve **zero** objeções para uma slice inteira cujo review só
/// tem itens resolvidos (S02, 0 headings) e perde 3 de 15 objeções na slice
/// que mistura as duas formas (S01). Um parser linha-a-linha ingênuo que não
/// junte continuação trunca todo corpo multi-linha (S03, S04).
///
/// Puro por desenho: `String` entra, `ReviewDoc` sai — sem tocar disco,
/// variável de ambiente ou processo. Quem lê o arquivo é o chamador.
public enum ReviewStatus: String, Hashable {
    case open, conceded, resolved
}

/// Um turno do diálogo, na ordem em que o artefato o registra.
public enum ReviewTurn: Hashable {
    case challenger(String)   // Objeção, Réplica
    case advocate(String)     // Defesa, Correção
    case open(String)         // Decisão ainda não resolvida / deferida
}

public struct ReviewObjection: Hashable {
    public let id: String        // "R8"
    public let path: String?     // "app/Sources/Forge/RouteResolver.swift"
    public let line: Int?        // 96
    public let severity: String? // "low" | "critical" | nil
    public let status: ReviewStatus
    public let objection: String
    public let defense: String?
    public let rebuttal: String?
    public let decision: String?
    public let correction: String?
    public let turns: [ReviewTurn]
}

public struct ReviewHeader: Hashable {
    public let sliceId: String?
    public let milestone: String?
    public let reviewed: String?
    public let rounds: Int?
    public let challenger: String?
    public let defender: String?
    public let outcome: String?   // linha crua "3 resolved · 11 conceded · 1 open"
    public let diffScope: String?
}

public struct ReviewDoc: Hashable {
    public let header: ReviewHeader
    public let objections: [ReviewObjection]

    public func objections(_ status: ReviewStatus) -> [ReviewObjection] {
        objections.filter { $0.status == status }
    }
}

public enum ReviewParser {
    public static func parse(_ text: String) -> ReviewDoc {
        let lines = text.components(separatedBy: "\n")
        let header = parseHeader(lines)
        let objections = parseObjections(lines)
        return ReviewDoc(header: header, objections: objections)
    }

    // MARK: - Header

    private static let boldFieldRegex = try! NSRegularExpression(pattern: "\\*\\*([^*]+):\\*\\*")

    /// Devolve os pares (chave, valor) de campos `**Chave:** valor` de uma
    /// linha — vários por linha quando o cabeçalho os empilha (Slice,
    /// Milestone, Reviewed, Rounds na mesma linha).
    private static func boldFields(in line: String) -> [(key: String, value: String)] {
        let ns = line as NSString
        let matches = boldFieldRegex.matches(in: line, range: NSRange(location: 0, length: ns.length))
        guard !matches.isEmpty else { return [] }
        var out: [(String, String)] = []
        for (i, m) in matches.enumerated() {
            let key = ns.substring(with: m.range(at: 1)).trimmingCharacters(in: .whitespaces)
            let valueStart = m.range.location + m.range.length
            let valueEnd = i + 1 < matches.count ? matches[i + 1].range.location : ns.length
            guard valueEnd > valueStart else { out.append((key, "")); continue }
            let value = ns.substring(with: NSRange(location: valueStart, length: valueEnd - valueStart))
                .trimmingCharacters(in: .whitespaces)
            out.append((key, value))
        }
        return out
    }

    private static func parseHeader(_ lines: [String]) -> ReviewHeader {
        var sliceId: String?, milestone: String?, reviewed: String?, rounds: Int?
        var challenger: String?, defender: String?, outcome: String?, diffScope: String?

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("## ") { break }
            for (key, value) in boldFields(in: line) {
                switch key {
                case "Slice": sliceId = value
                case "Milestone": milestone = value
                case "Reviewed": reviewed = value
                case "Rounds":
                    let digits = value.prefix { $0.isNumber }
                    rounds = Int(digits)
                case "Challenger": challenger = value
                case "Defender": defender = value
                case "Outcome": outcome = value
                case "Escopo do diff": diffScope = value
                default: break
                }
            }
        }
        return ReviewHeader(sliceId: sliceId, milestone: milestone, reviewed: reviewed, rounds: rounds,
                             challenger: challenger, defender: defender, outcome: outcome, diffScope: diffScope)
    }

    // MARK: - Objections

    private static let formAHeadingRegex = try! NSRegularExpression(
        pattern: "^###\\s+(R\\d+)(?:\\s+—\\s+`([^`]+)`)?(?:\\s+—\\s+\\*\\*\\[([^\\]]+)\\]\\*\\*)?"
    )
    private static let formBBulletRegex = try! NSRegularExpression(
        pattern: "^-\\s+(R\\d+)\\s+`([^`]+)`\\s+—\\s+(?:\\*\\*\\[([^\\]]+)\\]\\*\\*\\s+)?(.*)$"
    )
    private static let bulletKeyRegex = try! NSRegularExpression(pattern: "^-\\s+\\*\\*([^*]+):\\*\\*\\s*(.*)$")
    private static let pathLineRegex = try! NSRegularExpression(pattern: "^(.*):(\\d+)$")

    private static func splitPathLine(_ raw: String?) -> (String?, Int?) {
        guard let raw = raw else { return (nil, nil) }
        let ns = raw as NSString
        guard let m = pathLineRegex.firstMatch(in: raw, range: NSRange(location: 0, length: ns.length)) else {
            return (raw, nil)
        }
        let path = ns.substring(with: m.range(at: 1))
        let line = Int(ns.substring(with: m.range(at: 2)))
        return (path, line)
    }

    private static func parseObjections(_ lines: [String]) -> [ReviewObjection] {
        var objections: [ReviewObjection] = []
        var status: ReviewStatus?
        var i = 0
        while i < lines.count {
            let raw = lines[i]
            let trimmed = raw.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("## ") {
                let heading = String(trimmed.dropFirst(3))
                if heading.hasPrefix("Abertas") { status = .open }
                else if heading.hasPrefix("Concedidas") { status = .conceded }
                else if heading.hasPrefix("Resolvidas") { status = .resolved }
                else { status = nil }
                i += 1
                continue
            }

            guard let currentStatus = status else { i += 1; continue }

            if trimmed.hasPrefix("### R") {
                let (objection, consumed) = parseFormA(lines: lines, startIndex: i, status: currentStatus)
                if let objection = objection { objections.append(objection) }
                i += consumed
                continue
            }

            if trimmed.hasPrefix("- R"), isFormB(trimmed) {
                let (objection, consumed) = parseFormB(lines: lines, startIndex: i, status: currentStatus)
                if let objection = objection { objections.append(objection) }
                i += consumed
                continue
            }

            i += 1
        }
        return objections
    }

    private static func isFormB(_ line: String) -> Bool {
        let ns = line as NSString
        return formBBulletRegex.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) != nil
    }

    /// Consome o bullet `- R# \`path:line\` — texto` de Form B e as linhas de
    /// continuação indentadas que o seguem, parando na primeira linha em
    /// branco, heading, ou próximo item `- R…` de topo (não indentado).
    /// Devolve a objeção (ou nil se o bullet inicial não casar) e quantas
    /// linhas foram consumidas a partir de `startIndex` — sem isso, um item
    /// flat que a Forge quebra em várias linhas (o formato real que
    /// `S02-REVIEW.md`/`S04-REVIEW.md` produzem) perde tudo além da
    /// primeira.
    private static func parseFormB(lines: [String], startIndex: Int, status: ReviewStatus) -> (ReviewObjection?, Int) {
        let line = lines[startIndex].trimmingCharacters(in: .whitespaces)
        let ns = line as NSString
        guard let m = formBBulletRegex.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) else {
            return (nil, 1)
        }
        let id = ns.substring(with: m.range(at: 1))
        let pathLine = ns.substring(with: m.range(at: 2))
        let severity = m.range(at: 3).location != NSNotFound ? ns.substring(with: m.range(at: 3)) : nil
        var text = ns.substring(with: m.range(at: 4)).trimmingCharacters(in: .whitespaces)
        let (path, lineNum) = splitPathLine(pathLine)

        var j = startIndex + 1
        while j < lines.count {
            let rawLine = lines[j]
            let trimmedLine = rawLine.trimmingCharacters(in: .whitespaces)

            if trimmedLine.isEmpty { j += 1; break }
            if trimmedLine.hasPrefix("### ") || trimmedLine.hasPrefix("## ") { break }

            let isIndented = rawLine.hasPrefix(" ") || rawLine.hasPrefix("\t")
            if !isIndented { break }  // next top-level item (incl. another "- R…") ends this one

            if !trimmedLine.isEmpty {
                text += " " + trimmedLine
            }
            j += 1
        }

        let objection = ReviewObjection(
            id: id, path: path, line: lineNum, severity: severity, status: status,
            objection: text, defense: nil, rebuttal: nil, decision: nil, correction: nil,
            turns: [.challenger(text)]
        )
        return (objection, j - startIndex)
    }

    /// Consome a heading `### R#` e os bullets nomeados que a seguem, juntando
    /// continuações indentadas ao corpo do bullet corrente. Devolve a objeção
    /// (ou nil se a heading não trouxer um id reconhecível) e quantas linhas
    /// foram consumidas a partir de `startIndex`.
    private static func parseFormA(lines: [String], startIndex: Int, status: ReviewStatus) -> (ReviewObjection?, Int) {
        let headingLine = lines[startIndex].trimmingCharacters(in: .whitespaces)
        let ns = headingLine as NSString
        guard let hm = formAHeadingRegex.firstMatch(in: headingLine, range: NSRange(location: 0, length: ns.length)) else {
            return (nil, 1)
        }
        let id = ns.substring(with: hm.range(at: 1))
        let pathLine = hm.range(at: 2).location != NSNotFound ? ns.substring(with: hm.range(at: 2)) : nil
        let severity = hm.range(at: 3).location != NSNotFound ? ns.substring(with: hm.range(at: 3)) : nil
        let (path, lineNum) = splitPathLine(pathLine)

        var objectionText = ""
        var defense: String?
        var rebuttal: String?
        var decision: String?
        var correction: String?
        var turns: [ReviewTurn] = []

        var currentKey: String?
        var currentText = ""

        func flush() {
            guard let key = currentKey else { return }
            let text = currentText.trimmingCharacters(in: .whitespaces)
            switch key {
            case "Objeção":
                objectionText = text
                turns.append(.challenger(text))
            case "Defesa":
                defense = text
                turns.append(.advocate(text))
            case "Réplica":
                rebuttal = text
                turns.append(.challenger(text))
            case "Correção":
                correction = text
                turns.append(.advocate(text))
            case "Decisão":
                decision = text
                if status == .open { turns.append(.open(text)) }
            default:
                break // Ação sugerida, Medição do orquestrador, etc — ignorados por desenho
            }
        }

        var j = startIndex + 1
        while j < lines.count {
            let rawLine = lines[j]
            let trimmedLine = rawLine.trimmingCharacters(in: .whitespaces)

            if trimmedLine.isEmpty { j += 1; break }
            if trimmedLine.hasPrefix("### ") || trimmedLine.hasPrefix("## ") { break }

            let startsFlush = !rawLine.hasPrefix(" ") && !rawLine.hasPrefix("\t")
            if startsFlush, let bm = bulletMatch(rawLine) {
                flush()
                currentKey = bm.0
                currentText = bm.1
            } else if !trimmedLine.isEmpty {
                // continuação indentada (ou sub-bullet aninhado) do bullet corrente
                if currentText.isEmpty { currentText = trimmedLine } else { currentText += " " + trimmedLine }
            }
            j += 1
        }
        flush()

        let objection = ReviewObjection(
            id: id, path: path, line: lineNum, severity: severity, status: status,
            objection: objectionText, defense: defense, rebuttal: rebuttal,
            decision: decision, correction: correction, turns: turns
        )
        return (objection, j - startIndex)
    }

    private static func bulletMatch(_ line: String) -> (String, String)? {
        let ns = line as NSString
        guard let m = bulletKeyRegex.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) else {
            return nil
        }
        let key = ns.substring(with: m.range(at: 1)).trimmingCharacters(in: .whitespaces)
        let value = ns.substring(with: m.range(at: 2)).trimmingCharacters(in: .whitespaces)
        return (key, value)
    }
}
