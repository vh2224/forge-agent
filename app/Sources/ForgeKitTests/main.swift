// ForgeKitTests — contract tests for the pure logic in ForgeKit.
//
// Uses the project's own harness rather than XCTest: XCTest ships with full
// Xcode, not with the Command Line Tools this repo builds against, and every
// JS suite here already follows the same exit-0/exit-1 shape.
//
// Run: swift run ForgeKitTests   (from app/), or via scripts/forge-app.test.js

import Foundation
import ForgeKit
// Only for asserting that the SF Symbol names ForgeKit hands the view actually
// resolve. ForgeKit itself carries no AppKit/SwiftUI — a symbol name is data,
// but an INVALID one renders as a blank square, and checking that is the one
// thing that needs the real symbol set rather than the type system.
import AppKit

var passed = 0
var failed = 0
var failures: [(String, String)] = []
var current = ""

func test(_ name: String, _ body: () throws -> Void) {
    current = name
    do {
        try body()
        passed += 1
        print("  ✓ \(name)")
    } catch let e as Failure {
        failed += 1
        failures.append((name, e.message))
        print("  ✗ \(name)")
        print("      \(e.message)")
    } catch {
        failed += 1
        failures.append((name, "\(error)"))
        print("  ✗ \(name)")
    }
}

struct Failure: Error { let message: String }

func assertTrue(_ c: Bool, _ msg: String = "esperado true") {
    if !c { failures.append((current, msg)); failed += 1; print("  ✗ \(current)\n      \(msg)") }
}
func assertFalse(_ c: Bool, _ msg: String = "esperado false") { assertTrue(!c, msg) }
func assertEqual<T: Equatable>(_ a: T, _ b: T, _ msg: String = "") {
    if a != b {
        let m = "\(msg)\n     esperado: \(b)\n     obtido:   \(a)"
        failures.append((current, m)); failed += 1; print("  ✗ \(current)\n      \(m)")
    }
}
func assertGreater<T: Comparable>(_ a: T, _ b: T, _ msg: String = "") {
    if !(a > b) { failures.append((current, msg)); failed += 1; print("  ✗ \(current)\n      \(msg)") }
}
func assertLessOrEqual<T: Comparable>(_ a: T, _ b: T, _ msg: String = "") {
    if !(a <= b) {
        let m = "\(msg)\n     esperado <= \(b)\n     obtido:    \(a)"
        failures.append((current, m)); failed += 1; print("  ✗ \(current)\n      \(m)")
    }
}
func assertNil<T>(_ v: T?, _ msg: String = "esperado nil") {
    if v != nil {
        let m = "\(msg)\n     obtido: \(String(describing: v))"
        failures.append((current, m)); failed += 1; print("  ✗ \(current)\n      \(m)")
    }
}
func assertNoThrow(_ body: () throws -> Void, _ msg: String = "") {
    do { try body() } catch {
        failures.append((current, msg)); failed += 1; print("  ✗ \(current)\n      \(msg)")
    }
}

print("\n=== ForgeKit — contract test suite ===\n")
print("PrefsEdit (escreve na config real do usuário)")

// PrefsEditTests — the code that writes to the user's real preferences file.
//
// This is the only place in the app that mutates a file the user owns and
// cannot regenerate. The scaffolded forge-agent-prefs.jsonc is ~450 lines of
// commented documentation with a handful of live assignments, so the risks are
// specific and worth pinning down:
//   - hitting a COMMENTED example instead of the real assignment
//   - hitting a same-named leaf in the WRONG section
//   - destroying comments while editing
// Each of those has a test below.

import Foundation
import ForgeKit


/// Shaped like the real scaffold: a commented example far above the live value.
let scaffold = """
{
  // ── repo_path ───────────────────────────────────────────
  // Caminho do repositório do Forge (dev/dogfood).
  // "repo_path": "",

  // ── review ──────────────────────────────────────────────
  // "review": { "challenger": "claude" },

  "review": {
    "challenger": "codex"
  },
  "repo_path": "/Users/dev/forge-agent",
  "tier_models": {
    "heavy": "claude-opus-5"
  }
}
"""

// MARK: - The commented-line trap

test("testIgnoresCommentedAssignment") {
    let out = PrefsEdit.upsert(scaffold, path: ["repo_path"], value: .string("/novo"))
    assertTrue(out.contains("\"repo_path\": \"/novo\""), "deve escrever o valor novo")
    assertTrue(out.contains("// \"repo_path\": \"\","),
                  "a linha COMENTADA deve permanecer intacta")
    // Exactly one live assignment — not two.
    let live = out.split(separator: "\n").filter {
        PrefsEdit.isAssignment(String($0), key: "repo_path")
    }
    assertEqual(live.count, 1, "não pode duplicar a chave")
}

test("testIsAssignmentRejectsComments") {
    assertFalse(PrefsEdit.isAssignment("  // \"repo_path\": \"\",", key: "repo_path"))
    assertFalse(PrefsEdit.isAssignment("  # repo_path: x", key: "repo_path"))
    assertFalse(PrefsEdit.isAssignment("  // ── repo_path ──", key: "repo_path"))
    assertTrue(PrefsEdit.isAssignment("  \"repo_path\": \"/x\",", key: "repo_path"))
}

test("testIsAssignmentRejectsPrefixCollision") {
    // "repo_path_extra" must not satisfy a lookup for "repo_path".
    assertFalse(PrefsEdit.isAssignment("  \"repo_path_extra\": 1,", key: "repo_path"))
    // Nor a mere mention inside a string value.
    assertFalse(PrefsEdit.isAssignment("  \"note\": \"veja repo_path\",", key: "repo_path"))
}

// MARK: - Comments must survive

test("testCommentsPreserved") {
    let out = PrefsEdit.upsert(scaffold, path: ["review", "challenger"], value: .string("gemini"))
    for marker in ["// ── repo_path ─", "// ── review ─",
                   "// Caminho do repositório do Forge (dev/dogfood).",
                   "// \"review\": { \"challenger\": \"claude\" },"] {
        assertTrue(out.contains(marker), "comentário perdido: \(marker)")
    }
}

test("testUnrelatedLinesByteIdentical") {
    let out = PrefsEdit.upsert(scaffold, path: ["review", "challenger"], value: .string("gemini"))
    let before = scaffold.components(separatedBy: "\n")
    let after = out.components(separatedBy: "\n")
    assertEqual(before.count, after.count, "não deve inserir nem remover linhas")
    let changed = zip(before, after).filter { $0 != $1 }
    assertEqual(changed.count, 1, "exatamente uma linha muda")
    assertTrue(changed.first?.1.contains("gemini") == true)
}

// MARK: - Nested keys

test("testNestedReplaceStaysInItsSection") {
    // Same leaf name in two sections: the edit must land in the right one.
    let doc = """
    {
      "review": {
        "mode": "enabled"
      },
      "plan_check": {
        "mode": "advisory"
      }
    }
    """
    let out = PrefsEdit.upsert(doc, path: ["plan_check", "mode"], value: .string("blocking"))
    assertTrue(out.contains("\"mode\": \"blocking\""))
    assertTrue(out.contains("\"mode\": \"enabled\""), "a seção review não pode ser tocada")

    // And the blocking value must be inside plan_check, not review.
    let lines = out.components(separatedBy: "\n")
    let planIdx = lines.firstIndex { $0.contains("\"plan_check\"") }!
    let blockingIdx = lines.firstIndex { $0.contains("blocking") }!
    assertGreater(blockingIdx, planIdx, "valor foi para a seção errada")
}

test("testNestedInsertIntoExistingSection") {
    let doc = """
    {
      "review": {
        "mode": "enabled"
      }
    }
    """
    let out = PrefsEdit.upsert(doc, path: ["review", "ask_in_auto"], value: .string("gate"))
    assertTrue(out.contains("\"ask_in_auto\": \"gate\","))
    assertTrue(out.contains("\"mode\": \"enabled\""), "irmão preservado")
}

test("testNestedCreatesMissingSection") {
    let out = PrefsEdit.upsert("{\n}", path: ["review", "ask_in_auto"], value: .string("gate"))
    assertTrue(out.contains("\"review\""))
    assertTrue(out.contains("\"ask_in_auto\": \"gate\""))
}

// MARK: - Removal

test("testNullRemovesKey") {
    let out = PrefsEdit.upsert(scaffold, path: ["repo_path"], value: .null)
    let live = out.split(separator: "\n").filter {
        PrefsEdit.isAssignment(String($0), key: "repo_path")
    }
    assertEqual(live.count, 0, "a atribuição real deve sumir")
    assertTrue(out.contains("// \"repo_path\": \"\","), "o comentário permanece")
}

test("testNullOnMissingSectionIsNoOp") {
    let doc = "{\n  \"a\": 1\n}"
    assertEqual(PrefsEdit.upsert(doc, path: ["nope", "x"], value: .null), doc)
}

// MARK: - Formatting

test("testPreservesTrailingComma") {
    let doc = "{\n  \"a\": 1,\n  \"b\": 2\n}"
    let withComma = PrefsEdit.upsert(doc, path: ["a"], value: .number(9))
    assertTrue(withComma.contains("\"a\": 9,"), "vírgula mantida")
    let withoutComma = PrefsEdit.upsert(doc, path: ["b"], value: .number(9))
    assertTrue(withoutComma.contains("\"b\": 9"))
    assertFalse(withoutComma.contains("\"b\": 9,"), "não pode inventar vírgula")
}

test("testPreservesIndentation") {
    let doc = "{\n      \"deep\": 1\n}"
    let out = PrefsEdit.upsert(doc, path: ["deep"], value: .number(2))
    assertTrue(out.contains("      \"deep\": 2"), "indentação original mantida")
}

test("testDeeperThanTwoLevelsIsNoOp") {
    // Not supported by design — must leave the document untouched rather
    // than write something wrong.
    let doc = "{\n  \"a\": { \"b\": { \"c\": 1 } }\n}"
    assertEqual(PrefsEdit.upsert(doc, path: ["a", "b", "c"], value: .number(2)), doc)
}

// MARK: - Encoding

test("testEncodeTypes") {
    assertEqual(PrefsEdit.encode(.bool(true)), "true")
    assertEqual(PrefsEdit.encode(.number(30)), "30")
    assertEqual(PrefsEdit.encode(.number(1.5)), "1.5")
    assertEqual(PrefsEdit.encode(.null), "null")
    assertEqual(PrefsEdit.encode(.string("x")), "\"x\"")
    assertEqual(PrefsEdit.encode(.array([.string("a"), .number(1)])), "[\"a\", 1]")
}

test("testEncodeEscapesQuotes") {
    assertEqual(PrefsEdit.encode(.string("diz \"oi\"")), "\"diz \\\"oi\\\"\"")
}

/// Whatever comes out must still parse once comments are stripped —
/// otherwise a save silently corrupts the file for every engine that
/// reads it.
test("testResultStillParsesAsJSON") {
    var doc = scaffold
    doc = PrefsEdit.upsert(doc, path: ["review", "ask_in_auto"], value: .string("gate"))
    doc = PrefsEdit.upsert(doc, path: ["repo_path"], value: .string("/outro"))
    doc = PrefsEdit.upsert(doc, path: ["auto_push"], value: .bool(true))

    let stripped = doc.components(separatedBy: "\n")
        .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
        .joined(separator: "\n")
    assertNoThrow({ _ = try JSONSerialization.jsonObject(with: Data(stripped.utf8)) }, "documento resultante não é JSON válido:\n\(stripped)")
}

test("testRepeatedEditsAreIdempotent") {
    let once = PrefsEdit.upsert(scaffold, path: ["review", "challenger"], value: .string("gemini"))
    let twice = PrefsEdit.upsert(once, path: ["review", "challenger"], value: .string("gemini"))
    assertEqual(once, twice, "reescrever o mesmo valor não pode mudar o arquivo")
}

test("chave nova entra junto do próprio comentário") {
    // The scaffold documents every knob; a value dropped at the top of the file
    // sits orphaned while its comment block still shows the default.
    let doc = """
    {
      "$schema": "x",
      // ── main_branch ─────────────────
      // Nome da branch principal.
      // "main_branch": "master",
      // ── auto_push ───────────────────
      // "auto_push": false,
    }
    """
    let out = PrefsEdit.upsert(doc, path: ["main_branch"], value: .string("main"))
    let lines = out.components(separatedBy: "\n")
    let commented = lines.firstIndex { $0.contains("// \"main_branch\"") }!
    let live = lines.firstIndex { PrefsEdit.isAssignment($0, key: "main_branch") }!
    assertEqual(live, commented + 1, "valor deve ficar logo abaixo do comentário que o explica")
    assertTrue(lines.firstIndex { $0.contains("auto_push") }! > live,
               "não pode invadir a seção seguinte")
}

test("sem comentário correspondente, cai no topo") {
    let out = PrefsEdit.upsert("{\n  \"a\": 1\n}", path: ["novo"], value: .bool(true))
    let lines = out.components(separatedBy: "\n")
    assertEqual(lines.firstIndex { $0.contains("novo") }, 1)
}

test("cabeçalho de seção não é confundido com atribuição comentada") {
    assertFalse(PrefsEdit.isCommentedAssignment("  // ── main_branch ───", key: "main_branch"))
    assertTrue(PrefsEdit.isCommentedAssignment("  // \"main_branch\": \"master\",", key: "main_branch"))
}

print("\nPrefsLocator (achou o repo errado uma vez)")

test("parseRepoPath ignora a linha comentada do scaffold") {
    // Shape of the real file: a commented example ~400 lines above the live one.
    let doc = """
    {
      // ── repo_path ─────────────────────
      // "repo_path": "",
      "review": { "challenger": "codex" },
      "repo_path": "/Users/dev/forge-agent"
    }
    """
    assertEqual(PrefsLocator.parseRepoPath(doc), "/Users/dev/forge-agent")
}

test("parseRepoPath retorna nil quando só há comentário") {
    let doc = "{\n  // \"repo_path\": \"/nao/usar\",\n}"
    assertEqual(PrefsLocator.parseRepoPath(doc), nil)
}

test("parseRepoPath tira comentário de fim de linha") {
    let doc = "{\n  \"repo_path\": \"/x\", // dogfood\n}"
    assertEqual(PrefsLocator.parseRepoPath(doc), "/x")
}

test("parseRepoPath aceita a forma sem aspas") {
    // Tolerated by the parser, but only the JSONC/JSON files are ever read —
    // the legacy markdown format is deliberately not consulted.
    assertEqual(PrefsLocator.parseRepoPath("repo_path: /sem/aspas"), "/sem/aspas")
}

test("parseRepoPath usa a ÚLTIMA atribuição viva") {
    let doc = "{\n  \"repo_path\": \"/antigo\",\n  \"repo_path\": \"/novo\"\n}"
    assertEqual(PrefsLocator.parseRepoPath(doc), "/novo")
}

print("\nGit.parseWorktrees (decide se a atividade do projeto é contada)")

test("parseWorktrees lê o formato porcelain") {
    let out = """
    worktree /repo
    HEAD abc123
    branch refs/heads/main

    worktree /repo/.forge-worktrees/M008
    HEAD def456
    branch refs/heads/forge/M008

    """
    let w = Git.parseWorktrees(out)
    assertEqual(w.count, 2)
    assertEqual(w[0].path, "/repo")
    assertEqual(w[0].branch, "main")
    assertEqual(w[0].isPrimary, true)
    assertEqual(w[1].branch, "forge/M008")
    assertEqual(w[1].isPrimary, false)
    assertEqual(w[1].name, "M008")
}

test("parseWorktrees aceita HEAD destacado (sem branch)") {
    let out = "worktree /repo\nHEAD abc\ndetached\n"
    let w = Git.parseWorktrees(out)
    assertEqual(w.count, 1)
    assertEqual(w[0].branch, nil)
}

test("parseWorktrees pula repositório bare") {
    // A bare repo has no working tree — offering to open it would be a dead end.
    let out = "worktree /repo.git\nHEAD abc\nbare\n\nworktree /wt\nHEAD def\nbranch refs/heads/x\n"
    let w = Git.parseWorktrees(out)
    assertEqual(w.count, 1)
    assertEqual(w[0].path, "/wt")
    assertEqual(w[0].isPrimary, true, "o primeiro NÃO-bare vira o primário")
}

test("parseWorktrees devolve vazio para saída vazia") {
    assertEqual(Git.parseWorktrees("").count, 0)
}

print("\nModels")

test("gate pendente vira expirado ao passar do prazo") {
    let opt = GateOption(key: "a", label: "A", description: "")
    let g = Gate(id: "g", run_id: nil, unit_id: nil, origin: nil, cwd: nil,
                 question: "q", context: nil, options: [opt], default: "a",
                 status: "pending", answer: nil,
                 created_at: 0, expires_at: Date.nowMs - 1000)
    assertEqual(g.effectiveStatus, "expired")
    assertFalse(g.isPending)
}

test("gate sem prazo permanece pendente") {
    let opt = GateOption(key: "a", label: "A", description: "")
    let g = Gate(id: "g", run_id: nil, unit_id: nil, origin: nil, cwd: nil,
                 question: "q", context: nil, options: [opt], default: "a",
                 status: "pending", answer: nil, created_at: 0, expires_at: nil)
    assertEqual(g.effectiveStatus, "pending")
}

test("gate respondido nunca regride para expirado") {
    // The real race: the human answers as the clock runs out. A durable answer
    // must win over the deadline.
    let opt = GateOption(key: "a", label: "A", description: "")
    let g = Gate(id: "g", run_id: nil, unit_id: nil, origin: nil, cwd: nil,
                 question: "q", context: nil, options: [opt], default: "a",
                 status: "answered",
                 answer: GateAnswer(key: "a", label: "A", source: "human", notes: nil),
                 created_at: 0, expires_at: Date.nowMs - 1000)
    assertEqual(g.effectiveStatus, "answered")
}

test("Duration formata as faixas") {
    assertEqual(Duration.short(ms: 5000), "5s")
    assertEqual(Duration.short(ms: 120_000), "2min")
    assertEqual(Duration.short(ms: 5_400_000), "1.5h")
    assertEqual(Duration.short(ms: -1), "agora")
}

print("\nProjectDiscovery (a cópia local sombreava esta — código testado ≠ código rodado)")

test("scan acha projeto e continua descendo para aninhados") {
    let tmp = NSTemporaryDirectory() + "forge-disc-\(UUID().uuidString.prefix(6))"
    let fm = FileManager.default
    defer { try? fm.removeItem(atPath: tmp) }

    // ~/Development/repo/.gsd  and  ~/Development/repo/services/.gsd (monorepo).
    // `milestones/` is what makes each a project now — a bare `.gsd/` is only
    // evidence that a tool ran there (see ProjectMarker).
    for p in ["Development/repo/.gsd/milestones",
              "Development/repo/services/.gsd/milestones",
              "Development/plain/src",
              "Development/repo/node_modules/pkg/.gsd/milestones"] {
        try? fm.createDirectory(atPath: "\(tmp)/\(p)", withIntermediateDirectories: true)
    }

    // Compare by suffix: macOS canonicalises /var to /private/var, so the
    // returned paths never string-match the ones built here.
    let found = ProjectDiscovery.scan(home: tmp)
    func has(_ suffix: String) -> Bool { found.contains { $0.hasSuffix(suffix) } }

    assertTrue(has("/Development/repo"), "projeto raiz não encontrado")
    assertTrue(has("/Development/repo/services"),
               "projeto aninhado perdido — parar no primeiro acerto seria errado")
    assertFalse(has("/Development/plain"), "pasta sem .gsd não é projeto")
    assertFalse(found.contains { $0.contains("node_modules") },
                "node_modules deve ser pulado")
}

test("scan ignora raiz inexistente sem falhar") {
    let tmp = NSTemporaryDirectory() + "forge-disc-empty-\(UUID().uuidString.prefix(6))"
    try? FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    assertEqual(ProjectDiscovery.scan(home: tmp).count, 0)
}

test("scan não oferece diretório que só foi tocado por uma run") {
    // The measured defect: forge-verify.js wrote .gsd/forge/events.jsonl into
    // every repo it verified, and discovery read that as a project. Five of
    // eighteen registered projects were enrolled this way.
    let tmp = NSTemporaryDirectory() + "forge-disc-touch-\(UUID().uuidString.prefix(6))"
    let fm = FileManager.default
    defer { try? fm.removeItem(atPath: tmp) }
    try? fm.createDirectory(atPath: "\(tmp)/Development/repo/.gsd/forge",
                            withIntermediateDirectories: true)
    fm.createFile(atPath: "\(tmp)/Development/repo/.gsd/forge/events.jsonl",
                  contents: Data("{\"event\":\"verify\"}\n".utf8))

    assertEqual(ProjectDiscovery.scan(home: tmp).count, 0,
                "repo com só events.jsonl não é projeto")
}

print("\nProjectMarker (.gsd/ prova que uma ferramenta rodou, não que há trabalho)")

/// Builds `<tmp>/.gsd/` with the given entries; directories end in `/`.
func markerFixture(_ entries: [String: String?], line: Int = #line) -> String {
    let tmp = NSTemporaryDirectory() + "forge-mark-\(UUID().uuidString.prefix(8))"
    let fm = FileManager.default
    try? fm.createDirectory(atPath: "\(tmp)/.gsd", withIntermediateDirectories: true)
    for (name, body) in entries {
        let p = "\(tmp)/.gsd/\(name)"
        if let body {
            fm.createFile(atPath: p, contents: Data(body.utf8))
        } else {
            try? fm.createDirectory(atPath: p, withIntermediateDirectories: true)
        }
    }
    return tmp
}

test("sem .gsd/ é none") {
    let tmp = NSTemporaryDirectory() + "forge-mark-none-\(UUID().uuidString.prefix(6))"
    try? FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    assertEqual(ProjectMarker.classify(tmp).kind, .none)
}

test(".gsd/ só com runtime é touched, não projeto") {
    let tmp = markerFixture(["forge": nil, ".locks": nil])
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    let r = ProjectMarker.classify(tmp)
    assertEqual(r.kind, .touched)
    assertTrue(r.signals.isEmpty, "runtime não é sinal de trabalho")
}

test(".gsd/ vazio é touched — visível, não descartado") {
    let tmp = markerFixture([:])
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    assertEqual(ProjectMarker.classify(tmp).kind, .touched)
}

test("qualquer artefato de trabalho promove a projeto") {
    for artifact in ["milestones", "tasks", "items", "ledger", "memory", "decisions"] {
        let tmp = markerFixture(["forge": nil, artifact: nil])
        defer { try? FileManager.default.removeItem(atPath: tmp) }
        let r = ProjectMarker.classify(tmp)
        assertEqual(r.kind, .project, "\(artifact) deveria promover")
        assertTrue(r.signals.contains(artifact), "\(artifact) deveria aparecer nos sinais")
    }
}

test("STATE.md do dashboard não conta como trabalho") {
    // This is the whole `~/Development/.gsd` case: .locks/ plus a STATE.md the
    // dashboard rendered. Counting it would have kept the phantom alive.
    let tmp = markerFixture([
        ".locks": nil,
        "STATE.md": "<!-- AUTO-GENERATED by scripts/forge-dashboard.js — do not edit by hand -->\n\n# GSD Dashboard\n",
    ])
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    assertEqual(ProjectMarker.classify(tmp).kind, .touched)
}

test("STATE.md escrito à mão conta") {
    let tmp = markerFixture(["STATE.md": "# Estado\n\n**Active Milestone:** M001\n"])
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    let r = ProjectMarker.classify(tmp)
    assertEqual(r.kind, .project)
    assertTrue(r.signals.contains("STATE.md"))
}

test("projeto que contém outro projeto é workspace") {
    // lookchina: own milestones and tasks, and thirteen repos below it.
    let roles = ProjectMarker.roles([
        "/h/Development/lookchina",
        "/h/Development/lookchina/apps/odin",
        "/h/Development/lookchina/services/freyr",
        "/h/Development/message",
    ])
    assertEqual(roles["/h/Development/lookchina"], .workspace)
    assertEqual(roles["/h/Development/lookchina/apps/odin"], .project)
    assertEqual(roles["/h/Development/message"], .project,
                "projeto sozinho não vira workspace")
}

print("\nPrefKind (evita reescrever lista como string)")

test("array de strings vira editor de lista") {
    assertEqual(PrefKind.from(types: ["array"], hasEnum: false, itemsAreStrings: true), .stringList)
}

test("união string|array fica opaca") {
    // tier_models.heavy aceita as duas formas; escrever numa delas poderia
    // mudar o significado em silêncio.
    assertEqual(PrefKind.from(types: ["string", "array"], hasEnum: false, itemsAreStrings: true), .opaque)
}

test("object fica opaco") {
    assertEqual(PrefKind.from(types: ["object"], hasEnum: false, itemsAreStrings: false), .opaque)
}

test("enum vence o tipo base") {
    assertEqual(PrefKind.from(types: ["string"], hasEnum: true, itemsAreStrings: false), .choice)
}

test("tipos escalares") {
    assertEqual(PrefKind.from(types: ["boolean"], hasEnum: false, itemsAreStrings: false), .toggle)
    assertEqual(PrefKind.from(types: ["integer"], hasEnum: false, itemsAreStrings: false), .number)
    assertEqual(PrefKind.from(types: ["string"], hasEnum: false, itemsAreStrings: false), .text)
}

test("asStringArray só aceita array homogêneo de strings") {
    assertEqual(JSONValue.array([.string("a"), .string("b")]).asStringArray ?? [], ["a", "b"])
    assertTrue(JSONValue.array([.string("a"), .number(1)]).asStringArray == nil,
               "array misto não pode virar lista de strings")
    assertTrue(JSONValue.string("a").asStringArray == nil)
}

test("lista sobrevive ao round-trip como array, não como string") {
    // The regression this guards: editing a list used to write it back as one
    // comma-joined string.
    let list = JSONValue.array([.string("dist/**"), .string("build/**")])
    let doc = PrefsEdit.upsert("{\n}", path: ["file_audit", "ignore_list"], value: list)
    assertTrue(doc.contains("[\"dist/**\", \"build/**\"]"), "deve gravar como array: \(doc)")
    assertFalse(doc.contains("\"dist/**, build/**\""), "não pode virar string única")
}

print("\nPrefLabels (nome de máquina → texto humano)")

test("humanise converte snake_case") {
    assertEqual(PrefLabels.humanise("ask_in_auto"), "Ask in auto")
    assertEqual(PrefLabels.humanise("adaptive_flags_lines"), "Adaptive flags lines")
    assertEqual(PrefLabels.humanise("mode"), "Mode")
}

test("grupos conhecidos têm rótulo curado") {
    assertEqual(PrefLabels.group("review").title, "Revisão de código")
    assertEqual(PrefLabels.group("tier_models").title, "Modelos por tier")
    assertFalse(PrefLabels.group("review").blurb.isEmpty, "grupo curado deve explicar-se")
}

test("grupo desconhecido cai na humanização, não quebra") {
    // The schema keeps growing; a new group must render sanely with no edit here.
    assertEqual(PrefLabels.group("nova_secao_qualquer").title, "Nova secao qualquer")
}

test("duração vira legível") {
    assertEqual(PrefLabels.duration(ms: 1_800_000), "30 min")
    assertEqual(PrefLabels.duration(ms: 2000), "2s")
    assertEqual(PrefLabels.duration(ms: 3_600_000), "1h")
    assertEqual(PrefLabels.duration(ms: 500), "500 ms")
}

test("humanValue usa o sufixo da chave como unidade") {
    assertEqual(PrefLabels.humanValue(key: "gate_timeout_ms", value: .number(1_800_000)), "30 min")
    assertEqual(PrefLabels.humanValue(key: "adaptive_flags_lines", value: .number(40)), "40 linhas")
    // Thresholds appear both as fraction and percentage in this schema.
    assertEqual(PrefLabels.humanValue(key: "warning_threshold", value: .number(0.35)), "35%")
    assertEqual(PrefLabels.humanValue(key: "handoff_threshold", value: .number(90)), "90%")
}

test("humanValue não inventa unidade onde não há") {
    assertTrue(PrefLabels.humanValue(key: "mode", value: .string("advisory")) == nil)
    assertTrue(PrefLabels.humanValue(key: "rounds", value: .number(1)) == nil)
}

test("união escalar não vira número") {
    // compact_after is integer OR "unlimited"; treating it as a number showed 0
    // on screen and would have destroyed the sentinel on save.
    assertEqual(PrefKind.from(types: ["integer", "string"], hasEnum: false, itemsAreStrings: false),
                .scalarUnion)
}

test("scalar preserva sentinela e número") {
    assertEqual(PrefsEdit.scalar(from: "unlimited", allowsNumber: true), .string("unlimited"))
    assertEqual(PrefsEdit.scalar(from: "12", allowsNumber: true), .number(12))
    assertEqual(PrefsEdit.scalar(from: " 8 ", allowsNumber: true), .number(8))
    // Not a bare number → stays a string rather than becoming a lossy 5.
    assertEqual(PrefsEdit.scalar(from: "5x", allowsNumber: true), .string("5x"))
}

test("humanise não inverte a ordem das palavras") {
    // The Portuguese translation of single words produced "Automático commit".
    assertEqual(PrefLabels.humanise("auto_commit"), "Auto commit")
    assertEqual(PrefLabels.humanise("compact_after"), "Compact after")
}

print("\nModelChain (escalar OU cadeia — as duas formas são válidas no arquivo)")

test("lê as duas formas do disco") {
    assertEqual(ModelChain.from(.string("claude-opus-5")), .single("claude-opus-5"))
    assertEqual(ModelChain.from(.array([.string("a"), .string("b")])), .chain(["a", "b"]))
    assertTrue(ModelChain.from(.number(1)) == nil, "forma desconhecida não vira cadeia")
}

test("um item volta como escalar, vários como lista") {
    // Round-tripping a scalar into a one-item array would rewrite a file the
    // user authored by hand, for no gain.
    assertEqual(ModelChain.single("x").toValue(), .string("x"))
    assertEqual(ModelChain.chain(["x"]).toValue(), .string("x"))
    assertEqual(ModelChain.chain(["x", "y"]).toValue(), .array([.string("x"), .string("y")]))
}

test("entradas vazias são descartadas ao gravar") {
    assertEqual(ModelChain.chain(["x", "  ", "y"]).toValue(),
                .array([.string("x"), .string("y")]))
}

test("editar a cadeia") {
    let c = ModelChain.chain(["a", "b", "c"])
    assertEqual(c.replacing(at: 1, with: "z").ids, ["a", "z", "c"])
    assertEqual(c.removing(at: 0).ids, ["b", "c"])
    assertEqual(c.moved(from: 2, to: 0).ids, ["c", "a", "b"])
    assertEqual(c.appending("d").ids, ["a", "b", "c", "d"])
}

test("nunca remove o último modelo") {
    // An empty tier has no meaning — the engine would have nothing to dispatch.
    assertEqual(ModelChain.single("a").removing(at: 0).ids, ["a"])
}

test("índice inválido não corrompe a cadeia") {
    let c = ModelChain.chain(["a", "b"])
    assertEqual(c.replacing(at: 9, with: "z").ids, ["a", "b"])
    assertEqual(c.moved(from: 0, to: 9).ids, ["a", "b"])
}

print("\nRoutingReader (achata domain → phase → tier → cadeia)")

test("achata a estrutura aninhada") {
    let routing = JSONValue.object([
        "backend": .object([
            "executor": .object([
                "standard": .array([.string("gpt-5"), .string("claude-sonnet-5")]),
            ]),
        ]),
    ])
    let rows = RoutingReader.rows(from: routing)
    assertEqual(rows.count, 1)
    assertEqual(rows[0].domain, "backend")
    assertEqual(rows[0].phase, "executor")
    assertEqual(rows[0].tier, "standard")
    assertEqual(rows[0].chain, ["gpt-5", "claude-sonnet-5"])
}

test("aceita cadeia escalar e ignora o que não entende") {
    let routing = JSONValue.object([
        "default": .object([
            "planner": .object([
                "heavy": .string("claude-opus-5"),
                "vazio": .array([]),
            ]),
        ]),
        "lixo": .string("não é objeto"),
    ])
    let rows = RoutingReader.rows(from: routing)
    assertEqual(rows.count, 1)
    assertEqual(rows[0].chain, ["claude-opus-5"])
}

test("routing ausente devolve vazio") {
    assertEqual(RoutingReader.rows(from: nil).count, 0)
    assertEqual(RoutingReader.rows(from: .object([:])).count, 0)
}

print("\nClosedSets")

test("dashboard_refresh_on tem vocabulário fechado") {
    assertEqual(ClosedSets.options(forLeaf: "dashboard_refresh_on") ?? [],
                ["boot", "exit", "phase_change"])
    assertTrue(ClosedSets.options(forLeaf: "ignore_list") == nil,
               "lista aberta não pode virar checkbox")
}

print("\nProjectOrganiser (21 projetos aninhados não cabem numa lista plana)")

let sample = [
    "/h/Development",
    "/h/Development/message",
    "/h/Development/lookchina",
    "/h/Development/lookchina/services",
    "/h/Development/lookchina/services/asgard",
    "/h/Development/lookchina/services/loki",
    "/h/Development/lookchina/apps/odin",
]

test("agrupa pelo diretório pai") {
    let g = ProjectOrganiser.groups(sample, home: "/h")
    let titles = g.map(\.title)
    assertTrue(titles.contains("~/Development"), "faltou ~/Development: \(titles)")
    assertTrue(titles.contains("~/Development/lookchina/services"), "faltou services")
    let services = g.first { $0.title == "~/Development/lookchina/services" }!
    assertEqual(services.projects.map(ProjectOrganiser.name), ["asgard", "loki"])
}

test("grupos saem em ordem estável de caminho") {
    let a = ProjectOrganiser.groups(sample, home: "/h").map(\.path)
    let b = ProjectOrganiser.groups(sample.reversed(), home: "/h").map(\.path)
    assertEqual(a, b, "ordem não pode depender da ordem de entrada")
    assertEqual(a, a.sorted(), "pais ordenados por caminho")
}

test("detecta projeto que contém outros") {
    // A stray .gsd/ at the top of a code folder swallows everything below it,
    // and from a flat list that is invisible.
    let c = ProjectOrganiser.containment(sample)
    assertEqual(c["/h/Development"], 6, "Development contém todos os outros")
    assertEqual(c["/h/Development/lookchina"], 4)
    assertTrue(c["/h/Development/message"] == nil, "folha não contém nada")
}

// I-20260803154521 — the notice accused the workspace this milestone promoted.
//
// These exercise `ProjectOrganiser.containmentHazards`, which is the predicate
// the notice calls, but NOT the notice itself: `hazardNotice` is a SwiftUI view
// in the `Forge` executable target, which `ForgeKitTests` cannot import. What is
// proven here is the decision; that `Projects.swift` asks this function for it
// is held by review, not by these asserts.
test("workspace declarado não é acusado de conter os outros") {
    let hazards = ProjectOrganiser.containmentHazards(
        sample, declaredWorkspaces: ["/h/Development/lookchina"])
    assertFalse(hazards.contains { $0.path == "/h/Development/lookchina" },
                "um workspace contém seus membros por definição — acusá-lo manda "
                + "o operador apagar exatamente a entrada que ele promoveu")
}

test("o .gsd/ perdido continua sendo denunciado") {
    // The regression guard's other half. Suppressing the workspace must not
    // suppress the hazard that really existed: a `.gsd/` at ~/Development,
    // above every real project, enrolling all of them.
    let hazards = ProjectOrganiser.containmentHazards(
        sample, declaredWorkspaces: ["/h/Development/lookchina"])
    assertEqual(hazards.first?.path, "/h/Development", "o intruso não declarado")
    assertEqual(hazards.first?.count, 6)
}

test("sem declarações o aviso é exatamente o de antes") {
    // A legacy registry has no `kind` field, so it declares nothing — and must
    // behave as it did before workspaces existed.
    let hazards = ProjectOrganiser.containmentHazards(sample)
    assertEqual(hazards.map(\.path),
                ["/h/Development", "/h/Development/lookchina"],
                "ambos acima do limiar, do maior para o menor")
    assertFalse(hazards.contains { $0.path == "/h/Development/lookchina/services" },
                "2 contidos está abaixo do limiar de 3")
}

test("ordem dos riscos não depende da ordem de entrada") {
    let a = ProjectOrganiser.containmentHazards(sample)
    let b = ProjectOrganiser.containmentHazards(sample.reversed())
    assertEqual(a, b, "empates desempatados por caminho, não pela ordem do dicionário")
}

test("prefixo parcial não conta como contido") {
    // "/h/Dev" must not swallow "/h/Development".
    let c = ProjectOrganiser.containment(["/h/Dev", "/h/Development"])
    assertTrue(c["/h/Dev"] == nil, "prefixo de string não é contenção de caminho")
}

test("container devolve o pai mais próximo") {
    let owner = ProjectOrganiser.container(of: "/h/Development/lookchina/services/asgard",
                                           in: sample)
    assertEqual(owner, "/h/Development/lookchina/services",
                "o mais próximo, não o mais alto")
    assertTrue(ProjectOrganiser.container(of: "/h/Development", in: sample) == nil)
}

test("abbreviate encurta o home") {
    assertEqual(ProjectOrganiser.abbreviate("/h/Development", home: "/h"), "~/Development")
    assertEqual(ProjectOrganiser.abbreviate("/outro/x", home: "/h"), "/outro/x")
}

print("\nProjectTree (a hierarquia é transitiva; o agrupamento por pai imediato não era)")

// Three levels on purpose: the grandchild is what tells a transitive tree from
// a bucket-by-parent one. Under `groups`, `/h/w/apps/odin/vendor/x` came out as
// a header next to `/h/w` with nothing relating them.
let treeSample = [
    "/h/w",
    "/h/w/apps/odin",
    "/h/w/apps/odin/vendor/x",
]

test("três níveis: o neto fica sob o filho, não ao lado do avô") {
    let forest = ProjectTree.build(projects: treeSample, home: "/h")
    assertEqual(forest.count, 1, "o topo tem um único nó — o avô")
    assertEqual(forest[0].path, "/h/w")

    // Depth asserted explicitly: w > apps > odin > vendor > x.
    let apps = forest[0].children
    assertEqual(apps.count, 1)
    assertEqual(apps[0].path, "/h/w/apps")
    let odin = apps[0].children
    assertEqual(odin.count, 1)
    assertEqual(odin[0].path, "/h/w/apps/odin")
    let vendor = odin[0].children
    assertEqual(vendor.count, 1)
    assertEqual(vendor[0].path, "/h/w/apps/odin/vendor")
    assertEqual(vendor[0].children.map(\.path), ["/h/w/apps/odin/vendor/x"])

    let topPaths = forest.map(\.path)
    assertFalse(topPaths.contains("/h/w/apps/odin/vendor/x"),
                "neto no topo é exatamente a regressão para bucket por pai imediato")
}

test("o intermediário que não é projeto vira folder") {
    let forest = ProjectTree.build(projects: treeSample, home: "/h")
    let apps = forest[0].children[0]
    assertEqual(apps.role, .folder, "apps/ não tem .gsd/ — é nó de display")
    assertEqual(apps.title, "apps")
    assertEqual(forest[0].role, .workspace, "w contém projetos")
    assertEqual(forest[0].children[0].children[0].role, .workspace, "odin contém x")
}

test("diretório sem projeto abaixo não é sintetizado") {
    // `/h/w/docs` existe no mundo, mas nada registrado mora lá. A árvore mostra
    // o que o registro contém; não sai procurando estrutura para desenhar.
    let forest = ProjectTree.build(projects: treeSample, home: "/h")
    var seen: [String] = []
    func walk(_ n: ProjectTreeNode) { seen.append(n.path); n.children.forEach(walk) }
    forest.forEach(walk)
    assertFalse(seen.contains("/h/w/docs"), "nó inventado: \(seen)")
    assertEqual(seen.count, 5, "w, apps, odin, vendor, x — nada além disso: \(seen)")
}

test("a árvore não depende da ordem de entrada") {
    let a = ProjectTree.build(projects: treeSample, home: "/h")
    let b = ProjectTree.build(projects: treeSample.reversed(), home: "/h")
    assertEqual(a, b, "ordem de entrada não pode mudar a estrutura")
}

test("registráveis são exatamente os projetos de entrada — nem a mais, nem a menos") {
    let forest = ProjectTree.build(projects: treeSample, home: "/h")
    var registrable: [String] = []
    func walk(_ n: ProjectTreeNode) {
        if n.role.isRegistrable { registrable.append(n.path) }
        n.children.forEach(walk)
    }
    forest.forEach(walk)
    assertEqual(registrable.sorted(), treeSample.sorted(),
                "folder vazando para registrável, ou projeto sumindo, é o mesmo defeito")
    assertFalse(ProjectRole.folder.isRegistrable, "pasta nunca é registrável")
    assertTrue(ProjectRole.workspace.isRegistrable && ProjectRole.project.isRegistrable)
}

test("projectCount é transitivo — o avô conta o neto") {
    let forest = ProjectTree.build(projects: treeSample, home: "/h")
    assertEqual(forest[0].projectCount, 2, "odin e x")
    assertEqual(forest[0].children[0].projectCount, 2, "a pasta apps carrega os dois")
    assertEqual(forest[0].children[0].children[0].projectCount, 1, "odin conta x")
}

test("roots declarados ancoram os projetos de topo; root sem projeto não aparece") {
    let forest = ProjectTree.build(projects: ["/h/Development/message"],
                                   roots: ["/h/Development", "/h/Desktop"],
                                   home: "/h")
    assertEqual(forest.count, 1, "Desktop não tem projeto abaixo — não é sintetizado")
    assertEqual(forest[0].path, "/h/Development")
    assertEqual(forest[0].role, .folder)
    assertEqual(forest[0].title, "~/Development", "topo é abreviado pelo home injetado")
    assertEqual(forest[0].children.map(\.path), ["/h/Development/message"])
    assertEqual(forest[0].projectCount, 1)
}

test("a forma do registro vivo: uma árvore para lookchina, com apps/ e services/") {
    // Os 14 ativos que o registro contém hoje, como literais. As contagens são
    // as que ESTA fixture implica (5 e 4) — os 6/7 do texto do ROADMAP
    // descrevem o registro anterior à migração de S01 e não existem mais.
    let dev = "/h/Development"
    let live = [
        "\(dev)/lookchina",
        "\(dev)/lookchina/apps/fenrir",
        "\(dev)/lookchina/apps/heimdall",
        "\(dev)/lookchina/apps/nidhogg",
        "\(dev)/lookchina/apps/odin",
        "\(dev)/lookchina/apps/valyria",
        "\(dev)/lookchina/services/freyr",
        "\(dev)/lookchina/services/gna",
        "\(dev)/lookchina/services/loki",
        "\(dev)/lookchina/services/muninn",
        "\(dev)/feirao-do-lu",
        "\(dev)/forge-agent",
        "\(dev)/message",
        "\(dev)/nura-smpp",
    ]
    let forest = ProjectTree.build(projects: live, home: "/h")

    assertEqual(forest.count, 5, "quatro soltos + lookchina, sem roots declarados")
    let look = forest.first { $0.path == "\(dev)/lookchina" }!
    assertEqual(look.role, .workspace)
    assertEqual(look.projectCount, 9, "cinco em apps/ e quatro em services/")
    assertEqual(look.children.map(\.title), ["apps", "services"], "irmãos em ordem estável")
    assertEqual(look.children.map(\.role), [.folder, .folder],
                "apps/ e services/ não têm .gsd/ — são pastas, não cards")
    assertEqual(look.children[0].projectCount, 5)
    assertEqual(look.children[1].projectCount, 4)
    assertEqual(look.children[1].children.map(\.title), ["freyr", "gna", "loki", "muninn"])
    assertTrue(forest.first { $0.path == "\(dev)/message" }?.role == .project,
               "projeto solto continua projeto")
}

print("\nStatusModels (o modelo antigo lia o JSON errado, em silêncio)")

test("decodifica o payload real do forge-status") {
    // Shape taken verbatim from the engine: progress is an OBJECT and the slice
    // key is active_slice — the previous model declared a String and `slice`,
    // so both silently decoded to nil.
    let json = """
    {"cwd":"/p","runs":{"active":[{"id":"M-1","kind":"milestone","phase":"plan-slice",
     "heartbeat_age_ms":441136,"stale":false,"isolation_mode":"worktree"}],"focused":"M-1"},
     "milestone":{"id":"M-1","title":"M-1","phase":"plan-slice","active_slice":"S14",
     "active_task":"—","auto_mode":"on","next_action":"plan-slice S14 — SKU fiscal",
     "progress":{"done":13,"total":28},
     "slices":[{"id":"S01","title":"Link vivo","checked":true,"risk":"high","status":"done",
       "tasks":[{"id":"T01","title":"Baseline** — `depends:[]`","checked":true,"status":"done"}]}]},
     "autonomous_tasks":[],"warnings":[]}
    """
    let p = try! JSONDecoder().decode(StatusPayload.self, from: Data(json.utf8))
    assertEqual(p.milestone?.progress?.done, 13)
    assertEqual(p.milestone?.progress?.total, 28)
    assertEqual(p.milestone?.progress?.percent, 46)
    assertEqual(p.milestone?.active_slice, "S14")
    assertEqual(p.runs?.active?.first?.phase, "plan-slice")
    assertEqual(p.runs?.active?.first?.isolation_mode, "worktree")
    assertEqual(p.milestone?.slices?.first?.isDone, true)
    assertEqual(p.milestone?.slices?.first?.isHighRisk, true)
}

test("progresso não divide por zero antes do planejamento") {
    let p = MilestoneStatus.Progress(done: 0, total: 0)
    assertEqual(p.fraction, 0)
    assertEqual(p.percent, 0)
}

test("progresso satura em 100%") {
    assertEqual(MilestoneStatus.Progress(done: 30, total: 28).percent, 100)
}

test("título repetido do id não é mostrado") {
    // The engine repeats the id as title when the milestone has no human name;
    // showing it twice is noise.
    let json = "{\"id\":\"M-1\",\"title\":\"M-1\"}"
    let m = try! JSONDecoder().decode(MilestoneStatus.self, from: Data(json.utf8))
    assertTrue(m.displayTitle == nil)
}

test("título de task perde a metadata do plano") {
    let json = "{\"id\":\"T02\",\"title\":\"Backend — mint do token** — `depends:[T01]` `domain:backend`\"}"
    let t = try! JSONDecoder().decode(TaskStatus.self, from: Data(json.utf8))
    assertEqual(t.cleanTitle, "Backend — mint do token")
}

test("contagem de tasks por slice") {
    let json = """
    {"id":"S02","tasks":[{"id":"T01","status":"done"},{"id":"T02","status":"pending"},
                          {"id":"T03","checked":true}]}
    """
    let sl = try! JSONDecoder().decode(SliceStatus.self, from: Data(json.utf8))
    assertEqual(sl.doneTasks, 2)
    assertEqual(sl.totalTasks, 3)
}

print("\nChangelogParser + Version")

test("parseia versões, seções e bullets") {
    let md = """
    ## Unreleased — Cost-aware dispatch

    ### Added

    - Prompts determinísticos com budget.
    - Telemetria por chamada.

    ### Fixed

    - **Perda silenciosa de dados.** `forge-state.js` truncava a seção
      até a primeira linha, apagando o histórico.

    ---

    ## v2.10.0 — Roteamento

    ### Changed

    - Modelo resolvido por tier.
    """
    let r = ChangelogParser.parse(md)
    assertEqual(r.count, 2)
    assertEqual(r[0].version, "Unreleased")
    assertEqual(r[0].headline, "Cost-aware dispatch")
    assertTrue(r[0].isUnreleased)
    assertEqual(r[0].sections.count, 2)
    assertEqual(r[0].sections[0].kind, .added)
    assertEqual(r[0].sections[0].entries.count, 2)
    assertEqual(r[1].version, "v2.10.0")
}

test("bullet quebrado em várias linhas vira uma entrada") {
    let md = """
    ## v1.0.0 — x

    ### Fixed

    - Primeira linha
      continuação da mesma entrada.
    - Outra entrada.
    """
    let sec = ChangelogParser.parse(md)[0].sections[0]
    assertEqual(sec.entries.count, 2)
    assertTrue(sec.entries[0].contains("continuação"), "linhas juntadas: \(sec.entries[0])")
}

test("markdown é preservado para renderização") {
    // The notes lead with a bold sentence carrying the point of the item;
    // stripping it threw away the only hierarchy the entries have.
    let md = """
    ## v1.0.0 — x

    ### Fixed

    - **Perda de dados.** roda `forge-state.js` agora
    """
    let e = ChangelogParser.parse(md)[0].sections[0].entries[0]
    assertTrue(e.contains("**"), "negrito preservado: \(e)")
    assertTrue(e.contains("`"), "code preservado")
}

test("plain remove markdown para onde não dá para renderizar") {
    assertEqual(ChangelogParser.plain("**Bold.** roda `forge-state.js` agora"),
                "Bold. roda forge-state.js agora")
}

test("separa a frase-título do resto") {
    let split = "**Perda de dados.** o parser truncava a seção".changelogLead
    assertEqual(split?.lead, "Perda de dados.")
    assertEqual(split?.rest, "o parser truncava a seção")
    assertTrue("sem negrito no início".changelogLead == nil)
    assertTrue("**".changelogLead == nil, "negrito vazio não conta")
}

test("seção desconhecida carrega o próprio heading, não um balde") {
    assertEqual(ReleaseSection.Kind.from("Deprecated"), .other("Deprecated"))
    assertEqual(ReleaseSection.Kind.from("Fixed"), .fixed)
    // Duas desconhecidas DIFERENTES têm de ter ids diferentes: era aqui que a
    // colisão nascia — ambas viravam `.other`, id "Outros", e o `ForEach` da
    // tela recebia dois ids iguais sem que nada avisasse.
    assertFalse(ReleaseSection.Kind.from("Breaking").key == ReleaseSection.Kind.from("Notes").key,
                "dois headings distintos com a mesma identidade voltam a colidir no ForEach")
    // `key` é estrutural e `label` é exibição: keyar a linha pelo texto
    // traduzido faria a identidade depender do idioma da UI.
    assertEqual(ReleaseSection.Kind.fixed.key, "Fixed")
    assertEqual(ReleaseSection.Kind.fixed.label, "Correções")
    assertEqual(ReleaseSection.Kind.from("  Breaking  ").label, "Breaking")
}

test("o label de uma seção desconhecida é cortado para caber na caption") {
    // A tela faz `label.uppercased()` num caption; dois headings deste arquivo
    // têm 85 caracteres. O corte é de EXIBIÇÃO — `key` guarda o heading inteiro,
    // senão o corte reintroduziria colisão entre dois `Architecture (…)`.
    let longo = ReleaseSection.Kind.from("Architecture (M004 decisions D-M004-1..12 — see .gsd/)")
    assertEqual(longo.label, "Architecture")
    assertEqual(longo.key, "Architecture (M004 decisions D-M004-1..12 — see .gsd/)")
    assertFalse(longo.key == ReleaseSection.Kind.from("Architecture (M005 decisions)").key,
                "o corte de exibição não pode fundir duas seções distintas")
    assertEqual(ReleaseSection.Kind.from("Known, not fixed").label, "Known, not fixed",
                "heading curto sem separador não é cortado")
    // Heading vazio degrada para o balde antigo em vez de virar um label em branco.
    assertEqual(ReleaseSection.Kind.from("   ").label, "Outros")
}

test("o detector de seção morde: dois headings iguais na mesma release colidem") {
    // Sem este caso o teste acima prova que o arquivo está limpo, não que a
    // sujeira seria vista.
    let md = """
    ## v9.9.9 — duas seções com o mesmo heading

    ### Breaking

    - primeira

    ### Breaking

    - segunda
    """
    let sections = ChangelogParser.parse(md)[0].sections
    assertEqual(sections.count, 2, "as duas seções têm de chegar ao ForEach")
    assertEqual(sections[0].id, sections[1].id, "é exatamente esta igualdade que o teste acima proíbe")
    // E o contraste: headings distintos, ids distintos — o que antes NÃO valia.
    let ok = """
    ## v9.9.8 — duas seções distintas fora do enum

    ### Breaking

    - primeira

    ### Notes

    - segunda
    """
    let distintas = ChangelogParser.parse(ok)[0].sections
    assertFalse(distintas[0].id == distintas[1].id,
                "`Breaking` e `Notes` compartilhavam o id 'Outros' — era a colisão real")
}

test("changelog vazio não quebra") {
    assertEqual(ChangelogParser.parse("").count, 0)
    assertEqual(ChangelogParser.parse("texto solto sem cabeçalho").count, 0)
}

// MARK: - Id duplicado no CHANGELOG real (D36)
//
// `Release.id` é a própria `version`, e a tela de Atualizações passa a lista para
// um `ForEach`. Dois headings com a mesma versão — foi o caso real: `## Unreleased`
// na linha 1 E na 104 — produzem dois ids iguais, que em SwiftUI é comportamento
// INDEFINIDO, não erro: nada avisa, nada quebra visivelmente, e a lista renderiza
// uma das duas entradas ou as duas no lugar errado. O conserto do arquivo não se
// protege sozinho (basta o próximo release abrir um `## Unreleased` novo e esquecer
// de fechá-lo), então o invariante é asserido contra o arquivo de verdade, aqui.

/// O CHANGELOG.md do repositório, localizado a partir do `#filePath` deste arquivo
/// e não do diretório de trabalho: `swift run ForgeKitTests` roda de `app/`, mas
/// `scripts/run-tests.js` invoca de outro lugar, e um teste que só encontra o
/// arquivo sob um cwd específico é um teste que passa por não achar nada.
let repoChangelogPath: String = {
    var url = URL(fileURLWithPath: #filePath)   // …/app/Sources/ForgeKitTests/main.swift
    for _ in 0..<4 { url = url.deletingLastPathComponent() }
    return url.appendingPathComponent("CHANGELOG.md").path
}()

test("o CHANGELOG.md do repositório existe e é parseável") {
    assertTrue(FileManager.default.fileExists(atPath: repoChangelogPath),
               "CHANGELOG.md não encontrado em \(repoChangelogPath) — os dois testes "
               + "seguintes passariam por vacuidade")
    let text = (try? String(contentsOfFile: repoChangelogPath, encoding: .utf8)) ?? ""
    assertGreater(ChangelogParser.parse(text).count, 10,
                  "o CHANGELOG real parseou em quase nada — o formato mudou e os "
                  + "invariantes abaixo deixaram de medir o arquivo")
}

test("nenhuma release do CHANGELOG.md real tem id duplicado (D36)") {
    let text = (try? String(contentsOfFile: repoChangelogPath, encoding: .utf8)) ?? ""
    var seen: [String: Int] = [:]
    for r in ChangelogParser.parse(text) { seen[r.id, default: 0] += 1 }
    let dupes = seen.filter { $0.value > 1 }.keys.sorted()
    assertTrue(dupes.isEmpty,
               "headings `## <version>` repetidos em CHANGELOG.md: \(dupes.joined(separator: ", ")) "
               + "— `Release.id` é a version, então isso dá ids iguais num ForEach "
               + "(comportamento indefinido). Renomeie o heading para a versão que a "
               + "entrada efetivamente é (`git describe --contains <commit>` responde qual)")
}

test("o CHANGELOG.md real tem no máximo um `## Unreleased` (D36)") {
    let text = (try? String(contentsOfFile: repoChangelogPath, encoding: .utf8)) ?? ""
    let unreleased = ChangelogParser.parse(text).filter(\.isUnreleased)
    assertLessOrEqual(unreleased.count, 1,
                      "\(unreleased.count) entradas `Unreleased` em CHANGELOG.md — todas "
                      + "colidem no mesmo id. Feche a antiga com a versão em que ela saiu")
}

test("nenhuma release do CHANGELOG.md real tem seções com id duplicado") {
    // Mesma classe da D36, um nível abaixo: `ReleaseSection.id` alimenta o
    // `ForEach` interno do card. Oito releases do arquivo estavam nesse estado
    // enquanto TODO heading fora do enum compartilhava o id "Outros" — D36
    // guardava o id da release e ninguém guardava o da seção. O caso sintético
    // logo abaixo prova que este cálculo morde.
    let text = (try? String(contentsOfFile: repoChangelogPath, encoding: .utf8)) ?? ""
    let releases = ChangelogParser.parse(text)
    assertGreater(releases.count, 10,
                  "o CHANGELOG real não foi lido — este teste passaria por vacuidade")
    var offenders: [String] = []
    var sectionsSeen = 0
    for r in releases {
        sectionsSeen += r.sections.count
        var seen: [String: Int] = [:]
        for s in r.sections { seen[s.id, default: 0] += 1 }
        for (id, n) in seen where n > 1 { offenders.append("\(r.version): \(id) (\(n)x)") }
    }
    assertGreater(sectionsSeen, 10,
                  "nenhuma seção lida — o formato mudou e o invariante parou de medir")
    assertTrue(offenders.isEmpty,
               "seções com id repetido: \(offenders.sorted().joined(separator: ", ")) — dois ids "
               + "iguais num ForEach é comportamento indefinido. Renomeie o heading repetido")
}

test("o detector morde: duas entradas Unreleased dão dois ids iguais") {
    // Sem este caso os dois testes acima seriam indistinguíveis de asserções
    // vazias: eles provam que o arquivo está limpo, não que a sujeira seria vista.
    let md = """
    ## Unreleased — primeiro bloco

    ### Added

    - a

    ---

    ## v1.0.0 — meio

    ### Fixed

    - b

    ---

    ## Unreleased — segundo bloco, esquecido de fechar

    ### Added

    - c
    """
    let rs = ChangelogParser.parse(md)
    assertEqual(rs.count, 3)
    assertEqual(rs.filter(\.isUnreleased).count, 2)
    // O ponto: os ids são IGUAIS, e é isso que o ForEach recebe.
    assertEqual(rs[0].id, rs[2].id)
    var seen: [String: Int] = [:]
    for r in rs { seen[r.id, default: 0] += 1 }
    assertEqual(seen.filter { $0.value > 1 }.count, 1,
                "o mesmo cálculo que roda contra o arquivo real não acusou a duplicata "
                + "deste fixture — então ele não acusaria a do arquivo tampouco")
}

// MARK: - ReleaseWindow — 5 cards em repouso, o resto a um clique (D30, R10)

print("\nReleaseWindow (o corte é a cauda histórica, nunca o topo — D30)")

/// Um CHANGELOG sintético a partir de uma lista de versões, na ORDEM DADA.
///
/// A ordem é o ponto: a ordem do arquivo não é a ordem das versões neste repo
/// (`v1.35.0` precede `v1.36.0`), e um fixture que só usa listas decrescentes não
/// consegue distinguir "janela em ordem de arquivo" de "janela ordenada".
func windowFixture(_ versions: [String]) -> [Release] {
    let md = versions
        .map { "## \($0) — cabeçalho de \($0)\n\n### Added\n\n- entrada de \($0)\n" }
        .joined(separator: "\n")
    let rs = ChangelogParser.parse(md)
    assertEqual(rs.count, versions.count, "o fixture não parseou no número de entradas pedido")
    return rs
}

test("dedupe por version: duas entradas Unreleased dão UM card") {
    // O chunk irmão consertou o arquivo deste repo; isto conserta o PROGRAMA,
    // que também tem de sobreviver a um fork, a um merge e a uma edição à mão.
    let rs = windowFixture(["Unreleased", "v3.3.0", "Unreleased", "v3.1.4"])
    assertEqual(rs.count, 4, "o fixture precisa entrar com a duplicata para o teste valer")
    let w = ReleaseWindow.visible(releases: rs, installed: nil, latest: nil, limit: 5)
    assertEqual(w.visible.filter(\.isUnreleased).count, 1,
                "duas entradas Unreleased chegaram ao ForEach — dois ids iguais")
    assertEqual(w.visible.map(\.id), ["Unreleased", "v3.3.0", "v3.1.4"])
    assertEqual(w.hiddenCount, 0, "o deduplicado tem 3 entradas e o limite é 5")
}

test("limite respeitado quando nenhum pino está fora da janela") {
    let rs = windowFixture(["v9.0.0", "v8.0.0", "v7.0.0", "v6.0.0", "v5.0.0",
                            "v4.0.0", "v3.0.0", "v2.0.0"])
    let w = ReleaseWindow.visible(releases: rs, installed: "v9.0.0", latest: "v9.0.0", limit: 5)
    assertEqual(w.visible.count, 5)
    assertEqual(w.visible.map(\.id), ["v9.0.0", "v8.0.0", "v7.0.0", "v6.0.0", "v5.0.0"])
    assertEqual(w.hiddenCount, 3, "8 entradas menos as 5 visíveis")
}

test("R10: SE existe entrada para installed, ela está na janela — mesmo na cauda") {
    // O invariante da D30, na única forma em que ele é satisfazível (ver o teste
    // seguinte): condicionado à existência da entrada.
    let rs = windowFixture(["v9.0.0", "v8.0.0", "v7.0.0", "v6.0.0", "v5.0.0",
                            "v4.0.0", "v3.0.0", "v2.0.0"])
    let w = ReleaseWindow.visible(releases: rs, installed: "v2.0.0", latest: "v9.0.0", limit: 5)
    assertTrue(w.visible.contains { $0.id == "v2.0.0" },
               "a entrada da versão INSTALADA caiu atrás do mostrar mais — é justo o que a "
               + "D30 proíbe: o corte é a cauda histórica, nunca o que o operador está rodando")
    assertEqual(w.visible.count, 6, "os 5 do topo mais o pino que estava fora")
    assertEqual(w.hiddenCount, 2)
    // E a ordem do arquivo é preservada: o pino não é promovido para o topo.
    assertEqual(w.visible.map(\.id),
                ["v9.0.0", "v8.0.0", "v7.0.0", "v6.0.0", "v5.0.0", "v2.0.0"])
}

test("R10 é VACUAMENTE verdadeiro quando installed não tem entrada nenhuma") {
    // O caso real, não hipotético: `v3.1.4` é a tag instalada hoje e o
    // CHANGELOG deste repo não tem entrada para ela. Escrito como "o card da
    // versão instalada está sempre visível", o invariante seria insatisfazível e
    // este teste falharia contra o próprio arquivo do repo.
    let rs = windowFixture(["v3.3.0", "v3.2.0", "v3.1.1", "v3.1.0", "v3.0.0", "v2.9.0"])
    let w = ReleaseWindow.visible(releases: rs, installed: "v3.1.4", latest: nil, limit: 5)
    assertEqual(w.visible.count, 5, "um installed inexistente não pode pinar nada")
    assertEqual(w.hiddenCount, 1)
    assertFalse(w.visible.contains { $0.id == "v3.1.4" }, "inventou uma entrada que não existe")
}

test("R10: latest pina do mesmo jeito, e as duas condições compõem") {
    let rs = windowFixture(["v9.0.0", "v8.0.0", "v7.0.0", "v6.0.0", "v5.0.0",
                            "v4.0.0", "v3.0.0", "v2.0.0"])
    let w = ReleaseWindow.visible(releases: rs, installed: "v3.0.0", latest: "v2.0.0", limit: 5)
    assertTrue(w.visible.contains { $0.id == "v3.0.0" }, "o pino de installed não entrou")
    assertTrue(w.visible.contains { $0.id == "v2.0.0" }, "o pino de latest não entrou")
    assertEqual(w.visible.count, 7)
    assertEqual(w.hiddenCount, 1, "só v4.0.0 sobra escondida")
}

test("isUnreleased é pino, esteja onde estiver na cauda") {
    let rs = windowFixture(["v9.0.0", "v8.0.0", "v7.0.0", "v6.0.0", "v5.0.0",
                            "v4.0.0", "Unreleased"])
    let w = ReleaseWindow.visible(releases: rs, installed: nil, latest: nil, limit: 5)
    assertTrue(w.visible.contains(where: \.isUnreleased),
               "trabalho ainda não lançado ficou escondido")
    assertEqual(w.hiddenCount, 1)
}

test("a ordem do arquivo NÃO é a ordem das versões, e a janela não ordena") {
    // Pitfall real deste repo: `v1.35.0` aparece ANTES de `v1.36.0`. A janela
    // promete "as 5 primeiras do arquivo mais os pinos", nunca "as 5 mais
    // recentes" — e uma lógica que assumisse arquivo ordenado pinaria o card
    // errado sem nada avisar.
    let rs = windowFixture(["v1.35.0", "v1.36.0", "v1.34.0", "v1.33.0", "v1.32.0", "v1.31.0"])
    let w = ReleaseWindow.visible(releases: rs, installed: nil, latest: nil, limit: 5)
    assertEqual(w.visible.map(\.id),
                ["v1.35.0", "v1.36.0", "v1.34.0", "v1.33.0", "v1.32.0"],
                "a janela reordenou o arquivo — a promessa é ordem de arquivo")
    assertEqual(w.hiddenCount, 1)
}

test("hiddenCount é 0 quando a lista é menor que o limite") {
    let w = ReleaseWindow.visible(releases: windowFixture(["v3.0.0", "v2.0.0"]),
                                  installed: "v3.0.0", latest: "v3.0.0", limit: 5)
    assertEqual(w.visible.count, 2)
    assertEqual(w.hiddenCount, 0, "com hiddenCount > 0 a view desenharia um controle inútil")
}

test("expandido (.max) mostra tudo, sem duplicar e sem esconder nada") {
    let rs = windowFixture(["Unreleased", "v9.0.0", "Unreleased", "v8.0.0", "v7.0.0",
                            "v6.0.0", "v5.0.0", "v4.0.0"])
    let w = ReleaseWindow.visible(releases: rs, installed: "v5.0.0", latest: "v9.0.0",
                                  limit: Int.max)
    assertEqual(w.visible.count, 7, "o deduplicado tem 7 entradas")
    assertEqual(w.hiddenCount, 0)
    assertEqual(Set(w.visible.map(\.id)).count, w.visible.count, "id duplicado no estado expandido")
}

test("limite 0 ou negativo ainda devolve os pinos") {
    // Esconder a versão em execução é o único resultado que a D30 proíbe, então
    // nem um limite degenerado pode produzi-lo.
    let rs = windowFixture(["v9.0.0", "v8.0.0", "v7.0.0"])
    let w = ReleaseWindow.visible(releases: rs, installed: "v8.0.0", latest: nil, limit: 0)
    assertEqual(w.visible.map(\.id), ["v8.0.0"])
    assertEqual(w.hiddenCount, 2)
    assertEqual(ReleaseWindow.visible(releases: rs, installed: nil, latest: nil, limit: -3)
                    .visible.count, 0)
}

test("o dedupe acontece ANTES do pino: uma versão repetida pina uma vez") {
    let rs = windowFixture(["v9.0.0", "v8.0.0", "v7.0.0", "v6.0.0", "v5.0.0",
                            "v2.0.0", "v2.0.0"])
    let w = ReleaseWindow.visible(releases: rs, installed: "v2.0.0", latest: nil, limit: 5)
    assertEqual(w.visible.filter { $0.id == "v2.0.0" }.count, 1,
                "o pino entrou duas vezes — dois ids iguais no ForEach")
    assertEqual(w.visible.count, 6)
    assertEqual(w.hiddenCount, 0, "o deduplicado tem 6 entradas, todas visíveis")
}

test("installed com e sem o `v` nomeiam a mesma release") {
    // `installed` é uma tag git; as entradas são headings escritos à mão. Um `v`
    // a mais não pode decidir se o card pode ser escondido.
    let rs = windowFixture(["v9.0.0", "v8.0.0", "v7.0.0", "v6.0.0", "v5.0.0", "v4.0.0"])
    let w = ReleaseWindow.visible(releases: rs, installed: "4.0.0", latest: nil, limit: 5)
    assertTrue(w.visible.contains { $0.id == "v4.0.0" }, "`4.0.0` não casou com `## v4.0.0`")
    assertEqual(w.hiddenCount, 0)
}

test("o limite em repouso é uma constante nomeada, e vale 5") {
    // O número nunca foi validado contra uma lista ao vivo (ninguém respondeu
    // "olhando, 5 é pouco ou muito?"), então trocá-lo tem de ser uma linha.
    assertEqual(ReleaseWindow.restingLimit, 5)
}

test("o rótulo do mostrar-mais concorda em número") {
    assertEqual(ReleaseWindow.moreLabel(hiddenCount: 1), "Mostrar mais 1 versão")
    assertEqual(ReleaseWindow.moreLabel(hiddenCount: 7), "Mostrar mais 7 versões")
    assertEqual(ReleaseWindow.lessLabel, "Mostrar menos")
}

test("o CHANGELOG real, na janela de repouso, mantém tudo o que a D30 pina") {
    // Contra o arquivo de verdade, não contra fixture: é o único lugar onde o
    // Pitfall 8 (installed sem entrada) aparece sozinho.
    guard let text = try? String(contentsOfFile: repoChangelogPath, encoding: .utf8) else {
        assertTrue(false, "CHANGELOG.md não encontrado em \(repoChangelogPath)")
        return
    }
    let rs = ChangelogParser.parse(text)
    let w = ReleaseWindow.visible(releases: rs, installed: "v3.1.4", latest: "v3.3.0",
                                  limit: ReleaseWindow.restingLimit)
    assertEqual(Set(w.visible.map(\.id)).count, w.visible.count, "id duplicado na janela real")
    assertTrue(w.visible.contains { $0.id == "v3.3.0" },
               "a entrada da versão disponível não está na janela de repouso")
    assertGreater(w.hiddenCount, 0, "o arquivo real tem mais de 5 entradas — nada a esconder?")
    assertEqual(w.visible.count + w.hiddenCount, rs.count,
                "visible + hidden tem de fechar com o total deduplicado")
}

test("comparação de versão é semântica, não alfabética") {
    // The case that matters as a project ages: a string compare puts v2.9.0
    // above v2.11.0 and would tell you to downgrade.
    assertTrue(Version.isNewer("v2.11.0", than: "v2.9.0"))
    assertFalse(Version.isNewer("v2.9.0", than: "v2.11.0"))
    assertTrue(Version.isNewer("2.11.1", than: "v2.11.0"))
    assertFalse(Version.isNewer("v2.11.0", than: "v2.11.0"))
    assertTrue(Version.isNewer("v3.0.0", than: "v2.99.99"))
}

test("sufixo de pré-release é ignorado na comparação") {
    assertEqual(Version.components("v2.1.0-beta.1"), [2, 1, 0])
    assertFalse(Version.isNewer("v2.1.0-beta.1", than: "v2.1.0"))
}

print("\nModelCatalog (o input livre virou picker — typo só falhava em runtime)")

test("família reconhecida pelo id, incluindo sufixo [1m]") {
    assertEqual(ModelCatalog.family(of: "claude-opus-4-8[1m]"), .opus)
    assertEqual(ModelCatalog.family(of: "claude-haiku-4-5-20251001"), .haiku)
    assertEqual(ModelCatalog.family(of: "claude-fable-5"), .fable)
    assertEqual(ModelCatalog.family(of: "gpt-5-codex"), .gpt)
    assertEqual(ModelCatalog.family(of: "Gemini 3.1 Pro (High)"), .gemini)
    assertEqual(ModelCatalog.family(of: "modelo-desconhecido"), .unknown)
}

test("fable vem antes de opus na detecção") {
    // Substring order matters: both ids contain "claude-", and a fable id must
    // not be classified by a later opus check.
    assertEqual(ModelCatalog.family(of: "claude-fable-5"), .fable)
}

test("sugestões por engine") {
    assertEqual(ModelCatalog.suggestions(for: .claude).count, ModelCatalog.known.count)
    assertTrue(ModelCatalog.suggestions(for: .gemini).contains { $0.id.contains("Gemini") })
    assertTrue(ModelCatalog.suggestions(for: .codex).contains { $0.id == "gpt-5" })
}

test("engine sabe qual binário precisa estar no PATH") {
    assertEqual(ModelEngine.gemini.binary, "agy")
    assertEqual(ModelEngine.codex.binary, "codex")
    assertEqual(ModelEngine.claude.binary, "claude")
}

test("isKnown cobre os catálogos externos") {
    assertTrue(ModelCatalog.isKnown("claude-opus-5"))
    assertTrue(ModelCatalog.isKnown("Gemini 3.1 Pro (High)"))
    assertFalse(ModelCatalog.isKnown("claude-opus-6"), "id inexistente deve ser sinalizado")
}

test("label cai no id quando não catalogado") {
    assertEqual(ModelCatalog.label(for: "claude-opus-5"), "Opus 5")
    assertEqual(ModelCatalog.label(for: "modelo-novo"), "modelo-novo")
}

print("\nMetricsEngine (events.jsonl já acumulava isso — ninguém lia)")

let sampleEvents = """
{"ts":"2026-07-29T02:16:45Z","event":"dispatch","unit":"execute-task/T02","model":"gpt-5.6-luna","engine":"codex","domain":"backend","slice":"S14","input_tokens":4988,"output_tokens":1869}
{"ts":"2026-07-29T02:20:00Z","event":"dispatch","unit":"execute-task/T03","model":"claude-opus-5","engine":"claude","domain":"frontend","slice":"S14","input_tokens":1000000,"output_tokens":100000}
{"ts":"2026-07-29T02:22:00Z","event":"review","slice":"S14"}
{"ts":"2026-07-29T02:23:00Z","event":"retry","attempts":2}
linha quebrada sem json
{"ts":"2026-07-29T02:24:00Z","event":"dispatch","unit":"plan-slice/S15","model":"claude-opus-5","engine":"claude","input_tokens":2000,"output_tokens":500}
"""

test("parseia dispatches e ignora linha corrompida") {
    // The file is appended to by a live process, so the last line can be torn.
    let (d, e) = MetricsEngine.parse(sampleEvents)
    assertEqual(d.count, 3)
    assertEqual(e["review"], 1)
    assertEqual(e["retry"], 1)
    assertEqual(d[0].engine, "codex")
    assertEqual(d[0].totalTokens, 6857)
}

test("unitType descarta o id da unidade") {
    let (d, _) = MetricsEngine.parse(sampleEvents)
    assertEqual(d[0].unitType, "execute-task")
    assertEqual(d[2].unitType, "plan-slice")
}

test("custo usa a tabela por família") {
    // Opus 5: $5/MTok in, $25/MTok out → 1M in + 100k out = 5 + 2.5
    let c = Pricing.cost(model: "claude-opus-5", input: 1_000_000, output: 100_000)
    assertEqual(c ?? 0, 7.5)
}

test("modelo sem preço não inventa custo") {
    // Inventing a number for an externally-billed engine would make the total
    // look authoritative when it is not.
    assertTrue(Pricing.cost(model: "gpt-5.6-luna", input: 1000, output: 1000) == nil)
}

test("resumo marca custo incompleto quando há modelo sem preço") {
    let (d, e) = MetricsEngine.parse(sampleEvents)
    let s = MetricsEngine.summarise(d, events: e)
    assertEqual(s.dispatches, 3)
    assertTrue(s.costIncomplete, "codex não tem preço na tabela")
    // Only the two Claude dispatches contribute to cost.
    assertTrue(s.cost > 7.5 && s.cost < 7.6, "custo: \(s.cost)")
}

test("agrupa por modelo, engine, unidade e domínio") {
    let (d, e) = MetricsEngine.parse(sampleEvents)
    let s = MetricsEngine.summarise(d, events: e)
    assertEqual(s.byEngine.count, 2)
    assertEqual(s.byUnit.count, 2)
    assertEqual(s.byDomain.count, 2)
    // Sorted by spend: the Claude bucket outranks the unpriced codex one.
    assertEqual(s.byEngine[0].key, "claude")
}

test("filtro por data corta o histórico") {
    let (d, e) = MetricsEngine.parse(sampleEvents)
    let iso = ISO8601DateFormatter()
    let cut = iso.date(from: "2026-07-29T02:21:00Z")!
    let s = MetricsEngine.summarise(d, events: e, since: cut)
    assertEqual(s.dispatches, 1, "só o dispatch das 02:24")
}

test("share de output explica a conta melhor que o total") {
    // Output costs 5x input across the table.
    let (d, e) = MetricsEngine.parse(sampleEvents)
    let s = MetricsEngine.summarise(d, events: e)
    assertTrue(s.outputShare > 0 && s.outputShare < 1)
}

test("formatação de tokens e dinheiro") {
    assertEqual(MetricsEngine.tokens(999), "999")
    assertEqual(MetricsEngine.tokens(4988), "5.0k")
    assertEqual(MetricsEngine.tokens(1_250_000), "1.25M")
    assertEqual(MetricsEngine.money(0.004), "<$0,01")
    assertEqual(MetricsEngine.money(7.5), "$7.50")
}

test("arquivo vazio não quebra") {
    let (d, e) = MetricsEngine.parse("")
    assertEqual(d.count, 0)
    assertEqual(e.count, 0)
    assertEqual(MetricsEngine.summarise(d).dispatches, 0)
}

print("\nComposerParser (autocomplete estilo Claude Code)")

func ctx(_ text: String, caretAtEnd: Bool = true) -> CompletionContext {
    ComposerParser.context(in: text, caret: text.endIndex)
}

test("/ no início abre comandos") {
    let c = ctx("/forge-au")
    assertEqual(c, .command(query: "forge-au",
                            range: "/forge-au".startIndex..<"/forge-au".endIndex))
}

test("@ abre projetos") {
    if case .project(let q, _) = ctx("@mess") { assertEqual(q, "mess") }
    else { assertTrue(false, "esperava contexto de projeto") }
}

test("gatilho depois de espaço também vale") {
    if case .command(let q, _) = ctx("olha /forge-st") { assertEqual(q, "forge-st") }
    else { assertTrue(false, "esperava comando após espaço") }
}

test("barra no meio de uma palavra NÃO abre menu") {
    // Otherwise every path and URL would pop a menu mid-sentence.
    assertEqual(ctx("veja src/main"), .none)
    assertEqual(ctx("email a@b"), .none)
}

test("espaço encerra o token") {
    assertEqual(ctx("/forge-task corrigir"), .none)
}

test("filtro põe prefixo antes de substring") {
    let cmds = [
        SlashCommand(name: "forge-accounts", description: "", source: .skill),
        SlashCommand(name: "forge-auto", description: "", source: .skill),
        SlashCommand(name: "auto-outro", description: "", source: .skill),
    ]
    let r = ComposerParser.filter(cmds, query: "forge-au")
    assertEqual(r.first?.name, "forge-auto")
}

test("completar substitui o token e devolve o caret") {
    let text = "/forge-au"
    guard case .command(_, let range) = ctx(text) else {
        assertTrue(false, "sem contexto"); return
    }
    let (out, caret) = ComposerParser.complete(text, range: range, with: "/forge-auto")
    assertEqual(out, "/forge-auto ")
    assertEqual(caret, 12)
}

test("split separa comando do resto") {
    let a = ComposerParser.split("/forge-task corrigir o retry")
    assertEqual(a.command, "forge-task")
    assertEqual(a.rest, "corrigir o retry")

    let b = ComposerParser.split("apenas uma conversa")
    assertTrue(b.command == nil)
    assertEqual(b.rest, "apenas uma conversa")

    let c = ComposerParser.split("/forge-status")
    assertEqual(c.command, "forge-status")
    assertEqual(c.rest, "")
}

print("\nCommandCatalog")

test("lê name e description do frontmatter") {
    let md = """
    ---
    name: forge-auto
    description: "Executa o milestone inteiro."
    allowed-tools: Read, Write
    ---

    # corpo
    description: isto não deve ser lido
    """
    assertEqual(CommandCatalog.frontmatter(md, key: "name"), "forge-auto")
    assertEqual(CommandCatalog.frontmatter(md, key: "description"),
                "Executa o milestone inteiro.")
}

test("sem frontmatter devolve nil em vez de ler o corpo") {
    assertTrue(CommandCatalog.frontmatter("# só markdown\nname: x", key: "name") == nil)
}

test("catálogo real da máquina tem comandos do forge") {
    // Reads what is installed, not a list baked into the app.
    let all = CommandCatalog.load()
    assertTrue(all.contains { $0.name.hasPrefix("forge") },
               "esperava comandos forge instalados; achei \(all.count)")
}

test("maxTokens usa o maior, não o primeiro") {
    // Buckets are ordered by spend, so a cheap high-volume model sits below a
    // pricey low-volume one — scaling against first() rendered a bar at 297%.
    var fable = MetricsBucket(key: "claude-fable-5")
    fable.cost = 70.51; fable.inputTokens = 1_420_000
    var sonnet = MetricsBucket(key: "claude-sonnet-5")
    sonnet.cost = 62.64; sonnet.inputTokens = 4_220_000

    let ordered = [fable, sonnet]   // sorted by cost, not tokens
    assertEqual(MetricsEngine.maxTokens(ordered), 4_220_000)
    assertEqual(MetricsEngine.fraction(sonnet.totalTokens,
                                       of: MetricsEngine.maxTokens(ordered)), 1.0)
}

test("fração nunca passa de 1 nem fica negativa") {
    assertEqual(MetricsEngine.fraction(500, of: 100), 1.0)
    assertEqual(MetricsEngine.fraction(-5, of: 100), 0.0)
    assertEqual(MetricsEngine.fraction(10, of: 0), 0.0, "sem denominador não desenha")
}


print("\nWorkspaceDefaults")

test("pref explícito vence o último usado") {
    let p = WorkspaceDefaults.preselect(
        configuredDefault: "/repo/a", lastUsed: "/repo/b", known: ["/repo/a", "/repo/b"])
    assertEqual(p.workspace, "/repo/a")
    assertEqual(p.reason, .pref)
    assertTrue(p.warning == nil, "pref registrado não deve gerar aviso")
}

test("último usado é o segundo default") {
    let p = WorkspaceDefaults.preselect(
        configuredDefault: nil, lastUsed: "/repo/b", known: ["/repo/a", "/repo/b"])
    assertEqual(p.workspace, "/repo/b")
    assertEqual(p.reason, .lastUsed)
    assertTrue(p.warning == nil)
}

test("sem pref e sem último usado não resolve nada") {
    // The b992edf regression test: `known` has two projects, but with no
    // pref and no last-used, nothing must be preselected — `known.first`
    // is never consulted.
    let p = WorkspaceDefaults.preselect(
        configuredDefault: nil, lastUsed: nil, known: ["/repo/a", "/repo/b"])
    assertTrue(p.workspace == nil, "sem configuração nenhuma, workspace deve ser nil")
    assertEqual(p.reason, .none)
}

test("último usado que saiu da lista não vira outro projeto") {
    let p = WorkspaceDefaults.preselect(
        configuredDefault: nil, lastUsed: "/repo/removido", known: ["/repo/a", "/repo/b"])
    assertTrue(p.workspace == nil, "last-used stale não deve substituir por outro projeto")
    assertEqual(p.reason, .none)
}

test("pref fora da lista de projetos resolve com aviso") {
    let p = WorkspaceDefaults.preselect(
        configuredDefault: "/repo/fora", lastUsed: "/repo/a", known: ["/repo/a"])
    assertEqual(p.workspace, "/repo/fora")
    assertEqual(p.reason, .pref)
    assertTrue(p.warning != nil, "pref fora de known deve carregar aviso")
}

test("root dir expande ~ e cai no home quando vazio") {
    let alwaysExists: (String) -> Bool = { _ in true }
    assertEqual(WorkspaceDefaults.sessionRoot(configured: nil, home: "/Users/x", isDirectory: alwaysExists).path, "/Users/x")
    assertEqual(WorkspaceDefaults.sessionRoot(configured: "  ", home: "/Users/x", isDirectory: alwaysExists).path, "/Users/x")
    assertEqual(WorkspaceDefaults.sessionRoot(configured: "~", home: "/Users/x", isDirectory: alwaysExists).path, "/Users/x")
    assertEqual(WorkspaceDefaults.sessionRoot(configured: "~/code", home: "/Users/x", isDirectory: alwaysExists).path, "/Users/x/code")
    assertEqual(WorkspaceDefaults.sessionRoot(configured: "/abs/path", home: "/Users/x", isDirectory: alwaysExists).path, "/abs/path")

    let nilCase = WorkspaceDefaults.sessionRoot(configured: nil, home: "/Users/x", isDirectory: alwaysExists)
    assertTrue(nilCase.warning == nil, "sem valor configurado não deve haver aviso")
}

// R1 fix (S04 review): a configured session root that does not resolve to an
// existing directory must fall back to $HOME with a visible warning, never
// silently open somewhere the "abre em …" caption does not describe.
test("root dir inexistente cai no home com aviso") {
    let neverExists: (String) -> Bool = { _ in false }
    let r = WorkspaceDefaults.sessionRoot(configured: "/repo/removido", home: "/Users/x", isDirectory: neverExists)
    assertEqual(r.path, "/Users/x")
    assertTrue(r.warning != nil, "diretório inexistente deve carregar aviso")
}

test("root dir existente é honrado sem aviso") {
    let alwaysExists: (String) -> Bool = { _ in true }
    let r = WorkspaceDefaults.sessionRoot(configured: "/repo/valido", home: "/Users/x", isDirectory: alwaysExists)
    assertEqual(r.path, "/repo/valido")
    assertTrue(r.warning == nil, "diretório existente não deve carregar aviso")
}

// Both preselect() and sessionRoot() are pure and Foundation-free at the
// call boundary above; the tests here are what pins the b992edf invariant
// down mechanically, so a future edit that reintroduces `known.first`
// breaks the build, not just the behaviour.

print("\nItems (board)")

test("colunas saem na ordem canônica") {
    let cols = ItemBoard.columns([])
    assertEqual(cols.map(\.status), [.inbox, .triaged, .doing, .done, .dropped])
    assertTrue(cols.allSatisfy { $0.items.isEmpty }, "colunas vazias devem existir mesmo sem itens")
}

test("rótulos pt-BR de cada status") {
    assertEqual(ItemStatus.inbox.label, "Entrada")
    assertEqual(ItemStatus.triaged.label, "Triado")
    assertEqual(ItemStatus.doing.label, "Fazendo")
    assertEqual(ItemStatus.done.label, "Feito")
    assertEqual(ItemStatus.dropped.label, "Descartado")
}

test("openCount ignora done e dropped") {
    let items = [
        Item(id: "I-1", status: "inbox"),
        Item(id: "I-2", status: "triaged"),
        Item(id: "I-3", status: "doing"),
        Item(id: "I-4", status: "done"),
        Item(id: "I-5", status: "dropped"),
    ]
    assertEqual(ItemBoard.openCount(items), 3)
}

test("status desconhecido não entra em coluna nenhuma e aparece em unknown") {
    let items = [
        Item(id: "I-1", status: "inbox"),
        Item(id: "I-2", status: "arquivado"),
        Item(id: "I-3", status: nil),
    ]
    let cols = ItemBoard.columns(items)
    assertEqual(cols.flatMap(\.items).count, 1, "só o item conhecido entra em alguma coluna")
    let unk = ItemBoard.unknown(items)
    assertEqual(unk.count, 2)
    assertTrue(unk.contains { $0.id == "I-2" })
    assertTrue(unk.contains { $0.id == "I-3" })
}

test("LoadGeneration descarta resultado de uma geração anterior") {
    var gen = LoadGeneration()
    let genA = gen.start()   // load A começa
    let genB = gen.start()   // usuário troca de projeto antes de A terminar
    assertTrue(!gen.isCurrent(genA), "A não é mais a geração atual — resultado de A deve ser descartado")
    assertTrue(gen.isCurrent(genB), "B é a geração atual — resultado de B deve ser aplicado")
}

test("LoadGeneration aceita a geração mais recente mesmo sem concorrência") {
    var gen = LoadGeneration()
    let only = gen.start()
    assertTrue(gen.isCurrent(only), "única geração iniciada deve ser sempre a atual")
}

test("decodifica um item real da saída do engine") {
    // Copiado verbatim de `node scripts/forge-items.js --list --json`.
    let json = """
    {"id":"I-20260729145851-test-title","title":"Test title","status":"inbox",
     "origin":"human","created":"2026-07-29T14:58:51.237Z",
     "updated":"2026-07-29T14:58:51.237Z","body":"Some body text"}
    """
    let item = try! JSONDecoder().decode(Item.self, from: Data(json.utf8))
    assertEqual(item.id, "I-20260729145851-test-title")
    assertEqual(item.title, "Test title")
    assertEqual(item.status, "inbox")
    assertEqual(item.parsedStatus, .inbox)
    assertEqual(item.origin, "human")
    assertEqual(item.body, "Some body text")
}

test("item sem campos opcionais decodifica") {
    let json = "{\"id\":\"I-20260729000000-bare\"}"
    let item = try! JSONDecoder().decode(Item.self, from: Data(json.utf8))
    assertEqual(item.id, "I-20260729000000-bare")
    assertTrue(item.title == nil)
    assertTrue(item.parsedStatus == nil)
}

test("decodifica closed_at, labels e priority da saída real pós-T03") {
    // Copiado verbatim de `node scripts/forge-items.js --list --json`
    // (item criado, --set-priority p1, --update labels, --set-status done).
    let json = """
    [{"id":"I-20260730180758-test-title","title":"Test title","status":"done",
      "priority":"p1","labels":["bug","ui"],"origin":"human",
      "created":"2026-07-30T18:07:58.670Z","updated":"2026-07-30T18:07:59.007Z",
      "closed_at":"2026-07-30T18:07:59.009Z","body":""}]
    """
    let items = try! JSONDecoder().decode([Item].self, from: Data(json.utf8))
    let item = items[0]
    assertEqual(item.closed_at, "2026-07-30T18:07:59.009Z")
    assertEqual(item.priority, "p1")
    assertEqual(item.labels ?? [], ["bug", "ui"])
}

test("item legado sem closed_at/labels/priority decodifica com os três nil") {
    let json = """
    {"id":"I-20260729145851-test-title","title":"Test title","status":"inbox",
     "origin":"human","created":"2026-07-29T14:58:51.237Z",
     "updated":"2026-07-29T14:58:51.237Z","body":"Some body text"}
    """
    let item = try! JSONDecoder().decode(Item.self, from: Data(json.utf8))
    assertTrue(item.closed_at == nil, "item legado não tem closed_at")
    assertTrue(item.labels == nil, "item legado não tem labels — nil, não []")
    assertTrue(item.priority == nil, "item legado não tem priority")
}

test("labels vazio no JSON decodifica como array vazio, não nil") {
    let json = """
    {"id":"I-20260730000000-sem-labels","title":"Sem labels","status":"inbox",
     "labels":[]}
    """
    let item = try! JSONDecoder().decode(Item.self, from: Data(json.utf8))
    assertTrue(item.labels != nil, "labels: [] deve decodificar como array vazio, não nil")
    assertEqual(item.labels ?? ["sentinel"], [])
}

print("\nItems (card)")

// O critério #4 da milestone é uma CONTAGEM: onde o card mostra 3 coisas hoje,
// tem de mostrar 7. Estes testes são o que torna esse critério verificável sem
// olhar para uma tela — o target `Forge` não é importável daqui, então tudo o
// que decidisse conteúdo dentro de `ItemCard` ficaria fora de qualquer suíte.
//
// A ordem é asserida junto com a contagem de propósito: contar 7 não detecta
// uma troca de ordem, e a ordem é o que faz o card ler como issue.

/// Item com todos os campos que o card sabe desenhar — o "depois".
private func fullItem(status: String = "done") -> Item {
    Item(
        id: "I-20260730120000-completo",
        title: "Corrigir o parser de datas do progresso",
        status: status,
        source: "roadmap",
        body: "Primeiro parágrafo.\n\nSegundo parágrafo.\n\nTerceiro parágrafo.\n\nQuarto parágrafo.\n\nQuinto parágrafo.",
        closed_at: "2026-07-30T12:00:00.000Z",
        labels: ["bug", "ui"],
        priority: "p1"
    )
}

test("card denso: item completo desenha 3 elementos, na ordem canônica") {
    // Era 7 (critério #4, S04). O operador reverteu depois de ver num board
    // real: a 268pt, corpo de 3 linhas + id de 40 caracteres + origem + data
    // viram parágrafo, e cabiam ~3 cards na tela. Corpo/id/origem/data NÃO
    // sumiram — ver os dois testes de `cardTooltip` abaixo e o guard do sheet
    // em scripts/forge-app-items.test.js.
    let els = ItemCardPresentation.elements(for: fullItem())
    assertEqual(els.count, 3, "o card denso tem 3 elementos: título, labels, prioridade")

    guard els.count == 3 else { return }
    if case .title(let t) = els[0] { assertEqual(t, "Corrigir o parser de datas do progresso") }
    else { assertTrue(false, "elemento 0 deveria ser .title, veio \(els[0])") }
    if case .labels(let shown, let overflow) = els[1] {
        assertEqual(shown, ["bug", "ui"])
        assertEqual(overflow, 0)
    } else { assertTrue(false, "elemento 1 deveria ser .labels, veio \(els[1])") }
    if case .priority(let p) = els[2] { assertEqual(p, .p1) }
    else { assertTrue(false, "elemento 2 deveria ser .priority, veio \(els[2])") }
}

test("card denso: item legado desenha 1 elemento — só o título") {
    // O shape exato dos itens reais que o repo tem hoje: sem corpo, sem label,
    // sem prioridade, sem closed_at.
    let legacy = Item(id: "I-20260729145851-test-title", title: "Test title",
                      status: "inbox", source: "manual")
    let els = ItemCardPresentation.elements(for: legacy)
    assertEqual(els.count, 1, "sem label e sem prioridade, sobra só o título")
    if case .title = els[0] {} else { assertTrue(false, "0 deveria ser .title") }
}

test("dropped NÃO mostra data de fechamento, mesmo com closed_at gravado") {
    let dropped = fullItem(status: "dropped")
    assertNil(ItemCardPresentation.closedDay(dropped), "dropped nunca mostra 'fechado em' (S04-b)")
}

test("done sem closed_at (os itens legados do repo) não mostra data e não crasha") {
    let done = Item(id: "I-2", title: "Feito antigo", status: "done", source: "manual")
    assertNil(ItemCardPresentation.closedDay(done))
    assertEqual(ItemCardPresentation.elements(for: done).count, 1)
}

test("closedDay só aceita done — os outros três status também ficam de fora") {
    for s in ["inbox", "triaged", "doing"] {
        assertNil(ItemCardPresentation.closedDay(fullItem(status: s)),
                  "status \(s) não deve ter data de fechamento")
    }
    assertEqual(ItemCardPresentation.closedDay(fullItem(status: "done")), "2026-07-30")
}

test("closedDay aceita as três formas de data que o engine escreve") {
    func at(_ raw: String) -> Item { Item(id: "I-3", status: "done", closed_at: raw) }
    assertEqual(ItemCardPresentation.closedDay(at("2026-07-30T12:00:00.000Z")), "2026-07-30")
    assertEqual(ItemCardPresentation.closedDay(at("2026-07-30T12:00:00Z")), "2026-07-30")
    assertEqual(ItemCardPresentation.closedDay(at("2026-07-30")), "2026-07-30")
    assertNil(ItemCardPresentation.closedDay(at("ontem")), "forma não reconhecida vira nil, não crash")
}

test("bodyPreview corta em 3 linhas e sinaliza o corte") {
    let five = "um\ndois\ntrês\nquatro\ncinco"
    let p = ItemCardPresentation.bodyPreview(five)
    assertEqual(p?.text, "um\ndois\ntrês")
    assertEqual(p?.truncated, true)
}

test("bodyPreview de 2 linhas não sinaliza corte") {
    let p = ItemCardPresentation.bodyPreview("um\ndois")
    assertEqual(p?.text, "um\ndois")
    assertEqual(p?.truncated, false)
}

test("bodyPreview descarta linhas em branco antes de contar as 3") {
    let p = ItemCardPresentation.bodyPreview("um\n\n\ndois\n\ntrês")
    assertEqual(p?.text, "um\ndois\ntrês")
    assertEqual(p?.truncated, false, "linha em branco não conta como conteúdo cortado")
}

test("bodyPreview devolve nil para corpo ausente, vazio ou só espaço") {
    assertNil(ItemCardPresentation.bodyPreview(nil))
    assertNil(ItemCardPresentation.bodyPreview(""))
    assertNil(ItemCardPresentation.bodyPreview("   \n\n  \n"))
}

test("labelChips corta em 3 e reporta o overflow, preservando a ordem do engine") {
    let c = ItemCardPresentation.labelChips(["zeta", "alpha", "meio", "quarto", "quinto"])
    assertEqual(c?.shown ?? [], ["zeta", "alpha", "meio"], "ordem é a do disco, não alfabética")
    assertEqual(c?.overflow, 2)
}

test("labelChips com 1 label não tem overflow; vazio e nil somem") {
    assertEqual(ItemCardPresentation.labelChips(["bug"])?.overflow, 0)
    assertEqual(ItemCardPresentation.labelChips(["bug"])?.shown ?? [], ["bug"])
    assertNil(ItemCardPresentation.labelChips([]))
    assertNil(ItemCardPresentation.labelChips(nil))
    assertNil(ItemCardPresentation.labelChips(["", "   "]), "só espaço não é label")
}

test("prioridade: parse dos quatro valores, marca e rótulo pt-BR") {
    assertEqual(ItemPriority.parse("p0"), .p0)
    assertEqual(ItemPriority.parse("p1"), .p1)
    assertEqual(ItemPriority.parse("p2"), .p2)
    assertEqual(ItemPriority.parse("p3"), .p3)
    assertEqual(ItemPriority.p0.mark, "P0")
    assertEqual(ItemPriority.p3.mark, "P3")
    assertEqual(ItemPriority.p0.label, "crítica")
    assertEqual(ItemPriority.p1.label, "alta")
    assertEqual(ItemPriority.p2.label, "média")
    assertEqual(ItemPriority.p3.label, "baixa")
}

test("prioridade desconhecida vira nil e some do card — nada é inventado") {
    assertNil(ItemPriority.parse("lixo"))
    assertNil(ItemPriority.parse(nil))
    assertNil(ItemPriority.parse("P0"), "o valor do engine é minúsculo; não normalizamos aqui")
    let item = Item(id: "I-4", title: "t", status: "inbox", priority: "lixo")
    let els = ItemCardPresentation.elements(for: item)
    assertFalse(els.contains { if case .priority = $0 { return true } else { return false } },
                "prioridade desconhecida não desenha marca nenhuma")
}

test("título vazio cai no fallback e continua sempre presente") {
    let els = ItemCardPresentation.elements(for: Item(id: "I-5", title: "   ", status: "inbox"))
    if case .title(let t) = els[0] { assertEqual(t, "(sem título)") }
    else { assertTrue(false, "título sempre presente, mesmo em branco") }
}

// S04 review (R2): the card view and the detail sheet used to each write
// their own `item.title ?? "(sem título)"`, which let a whitespace-only
// title (present, but only spaces) through unfiltered — `elements(for:)`
// already normalised that case, but the raw views did not. `displayTitle`
// is the single function both views now call; these tests pin its contract
// directly, independent of `elements(for:)`.
test("displayTitle: título normal passa direto") {
    let item = Item(id: "I-6", title: "Corrigir bug", status: "inbox")
    assertEqual(ItemCardPresentation.displayTitle(item), "Corrigir bug")
}

test("displayTitle: título ausente cai no fallback") {
    let item = Item(id: "I-7", status: "inbox")
    assertEqual(ItemCardPresentation.displayTitle(item), "(sem título)")
}

test("displayTitle: título só de espaços cai no fallback — não é 'presente'") {
    let item = Item(id: "I-8", title: "   ", status: "inbox")
    assertEqual(ItemCardPresentation.displayTitle(item), "(sem título)")
}

test("displayTitle: espaços nas bordas de um título real são aparados") {
    let item = Item(id: "I-9", title: "  com espaços  ", status: "inbox")
    assertEqual(ItemCardPresentation.displayTitle(item), "com espaços")
}

print("\nNodeLocator (descoberta de node fora dos três caminhos fixos)")

// Fake probe: the filesystem is a set of executable paths and a directory map,
// so the search order is exercised without depending on what this machine has
// installed. `pathVar` defaults to launchd's minimal PATH — the exact
// environment a GUI app inherits from Finder, where the old `/usr/bin/env node`
// fallback died with "env: node: No such file or directory".
let launchdPath = "/usr/bin:/bin:/usr/sbin:/sbin"

func fakeProbe(home: String = "/Users/tester",
               executables: Set<String> = [],
               dirs: [String: [String]] = [:],
               files: [String: String] = [:],
               envOverride: String? = nil,
               prefValue: String? = nil,
               pathVar: String = launchdPath,
               shell: @escaping () -> String? = { nil }) -> NodeLocator.Probe {
    NodeLocator.Probe(
        home: home,
        envOverride: envOverride,
        prefValue: prefValue,
        pathVar: pathVar,
        isExecutable: { executables.contains($0) },
        listDir: { dirs[$0] ?? [] },
        readFile: { files[$0] },
        loginShell: shell)
}

test("encontra node do nvm sem versão hardcoded (árvore sintética)") {
    let home = "/Users/tester"
    let root = "\(home)/.nvm/versions/node"
    let probe = fakeProbe(
        home: home,
        executables: ["\(root)/v20.9.0/bin/node", "\(root)/v24.11.1/bin/node"],
        dirs: [root: ["v20.9.0", "v24.11.1"]])
    assertEqual(NodeLocator.resolve(probe).path, "\(root)/v24.11.1/bin/node",
                "deve escolher a maior versão instalada")
    assertEqual(NodeLocator.resolve(probe).source, NodeLocator.Source.versionManager)
}

test("nvm: alias/default vence a maior versão") {
    let home = "/Users/tester"
    let root = "\(home)/.nvm/versions/node"
    let probe = fakeProbe(
        home: home,
        executables: ["\(root)/v20.9.0/bin/node", "\(root)/v24.11.1/bin/node"],
        dirs: [root: ["v20.9.0", "v24.11.1"]],
        files: ["\(home)/.nvm/alias/default": "v20.9.0\n"])
    assertEqual(NodeLocator.resolve(probe).path, "\(root)/v20.9.0/bin/node")
}

test("nvm: alias parcial (\"20\") resolve para a maior v20.x") {
    let home = "/Users/tester"
    let root = "\(home)/.nvm/versions/node"
    let probe = fakeProbe(
        home: home,
        executables: ["\(root)/v20.9.0/bin/node", "\(root)/v20.11.0/bin/node",
                      "\(root)/v24.11.1/bin/node"],
        dirs: [root: ["v20.9.0", "v20.11.0", "v24.11.1"]],
        files: ["\(home)/.nvm/alias/default": "20"])
    assertEqual(NodeLocator.resolve(probe).path, "\(root)/v20.11.0/bin/node")
}

test("ordenação de versões é numérica, não lexicográfica") {
    assertEqual(NodeLocator.highestVersion(["v9.11.2", "v10.0.0"]), "v10.0.0")
}

test("fnm, asdf, mise e volta também são encontrados") {
    let home = "/Users/tester"
    let cases: [(String, [String: [String]])] = [
        ("\(home)/.local/share/fnm/aliases/default/bin/node", [:]),
        ("\(home)/.asdf/shims/node", [:]),
        ("\(home)/.local/share/mise/shims/node", [:]),
        ("\(home)/.volta/bin/node", [:]),
        ("\(home)/.asdf/installs/nodejs/24.11.1/bin/node",
         ["\(home)/.asdf/installs/nodejs": ["24.11.1"]]),
    ]
    for (path, dirs) in cases {
        let r = NodeLocator.resolve(fakeProbe(home: home, executables: [path], dirs: dirs))
        assertEqual(r.path, path, "não encontrou \(path)")
    }
}

test("PATH mínimo do launchd NÃO produz /usr/bin/env silenciosamente") {
    // O bug original: sem nenhum node instalado nos caminhos fixos, o app
    // devolvia "/usr/bin/env" e a falha só aparecia no exec, como
    // `env: node: No such file or directory`.
    let outcome = NodeLocator.resolve(fakeProbe())
    switch outcome {
    case .found(let r):
        assertTrue(false, "não deveria resolver nada, obteve \(r.path)")
    case .notFound(let tried):
        assertFalse(tried.isEmpty, "o diagnóstico deve listar onde procurou")
        let msg = NodeLocator.notFoundMessage(tried: tried)
        assertTrue(msg.contains("FORGE_NODE_PATH"), "a mensagem deve nomear o override")
        assertTrue(msg.contains("node_path"), "a mensagem deve nomear a pref")
        assertFalse(msg.contains("No such file or directory"), "não é a mensagem do env")
    }
    assertTrue(outcome.path == nil, "nenhum caminho deve ser reportado")
    assertFalse("\(outcome)".contains("/usr/bin/env"), "/usr/bin/env nunca é resposta")
}

test("override do operador vence tudo") {
    let home = "/Users/tester"
    let probe = fakeProbe(home: home,
                          executables: ["/opt/homebrew/bin/node", "/custom/node"],
                          envOverride: "/custom/node")
    assertEqual(NodeLocator.resolve(probe).path, "/custom/node")
    assertEqual(NodeLocator.resolve(probe).source, NodeLocator.Source.envOverride)

    let prefProbe = fakeProbe(home: home,
                              executables: ["/opt/homebrew/bin/node", "/pref/node"],
                              prefValue: "/pref/node")
    assertEqual(NodeLocator.resolve(prefProbe).source, NodeLocator.Source.pref)
}

test("override quebrado é reportado, não contornado em silêncio") {
    // Contornar deixaria o operador sem sinal de que a config dele foi ignorada.
    let probe = fakeProbe(executables: ["/opt/homebrew/bin/node"], envOverride: "/nao/existe/node")
    let outcome = NodeLocator.resolve(probe)
    assertTrue(outcome.path == nil, "override inválido não deve cair no caminho fixo")
    if case .notFound(let tried) = outcome {
        assertTrue(tried.contains(where: { $0.contains("/nao/existe/node") }),
                   "o diagnóstico deve citar o valor inválido")
    }
}

test("caminhos fixos continuam valendo e vêm antes de gerenciadores") {
    let home = "/Users/tester"
    let nvm = "\(home)/.nvm/versions/node/v24.11.1/bin/node"
    let probe = fakeProbe(home: home,
                          executables: ["/opt/homebrew/bin/node", nvm],
                          dirs: ["\(home)/.nvm/versions/node": ["v24.11.1"]])
    assertEqual(NodeLocator.resolve(probe).path, "/opt/homebrew/bin/node")
    assertEqual(NodeLocator.resolve(probe).source, NodeLocator.Source.fixed)
}

test("$PATH e shell de login servem de rede de segurança") {
    let onPath = NodeLocator.resolve(fakeProbe(executables: ["/opt/tools/bin/node"],
                                               pathVar: "/opt/tools/bin:/usr/bin"))
    assertEqual(onPath.path, "/opt/tools/bin/node")
    assertEqual(onPath.source, NodeLocator.Source.pathScan)

    let viaShell = NodeLocator.resolve(fakeProbe(executables: ["/from/shell/node"],
                                                 shell: { "/from/shell/node\n" }))
    assertEqual(viaShell.path, "/from/shell/node")
    assertEqual(viaShell.source, NodeLocator.Source.loginShell)

    // Resposta do shell apontando para nada não é aceita.
    let bogus = NodeLocator.resolve(fakeProbe(shell: { "/nao/existe/node" }))
    assertTrue(bogus.path == nil)
}

test("systemProbe encontra nvm numa árvore real em disco (não a desta máquina)") {
    // O teste acima usa um filesystem falso; este exercita os closures reais
    // (contentsOfDirectory / isExecutableFile) contra um $HOME sintético, que é
    // onde um erro de layout apareceria.
    let fm = FileManager.default
    let home = NSTemporaryDirectory() + "forge-node-\(UUID().uuidString.prefix(8))"
    defer { try? fm.removeItem(atPath: home) }
    for v in ["v18.20.4", "v24.11.1"] {
        let bin = "\(home)/.nvm/versions/node/\(v)/bin"
        try fm.createDirectory(atPath: bin, withIntermediateDirectories: true)
        try "#!/bin/sh\necho \(v)\n".write(toFile: "\(bin)/node", atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: "\(bin)/node")
    }
    // PATH mínimo do launchd + $SHELL ausente: só o nvm pode responder.
    let probe = NodeLocator.systemProbe(environment: ["PATH": launchdPath],
                                        home: home, prefValue: nil, shellTimeout: 1)
    let outcome = NodeLocator.resolve(probe)
    assertEqual(outcome.path, "\(home)/.nvm/versions/node/v24.11.1/bin/node")
    assertEqual(outcome.source, NodeLocator.Source.versionManager)
}

test("systemProbe lê node_path das prefs e FORGE_NODE_PATH do ambiente") {
    let probe = NodeLocator.systemProbe(
        environment: ["FORGE_NODE_PATH": "/env/node", "PATH": launchdPath],
        home: "/Users/tester", prefValue: "/pref/node")
    assertEqual(probe.envOverride, "/env/node")
    assertEqual(probe.prefValue, "/pref/node")
    assertEqual(probe.pathVar, launchdPath)
}

test("node_path é lido do JSONC ignorando a linha comentada") {
    let jsonc = """
    {
      // "node_path": "/comentado/node",
      "node_path": "/real/node"
    }
    """
    assertEqual(PrefsLocator.parseString(jsonc, key: "node_path"), "/real/node")
}

// TerminalRegistry / TerminalLifecycle / TerminalFocus —
// terminals survive navigation and never replay the bootstrap.

print("\nTerminalRegistry (uma sessão, um terminal vivo)")

/// Stand-in for the AppKit terminal: counts how often it would have been
/// spawned, which is the whole thing under test.
final class FakeTerminal {
    let tag: String
    static var made = 0
    init(tag: String) { self.tag = tag; FakeTerminal.made += 1 }
}

test("adopt cria uma vez e devolve a mesma instância nas rebuilds seguintes") {
    FakeTerminal.made = 0
    let registry = TerminalRegistry<FakeTerminal>()
    let id = UUID()

    let first = registry.adopt(id) { FakeTerminal(tag: "a") }
    // Three more rebuilds: navegar pra fora e voltar, duas vezes.
    let second = registry.adopt(id) { FakeTerminal(tag: "b") }
    let third = registry.adopt(id) { FakeTerminal(tag: "c") }

    assertEqual(FakeTerminal.made, 1, "o processo foi criado mais de uma vez")
    assertTrue(first.isNew, "a primeira adoção deveria ser nova")
    assertFalse(second.isNew, "a segunda adoção não é nova")
    assertTrue(second.entry === first.entry, "devolveu outro terminal na volta")
    assertTrue(third.entry === first.entry, "devolveu outro terminal na volta")
    assertEqual(registry.count, 1)
}

test("sessões diferentes têm terminais diferentes, chaveados pelo id") {
    FakeTerminal.made = 0
    let registry = TerminalRegistry<FakeTerminal>()
    let a = UUID(), b = UUID()
    let ta = registry.adopt(a) { FakeTerminal(tag: "a") }.entry
    let tb = registry.adopt(b) { FakeTerminal(tag: "b") }.entry
    assertFalse(ta === tb, "duas sessões compartilharam um terminal")
    assertEqual(registry.count, 2)
    assertEqual(registry.entry(for: a)?.tag, "a")
    assertEqual(registry.entry(for: b)?.tag, "b")
}

test("claimBootstrap só concede uma vez — a primeira mensagem não é reenviada") {
    let registry = TerminalRegistry<FakeTerminal>()
    let id = UUID()
    registry.adopt(id) { FakeTerminal(tag: "a") }

    assertTrue(registry.claimBootstrap(for: id), "o primeiro envio deveria ser permitido")
    assertFalse(registry.claimBootstrap(for: id), "a volta reenviaria a primeira mensagem")
    assertFalse(registry.claimBootstrap(for: id))
    assertTrue(registry.hasBootstrapped(id))
}

test("claimBootstrap sobre id desconhecido é negado, não cria slot") {
    let registry = TerminalRegistry<FakeTerminal>()
    assertFalse(registry.claimBootstrap(for: UUID()))
    assertEqual(registry.count, 0)
}

test("discard devolve o terminal para o chamador encerrar e libera a chave") {
    let registry = TerminalRegistry<FakeTerminal>()
    let id = UUID()
    let made = registry.adopt(id) { FakeTerminal(tag: "a") }.entry
    let dropped = registry.discard(id)
    assertTrue(dropped === made, "discard devolveu outro objeto")
    assertEqual(registry.count, 0)
    assertTrue(registry.discard(id) == nil, "discard duplo deveria ser nil")
}

test("uma sessão reaberta depois do discard bootstrapa de novo") {
    let registry = TerminalRegistry<FakeTerminal>()
    let id = UUID()
    registry.adopt(id) { FakeTerminal(tag: "a") }
    assertTrue(registry.claimBootstrap(for: id))
    registry.discard(id)
    registry.adopt(id) { FakeTerminal(tag: "a2") }
    assertTrue(registry.claimBootstrap(for: id), "sessão nova não conseguiu bootstrapar")
}

print("\nTerminalLifecycle (sair da tela não é fechar a sessão)")

test("view desmontada mantém o processo vivo") {
    assertEqual(TerminalLifecycle.action(for: .viewDismantled), .keepAlive)
}

test("fechar a sessão encerra e descarta") {
    assertEqual(TerminalLifecycle.action(for: .sessionClosed), .terminateAndDiscard)
}

print("\nTerminalFocus (qual sessão a tela mostra)")

test("a seleção vale enquanto a sessão existir") {
    let a = UUID(), b = UUID()
    assertEqual(TerminalFocus.resolve(selection: b, among: [a, b]), b)
    assertEqual(TerminalFocus.resolve(selection: nil, among: [a, b]), a)
    assertEqual(TerminalFocus.resolve(selection: UUID(), among: [a, b]), a)
    assertTrue(TerminalFocus.resolve(selection: a, among: []) == nil)
}

test("fechar uma aba em segundo plano não move o foco") {
    let a = UUID(), b = UUID()
    assertEqual(TerminalFocus.afterClosing(b, selection: a, remaining: [a]), a)
}

test("fechar a aba visível cai na primeira restante") {
    let a = UUID(), b = UUID()
    assertEqual(TerminalFocus.afterClosing(a, selection: a, remaining: [b]), b)
    assertTrue(TerminalFocus.afterClosing(a, selection: a, remaining: []) == nil)
}

// UpdateCore — the installer's output, and when a relaunch is allowed.

print("\nAtualização — saída do instalador")

/// Classify one line with a fresh tracker.
func classify(_ line: String) -> InstallerLine {
    var t = InstallerPhaseTracker()
    return t.consume(line)
}

test("linha com marcador ▸ do build.sh é fase (a fase mais longa da atualização)") {
    assertEqual(classify("▸ Compilando (swift build, SwiftTerm)"),
                .phase("Compilando (swift build, SwiftTerm)"),
                "sem isso a barra fica travada durante minutos de swift build")
    assertEqual(InstallerLabels.label(for: "Compilando (swift build, SwiftTerm)"),
                "compilando o app")
}

test("linha com 2 espaços é fase; com 4 é detalhe") {
    assertEqual(classify("  Installing skills..."), .phase("Installing skills..."))
    assertEqual(classify("    forge-auto"), .detail("    forge-auto"))
}

test("saída crua do SwiftPM (sem indentação) é detalhe") {
    assertEqual(classify("[14/16] Compiling Forge Stores.swift"),
                .detail("[14/16] Compiling Forge Stores.swift"))
    assertEqual(classify("Build complete! (6.06s)"), .detail("Build complete! (6.06s)"))
}

test("o marcador vence a indentação — ✓ com sub-item ainda é fase") {
    assertEqual(classify("✓   hooks sincronizados em settings.json"),
                .phase("hooks sincronizados em settings.json"))
}

test("⚠ é fase, não detalhe") {
    assertEqual(classify("⚠ swift não encontrado"), .phase("swift não encontrado"))
}

test("linha vazia é detalhe vazio") {
    assertEqual(classify(""), .detail(""))
    assertEqual(classify("\n"), .detail(""))
}

test("\\r é removido antes de classificar") {
    assertEqual(classify("  Installing scripts...\r\n"), .phase("Installing scripts..."))
}

test("a linha de sucesso encerra e vira 'concluído'") {
    var t = InstallerPhaseTracker()
    assertEqual(t.consume("✓ Forge Agent instalado com sucesso!"), .finished("concluído"))
}

test("Próximos passos DEPOIS do sucesso é detalhe, não a última fase") {
    var t = InstallerPhaseTracker()
    _ = t.consume("✓ Forge Agent instalado com sucesso!")
    assertEqual(t.consume("  Próximos passos:"), .detail("  Próximos passos:"))
    assertEqual(t.consume("  Ajuda a qualquer momento:   /forge-help"),
                .detail("  Ajuda a qualquer momento:   /forge-help"),
                "o último rótulo não pode ser uma instrução de onboarding")
}

test("✓ Forge.app instalado em /Applications é fase legítima, antes do marco final") {
    var t = InstallerPhaseTracker()
    assertEqual(t.consume("✓ Forge.app instalado em /Applications"),
                .phase("Forge.app instalado em /Applications"))
    assertEqual(InstallerLabels.label(for: "Forge.app instalado em /Applications"),
                "app instalado")
}

print("\nAtualização — rótulos em PT")

test("as fases conhecidas ganham rótulo em português") {
    assertEqual(InstallerLabels.label(for: "Backup saved to ~/.claude.bak"), "fazendo backup")
    assertEqual(InstallerLabels.label(for: "Installing agents..."), "copiando agentes")
    assertEqual(InstallerLabels.label(for: "Installing dispatch templates..."),
                "copiando templates de dispatch")
    assertEqual(InstallerLabels.label(for: "Verificando disponibilidade de claude-opus-5..."),
                "verificando modelos")
    assertEqual(InstallerLabels.label(for: "Installing preferences..."), "instalando preferências")
    assertEqual(InstallerLabels.label(for: "MCPs globais (Tier 1 — zero-config)"),
                "configurando MCPs")
    assertEqual(InstallerLabels.label(for: "Building the macOS app..."), "compilando o app")
    assertEqual(InstallerLabels.label(for: "Instalando em /Applications"),
                "instalando em /Applications")
}

test("rótulo desconhecido degrada para a frase crua, sem parar a barra") {
    assertEqual(InstallerLabels.label(for: "Doing something brand new..."),
                "Doing something brand new...")
}

print("\nAtualização — relaunch e bundle")

test("só o exit 0 autoriza o relaunch") {
    assertTrue(UpdateOutcome.canRelaunch(exitCode: 0))
    assertFalse(UpdateOutcome.canRelaunch(exitCode: 1))
    assertFalse(UpdateOutcome.canRelaunch(exitCode: 128))
}

test("a mensagem de falha carrega o código e a cauda do log") {
    let msg = UpdateOutcome.failureMessage(
        exitCode: 1, lastLines: ["a", "", "b", "c", "d"])
    assertTrue(msg.contains("código 1"), "sem o código: \(msg)")
    assertTrue(msg.contains("d"), "sem a última linha: \(msg)")
    assertFalse(msg.contains("\na\n"), "levou mais de três linhas: \(msg)")
}

test("bundle canônico não gera aviso; um build de dev gera") {
    assertTrue(RelaunchTarget.divergenceNote(for: "/Applications/Forge.app") == nil)
    assertTrue(RelaunchTarget.divergenceNote(for: "/Applications/Forge.app/") == nil,
               "barra final não deveria contar como divergência")
    let note = RelaunchTarget.divergenceNote(for: "/Users/dev/forge-agent/app/build/Forge.app")
    assertTrue(note != nil, "um bundle fora de /Applications tem que avisar")
    assertTrue(note?.contains("/Users/dev/forge-agent/app/build/Forge.app") ?? false,
               "o aviso tem que dizer QUAL bundle vai reabrir")
}

print("\nAtualização — restauração de seção e pré-checagem do git")

test("RemoteRelease escolhe a maior tag semver estável do ls-remote") {
    let refs = """
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v4.9.0
    bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/tags/v4.10.0
    cccccccccccccccccccccccccccccccccccccccc\trefs/tags/v4.10.0^{}
    dddddddddddddddddddddddddddddddddddddddd\trefs/tags/v5.0.0-beta.1
    """
    assertEqual(RemoteRelease.latestTag(from: refs), "v4.10.0")
    assertTrue(RemoteRelease.latestTag(from: nil) == nil)
}

test("versão instalada vem do manifest mesmo com clone defasado") {
    let manifest = Data(#"{"runtime":"codex","version":"4.21.2"}"#.utf8)
    assertEqual(InstalledForgeVersion.resolve(manifestData: manifest, cloneVersion: "v4.20.0"),
                "4.21.2")
}

test("versão instalada funciona sem checkout e clone é apenas fallback") {
    let manifest = Data(#"{"version":" 4.21.2 \n"}"#.utf8)
    assertEqual(InstalledForgeVersion.resolve(manifestData: manifest, cloneVersion: nil), "4.21.2")
    assertEqual(InstalledForgeVersion.resolve(manifestData: nil, cloneVersion: " v4.20.0\n"),
                "v4.20.0")
    assertTrue(InstalledForgeVersion.resolve(manifestData: Data(#"{"version":42}"#.utf8),
                                             cloneVersion: nil) == nil)
}

test("FORGE_HOME segue exatamente o override efetivo do updater") {
    assertEqual(InstalledForgeVersion.forgeHome(environment: [:], home: "/Users/dev"),
                "/Users/dev/.forge-agent")
    assertEqual(InstalledForgeVersion.forgeHome(
        environment: ["FORGE_HOME": "/Volumes/Forge/runtime"], home: "/Users/dev"),
        "/Volumes/Forge/runtime")
    assertEqual(InstalledForgeVersion.forgeHome(
        environment: ["FORGE_HOME": "runtime/forge"], home: "/Users/dev"),
        "/Users/dev/runtime/forge")
    assertEqual(InstalledForgeVersion.forgeHome(
        environment: ["FORGE_HOME": ""], home: "/Users/dev"),
        "/Users/dev/.forge-agent")
}

test("SectionRestore devolve o raw válido e cai no fallback no resto") {
    let valid = ["Início", "Atualizações", "Terminal"]
    assertEqual(SectionRestore.resolve(rawValue: "Atualizações", valid: valid, fallback: "Início"),
                "Atualizações")
    assertEqual(SectionRestore.resolve(rawValue: nil, valid: valid, fallback: "Início"), "Início")
    assertEqual(SectionRestore.resolve(rawValue: "", valid: valid, fallback: "Início"), "Início")
    assertEqual(SectionRestore.resolve(rawValue: "Seção Renomeada", valid: valid, fallback: "Início"),
                "Início",
                "um label renomeado invalida a preferência gravada")
}

test("a pré-checagem distingue árvore suja de branch divergente") {
    assertTrue(UpdatePrecheck.evaluate(dirty: false, ahead: 0, pulls: true) == nil)
    assertEqual(UpdatePrecheck.evaluate(dirty: true, ahead: 0, pulls: true), .dirtyTree)
    assertEqual(UpdatePrecheck.evaluate(dirty: false, ahead: 2, pulls: true), .diverged)
    assertEqual(UpdatePrecheck.evaluate(dirty: true, ahead: 2, pulls: true), .dirtyTree,
                "sujo vence: é o caso mais perigoso de 'resolver' sozinho")
}

test("reinstalar nunca é bloqueado por estado de git") {
    assertTrue(UpdatePrecheck.evaluate(dirty: true, ahead: 3, pulls: false) == nil,
               "sem pull não existe o dano que a checagem previne — bloquear aqui "
               + "impediria a afordance exatamente na máquina que ela desbloqueia")
    assertEqual(UpdatePrecheck.evaluate(dirty: true, ahead: 0, pulls: true), .dirtyTree,
                "o caminho que puxa não mudou")
}

test("o comando de atualizar usa o updater instalado, com --apply e --with-app") {
    let cmd = InstallerCommand.build(repo: "/Users/dev/forge-agent", mode: .update, nodePath: nil)
    assertTrue(cmd.contains("--apply"), "sem --apply: \(cmd)")
    assertTrue(cmd.contains("--with-app"),
               "sem --with-app o app atualizaria tudo menos ele mesmo: \(cmd)")
    assertFalse(cmd.contains("--source local"), "update remoto virou fonte local: \(cmd)")
    assertFalse(cmd.contains("git"), "update voltou a puxar o clone local: \(cmd)")
    assertTrue(cmd.contains("${FORGE_HOME:-$HOME/.forge-agent}/scripts/forge-update.js"),
               "update não usa o updater instalado: \(cmd)")
    assertFalse(cmd.contains("/Users/dev/forge-agent/install.sh"),
                "update depende do install.sh do repo: \(cmd)")
}

test("o comando de reinstalar seleciona explicitamente o repo local") {
    let cmd = InstallerCommand.build(repo: "/Users/dev/forge-agent", mode: .reinstall, nodePath: nil)
    assertTrue(cmd.contains("--apply"), "sem --apply: \(cmd)")
    assertTrue(cmd.contains("--with-app"),
               "sem --with-app o app reinstalaria tudo menos ele mesmo: \(cmd)")
    assertFalse(cmd.contains("git"), "a reinstalação executa git: \(cmd)")
    assertFalse(cmd.contains("pull"), "a reinstalação puxa: \(cmd)")
    assertTrue(cmd.contains("--source local --repo '/Users/dev/forge-agent'"),
               "a reinstalação não fixa a fonte local: \(cmd)")
}

test("os dois modos diferem só pela seleção explícita da fonte local") {
    let repo = "/Users/dev/forge-agent"
    let update = InstallerCommand.build(repo: repo, mode: .update, nodePath: nil)
    let reinstall = InstallerCommand.build(repo: repo, mode: .reinstall, nodePath: nil)
    assertTrue(reinstall.hasPrefix(update),
               "atualizar tem que ser exatamente a cabeça de reinstalar — se divergir, "
               + "um dos dois botões instala algo diferente do outro:\n\(update)\n\(reinstall)")
    assertEqual(reinstall, update + " --source local --repo '\(repo)'",
                "reinstall deve apenas tornar local a fonte do mesmo updater")
}

test("os comandos quotam um repo com espaço") {
    let cmd = InstallerCommand.build(repo: "/Users/dev/My Projects/forge-agent", mode: .reinstall, nodePath: nil)
    assertTrue(cmd.contains("${FORGE_HOME:-$HOME/.forge-agent}/scripts/forge-update.js"),
               "o updater instalado não foi usado: \(cmd)")
    assertTrue(cmd.contains("--repo '/Users/dev/My Projects/forge-agent'"),
               "o argumento --repo não foi quotado: \(cmd)")
}

test("o comando do instalador põe o node resolvido no PATH") {
    // O app roda o comando por `bash -lc` herdando o PATH mínimo do launchd
    // (/usr/bin:/bin:/usr/sbin:/sbin), onde um node de gerenciador de versão
    // não existe. Sem este prefixo o `exec node` do install.sh saía 127 e o app
    // só dizia "a atualização falhou (código 127)" (medido em 2026-08-20, v4.18.0).
    let node = "/Users/dev/.nvm/versions/node/v24.16.0/bin/node"
    let cmd = InstallerCommand.build(repo: "/Users/dev/forge-agent", mode: .update, nodePath: node)
    assertTrue(cmd.contains("PATH='/Users/dev/.nvm/versions/node/v24.16.0/bin':\"$PATH\""),
               "o diretório do node resolvido não foi prefixado no PATH: \(cmd)")
    assertTrue(cmd.contains("node \"${FORGE_HOME:-$HOME/.forge-agent}/scripts/forge-update.js\""),
               "o prefixo comeu a invocação do updater: \(cmd)")
}

test("o prefixo de PATH preserva a relação entre update e reinstall") {
    let repo = "/Users/dev/forge-agent"
    let node = "/opt/homebrew/bin/node"
    let update = InstallerCommand.build(repo: repo, mode: .update, nodePath: node)
    let reinstall = InstallerCommand.build(repo: repo, mode: .reinstall, nodePath: node)
    assertEqual(reinstall, update + " --source local --repo '\(repo)'",
                "com node resolvido os modos devem diferir só pela fonte local:\n\(update)\n\(reinstall)")
    assertTrue(update.hasPrefix("PATH='/opt/homebrew/bin':\"$PATH\" node "),
               "o node resolvido não ficou disponível para o updater: \(update)")
}

test("um repo com aspas no caminho do node é escapado") {
    let cmd = InstallerCommand.build(repo: "/Users/dev/forge-agent", mode: .reinstall,
                                     nodePath: "/Users/dev/it's/bin/node")
    assertTrue(cmd.contains("PATH='/Users/dev/it'\\''s/bin':\"$PATH\""),
               "a aspa simples no diretório do node não foi escapada: \(cmd)")
}

test("sem node resolvido o comando usa o node disponível no ambiente") {
    for node in [nil, ""] {
        let cmd = InstallerCommand.build(repo: "/Users/dev/forge-agent", mode: .reinstall, nodePath: node)
        assertFalse(cmd.contains("PATH="), "nodePath \(node ?? "nil") produziu prefixo de PATH: \(cmd)")
        assertTrue(cmd.hasPrefix("node "), "o comando cru deixou de começar pelo node: \(cmd)")
    }
}

test("o comando manual só inspeciona — nunca stash, reset ou rebase") {
    let cmd = UpdatePrecheck.manualCommand(repo: "/Users/dev/forge-agent")
    assertTrue(cmd.contains("/Users/dev/forge-agent"), "sem o repo: \(cmd)")
    assertTrue(cmd.contains("git status"), "sem git status: \(cmd)")
    for forbidden in ["stash", "reset", "rebase", "checkout"] {
        assertFalse(cmd.contains(forbidden), "o comando sugere \(forbidden): \(cmd)")
    }
}

test("o comando manual escapa um repo com espaço no caminho") {
    let cmd = UpdatePrecheck.manualCommand(repo: "/Users/dev/My Projects/forge-agent")
    assertTrue(cmd.contains("'/Users/dev/My Projects/forge-agent'"),
               "o caminho com espaço não foi quotado: \(cmd)")
}

test("ShellQuote.posix escapa aspas simples embutidas") {
    assertEqual(ShellQuote.posix("simple"), "'simple'")
    assertEqual(ShellQuote.posix("has space"), "'has space'")
    assertEqual(ShellQuote.posix("it's"), "'it'\\''s'")
}

test("a mensagem de bloqueio explica que a recusa é proteção") {
    for blocker in [UpdatePrecheck.Blocker.dirtyTree, .diverged] {
        let m = UpdatePrecheck.message(for: blocker)
        assertGreater(m.count, 40, "mensagem curta demais para explicar: \(m)")
        assertFalse(m.contains("stash"), "a mensagem sugere stash: \(m)")
    }
}

// MARK: - VersionFooter (D25 UI side, R9)

// The property under test is "the footer does not lie". Three states are real
// and reachable TODAY, before any stamping exists: unstamped (no bundle key at
// all), stamped-and-in-sync, and stamped-but-the-repo-moved.

test("short encurta um describe com sufixo de commits") {
    assertEqual(VersionFooter.short("v3.1.4-6-g63af17e"), "v3.1.4+6")
    assertEqual(VersionFooter.short("v3.1.4-7-gabc1234"), "v3.1.4+7")
    assertEqual(VersionFooter.short("v1.36.0-142-gdeadbee"), "v1.36.0+142")
}

test("short devolve uma tag sem sufixo inalterada") {
    assertEqual(VersionFooter.short("v3.1.4"), "v3.1.4")
    assertEqual(VersionFooter.short("3.1.4"), "3.1.4")
}

test("short não estraga uma tag pré-release") {
    // Duas componentes, nenhuma contagem: nada a encurtar.
    assertEqual(VersionFooter.short("v3.0.0-beta"), "v3.0.0-beta")
    assertEqual(VersionFooter.short("v3.0.0-rc.1"), "v3.0.0-rc.1")
    // Com sufixo de verdade, o hífen do pré-release fica no lugar.
    assertEqual(VersionFooter.short("v3.0.0-beta-6-gabc1234"), "v3.0.0-beta+6")
}

test("short devolve verbatim qualquer coisa que não seja forma de git describe") {
    // Sem `g` no sha, sem contagem numérica, sem tag: nada é adivinhado.
    assertEqual(VersionFooter.short("v3.1.4-6-63af17e"), "v3.1.4-6-63af17e")
    assertEqual(VersionFooter.short("v3.1.4-seis-g63af17e"), "v3.1.4-seis-g63af17e")
    assertEqual(VersionFooter.short("-6-g63af17e"), "-6-g63af17e")
    assertEqual(VersionFooter.short(""), "")
}

test("stamped: a sentinela é a AUSÊNCIA da chave, nunca o literal 0.1.0") {
    assertNil(VersionFooter.stamped(nil), "chave ausente tem de virar nil")
    assertNil(VersionFooter.stamped(""), "chave vazia é informação ausente")
    assertNil(VersionFooter.stamped("   \n"), "chave só com espaço é informação ausente")
    // `0.1.0` é o placeholder do Info.plist versionado — e também uma versão
    // perfeitamente legítima. Filtrá-la aqui apagaria o rodapé de quem a
    // publicasse de verdade, e ninguém acharia a causa.
    assertEqual(VersionFooter.stamped("0.1.0"), "0.1.0")
    assertEqual(VersionFooter.stamped(" v3.1.4-6-g63af17e \n"), "v3.1.4-6-g63af17e")
}

test("rodapé em dia: um número só, sem detalhe, sem divergência") {
    let d = VersionFooter.display(running: "v3.3.0", repo: "v3.3.0")
    assertEqual(d.text, "v3.3.0")
    assertNil(d.detail, "não há nada a explicar quando há um número só")
    assertFalse(d.diverged, "running == repo não é divergência")
    assertTrue(d.known, "um describe estampado é versão conhecida")
}

test("rodapé divergente: dois números, o segundo rotulado repo (R9)") {
    let d = VersionFooter.display(running: "v3.1.4-6-g63af17e", repo: "v3.1.4-7-gabc1234")
    assertEqual(d.text, "v3.1.4+6 · repo v3.1.4+7")
    assertTrue(d.diverged, "describes diferentes são divergência")
    assertTrue(d.known, "o binário em execução é conhecido")
    // R9: o texto curto rotula o segundo, e o detalhe diz a frase inteira.
    assertTrue(d.text.contains("repo "), "o segundo número não está rotulado: \(d.text)")
    let detail = d.detail ?? ""
    assertTrue(detail.contains("rodando v3.1.4+6"), "o detalhe não diz o que roda: \(detail)")
    assertTrue(detail.contains("repositório está em v3.1.4+7"),
               "o detalhe não diz onde o repo está: \(detail)")
}

test("rodapé não estampado: diz o repo e admite não saber o que roda") {
    let d = VersionFooter.display(running: nil, repo: "v3.1.4-7-gabc1234")
    assertEqual(d.text, "repo v3.1.4+7")
    assertFalse(d.known, "sem a chave do bundle a versão em execução é desconhecida")
    assertFalse(d.diverged, "não se pode divergir do que não se conhece")
    assertTrue((d.detail ?? "").contains("não sei qual versão está em execução"),
               "o detalhe não admite o desconhecido: \(d.detail ?? "nil")")
}

test("rodapé sem nada: texto explícito, nunca vazio") {
    let d = VersionFooter.display(running: nil, repo: nil)
    assertEqual(d.text, "versão desconhecida")
    assertFalse(d.known)
    assertFalse(d.diverged)
    assertTrue((d.detail ?? "").contains("ForgeGitDescribe"),
               "o detalhe não nomeia a chave que falta: \(d.detail ?? "nil")")
}

test("rodapé estampado com repo ilegível: mostra o que roda, sem inventar repo") {
    let d = VersionFooter.display(running: "v3.1.4-6-g63af17e", repo: nil)
    assertEqual(d.text, "v3.1.4+6")
    assertTrue(d.known, "o bundle foi estampado; isso é sabido")
    assertFalse(d.diverged, "sem describe do repo não há com o que divergir")
    assertFalse(d.text.contains("repo"),
                "rotulou um repo que não foi lido: \(d.text)")
}

test("divergência é decidida no describe COMPLETO, não na forma curta") {
    // O caso que morde: mesma tag, mesma contagem, commits diferentes. Comparar
    // a forma curta (`v3.1.4+6` == `v3.1.4+6`) diria "em dia" e esconderia
    // exatamente o "commitei e não recompilei" que o rodapé existe para mostrar.
    let d = VersionFooter.display(running: "v3.1.4-6-gaaaaaaa", repo: "v3.1.4-6-gbbbbbbb")
    assertTrue(d.diverged, "shas diferentes com a mesma contagem não foram detectados")
    assertEqual(d.text, "v3.1.4+6 · repo v3.1.4+6")

    // E o inverso: describe idêntico com sufixo não é divergência.
    let same = VersionFooter.display(running: "v3.1.4-6-gaaaaaaa", repo: "v3.1.4-6-gaaaaaaa")
    assertFalse(same.diverged, "o mesmo describe foi lido como divergente")
    assertEqual(same.text, "v3.1.4+6")
}

test("o texto do rodapé cabe no orçamento de largura de 152pt") {
    // A medição do research: 152pt úteis a 180pt de coluna. `.caption` no macOS
    // é 10pt, ~4,6pt por caractere em média — o pior caso realista tem de ficar
    // na casa dos 30 caracteres, não dos 40 (dois describes inteiros dariam 44).
    let worst = VersionFooter.display(running: "v3.1.4-6-g63af17e",
                                      repo: "v3.1.4-7-gabc1234")
    assertLessOrEqual(worst.text.count, 30,
                      "o texto do pior caso ficou longo demais para 152pt: "
                      + "\(worst.text.count) caracteres — \(worst.text)")
    // E o detalhe, que vive num tooltip, pode e deve ser prolixo.
    assertGreater((worst.detail ?? "").count, worst.text.count,
                  "o detalhe não é mais informativo que o texto curto")
}

print("Progress — itens fechados e janela")

// ProgressTests — window resolution (instant + day, DS1) and the "closed
// items" panel source (DS8 done-only, DS9 parse trap, D5 declared coverage).

func progressItem(status: String, closedAt: String?) -> Item {
    Item(id: "x", status: status, closed_at: closedAt)
}

test("cobertura declarada: 3 done sem closed_at → closed 0 e rótulo, não só o número") {
    let items = [
        progressItem(status: "done", closedAt: nil),
        progressItem(status: "done", closedAt: nil),
        progressItem(status: "done", closedAt: nil),
    ]
    let r = ClosedItems.count(items: items, window: .all)
    assertEqual(r.closed, 0, "closed deveria ser 0")
    assertEqual(r.missingClosedAt, 3, "missingClosedAt deveria contar os 3")
    assertTrue(r.coverageLabel != nil, "coverageLabel não pode ser nil quando há itens sem data")
}

test("dropped com closed_at na janela não conta (DS8) — done conta") {
    let now = Date()
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let raw = iso.string(from: now)
    let items = [
        progressItem(status: "dropped", closedAt: raw),
        progressItem(status: "done", closedAt: raw),
    ]
    let r = ClosedItems.count(items: items, window: .all, now: now)
    assertEqual(r.closed, 1, "só o done deveria contar")
}

test("closed_at fracionado (toISOString real) parseia e conta em .all e numa janela que o contém") {
    // Sample literal exatamente no formato que Date.toISOString() emite —
    // ISO8601DateFormatter sem .withFractionalSeconds devolve nil para isso
    // (DS9): esse teste existe para tornar esse nil impossível de passar
    // despercebido.
    let raw = "2026-07-30T18:20:00.123Z"
    let (instant, day) = ProgressDate.parse(raw)
    assertTrue(instant != nil, "parse fracionado não pode devolver nil (DS9)")
    assertEqual(day, "2026-07-30", "day deveria ser os 10 primeiros chars")

    let now = ISO8601DateFormatter().date(from: "2026-07-30T18:25:00Z")!
    let items = [progressItem(status: "done", closedAt: raw)]
    assertEqual(ClosedItems.count(items: items, window: .all, now: now).closed, 1,
                "deveria contar em .all")
    assertEqual(ClosedItems.count(items: items, window: .day24h, now: now).closed, 1,
                "deveria contar numa janela que contém o instante")
}

test("closed_at data-só conta por resolução de dia, não como meia-noite UTC") {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "America/Sao_Paulo")!
    let now = calendar.date(from: DateComponents(year: 2026, month: 7, day: 30, hour: 12))!
    let items = [progressItem(status: "done", closedAt: "2026-07-30")]
    let r = ClosedItems.count(items: items, window: .day24h, now: now, calendar: calendar)
    assertEqual(r.closed, 1, "data-só de hoje deveria contar em .day24h por resolução de dia")
}

test("borda de janela: closed_at 8 dias atrás fica fora de .week, dentro de .month") {
    let now = Date()
    let eightDaysAgo = now.addingTimeInterval(-86_400 * 8)
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let raw = iso.string(from: eightDaysAgo)
    let items = [progressItem(status: "done", closedAt: raw)]
    assertEqual(ClosedItems.count(items: items, window: .week, now: now).closed, 0,
                "8 dias atrás deveria ficar fora de .week")
    assertEqual(ClosedItems.count(items: items, window: .month, now: now).closed, 1,
                "8 dias atrás deveria ficar dentro de .month")
}

test("ProgressWindow.dayThreshold para .week com now fixo é exatamente hoje-6d") {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let now = calendar.date(from: DateComponents(year: 2026, month: 7, day: 30))!
    let expected = calendar.date(from: DateComponents(year: 2026, month: 7, day: 24))!
    let expectedStr = ProgressDate.dayString(expected, calendar: calendar)
    assertEqual(ProgressWindow.week.dayThreshold(now: now, calendar: calendar), expectedStr,
                "threshold de .week deveria ser hoje-6d")
}

test("ProgressWindow.ledgerWindowLabel: 'hoje' só para .day24h (DS1)") {
    assertEqual(ProgressWindow.day24h.ledgerWindowLabel, "hoje")
    assertNil(ProgressWindow.week.ledgerWindowLabel)
    assertNil(ProgressWindow.month.ledgerWindowLabel)
    assertNil(ProgressWindow.all.ledgerWindowLabel)
}

print("Ledger — leitor mínimo e janela por dia")

// LedgerTests — fence-and-root-only scanner (DS2/blocker 3) and day-window
// resolution (DS1/blocker 1).

// Literal copy of the real fragment shape at
// `.gsd/ledger/T-20260730020639-sidebar-secao.md` (list `key_decisions:`
// with `- ` items AND `|` block scalars with indented continuation lines) —
// embedded because `.gsd/` is gitignored (S02-PLAN Note 2), so the suite
// runs identically in any clone.
let ledgerFixtureReal = """
---
completed_at: 2026-07-30
id: T-20260730020639-sidebar-secao
key_decisions:
  - A versão exibida era a tag do repo, não a do binário rodando (Info.plist com 0.1.0 fixo, build.sh nunca reescrevia) — corrigido estampando 3 chaves no bundle entre a cópia do plist e o codesign, com plutil -replace
  - |
    Não agrupar as 13 seções: List sections adicionariam ~60pt de header e subiriam a contagem em repouso de 13 para 16, piorando a única métrica contável de minimalismo
  - Nenhuma renomeação de seção — Section.rawValue é rótulo E chave do @AppStorage via SectionRestore
  - |
    D15 da task irmã preservada: o slot de ação Atualizar+Reinstalar é intocado
  - |
    R6 do review: repoDescribe ficava stale após update, então o rodapé lia 'em dia' no instante em que a divergência passava a existir
  - O repo se auto-tagueia no merge via .github/workflows/release.yml — a discussão D35/D37 sobre quem taggeia era desnecessária
key_files:
  - app/build.sh
  - app/Sources/ForgeKit/UpdateCore.swift
  - app/Sources/Forge/Views.swift
  - app/Sources/Forge/Updates.swift
  - app/Sources/Forge/Previews.swift
  - scripts/forge-app-sidebar.test.js
  - CHANGELOG.md
slices: []
title: Sidebar e seção de atualizações mais minimalistas, com versão sempre visível
---

A UI de progresso entregue nas duas tasks irmãs era inalcançável e a versão exibida era do repo, não do binário.
"""

test("fixture real (lista + bloco) parseia id e completedDay corretos") {
    let f = Ledger.parseFragment(ledgerFixtureReal)
    assertEqual(f.id, "T-20260730020639-sidebar-secao", "id deveria vir da raiz")
    assertEqual(f.completedDay, "2026-07-30", "completedDay deveria vir da raiz")
}

test("armadilha: completed_at indentado num bloco | e outro após a cerca não sobrescrevem a raiz") {
    let trap = """
    ---
    completed_at: 2026-07-30
    id: T-trap
    key_decisions:
      - |
        Nota falsa que tenta confundir o scanner:
        completed_at: 1999-01-01
      - Outra linha normal
    ---
    Corpo com outra menção fora da cerca:
    completed_at: 1999-01-01
    """
    let f = Ledger.parseFragment(trap)
    assertEqual(f.completedDay, "2026-07-30",
                "o scanner não pode ler o valor de dentro do bloco nem o de depois da cerca")
    assertEqual(f.id, "T-trap", "id deveria continuar vindo da raiz")
}

test("deliveries: fragmento de hoje conta em .day24h com windowLabel 'hoje'; ontem não") {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let now = calendar.date(from: DateComponents(year: 2026, month: 7, day: 30, hour: 12))!
    let today = LedgerFragment(id: "a", completedDay: "2026-07-30")
    let yesterday = LedgerFragment(id: "b", completedDay: "2026-07-29")

    let day = Ledger.deliveries(fragments: [today, yesterday], window: .day24h, now: now, calendar: calendar)
    assertEqual(day.count, 1, "só o fragmento de hoje deveria contar em .day24h")
    assertEqual(day.windowLabel, "hoje", "windowLabel deveria ser 'hoje' para .day24h (DS1)")

    let week = Ledger.deliveries(fragments: [today, yesterday], window: .week, now: now, calendar: calendar)
    assertEqual(week.count, 2, "ambos deveriam contar em .week")
    assertNil(week.windowLabel, "windowLabel deveria ser nil fora de .day24h")
}

test("borda de 7 dias: hoje-6d dentro de .week, hoje-7d fora") {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let now = calendar.date(from: DateComponents(year: 2026, month: 7, day: 30))!
    let sixDaysAgoDate = calendar.date(byAdding: .day, value: -6, to: now)!
    let sevenDaysAgoDate = calendar.date(byAdding: .day, value: -7, to: now)!
    let sixDaysAgo = ProgressDate.dayString(sixDaysAgoDate, calendar: calendar)
    let sevenDaysAgo = ProgressDate.dayString(sevenDaysAgoDate, calendar: calendar)
    let fragments = [
        LedgerFragment(id: "in", completedDay: sixDaysAgo),
        LedgerFragment(id: "out", completedDay: sevenDaysAgo),
    ]
    let r = Ledger.deliveries(fragments: fragments, window: .week, now: now, calendar: calendar)
    assertEqual(r.count, 1, "só hoje-6d deveria estar dentro de .week (threshold inclusivo)")

    let month = Ledger.deliveries(fragments: fragments, window: .month, now: now, calendar: calendar)
    assertEqual(month.count, 2, "ambos deveriam estar dentro de .month")
}

test("fragmento sem completed_at válido nunca entra em janela; conta em undated") {
    let noDate = LedgerFragment(id: "x", completedDay: nil)
    let dated = LedgerFragment(id: "y", completedDay: "2026-07-30")
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let now = calendar.date(from: DateComponents(year: 2026, month: 7, day: 30))!

    let all = Ledger.deliveries(fragments: [noDate, dated], window: .all, now: now, calendar: calendar)
    assertEqual(all.count, 1, "undated não deveria entrar no count mesmo em .all")
    assertEqual(all.undated, 1, "undated deveria reportar o fragmento sem data")

    let day = Ledger.deliveries(fragments: [noDate, dated], window: .day24h, now: now, calendar: calendar)
    assertEqual(day.undated, 1, "undated deveria ser reportado em qualquer janela")
}

test("Ledger.read(dir:) ordena por nome e devolve [] para diretório ausente") {
    assertEqual(Ledger.read(dir: "/tmp/forge-ledger-test-nonexistent-\(UUID().uuidString)"), [],
                "diretório ausente não é erro")

    let tmp = NSTemporaryDirectory() + "forge-ledger-read-\(UUID().uuidString)"
    try! FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: tmp) }

    let bFrag = """
    ---
    completed_at: 2026-07-29
    id: b-frag
    ---
    """
    let aFrag = """
    ---
    completed_at: 2026-07-30
    id: a-frag
    ---
    """
    try! bFrag.write(toFile: tmp + "/b-frag.md", atomically: true, encoding: .utf8)
    try! aFrag.write(toFile: tmp + "/a-frag.md", atomically: true, encoding: .utf8)
    try! "not a fragment, ignored by extension".write(toFile: tmp + "/notes.txt", atomically: true, encoding: .utf8)

    let read = Ledger.read(dir: tmp)
    assertEqual(read.count, 2, "só os .md deveriam ser lidos")
    assertEqual(read.map { $0.id }, ["a-frag", "b-frag"], "ordem deveria ser por nome de arquivo")
}

// ═══════════════════════════════════════════════════════════════════════════
print("GitActivity — dedupe, globs e janela")

/// Run git with a HERMETIC environment. The point is that this fixture builds
/// the same repo on any machine: `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` at
/// /dev/null so no `~/.gitconfig` leaks in (a global `commit.gpgsign = true` or
/// a `init.defaultBranch` would otherwise decide whether the test passes), and
/// identity plus dates passed explicitly so commits are reproducible.
@discardableResult
func fixtureGit(_ args: [String], at path: String, date: String = "2026-07-30T12:00:00Z") -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    p.arguments = ["-C", path,
                   "-c", "user.name=Forge Fixture",
                   "-c", "user.email=fixture@forge.test",
                   "-c", "commit.gpgsign=false"] + args
    var env = ProcessInfo.processInfo.environment
    env["GIT_CONFIG_GLOBAL"] = "/dev/null"
    env["GIT_CONFIG_SYSTEM"] = "/dev/null"
    env["GIT_AUTHOR_DATE"] = date
    env["GIT_COMMITTER_DATE"] = date
    p.environment = env
    let out = Pipe()
    p.standardOutput = out
    p.standardError = Pipe()
    try! p.run()
    let d = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return String(data: d, encoding: .utf8) ?? ""
}

func fixtureWrite(_ text: String, to path: String) {
    try! FileManager.default.createDirectory(
        atPath: (path as NSString).deletingLastPathComponent,
        withIntermediateDirectories: true)
    try! text.write(toFile: path, atomically: true, encoding: .utf8)
}

test("parseLog lê header + numstat, com binário e rename, na forma exata") {
    // O `-` de binário NÃO é falha de parse: um arquivo cujas linhas não se
    // contam continua pertencendo ao commit, e recusar a linha derrubaria o
    // resto dele. O rename é normalizado para o lado NOVO antes de qualquer
    // glob — senão mover um arquivo para dentro de dist/ continua contando.
    let log = """
    a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 1753900000

    12\t3\tsrc/a.swift
    -\t-\tassets/logo.png
    4\t0\ta/{b => c}/d.js

    00112233445566778899aabbccddeeff00112233 1753800000

    1\t1\tREADME.md
    """
    let commits = GitActivity.parseLog(log)
    assertEqual(commits.count, 2, "dois headers deveriam virar dois commits")

    assertEqual(commits[0].sha, "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0")
    assertEqual(commits[0].epoch, 1753900000, "epoch vem do %ct")
    assertEqual(commits[0].files.count, 3, "as três linhas numstat deveriam sobreviver")
    assertEqual(commits[0].files[0], FileStat(added: 12, deleted: 3, path: "src/a.swift"))
    assertEqual(commits[0].files[1], FileStat(added: 0, deleted: 0, path: "assets/logo.png"),
                "binário conta 0 linhas em vez de quebrar o commit")
    assertEqual(commits[0].files[2], FileStat(added: 4, deleted: 0, path: "a/c/d.js"),
                "rename com chaves deveria normalizar para o caminho NOVO")

    assertEqual(commits[1].sha, "00112233445566778899aabbccddeeff00112233")
    assertEqual(commits[1].files.count, 1)
}

test("parseLog normaliza as três formas de rename e pula linha torta") {
    // Molde do MetricsEngine.parse: a saída vem de subprocesso e a última linha
    // pode vir truncada — uma linha ilegível não pode custar a janela inteira.
    let log = """
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1753900000

    1\t0\tvelho.js => novo.js
    2\t0\t{old => new}.js
    3\t0\tsrc/{ => nested}/x.js
    isto não é numstat nem header
    \t\t
    4\t0\tsem/rename.js
    """
    let commits = GitActivity.parseLog(log)
    assertEqual(commits.count, 1)
    assertEqual(commits[0].files.map { $0.path },
                ["novo.js", "new.js", "src/nested/x.js", "sem/rename.js"],
                "as três formas de rename normalizam para o lado novo; linha torta é pulada")
}

test("parseLog tolera commit de merge (header sem numstat)") {
    let log = """
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1753900000

    bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 1753800000

    5\t5\tx.swift
    """
    let commits = GitActivity.parseLog(log)
    assertEqual(commits.count, 2, "merge sem numstat continua sendo um commit")
    assertEqual(commits[0].files.count, 0)
    assertEqual(commits[1].files.count, 1)
}

test("union deduplica por SHA mantendo a primeira aparição e a ordem") {
    let a = Commit(sha: "aaa1111", epoch: 3, files: [FileStat(added: 1, deleted: 0, path: "a")])
    let b = Commit(sha: "bbb2222", epoch: 2, files: [])
    let c = Commit(sha: "ccc3333", epoch: 1, files: [])
    let merged = GitActivity.union([[a, b], [b, c]])
    assertEqual(merged.map { $0.sha }, ["aaa1111", "bbb2222", "ccc3333"],
                "SHA repetido entre checkouts deveria entrar uma vez só")
}

test("critério #10: união entre 2 checkouts reais é 3, e a soma ingênua é 5") {
    // Blocker 2 do RISK, e a razão de este teste existir: `git worktree list`
    // NESTE repo devolve UM checkout, então um `union` que só concatena passaria
    // em qualquer teste escrito contra o repo real — a inflação seria de 1x e
    // portanto invisível. O fixture constrói dois checkouts que compartilham
    // história de verdade, e o teste afirma DUAS coisas: que a união bate com o
    // `sort -u` dos SHAs, e que a concatenação é ESTRITAMENTE MAIOR. Sem a
    // segunda afirmação o teste não distingue um dedupe funcionando de um no-op.
    let tmp = NSTemporaryDirectory() + "forge-gitactivity-\(UUID().uuidString)"
    let main = tmp + "/main"
    let side = tmp + "/side"
    try! FileManager.default.createDirectory(atPath: main, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: tmp) }

    fixtureGit(["init", "-b", "main"], at: main)
    fixtureWrite("um\n", to: main + "/src/a.swift")
    fixtureGit(["add", "src/a.swift"], at: main)
    fixtureGit(["commit", "-m", "c1"], at: main, date: "2026-07-28T10:00:00Z")
    fixtureWrite("dois\n", to: main + "/src/b.swift")
    fixtureGit(["add", "src/b.swift"], at: main)
    fixtureGit(["commit", "-m", "c2"], at: main, date: "2026-07-29T10:00:00Z")

    // O segundo checkout parte da MESMA história: é o cenário real do
    // forge_isolation.mode = worktree, onde os commits da milestone vivem fora
    // da pasta que o operador adicionou (DS6).
    fixtureGit(["worktree", "add", side, "-b", "side"], at: main)
    fixtureWrite("três\n", to: side + "/src/c.swift")
    fixtureGit(["add", "src/c.swift"], at: side)
    fixtureGit(["commit", "-m", "c3"], at: side, date: "2026-07-30T10:00:00Z")

    let checkouts = [Checkout(path: main, branch: "main", isPrimary: true),
                     Checkout(path: side, branch: "side", isPrimary: false)]
    let perCheckout = GitActivity.collect(checkouts: checkouts)
    assertEqual(perCheckout.count, 2, "deveria haver um log por checkout")

    let concatenated = perCheckout.flatMap { $0 }
    let united = GitActivity.union(perCheckout)

    // `sort -u` calculado in-test: a verdade independente contra a qual a
    // implementação é conferida.
    let uniqueShas = Set(concatenated.map { $0.sha })
    assertEqual(uniqueShas.count, 3, "os dois checkouts deveriam somar 3 commits distintos")
    assertEqual(united.count, uniqueShas.count, "a união deveria bater com o sort -u dos SHAs")
    assertEqual(Set(united.map { $0.sha }), uniqueShas, "a união deveria ter exatamente esses SHAs")

    assertEqual(concatenated.count, 5,
                "main tem 2 commits e side tem 3 (2 compartilhados + 1) — a concatenação é 5")
    assertGreater(concatenated.count, united.count,
                  "a concatenação TEM de ser maior que a união: se fossem iguais, este teste "
                  + "não distinguiria um dedupe de um no-op")
}

test("linhas contam sobre a UNIÃO, não por checkout (o dobro seria silencioso)") {
    // O mesmo commit alcançável por dois checkouts contaria duas vezes se as
    // linhas fossem somadas por checkout e depois agregadas.
    let shared = Commit(sha: "aaa1111", epoch: 1,
                        files: [FileStat(added: 10, deleted: 4, path: "src/a.swift")])
    let perCheckout = [[shared], [shared]]
    let naive = perCheckout.map { GitActivity.linesTouched($0, ignoring: []) }
        .reduce(into: (added: 0, deleted: 0)) { $0.added += $1.added; $0.deleted += $1.deleted }
    let correct = GitActivity.linesTouched(GitActivity.union(perCheckout), ignoring: [])
    assertEqual(correct.added, 10, "a união conta o commit compartilhado uma vez")
    assertEqual(correct.deleted, 4)
    assertEqual(naive.added, 20, "somar por checkout dobraria — é a armadilha que a união evita")
}

test("linesTouched soma só o que está fora dos ignore-globs") {
    let c = Commit(sha: "aaa1111", epoch: 1, files: [
        FileStat(added: 10, deleted: 2, path: "dist/x.js"),
        FileStat(added: 3, deleted: 1, path: "src/a.js"),
    ])
    let r = GitActivity.linesTouched([c], ignoring: GitActivity.defaultIgnoreList)
    assertEqual(r.added, 3, "dist/x.js está sob dist/** e não deveria contar")
    assertEqual(r.deleted, 1)

    let unfiltered = GitActivity.linesTouched([c], ignoring: [])
    assertEqual(unfiltered.added, 13, "sem globs, tudo conta — o filtro é a diferença")
}

test("Glob fala exatamente o vocabulário da lista default") {
    assertTrue(GitActivity.Glob.matches(".gsd/**", ".gsd/forge/events.jsonl"),
               "sufixo /** casa abaixo do diretório na raiz")
    assertFalse(GitActivity.Glob.matches("dist/**", "mydist/a.js"),
                "dist/** é um diretório, não um prefixo de nome — mydist/ não é dist/")
    assertTrue(GitActivity.Glob.matches("dist/**", "dist/a/b.js"))

    // A regra de profundidade, exercitada onde o comentário antigo dizia que
    // era exercitada e não era: o diretório NÃO na raiz. Sem estes casos o
    // matcher ancorado na raiz passava no teste que afirmava o contrário.
    assertTrue(GitActivity.Glob.matches("node_modules/**", "packages/app/node_modules/x.js"),
               "/** casa o segmento em qualquer profundidade — node_modules aninhado de monorepo")
    assertTrue(GitActivity.Glob.matches("dist/**", "packages/app/dist/a.js"),
               "a regra é geral, não só node_modules")
    assertTrue(GitActivity.Glob.matches(".gsd/**", "sub/repo/.gsd/forge/events.jsonl"))
    // O lado negativo do alargamento: segmento, jamais substring.
    assertFalse(GitActivity.Glob.matches("node_modules/**", "packages/app/my_node_modules/x.js"),
                "profundidade não pode virar substring — my_node_modules não é node_modules")
    assertFalse(GitActivity.Glob.matches("dist/**", "a/mydist/b.js"),
                "mydist aninhado continua fora, como mydist na raiz")
    assertFalse(GitActivity.Glob.matches("dist/**", "a/distal/b.js"))
    assertFalse(GitActivity.Glob.matches("dist/**", "src/a.js"),
                "um matcher que casa tudo é tão errado quanto um que casa pouco")
    assertTrue(GitActivity.Glob.matches("package-lock.json", "app/nested/package-lock.json"),
               "padrão sem / casa o basename em qualquer diretório")
    assertTrue(GitActivity.Glob.matches("package-lock.json", "package-lock.json"))
    assertFalse(GitActivity.Glob.matches("package-lock.json", "package-lock.json.bak"))
    assertTrue(GitActivity.Glob.matches("*.lock", "a/b/Cargo.lock"), "* casa dentro do segmento")
    assertFalse(GitActivity.Glob.matches("src/*.js", "src/deep/a.js"),
                "* nunca atravessa a barra")
    assertTrue(GitActivity.Glob.matches("src/*.js", "src/a.js"))
}

test("resolveIgnoreList: caller manda; ausente ou vazio cai no default do engine") {
    assertEqual(GitActivity.resolveIgnoreList(prefValue: nil), GitActivity.defaultIgnoreList,
                "sem prefs resolvidas, vale o default do engine (DS5)")
    assertEqual(GitActivity.resolveIgnoreList(prefValue: []), GitActivity.defaultIgnoreList,
                "lista vazia da cascata significa 'chave não definida', como no completer")
    assertEqual(GitActivity.resolveIgnoreList(prefValue: ["só-isto"]), ["só-isto"],
                "valor resolvido pelo caller ganha")
    assertEqual(GitActivity.defaultIgnoreList.count, 8,
                "os 8 defaults do engine (inclui node_modules/** desde TASK-repair S03-T03) — "
                + "divergir de agents/forge-completer.md é o que "
                + "scripts/forge-app-progress.test.js existe para pegar")
}

test("a janela filtra pelo epoch parseado, não pelo comando") {
    // DS7: o comando é constante e o `--since` não existe, para que parse e
    // janela sejam puros — e para que 24h aqui signifique o mesmo que nas
    // outras duas fontes.
    let old = Commit(sha: "old1111", epoch: 1_700_000_000, files: [])
    let recent = Commit(sha: "new2222", epoch: 1_753_900_000, files: [])
    let since = Date(timeIntervalSince1970: 1_750_000_000)
    let kept = GitActivity.inWindow([old, recent], since: since)
    assertEqual(kept.map { $0.sha }, ["new2222"], "só o commit dentro da janela sobrevive")
    assertEqual(GitActivity.inWindow([old, recent], since: nil).count, 2,
                "sem janela, nada é filtrado")
}

print("Divergence + ProgressSummary")

test("Divergence: os 4 padrões canônicos produzem exatamente 1 frase cada, todas distintas") {
    let p1 = Divergence.sentence(closed: 0, deliveries: 0, commits: 5)
    let p2 = Divergence.sentence(closed: 3, deliveries: 0, commits: 4)
    let p3 = Divergence.sentence(closed: 0, deliveries: 2, commits: 6)
    let p4 = Divergence.sentence(closed: 1, deliveries: 2, commits: 0)
    assertTrue(p1 != nil, "P1 (commits>0, entregas==0, fechados==0) tem de emitir")
    assertTrue(p2 != nil, "P2 (fechados>0, entregas==0) tem de emitir")
    assertTrue(p3 != nil, "P3 (entregas>0, fechados==0) tem de emitir")
    assertTrue(p4 != nil, "P4 (entregas>0, commits==0) tem de emitir")
    let sentences = Set([p1, p2, p3, p4].compactMap { $0 })
    assertEqual(sentences.count, 4, "as 4 frases têm de ser distintas entre si")
}

test("Divergence: os três > 0 (proporcional) — SILÊNCIO, o caso que uma implementação sempre-emite falha") {
    let sentence = Divergence.sentence(closed: 7, deliveries: 3, commits: 22)
    assertTrue(sentence == nil,
               "todos > 0 é o caso proporcional — uma frase aqui é o bug que o critério #9 existe para pegar")
}

test("Divergence: janela vazia (0,0,0) não é divergência — silêncio também") {
    assertTrue(Divergence.sentence(closed: 0, deliveries: 0, commits: 0) == nil,
               "nada aconteceu, nada para relatar")
}

test("Divergence: overlap entre P3 e P4 resolve por precedência — exatamente 1 frase, nunca 2") {
    // fechados=0, entregas=2, commits=0: casa tanto P3 (entregas>0 ∧ fechados==0)
    // quanto P4 (entregas>0 ∧ commits==0). A tabela manda P3 vencer.
    let sentence = Divergence.sentence(closed: 0, deliveries: 2, commits: 0)
    assertEqual(sentence, "entrega sem higiene de board", "P3 vence por precedência sobre P4")
}

test("ProgressSummary não expõe nenhum campo composto — só os 3 contadores + divergence") {
    let summary = ProgressSummary(window: .day24h,
                                   closedItems: ClosedItemsCount(closed: 1, missingClosedAt: 0),
                                   ledger: LedgerCount(count: 1, undated: 0, windowLabel: "hoje"),
                                   gitCommits: 1, gitAdded: 1, gitDeleted: 1, divergence: nil)
    // Regressão do critério #7 em texto: nenhuma destas palavras aparece no
    // arquivo fonte (checado via shell no T04-SUMMARY / lint command), este
    // assert cobre só que os campos individuais continuam acessíveis
    // separadamente (não hipoteticamente combinados aqui).
    assertEqual(summary.closedItems.closed, 1)
    assertEqual(summary.ledger.count, 1)
    assertEqual(summary.gitCommits, 1)
}

test("ProgressEngine.summarise: fixture end-to-end — cobertura declarada, rótulo 'hoje', dedupe de commits") {
    let calendar = Calendar(identifier: .gregorian)
    let now = ISO8601DateFormatter().date(from: "2026-07-30T12:00:00Z")!

    // 3 `done` legados sem closed_at (S01 backfill ainda não rodou neles) — a
    // contagem de fechados tem de ser 0, COM rótulo de cobertura, nunca um 0
    // silencioso.
    let items = (1...3).map { Item(id: "T\($0)", status: "done") }

    // 1 fragmento de hoje.
    let ledgerFragments = [
        LedgerFragment(id: "M001", completedDay: ProgressDate.dayString(now, calendar: calendar)),
    ]

    // Logs de 2 checkouts com um SHA compartilhado — o dedupe tem de contar 1.
    let shared = Commit(sha: "abc1234", epoch: Int(now.timeIntervalSince1970) - 60,
                        files: [FileStat(added: 5, deleted: 2, path: "src/a.swift")])
    let gitLogs = [[shared], [shared]]

    let summary = ProgressEngine.summarise(items: items, ledgerFragments: ledgerFragments,
                                            gitLogs: gitLogs, window: .day24h, now: now,
                                            calendar: calendar)

    assertEqual(summary.closedItems.closed, 0, "nenhum dos 3 tem closed_at — 0 é o número honesto")
    assertTrue(summary.closedItems.coverageLabel != nil,
               "critério #8: o rótulo tem de existir — o teste é sobre o RÓTULO, não o número bruto")
    assertEqual(summary.ledger.count, 1, "1 entrega hoje")
    assertEqual(summary.ledger.windowLabel, "hoje", "janela 24h rotula 'hoje' na fonte ledger (DS1)")
    assertEqual(summary.gitCommits, 1, "commit compartilhado entre 2 checkouts conta 1 vez (dedupe)")
    assertEqual(summary.gitAdded, 5)
    assertEqual(summary.gitDeleted, 2)
    // fechados==0, entregas==1>0 → P3 é o padrão coerente com este fixture.
    assertEqual(summary.divergence, "entrega sem higiene de board",
                "divergence tem de refletir as contagens reais do summary, não um valor solto")
}

// MARK: - ItemLabelFilter (S05)

test("ItemLabelFilter.apply: query nil devolve a lista inteira, nunca vazia") {
    let items = [Item(id: "1", labels: ["a"]), Item(id: "2", labels: nil)]
    let result = ItemLabelFilter.apply(items, query: nil)
    assertEqual(result.count, 2, "query nil não é filtro — devolve tudo")
    assertEqual(result.map { $0.id }, ["1", "2"], "ordem de entrada preservada")
}

test("ItemLabelFilter.apply: query vazia (\"\") devolve a lista inteira") {
    let items = [Item(id: "1", labels: ["a"]), Item(id: "2", labels: [])]
    let result = ItemLabelFilter.apply(items, query: "")
    assertEqual(result.count, 2)
}

test("ItemLabelFilter.apply: query só-espaço (\"   \") devolve a lista inteira") {
    let items = [Item(id: "1", labels: ["a"]), Item(id: "2", labels: nil)]
    let result = ItemLabelFilter.apply(items, query: "   ")
    assertEqual(result.count, 2, "espaço puro é ausência de filtro, não uma consulta vazia")
}

test("ItemLabelFilter.apply: prefixo — \"ui\" não casa item cujo único label é \"ui-bug\"") {
    let itemUI = Item(id: "1", labels: ["ui"])
    let itemUIBug = Item(id: "2", labels: ["ui-bug"])
    let result = ItemLabelFilter.apply([itemUI, itemUIBug], query: "ui")
    assertEqual(result.count, 1, "casamento exato de elemento — nunca substring")
    assertEqual(result.first?.id, "1", "só o item com o label exato \"ui\" sobrevive")
}

test("ItemLabelFilter.apply: case — \"Bug\" devolve 0 itens quando o único label é \"bug\"") {
    let items = [Item(id: "1", labels: ["bug"])]
    let result = ItemLabelFilter.apply(items, query: "Bug")
    assertEqual(result.count, 0, "sensível a maiúsculas, igual ao jq index()")
}

test("ItemLabelFilter.apply: item sem labels (nil) nunca casa") {
    let items = [Item(id: "1", labels: nil)]
    let result = ItemLabelFilter.apply(items, query: "bug")
    assertEqual(result.count, 0)
}

test("ItemLabelFilter.apply: item com labels: [] nunca casa") {
    let items = [Item(id: "1", labels: [])]
    let result = ItemLabelFilter.apply(items, query: "bug")
    assertEqual(result.count, 0)
}

test("ItemLabelFilter.apply: labels com espaço no disco casam trimados, vazio descartado") {
    let items = [Item(id: "1", labels: [" bug ", ""])]
    let result = ItemLabelFilter.apply(items, query: "bug")
    assertEqual(result.count, 1, "\" bug \" trimado casa \"bug\"; \"\" nunca conta como label")
}

test("ItemLabelFilter.apply: item com status desconhecido casa normalmente (D-S05-2)") {
    let items = [Item(id: "1", status: "zzz", labels: ["bug"])]
    let result = ItemLabelFilter.apply(items, query: "bug")
    assertEqual(result.count, 1, "o filtro é sobre label, não sobre status — a coluna Desconhecido também filtra")
}

test("ItemLabelFilter.matches: item sem labels retorna false") {
    assertFalse(ItemLabelFilter.matches(Item(id: "1", labels: nil), label: "bug"))
}

test("ItemLabelFilter.matches: casamento exato sensível a maiúsculas") {
    assertTrue(ItemLabelFilter.matches(Item(id: "1", labels: ["bug"]), label: "bug"))
    assertFalse(ItemLabelFilter.matches(Item(id: "1", labels: ["bug"]), label: "Bug"))
    assertFalse(ItemLabelFilter.matches(Item(id: "1", labels: ["ui-bug"]), label: "ui"))
}

test("ItemLabelFilter.normalise: nil, vazio e só-espaço devolvem nil") {
    assertNil(ItemLabelFilter.normalise(nil))
    assertNil(ItemLabelFilter.normalise(""))
    assertNil(ItemLabelFilter.normalise("   "))
    assertNil(ItemLabelFilter.normalise("\n\t "))
}

test("ItemLabelFilter.normalise: trima whitespace/newlines em torno de uma consulta real") {
    assertEqual(ItemLabelFilter.normalise("  bug\n"), "bug")
}

test("ItemLabelFilter.availableLabels: únicos, ordenados, sem vazios, sobre lista com repetição") {
    let items = [
        Item(id: "1", labels: ["bug", "ui"]),
        Item(id: "2", labels: ["ui", ""]),
        Item(id: "3", labels: nil),
        Item(id: "4", labels: [" bug "]),
    ]
    let result = ItemLabelFilter.availableLabels(items)
    assertEqual(result, ["bug", "ui"], "únicos, trimados, ordenados — sem duplicata entre \"bug\" e \" bug \"")
}

test("ItemLabelFilter.availableLabels: lista vazia de itens devolve lista vazia") {
    assertEqual(ItemLabelFilter.availableLabels([]), [])
}

// MARK: - Paridade do filtro por label (S05/T04)
//
// O criterio #5 exige que a contagem na tela seja IGUAL a contagem da CLI —
// divergencia de 1 card e falha. Provar isso comparando o filtro Swift contra
// uma reimplementacao em Swift seria tautologia (D-S05-6). Entao a prova mora
// num fixture unico, `app/fixtures/label-filter-parity.json`, lido por DOIS
// lados independentes:
//
//   - este arquivo assere ItemLabelFilter.apply(items, query: L).count ==
//     expected[L] para TODA chave de expected;
//   - scripts/forge-app-label-filter.test.js RECALCULA expected a partir dos
//     mesmos items com a expressao equivalente ao `jq index()` e ainda ancora
//     a forma de `labels` rodando o engine de verdade sobre um store temporario.
//
// Consequencia deliberada: afrouxar um valor de `expected` para fazer o lado
// Swift passar quebra o lado JS. Nao existe atalho verde aqui.
//
// O fixture vive em app/fixtures/, FORA de qualquer `path:` de target no
// Package.swift — um .json dentro de Sources/ForgeKitTests/ viraria recurso
// nao declarado.

struct LabelParityFixture: Decodable {
    let items: [Item]
    let expected: [String: Int]
}

/// Resolve o fixture por `#filePath` (main.swift -> ForgeKitTests -> Sources ->
/// app), com fallback para o cwd. Devolve `nil` se nenhum dos dois existir — e
/// o chamador FALHA nesse caso: um fixture nao encontrado nunca pode virar
/// teste que passa silenciosamente.
func labelParityFixtureURL() -> URL? {
    let fromSource = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // ForgeKitTests/
        .deletingLastPathComponent()   // Sources/
        .deletingLastPathComponent()   // app/
        .appendingPathComponent("fixtures/label-filter-parity.json")
    if FileManager.default.fileExists(atPath: fromSource.path) { return fromSource }

    let fromCwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        .appendingPathComponent("fixtures/label-filter-parity.json")
    if FileManager.default.fileExists(atPath: fromCwd.path) { return fromCwd }

    return nil
}

test("Paridade: o fixture de paridade existe e decodifica em [Item] + expected") {
    guard let url = labelParityFixtureURL() else {
        assertTrue(false, "fixture label-filter-parity.json nao encontrado nem por #filePath nem pelo cwd — " +
                          "um fixture ausente NAO pode virar teste verde")
        return
    }
    let data = try Data(contentsOf: url)
    let fixture = try JSONDecoder().decode(LabelParityFixture.self, from: data)
    assertGreater(fixture.items.count, 0, "fixture.items nao pode ser vazio")
    assertGreater(fixture.expected.count, 0, "fixture.expected nao pode ser vazio")
}

test("Paridade: ItemLabelFilter.apply reproduz expected para TODO label do fixture") {
    guard let url = labelParityFixtureURL() else {
        assertTrue(false, "fixture label-filter-parity.json nao encontrado — nao ha o que verificar, isto e falha")
        return
    }
    let fixture = try JSONDecoder().decode(LabelParityFixture.self, from: try Data(contentsOf: url))
    for (label, count) in fixture.expected.sorted(by: { $0.key < $1.key }) {
        assertEqual(ItemLabelFilter.apply(fixture.items, query: label).count, count,
                    "paridade quebrada para o label \"\(label)\" — a contagem do filtro diverge do expected do fixture")
    }
}

test("Paridade: consulta vazia e nil devolvem a lista inteira do fixture (D-S05-4)") {
    guard let url = labelParityFixtureURL() else {
        assertTrue(false, "fixture label-filter-parity.json nao encontrado — isto e falha")
        return
    }
    let fixture = try JSONDecoder().decode(LabelParityFixture.self, from: try Data(contentsOf: url))
    assertEqual(ItemLabelFilter.apply(fixture.items, query: "").count, fixture.items.count,
                "consulta vazia nao e filtro — tem de devolver tudo")
    assertEqual(ItemLabelFilter.apply(fixture.items, query: nil).count, fixture.items.count,
                "consulta nil nao e filtro — tem de devolver tudo")
    assertEqual(ItemLabelFilter.apply(fixture.items, query: "   ").count, fixture.items.count,
                "consulta so-espaco nao e filtro — tem de devolver tudo")
}

test("Paridade: o item de status desconhecido do fixture tambem e filtrado (D-S05-2)") {
    guard let url = labelParityFixtureURL() else {
        assertTrue(false, "fixture label-filter-parity.json nao encontrado — isto e falha")
        return
    }
    let fixture = try JSONDecoder().decode(LabelParityFixture.self, from: try Data(contentsOf: url))
    let unknown = fixture.items.filter { $0.parsedStatus == nil }
    assertGreater(unknown.count, 0, "o fixture precisa de ao menos um item com status que o Swift nao reconhece")
    // Esse item carrega label; filtrar por ela tem de alcanca-lo — se o filtro
    // fosse aplicado por coluna, o item da coluna "Desconhecido" escaparia.
    for item in unknown {
        guard let label = item.labels?.first else {
            assertTrue(false, "o item de status desconhecido precisa carregar label, senao nao prova nada")
            continue
        }
        assertTrue(ItemLabelFilter.apply(fixture.items, query: label).contains(item),
                   "o item de status desconhecido \"\(item.id)\" sumiu ao filtrar por \"\(label)\"")
    }
}

test("Paridade: o par prefixo do fixture discrimina exato de substring (D-S05-1)") {
    guard let url = labelParityFixtureURL() else {
        assertTrue(false, "fixture label-filter-parity.json nao encontrado — isto e falha")
        return
    }
    let fixture = try JSONDecoder().decode(LabelParityFixture.self, from: try Data(contentsOf: url))
    let all = ItemLabelFilter.availableLabels(fixture.items)

    // Achar o par (curto, longo) em que o curto e prefixo estrito do longo —
    // e ele que mata casamento por substring. Sem esse par, o fixture nao
    // detecta a regressao que existe para detectar.
    var pair: (String, String)? = nil
    for short in all {
        for long in all where long != short && long.hasPrefix(short) { pair = (short, long) }
    }
    guard let (short, long) = pair else {
        assertTrue(false, "o fixture nao tem par prefixo (ex.: \"ui\" / \"ui-bug\") — substring passaria despercebido")
        return
    }

    // Um casamento por substring devolveria os itens de AMBOS os labels para a
    // consulta curta; o casamento exato devolve so os do curto.
    let exact = ItemLabelFilter.apply(fixture.items, query: short)
    let substringLike = fixture.items.filter { ($0.labels ?? []).contains { $0.contains(short) } }
    assertGreater(substringLike.count, exact.count,
                  "o par \"\(short)\"/\"\(long)\" nao distingue exato de substring neste fixture")
    assertTrue(exact.allSatisfy { ($0.labels ?? []).contains(short) },
               "apply(query: \"\(short)\") trouxe item que nao tem exatamente esse label")
    assertFalse(exact.contains { ($0.labels ?? []).contains(long) && !($0.labels ?? []).contains(short) },
                "apply(query: \"\(short)\") vazou um item que so tem \"\(long)\" — isso e 1 card a mais que o jq")
}

// MARK: - ItemLaunch (S06)

print("\nItemLaunch (o board origina trabalho — e só pelo botão)")

test("ItemLaunch.decide: os 5 movimentos consecutivos produzem ZERO LaunchRequest (D9/F7)") {
    let a = Item(id: "I-20260801120001", status: "inbox")
    let b = Item(id: "I-20260801120002", status: "triaged")
    let c = Item(id: "I-20260801120003", status: "doing")
    let d = Item(id: "I-20260801120004", status: "done")
    let e = Item(id: "I-20260801120005", status: "dropped")
    let gestures: [BoardGesture] = [
        .move(a, to: .doing),
        .move(b, to: .triaged),
        .move(c, to: .done),
        .move(d, to: .dropped),
        .move(e, to: .inbox),
    ]
    let requests = gestures.compactMap(ItemLaunch.decide)
    assertEqual(requests.count, 0, "contra-critério D9/F7: 5 movimentos → 0 abas — este teste é a prova headless dele")
}

test("ItemLaunch.decide: .move de item com status desconhecido devolve nil") {
    let item = Item(id: "I-20260801120006", status: "zzz")
    assertNil(ItemLaunch.decide(.move(item, to: .doing)))
}

test("ItemLaunch.decide: .openDetail devolve nil para qualquer item") {
    let open = Item(id: "I-20260801120007", status: "inbox")
    let done = Item(id: "I-20260801120008", status: "done")
    let unknown = Item(id: "I-20260801120009", status: "zzz")
    assertNil(ItemLaunch.decide(.openDetail(open)))
    assertNil(ItemLaunch.decide(.openDetail(done)))
    assertNil(ItemLaunch.decide(.openDetail(unknown)))
}

test("ItemLaunch.decide: .start de item triaged bem-formado devolve request com taskArgument e slashCommand corretos") {
    let item = Item(id: "I-20260801120010", status: "triaged")
    guard let request = ItemLaunch.decide(.start(item)) else {
        assertTrue(false, "item aberto e bem-formado deveria produzir um LaunchRequest")
        return
    }
    assertEqual(request.taskArgument, item.id, "taskArgument tem de ser exatamente o id puro (D-S06-4)")
    assertEqual(request.slashCommand, "/forge-task \(item.id)")
}

test("ItemLaunch.decide: .start de item inbox e de item doing também devolvem request (os três abertos)") {
    let inboxItem = Item(id: "I-20260801120011", status: "inbox")
    let doingItem = Item(id: "I-20260801120012", status: "doing")
    assertTrue(ItemLaunch.decide(.start(inboxItem)) != nil, "inbox é status aberto — deve poder começar")
    assertTrue(ItemLaunch.decide(.start(doingItem)) != nil, "doing é status aberto — deve poder começar")
}

test("ItemLaunch.decide: .start de item done devolve nil e refusal cita --set-status e o id") {
    let item = Item(id: "I-20260801120013", status: "done")
    assertNil(ItemLaunch.decide(.start(item)))
    guard let msg = ItemLaunch.refusal(for: item) else {
        assertTrue(false, "item done precisa de uma frase de recusa")
        return
    }
    assertTrue(msg.contains("--set-status"), "a frase de recusa tem de citar --set-status")
    assertTrue(msg.contains(item.id), "a frase de recusa tem de citar o id do item")
}

test("ItemLaunch.decide: .start de item dropped devolve nil") {
    let item = Item(id: "I-20260801120014", status: "dropped")
    assertNil(ItemLaunch.decide(.start(item)))
}

test("ItemLaunch.decide: .start de item de status desconhecido devolve nil") {
    let item = Item(id: "I-20260801120015", status: "zzz")
    assertNil(ItemLaunch.decide(.start(item)))
}

test("ItemLaunch.decide: .start de id fora da shape devolve nil em todos os casos") {
    let malformed = [
        "itm-20260801120000-x",
        "I-",
        "I-2026 08",
        "I-20260801120000-x extra",
    ]
    for id in malformed {
        let item = Item(id: id, status: "inbox")
        assertNil(ItemLaunch.decide(.start(item)), "id malformado \"\(id)\" não pode originar trabalho")
    }
}

test("ItemLaunch.isWellFormedItemID: aceita prefixo curto e timestamp completo com slug") {
    assertTrue(ItemLaunch.isWellFormedItemID("I-20260729235447-aceitacao-gui"))
    assertTrue(ItemLaunch.isWellFormedItemID("I-2026072912"))
}

test("ItemLaunch.isWellFormedItemID: recusa os quatro exemplos malformados") {
    assertFalse(ItemLaunch.isWellFormedItemID("itm-20260801120000-x"))
    assertFalse(ItemLaunch.isWellFormedItemID("I-"))
    assertFalse(ItemLaunch.isWellFormedItemID("I-2026 08"))
    assertFalse(ItemLaunch.isWellFormedItemID("I-20260801120000-x extra"))
}

test("ItemLaunch.refusal: nil para item que pode começar") {
    let item = Item(id: "I-20260801120016", status: "triaged")
    assertNil(ItemLaunch.refusal(for: item))
}

// MARK: - Paridade de gestos do board (S06/T04)
//
// O contra-criterio D9/F7 (LOCKED) exige que 5 movimentos consecutivos pelo
// menu "Mover para" produzam ZERO abas. Provar isso comparando ItemLaunch
// contra uma reimplementacao em Swift seria tautologia (mesmo raciocinio de
// D-S05-6). A prova mora num fixture unico,
// `app/fixtures/board-gesture-launches.json`, lido por DOIS lados
// independentes:
//
//   - este arquivo aplica ItemLaunch.decide a cada gesto NA ORDEM e assere
//     que a lista resultante de slashCommand bate com expected_launches,
//     item a item;
//   - scripts/forge-app-launch-parity.test.js RECALCULA expected_launches a
//     partir de items+gestures com uma regra propria (sem ler este arquivo)
//     e ainda ancora a forma do id no engine real (`forge-items.js --add`
//     sobre um store temporario).
//
// Consequencia deliberada: afrouxar um valor de expected_launches para
// fazer este lado passar quebra o lado JS. Nao existe atalho verde aqui.
//
// O fixture vive em app/fixtures/, FORA de qualquer `path:` de target no
// Package.swift — um .json dentro de Sources/ForgeKitTests/ viraria recurso
// nao declarado.

struct GestureFixtureItem: Decodable {
    let id: String
    let title: String?
    let status: String?
    let origin: String?
    let created: String?
    let updated: String?
    let closed_at: String?
}

struct Gesture: Decodable {
    let kind: String
    let item: String
    let to: String?
}

struct GestureFixture: Decodable {
    let items: [GestureFixtureItem]
    let gestures: [Gesture]
    let expected_launches: [String]
}

/// Resolve o fixture por `#filePath` (main.swift -> ForgeKitTests -> Sources ->
/// app), com fallback para o cwd. Devolve `nil` se nenhum dos dois existir — e
/// o chamador FALHA nesse caso: um fixture nao encontrado nunca pode virar
/// teste que passa silenciosamente. Nome novo (nao reusa
/// `labelParityFixtureURL`, S05/T04) mesmo compartilhando a forma.
func gestureLaunchFixtureURL() -> URL? {
    let fromSource = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // ForgeKitTests/
        .deletingLastPathComponent()   // Sources/
        .deletingLastPathComponent()   // app/
        .appendingPathComponent("fixtures/board-gesture-launches.json")
    if FileManager.default.fileExists(atPath: fromSource.path) { return fromSource }

    let fromCwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        .appendingPathComponent("fixtures/board-gesture-launches.json")
    if FileManager.default.fileExists(atPath: fromCwd.path) { return fromCwd }

    return nil
}

/// Decodifica o fixture e devolve um `[String: Item]` (por id) + a lista de
/// `Gesture` + `expected_launches`. Falha (via `fatalError`) se o fixture nao
/// existir — chamado apenas dentro de `test(...)`, cujo harness ja escreve a
/// mensagem de falha antes de qualquer chamada aqui; um `fatalError` neste
/// ponto so aconteceria se o teste que verifica a existencia do fixture ja
/// tivesse sido pulado, o que este arquivo nunca faz.
func loadGestureFixture() throws -> (items: [String: Item], gestures: [Gesture], expectedLaunches: [String]) {
    guard let url = gestureLaunchFixtureURL() else {
        throw NSError(domain: "GestureFixture", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "fixture board-gesture-launches.json nao encontrado nem por #filePath nem pelo cwd"
        ])
    }
    let data = try Data(contentsOf: url)
    let fixture = try JSONDecoder().decode(GestureFixture.self, from: data)
    var byId: [String: Item] = [:]
    for raw in fixture.items {
        byId[raw.id] = Item(
            id: raw.id, title: raw.title, status: raw.status, origin: raw.origin,
            created: raw.created, updated: raw.updated, closed_at: raw.closed_at
        )
    }
    return (byId, fixture.gestures, fixture.expected_launches)
}

/// Constroi o `BoardGesture` correspondente a uma entrada do fixture. Falha
/// (via `fatalError`) se `kind` for desconhecido ou se `item` nao existir em
/// `items` — um gesto que silenciosamente vira no-op mataria a prova.
func boardGesture(for g: Gesture, items: [String: Item]) -> BoardGesture {
    guard let item = items[g.item] else {
        fatalError("gesto referencia item \"\(g.item)\" que nao existe no fixture")
    }
    switch g.kind {
    case "move":
        guard let toRaw = g.to, let to = ItemStatus(rawValue: toRaw) else {
            fatalError("gesto move para \"\(g.to ?? "nil")\" nao e um ItemStatus valido")
        }
        return .move(item, to: to)
    case "drag":
        guard let toRaw = g.to, let to = ItemStatus(rawValue: toRaw) else {
            fatalError("gesto drag para \"\(g.to ?? "nil")\" nao e um ItemStatus valido")
        }
        return .drag(item, to: to)
    case "start":
        return .start(item)
    case "openDetail":
        return .openDetail(item)
    default:
        fatalError("gesto de kind desconhecido: \"\(g.kind)\"")
    }
}

test("Paridade de gestos: o fixture existe e decodifica em items + gestures + expected_launches") {
    guard gestureLaunchFixtureURL() != nil else {
        assertTrue(false, "fixture board-gesture-launches.json nao encontrado nem por #filePath nem pelo cwd — " +
                          "um fixture ausente NAO pode virar teste verde")
        return
    }
    let (items, gestures, expectedLaunches) = try loadGestureFixture()
    assertGreater(items.count, 0, "fixture.items nao pode ser vazio")
    assertGreater(gestures.count, 0, "fixture.gestures nao pode ser vazio")
    assertEqual(expectedLaunches.count, 1, "expected_launches do fixture tem de ter exatamente 1 entrada")
}

test("Paridade de gestos: ItemLaunch.decide aplicado NA ORDEM reproduz expected_launches item a item (D9/F7)") {
    guard gestureLaunchFixtureURL() != nil else {
        assertTrue(false, "fixture board-gesture-launches.json nao encontrado — isto e falha")
        return
    }
    let (items, gestures, expectedLaunches) = try loadGestureFixture()
    let boardGestures = gestures.map { boardGesture(for: $0, items: items) }
    let launches = boardGestures.compactMap(ItemLaunch.decide).map(\.slashCommand)
    assertEqual(launches, expectedLaunches,
                "paridade quebrada: a lista de launches produzida por ItemLaunch.decide diverge de expected_launches do fixture")
}

test("Paridade de gestos: o contra-criterio D9/F7 em voz alta — o prefixo dos 5 primeiros gestos produz ZERO launches") {
    guard gestureLaunchFixtureURL() != nil else {
        assertTrue(false, "fixture board-gesture-launches.json nao encontrado — isto e falha")
        return
    }
    let (items, gestures, _) = try loadGestureFixture()
    assertGreater(gestures.count, 4, "fixture precisa de pelo menos 5 gestos para exercitar o contra-criterio")
    let firstFive = Array(gestures.prefix(5))
    assertTrue(firstFive.allSatisfy { $0.kind == "move" },
               "os 5 primeiros gestos do fixture precisam ser todos \"move\" — o contra-criterio literal")
    let boardGestures = firstFive.map { boardGesture(for: $0, items: items) }
    let launches = boardGestures.compactMap(ItemLaunch.decide)
    assertEqual(launches.count, 0,
                "contra-criterio D9/F7: 5 movimentos consecutivos pelo menu \"Mover para\" tem de produzir ZERO LaunchRequest, produziu \(launches.count)")
}

// MARK: - Items (tokens visuais)

test("ItemStatus: os cinco status tem simbolo e tom, e nenhum simbolo se repete") {
    let symbols = ItemStatus.allCases.map(\.symbolName)
    assertEqual(symbols.count, 5, "esperados 5 status, vieram \(symbols.count)")
    assertEqual(Set(symbols).count, 5,
                "dois status compartilham o mesmo SF Symbol — a forma sozinha deixa de separar as colunas: \(symbols)")
    for s in ItemStatus.allCases {
        assert(!s.symbolName.isEmpty, "status \(s.rawValue) sem simbolo")
    }
}

test("ItemStatus: cada status tem tom proprio — nenhum par colide") {
    // `inbox` voltou a .neutral por decisao do operador (viu teal e indigo, e
    // recusou os dois). O que continua sendo propriedade: nenhum par de status
    // compartilha tom, senao a leitura por cor deixa de distinguir colunas.
    let tints = ItemStatus.allCases.map(\.tint)
    assertEqual(Set(tints).count, 5,
                "dois status compartilham tom: \(tints)")
    assertEqual(ItemStatus.doing.tint, ItemTint.orange, "doing continua sendo o unico tom quente")
    assertEqual(ItemStatus.done.tint, ItemTint.green, "done deveria ser verde")
}

test("ItemPriority: as quatro urgencias tem simbolo proprio e distinto") {
    let symbols = ItemPriority.allCases.map(\.symbolName)
    assertEqual(Set(symbols).count, 4,
                "duas prioridades compartilham simbolo — a leitura por forma deixa de funcionar: \(symbols)")
    for p in ItemPriority.allCases { assert(!p.symbolName.isEmpty, "\(p.rawValue) sem simbolo") }
}

test("ItemPriority: o tom e monotonico com a urgencia — p0 vermelho, p3 neutro") {
    assertEqual(ItemPriority.p0.tint, ItemTint.red, "p0 deveria ser vermelho")
    assertEqual(ItemPriority.p3.tint, ItemTint.neutral, "p3 nao deveria competir por atencao")
    assertEqual(Set(ItemPriority.allCases.map(\.tint)).count, 4,
                "duas prioridades compartilham tom — a triagem por cor deixa de funcionar")
}

test("labelTint: a paleta exclui neutral e red") {
    assert(!ItemCardPresentation.labelPalette.contains(.neutral),
           "um chip neutral e indistinguivel de um chip sem estilo")
    assert(!ItemCardPresentation.labelPalette.contains(.red),
           "vermelho e reservado a p0 — um label nao pode se passar por urgencia")
}

test("labelTint: determinismo — o mesmo texto sempre cai no mesmo tom") {
    for label in ["bug", "ui", "progresso", "parser", "d8", ""] {
        assertEqual(ItemCardPresentation.labelTint(label), ItemCardPresentation.labelTint(label),
                    "labelTint(\(label)) nao e deterministico")
    }
    // Regressao contra String.hashValue, que o Swift semeia por processo: se
    // alguem trocar FNV-1a por hashValue, estes valores fixos passam a variar
    // entre execucoes e o operador nunca aprende a cor.
    func fnv(_ s: String) -> ItemTint {
        var h: UInt32 = 2_166_136_261
        for b in Array(s.utf8) { h ^= UInt32(b); h = h &* 16_777_619 }
        return ItemCardPresentation.labelPalette[Int(h % UInt32(ItemCardPresentation.labelPalette.count))]
    }
    for label in ["bug", "ui", "progresso", "parser", "d8"] {
        assertEqual(ItemCardPresentation.labelTint(label), fnv(label),
                    "labelTint deixou de derivar de FNV-1a sobre os bytes utf8")
    }
}

test("labelTint: os labels reais do repo nao colapsam num tom so") {
    // A soma de escalares (primeira tentativa) jogava bug/ui/progresso/d8 todos
    // no mesmo slot — 4 de 5 iguais, o que anula a leitura por cor. Este teste
    // e a medida que reprovou aquela implementacao, nao uma formalidade.
    let labels = ["bug", "ui", "progresso", "parser", "d8"]
    let tints = Set(labels.map(ItemCardPresentation.labelTint))
    assert(tints.count >= 4,
           "\(labels.count) labels reais colapsaram em \(tints.count) tom(ns) — a cor deixa de distinguir: \(labels.map { "\($0)=\(ItemCardPresentation.labelTint($0).rawValue)" })")
}

test("shortID: devolve o slug de um id completo") {
    assertEqual(ItemCardPresentation.shortID("I-20260730202553-card-item-7-elementos"),
                "card-item-7-elementos",
                "o slug e a metade legivel do id")
}

test("shortID: sem slug cai nos ultimos 6 digitos do timestamp") {
    assertEqual(ItemCardPresentation.shortID("I-20260730202553"), "202553",
                "id sem slug deveria virar os ultimos 6 digitos")
}

test("shortID: id fora da forma I-<digitos>-<slug> volta inteiro, nunca mutilado") {
    assertEqual(ItemCardPresentation.shortID("TASK-017"), "TASK-017", "prefixo desconhecido deveria voltar inteiro")
    assertEqual(ItemCardPresentation.shortID("I-naodigito-slug"), "I-naodigito-slug",
                "timestamp nao numerico deveria voltar inteiro")
    assertEqual(ItemCardPresentation.shortID(""), "", "string vazia deveria voltar inteira")
}

// MARK: - Markdown (blocos)

test("markdown: paragrafos separados por linha em branco viram blocos distintos") {
    let b = MarkdownDoc.blocks("Primeiro.\n\nSegundo.")
    assertEqual(b.count, 2, "esperados 2 paragrafos, vieram \(b.count): \(b)")
    assertEqual(b, [.paragraph("Primeiro."), .paragraph("Segundo.")])
}

test("markdown: linhas consecutivas se juntam num paragrafo so") {
    assertEqual(MarkdownDoc.blocks("uma linha\noutra linha"), [.paragraph("uma linha outra linha")])
}

test("markdown: heading exige espaco depois dos hashes — #hashtag nao e heading") {
    assertEqual(MarkdownDoc.blocks("## Titulo"), [.heading(level: 2, text: "Titulo")])
    assertEqual(MarkdownDoc.blocks("#hashtag"), [.paragraph("#hashtag")],
                "#hashtag sem espaco tem de continuar paragrafo")
}

test("markdown: bullets viram UM bloco com os itens") {
    assertEqual(MarkdownDoc.blocks("- um\n- dois\n- tres"),
                [.bullets(["um", "dois", "tres"])])
}

test("markdown: *enfase* no inicio da linha NAO vira bullet") {
    assertEqual(MarkdownDoc.blocks("*enfase* no comeco"), [.paragraph("*enfase* no comeco")],
                "o marcador de bullet exige espaco — senao toda enfase inicial vira lista")
}

test("markdown: lista numerada") {
    assertEqual(MarkdownDoc.blocks("1. um\n2. dois"), [.numbered(["um", "dois"])])
}

test("markdown: fence preserva o conteudo VERBATIM — # e - la dentro sao codigo") {
    let src = "```swift\n# nao e heading\n- nao e bullet\n```"
    assertEqual(MarkdownDoc.blocks(src),
                [.code(language: "swift", text: "# nao e heading\n- nao e bullet")],
                "um diff colado no corpo nao pode ser mastigado como heading/bullet")
}

test("markdown: fence sem linguagem e fence nao fechado nao crasham") {
    assertEqual(MarkdownDoc.blocks("```\nx\n```"), [.code(language: nil, text: "x")])
    assertEqual(MarkdownDoc.blocks("```\nsem fim"), [.code(language: nil, text: "sem fim")],
                "fence nao fechado deveria consumir ate o fim, nao perder o conteudo")
}

test("markdown: regra horizontal e citacao") {
    assertEqual(MarkdownDoc.blocks("---"), [.rule])
    assertEqual(MarkdownDoc.blocks("> citado\n> em duas"), [.quote("citado em duas")])
}

test("markdown: --- e reconhecido como regra, nao como bullet") {
    let b = MarkdownDoc.blocks("antes\n\n---\n\ndepois")
    assertEqual(b, [.paragraph("antes"), .rule, .paragraph("depois")])
}

test("markdown: corpo vazio produz zero blocos") {
    assertEqual(MarkdownDoc.blocks(""), [])
    assertEqual(MarkdownDoc.blocks("\n\n   \n"), [])
}

test("markdown: documento misto na ordem do documento") {
    let src = "# Titulo\n\nUm paragrafo.\n\n- a\n- b\n\n```\ncodigo\n```\n\nFim."
    assertEqual(MarkdownDoc.blocks(src),
                [.heading(level: 1, text: "Titulo"),
                 .paragraph("Um paragrafo."),
                 .bullets(["a", "b"]),
                 .code(language: nil, text: "codigo"),
                 .paragraph("Fim.")])
}

// MARK: - Idade e checklist do card

test("checklist: conta [ ] e [x] do corpo") {
    let r = MarkdownDoc.checklist("- [x] feito\n- [ ] pendente\n- [ ] outro")
    assertEqual(r?.done, 1)
    assertEqual(r?.total, 3)
}

test("checklist: bullets normais nao contam") {
    assertNil(MarkdownDoc.checklist("- so um bullet\n- outro"))
}

test("checklist: um [ ] DENTRO de fence e literal, nao checkbox") {
    // Grepar a fonte crua contaria; blocks() preserva fence verbatim, entao o
    // filtro por .bullets ganha essa propriedade de graca.
    assertNil(MarkdownDoc.checklist("```\n- [ ] isso e exemplo de codigo\n```"),
              "checkbox dentro de fence nao pode ser contado")
}

test("checklist: corpo vazio ou nil devolve nil") {
    assertNil(MarkdownDoc.checklist(nil))
    assertNil(MarkdownDoc.checklist(""))
}

test("age: escala de agora ate meses, com now injetado") {
    let base = ProgressDate.parse("2026-08-02T12:00:00.000Z").instant!
    func item(_ iso: String) -> Item { Item(id: "I-1", title: "t", status: "inbox", created: iso) }
    assertEqual(ItemCardPresentation.age(for: item("2026-08-02T11:59:30.000Z"), now: base), "agora")
    assertEqual(ItemCardPresentation.age(for: item("2026-08-02T11:30:00.000Z"), now: base), "30min")
    assertEqual(ItemCardPresentation.age(for: item("2026-08-02T09:00:00.000Z"), now: base), "3h")
    assertEqual(ItemCardPresentation.age(for: item("2026-07-28T12:00:00.000Z"), now: base), "5d")
    assertEqual(ItemCardPresentation.age(for: item("2026-07-05T12:00:00.000Z"), now: base), "4sem")
}

test("age: created ausente, ilegivel ou no futuro devolve nil") {
    let base = ProgressDate.parse("2026-08-02T12:00:00.000Z").instant!
    assertNil(ItemCardPresentation.age(for: Item(id: "I-1", title: "t", status: "inbox"), now: base))
    assertNil(ItemCardPresentation.age(for: Item(id: "I-1", title: "t", status: "inbox", created: "lixo"), now: base))
    assertNil(ItemCardPresentation.age(for: Item(id: "I-1", title: "t", status: "inbox",
                                                 created: "2026-09-01T12:00:00.000Z"), now: base),
              "timestamp no futuro deveria devolver nil — 'ha -2d' e pior que nada")
}

// MARK: - Arrastar card e tom da idade

test("contra-criterio D9/F7 vale para o ARRASTAR igual ao menu — 5 drags, 0 launches") {
    let item = Item(id: "I-20260801120000-aberto", title: "Aberto", status: "doing")
    var launches: [LaunchRequest] = []
    for _ in 0..<5 {
        if let r = ItemLaunch.decide(.drag(item, to: .done)) { launches.append(r) }
    }
    assertEqual(launches.count, 0,
                "arrastar e organizar: 5 drags consecutivos tem de produzir ZERO LaunchRequest, produziu \(launches.count)")
}

test("drag nao olha o item — nem um item perfeitamente elegivel dispara") {
    // Mesma propriedade que .move: a recusa e estrutural, nao condicional.
    let elegivel = Item(id: "I-20260801120000-ok", title: "Ok", status: "doing",
                        body: "corpo", labels: ["bug"], priority: "p0")
    assertNil(ItemLaunch.decide(.drag(elegivel, to: .done)),
              "drag de item elegivel ainda assim nao pode disparar trabalho")
}

test("ageTint: fica mais alto conforme a tarefa envelhece") {
    let base = ProgressDate.parse("2026-08-02T12:00:00.000Z").instant!
    func item(_ iso: String, _ status: String = "inbox") -> Item {
        Item(id: "I-1", title: "t", status: status, created: iso)
    }
    assertEqual(ItemCardPresentation.ageTint(for: item("2026-08-02T06:00:00.000Z"), now: base), ItemTint.neutral)
    assertEqual(ItemCardPresentation.ageTint(for: item("2026-08-01T00:00:00.000Z"), now: base), ItemTint.blue)
    assertEqual(ItemCardPresentation.ageTint(for: item("2026-07-30T12:00:00.000Z"), now: base), ItemTint.yellow)
    assertEqual(ItemCardPresentation.ageTint(for: item("2026-07-24T12:00:00.000Z"), now: base), ItemTint.orange)
    assertEqual(ItemCardPresentation.ageTint(for: item("2026-07-01T12:00:00.000Z"), now: base), ItemTint.red)

    // A rampa tem de ser MONOTONICA: mais velho nunca pode ficar mais calmo.
    let ordem: [ItemTint] = [.neutral, .blue, .yellow, .orange, .red]
    let amostras = ["2026-08-02T06:00:00.000Z", "2026-08-01T00:00:00.000Z",
                    "2026-07-30T12:00:00.000Z", "2026-07-24T12:00:00.000Z",
                    "2026-07-01T12:00:00.000Z"]
    let obtidos = amostras.map { ItemCardPresentation.ageTint(for: item($0), now: base) }
    assertEqual(obtidos, ordem, "a rampa de idade deixou de ser calma -> urgente sem inversao")
}

test("ageTint: tarefa fechada nunca grita, por mais velha que seja") {
    let base = ProgressDate.parse("2026-08-02T12:00:00.000Z").instant!
    for st in ["done", "dropped"] {
        let velha = Item(id: "I-1", title: "t", status: st, created: "2025-01-01T12:00:00.000Z")
        assertEqual(ItemCardPresentation.ageTint(for: velha, now: base), ItemTint.neutral,
                    "status \(st): idade de item fechado e historia — gritar treina o operador a ignorar a cor")
    }
}

test("ageTint: created ausente devolve neutral, nunca crasha") {
    assertEqual(ItemCardPresentation.ageTint(for: Item(id: "I-1", title: "t", status: "inbox")), ItemTint.neutral)
}

// MARK: - Bloqueio

test("blockedCount: conta os ids e ignora vazios") {
    let it = Item(id: "I-1", title: "t", status: "doing", blocked_by: ["I-a", " ", "I-b", ""])
    assertEqual(ItemCardPresentation.blockedCount(it), 2, "ids em branco nao contam")
}

test("blockedCount: sem blocked_by, ou lista vazia, devolve nil e nao zero") {
    assertNil(ItemCardPresentation.blockedCount(Item(id: "I-1", title: "t", status: "doing")))
    assertNil(ItemCardPresentation.blockedCount(Item(id: "I-1", title: "t", status: "doing", blocked_by: [])))
    assertNil(ItemCardPresentation.blockedCount(Item(id: "I-1", title: "t", status: "doing", blocked_by: ["  "])),
              "so espaco em branco nao e bloqueio")
}

test("blockedCount: item fechado nunca aparece bloqueado") {
    for st in ["done", "dropped"] {
        let it = Item(id: "I-1", title: "t", status: st, blocked_by: ["I-a", "I-b"])
        assertNil(ItemCardPresentation.blockedCount(it),
                  "status \(st): ja entregou — bloqueio virou historia, e badge vermelho em card fechado e ruido")
    }
}

// MARK: - Texto dos recibos

test("shortTitle: titulo curto passa inteiro") {
    let it = Item(id: "I-1", title: "Corrigir o parser", status: "inbox")
    assertEqual(ItemCardPresentation.shortTitle(it), "Corrigir o parser")
}

test("shortTitle: corta em fronteira de palavra quando ha uma no ultimo terco") {
    let it = Item(id: "I-1", title: "Criacao anonima de pedido sem rate limit", status: "inbox")
    let out = ItemCardPresentation.shortTitle(it, max: 28)
    assertTrue(out.hasSuffix("…"), "deveria sinalizar corte")
    assertFalse(out.contains("  "), "nao deveria sobrar espaco duplo antes das reticencias")
    assertTrue(out.count <= 29, "passou do teto: \(out.count) — \(out)")
    assertFalse(out.dropLast().hasSuffix(" "), "nao deveria terminar em espaco antes das reticencias")
}

test("shortTitle: sem espaco no ultimo terco corta seco, sem perder o teto") {
    let it = Item(id: "I-1", title: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", status: "inbox")
    let out = ItemCardPresentation.shortTitle(it, max: 10)
    assertEqual(out, "AAAAAAAAAA…")
}

test("shortTitle: item sem titulo cai no fallback, nao em string vazia") {
    assertEqual(ItemCardPresentation.shortTitle(Item(id: "I-1", title: "   ", status: "inbox")),
                ItemCardPresentation.missingTitle)
}

// MARK: - Busca de projeto

test("ProjectFilter: busca vazia devolve tudo, nunca nada") {
    let ps = ["/a/forge-agent", "/b/lookchina"]
    assertEqual(ProjectFilter.matches(ps, query: ""), ps)
    assertEqual(ProjectFilter.matches(ps, query: "   "), ps,
                "caixa de busca em branco significa SEM filtro, nao SEM resultado")
}

test("ProjectFilter: casa pelo nome exibido e tambem pelo caminho") {
    let ps = ["/Users/x/work/forge-agent", "/Users/x/side/lookchina"]
    assertEqual(ProjectFilter.matches(ps, query: "forge"), ["/Users/x/work/forge-agent"])
    assertEqual(ProjectFilter.matches(ps, query: "side"), ["/Users/x/side/lookchina"],
                "quem lembra onde o projeto mora tem de conseguir achar pelo caminho")
}

test("ProjectFilter: ignora caixa e acento") {
    let ps = ["/a/Metricas-Painel", "/b/outro"]
    assertEqual(ProjectFilter.matches(ps, query: "MÉTRICAS"), ["/a/Metricas-Painel"],
                "ninguem digita acento numa caixa de busca")
}

test("ProjectFilter: preserva a ordem de entrada") {
    let ps = ["/z/alfa-x", "/a/alfa-y"]
    assertEqual(ProjectFilter.matches(ps, query: "alfa"), ps,
                "a ordem e a que o operador registrou; reordenar aqui seria decisao escondida")
}

test("ProjectFilter: sem casamento devolve lista vazia") {
    assertEqual(ProjectFilter.matches(["/a/forge-agent"], query: "zzz"), [])
}

// MARK: - Busca livre no board

private func searchFixture() -> [Item] {
    [Item(id: "I-20260801120001-parser", title: "Corrigir o parser de datas", status: "inbox",
          labels: ["bug"]),
     Item(id: "I-20260801120002-sem-label", title: "Tarefa sem label nenhum", status: "doing"),
     Item(id: "I-20260801120003-outro", title: "Métricas do painel", status: "inbox")]
}

test("ItemSearch: acha por titulo, que e o caso que o filtro de label nao cobre") {
    let r = ItemSearch.apply(searchFixture(), query: "parser")
    assertEqual(r.count, 1)
    assertEqual(r.first?.id, "I-20260801120001-parser")
}

test("ItemSearch: acha item SEM label — o cenario que tornava o campo inutil") {
    let r = ItemSearch.apply(searchFixture(), query: "sem label")
    assertEqual(r.count, 1, "um item sem labels tem de continuar alcancavel pela busca")
}

test("ItemSearch: acha por id e por label") {
    assertEqual(ItemSearch.apply(searchFixture(), query: "120003").count, 1)
    assertEqual(ItemSearch.apply(searchFixture(), query: "bug").count, 1)
}

test("ItemSearch: ignora caixa e acento") {
    assertEqual(ItemSearch.apply(searchFixture(), query: "METRICAS").count, 1,
                "ninguem digita acento numa caixa de busca")
}

test("ItemSearch: busca vazia devolve tudo") {
    assertEqual(ItemSearch.apply(searchFixture(), query: "").count, 3)
    assertEqual(ItemSearch.apply(searchFixture(), query: nil).count, 3)
    assertEqual(ItemSearch.apply(searchFixture(), query: "   ").count, 3)
}

test("ItemSearch NAO substitui ItemLabelFilter — a regra exata do criterio #5 segue intacta") {
    // ItemSearch e substring; ItemLabelFilter e igualdade de elemento. Confundir
    // os dois faria "ui" casar "ui-bug", que e a divergencia de 1 card que o
    // criterio #5 chama de falha.
    let its = [Item(id: "I-1", title: "t", status: "inbox", labels: ["ui-bug"])]
    assertEqual(ItemLabelFilter.apply(its, query: "ui").count, 0,
                "ItemLabelFilter continua exato")
    assertEqual(ItemSearch.apply(its, query: "ui").count, 1,
                "ItemSearch e substring de proposito — sao regras diferentes, e as duas existem")
}

// ── WorkspaceRegistry ───────────────────────────────────────────────────────
//
// Fixtures are byte literals and `home` is a synthetic string: nothing here
// reads the operator's real `~/.claude/`. That matters beyond hygiene — these
// tests run both under `swift run ForgeKitTests` (real $HOME) and through
// run-tests.js (isolated $HOME), and a test that touched the real path would
// pass in one launcher and lie in the other.

let synthHome = "/tmp/forge-synth-home"

func regData(_ s: String) -> Data { Data(s.utf8) }

let legacyFixture = regData("""
["/Users/x/Development/forge-agent","~/Development/lookchina"]
""")

let versionedFixture = regData("""
{
  "version": 1,
  "roots": [{"path": "~/Development", "primary": true}],
  "entries": [
    {"path": "forge-agent", "root": "~/Development", "kind": "project", "repos": []},
    {"path": "my project", "root": "~/Development", "kind": "project", "repos": ["freyr"]},
    {"path": "~/Library/Application Support/Forge/Sandbox", "root": null, "kind": "project", "repos": []}
  ],
  "quarantine": [
    {"path": "lookchina/services", "root": "~/Development", "reason": "touched"}
  ]
}
""")

test("WorkspaceRegistry: le a forma legada [String] — o arquivo que esta no disco hoje") {
    let r = WorkspaceRegistry.resolution(from: legacyFixture, home: synthHome)
    assertEqual(r?.shape, .legacy)
    assertEqual(r?.paths.count, 2)
    assertEqual(r?.paths.first, "/Users/x/Development/forge-agent")
}

test("WorkspaceRegistry: le a forma versionada como ativos ∪ quarentena") {
    let r = WorkspaceRegistry.resolution(from: versionedFixture, home: synthHome)
    assertEqual(r?.shape, .versioned(1))
    assertEqual(r?.paths.count, 4, "3 entries + 1 quarentena — a quarentena continua visivel")
    assertTrue(r?.paths.contains("\(synthHome)/Development/forge-agent") == true)
    assertTrue(r?.paths.contains("\(synthHome)/Development/lookchina/services") == true,
               "sumir com a quarentena e o mesmo defeito de sumir com o projeto")
}

test("WorkspaceRegistry: kind workspace chega ao leitor — o campo que o aviso precisa") {
    // I-20260803154521: the reader dropped `kind` entirely, so the hazard had
    // nothing to distinguish a promoted workspace from a stray .gsd/ by.
    let data = Data("""
    {"version":1,"roots":["~/Development"],"entries":[
      {"root":"~/Development","path":"lookchina","kind":"workspace","repos":[]},
      {"root":"~/Development","path":"lookchina/apps/odin","kind":"project","repos":[]}
    ],"quarantine":[
      {"root":"~/Development","path":"velho","reason":"touched"}
    ]}
    """.utf8)
    let r = WorkspaceRegistry.resolution(from: data, home: synthHome)
    assertEqual(r?.declaredWorkspaces, ["\(synthHome)/Development/lookchina"],
                "so o que declara kind:workspace")
    assertFalse(r?.declaredWorkspaces.contains("\(synthHome)/Development/velho") == true,
                "quarentena nao esta ativa — nao pode conter nada na tela")
}

test("WorkspaceRegistry: forma legada nao declara workspace nenhum") {
    let r = WorkspaceRegistry.resolution(from: legacyFixture, home: synthHome)
    assertEqual(r?.declaredWorkspaces, [],
                "nao ha campo kind na forma plana — declarar seria chutar")
}

test("WorkspaceRegistry: caminho com espacos sobrevive ao join root-relativo") {
    let r = WorkspaceRegistry.resolution(from: versionedFixture, home: synthHome)
    assertTrue(r?.paths.contains("\(synthHome)/Development/my project") == true,
               "um espaco no nome do diretorio nao pode partir a entrada em duas")
}

test("WorkspaceRegistry: expansao de ~ usa o home passado, nunca o ambiente") {
    let a = WorkspaceRegistry.activePaths(from: versionedFixture, home: "/home/alice") ?? []
    let b = WorkspaceRegistry.activePaths(from: versionedFixture, home: "/home/bob") ?? []
    assertTrue(a.contains("/home/alice/Library/Application Support/Forge/Sandbox"))
    assertTrue(b.contains("/home/bob/Library/Application Support/Forge/Sandbox"))
    assertTrue(!a.contains(where: { $0.hasPrefix("/home/bob") }),
               "um codec que fecha sobre o home ambiente nao viaja entre maquinas")
}

test("WorkspaceRegistry: arquivo ilegivel devolve nil, nunca [] — o defeito de origem") {
    assertNil(WorkspaceRegistry.resolution(from: regData("{ nao e json"), home: synthHome),
              "registry corrompido e registry vazio sao fatos diferentes")
    assertNil(WorkspaceRegistry.resolution(from: regData("42"), home: synthHome))
    let empty = WorkspaceRegistry.resolution(from: regData("[]"), home: synthHome)
    assertEqual(empty?.paths.count, 0, "vazio de verdade continua sendo vazio")
}

test("WorkspaceRegistry: version desconhecida ainda e lida — recusar aqui apagaria a lista") {
    let future = regData("""
    {"version": 9, "entries": [{"path": "~/Development/x", "root": null}]}
    """)
    let r = WorkspaceRegistry.resolution(from: future, home: synthHome)
    assertEqual(r?.paths, ["\(synthHome)/Development/x"])
}

test("WorkspaceRegistry: entrada que escapa do root e rejeitada — mesmo guard do codec JS") {
    let evil = regData("""
    {"version": 1, "roots": [{"path": "~/Development", "primary": true}],
     "entries": [{"path": "../../../etc", "root": "~/Development"},
                 {"path": "/tmp/absoluto", "root": "~/Development"},
                 {"path": "relativo-sem-root", "root": null},
                 {"path": "ok", "root": "~/Development"}]}
    """)
    let r = WorkspaceRegistry.resolution(from: evil, home: synthHome)
    assertEqual(r?.paths, ["\(synthHome)/Development/ok"],
                "dois leitores do mesmo arquivo, o mais fraco define o comportamento")
    assertEqual(r?.rejected.count, 3, "rejeitada e reportada — nao descartada em silencio")
}

test("WorkspaceRegistry: save preserva a forma versionada — roots e quarentena sobrevivem") {
    let paths = WorkspaceRegistry.activePaths(from: versionedFixture, home: synthHome) ?? []
    let removed = paths.filter { $0 != "\(synthHome)/Development/forge-agent" }
    let out = WorkspaceRegistry.updatedData(
        original: versionedFixture, newPaths: removed, home: synthHome)
    let obj = try! JSONSerialization.jsonObject(with: out!) as! [String: Any]
    assertEqual((obj["roots"] as? [Any])?.count, 1, "roots[] nao pode evaporar num clique de Remover")
    assertEqual((obj["quarantine"] as? [Any])?.count, 1)
    assertEqual(obj["version"] as? Int, 1)
    let entries = obj["entries"] as! [[String: Any]]
    assertEqual(entries.count, 2, "so a entrada removida sai")
    assertTrue(entries.contains { ($0["repos"] as? [String]) == ["freyr"] },
               "repos[] de uma entrada intocada segue intacto")
    assertTrue(WorkspaceRegistry.activePaths(from: out!, home: synthHome)?.sorted() == removed.sorted(),
               "round-trip: o que foi salvo e o que volta a ser lido")
}

// `layout` (hoje so `layout.worktrees`) e escrito e lido apenas pelo lado JS —
// `forge-isolation.js` decide por ele onde uma worktree nasce. O app nao sabe o
// que o campo significa e nao precisa saber; a unica obrigacao dele e nao
// destruir o campo ao salvar. `updatedData` mexe so em entries/quarantine/
// version e passa `roots[]` adiante intacto, e isso e a razao de o JS poder ser
// dono exclusivo do formato. Razao nao verificada e suposicao: um clique em
// Remover que apagasse `layout` mandaria as worktrees seguintes para outro
// diretorio, em silencio. Por isso isto e um teste, nao um comentario.
test("WorkspaceRegistry: save preserva layout do root — o campo de que so o JS e dono") {
    let withLayout = regData("""
    {
      "version": 1,
      "roots": [{"path": "~/Development", "primary": true,
                 "layout": {"worktrees": ".forge-worktrees", "futuro": {"n": 1}}},
                {"path": "~/Desktop"}],
      "entries": [{"path": "forge-agent", "root": "~/Development", "kind": "project", "repos": []}],
      "quarantine": []
    }
    """)
    let out = WorkspaceRegistry.updatedData(
        original: withLayout, newPaths: ["\(synthHome)/Development/outro"], home: synthHome)
    let obj = try! JSONSerialization.jsonObject(with: out!) as! [String: Any]
    let roots = obj["roots"] as? [[String: Any]]
    assertEqual(roots?.count, 2, "os dois roots sobrevivem")
    let layout = roots?.first?["layout"] as? [String: Any]
    assertEqual(layout?["worktrees"] as? String, ".forge-worktrees",
                "layout.worktrees sobrevive ao save — apaga-lo mudaria onde as worktrees nascem")
    assertEqual((layout?["futuro"] as? [String: Any])?["n"] as? Int, 1,
                "um campo de layout que este app nem conhece tambem sobrevive — preservacao e opaca, nao seletiva")
    assertEqual(roots?.last?["path"] as? String, "~/Desktop", "um root sem layout continua sem layout")
    assertTrue(roots?.last?["layout"] == nil, "e ninguem inventa um layout para ele")
}

test("WorkspaceRegistry: caminho novo entra como root null e kind project") {
    let paths = WorkspaceRegistry.activePaths(from: versionedFixture, home: synthHome) ?? []
    let out = WorkspaceRegistry.updatedData(
        original: versionedFixture, newPaths: paths + ["\(synthHome)/Development/novo"],
        home: synthHome)!
    let obj = try! JSONSerialization.jsonObject(with: out) as! [String: Any]
    let added = (obj["entries"] as! [[String: Any]]).first { ($0["path"] as? String)?.hasSuffix("novo") == true }
    assertTrue(added != nil, "a entrada adicionada tem de existir")
    assertTrue(added?["root"] is NSNull, "root e recalculado pelo loader JS — inventar um aqui e um chute que sobrevive ao clique")
    assertEqual(added?["kind"] as? String, "project")
    assertEqual(WorkspaceRegistry.activePaths(from: out, home: synthHome)?.count, 5)
}

test("WorkspaceRegistry: arquivo legado continua sendo escrito legado — migrar e tarefa da CLI") {
    let out = WorkspaceRegistry.updatedData(
        original: legacyFixture, newPaths: ["/b", "/a", "/a"], home: synthHome)!
    let arr = try! JSONSerialization.jsonObject(with: out) as? [String]
    assertEqual(arr, ["/a", "/b"], "dedup + sort, exatamente o comportamento anterior")
}

test("WorkspaceRegistry: sem arquivo, escreve legado (primeiro projeto de uma instalacao nova)") {
    let out = WorkspaceRegistry.updatedData(original: nil, newPaths: ["/a"], home: synthHome)!
    assertEqual(try! JSONSerialization.jsonObject(with: out) as? [String], ["/a"])
}

test("WorkspaceRegistry: save recusa sobrescrever um arquivo ilegivel") {
    assertNil(WorkspaceRegistry.updatedData(
        original: regData("{ lixo"), newPaths: ["/a"], home: synthHome),
        "recusar salvar e recuperavel; sobrescrever o que nao foi entendido nao e")
}

test("WorkspaceRegistry: R2 - newPaths filtrado por existencia em disco apaga registro valido (mecanismo do bug)") {
    // Reproduz o mecanismo exato do S01-REVIEW R2: um registro cujo diretorio
    // sumiu do disco resolve normalmente (resolveStored e puro, nunca toca o
    // filesystem) mas nao aparece no `newPaths` quando o CHAMADOR filtra por
    // `fileExists` antes de salvar — exatamente o que `Workspaces.load()`
    // fazia em `Stores.swift` antes do fix. O fix (Stores.swift `add`/`remove`
    // usando `loadAllResolved()`, sem filtro de existencia) e o que garante que
    // o `newPaths` passado aqui contenha SEMPRE a resolucao completa — este
    // teste falha (perde a entrada) se alguem voltar a filtrar por
    // `fileExists` antes de montar `newPaths`.
    let reg = regData("""
    {"version": 1, "entries": [{"path": "~/Development/deleted-dir", "root": null},
                               {"path": "~/Development/ok", "root": null}]}
    """)
    let allResolved = WorkspaceRegistry.activePaths(from: reg, home: synthHome) ?? []
    assertEqual(allResolved.count, 2, "resolveStored e puro — ambos resolvem mesmo sem existir no disco")

    // Simula o bug: o chamador filtrou por existencia (nenhum dos dois existe
    // de verdade neste teste) antes de montar newPaths, entao "deleted-dir"
    // nao chega em updatedData por um clique em outro projeto qualquer.
    let filteredLikeOldBug = allResolved.filter { _ in false } // nenhum "existe" no fixture
    let outBuggy = WorkspaceRegistry.updatedData(
        original: reg, newPaths: filteredLikeOldBug, home: synthHome)!
    assertEqual(WorkspaceRegistry.activePaths(from: outBuggy, home: synthHome)?.count, 0,
                "prova do bug: filtrar por existencia antes de newPaths apaga tudo")

    // O fix: newPaths vem da resolucao completa (loadAllResolved), sem filtro
    // de existencia — a entrada sobrevive a um add/remove nao relacionado.
    let outFixed = WorkspaceRegistry.updatedData(
        original: reg, newPaths: allResolved, home: synthHome)!
    assertEqual(WorkspaceRegistry.activePaths(from: outFixed, home: synthHome)?.sorted(),
                allResolved.sorted(),
                "com newPaths nao-filtrado por existencia, nada e perdido")
}

test("WorkspaceRegistry: R3 - updatedData recusa reescrever uma versao futura") {
    let future = regData("""
    {"version": 9, "entries": [{"path": "~/Development/x", "root": null}]}
    """)
    assertNil(WorkspaceRegistry.updatedData(original: future, newPaths: ["/anything"], home: synthHome),
               "declarar version 9 e escrever de volta sob regras v1 e o defeito exato do R3")
    // A leitura tolerante continua funcionando — so a escrita e recusada.
    assertEqual(WorkspaceRegistry.activePaths(from: future, home: synthHome), ["\(synthHome)/Development/x"])
    // version igual ao que este modulo escreve continua salvando normalmente.
    let current = regData("""
    {"version": 1, "entries": [{"path": "~/Development/x", "root": null}]}
    """)
    assertTrue(WorkspaceRegistry.updatedData(original: current, newPaths: ["/anything"], home: synthHome) != nil,
               "version == WorkspaceRegistry.version continua gravavel")
}

test("WorkspaceRegistry: R4 - root nao ancorado (nem absoluto nem ~) e rejeitado") {
    let unanchored = regData("""
    {"version": 1, "entries": [{"path": "x", "root": "relative/root"},
                               {"path": "y", "root": "~/Development"}]}
    """)
    let r = WorkspaceRegistry.resolution(from: unanchored, home: synthHome)
    assertEqual(r?.paths, ["\(synthHome)/Development/y"],
                "root relativo herdaria o cwd do processo — mesma classe de risco que entradas soltas ja recusam")
    assertEqual(r?.rejected.count, 1)
    assertTrue(r?.rejected.first?.reason.contains("neither absolute nor") == true)
}

test("WorkspaceRegistry: entrada irresolvivel nao e apagada por um clique alheio") {
    let broken = regData("""
    {"version": 1, "entries": [{"path": "relativa-sem-root", "root": null},
                               {"path": "~/Development/ok", "root": null}]}
    """)
    let out = WorkspaceRegistry.updatedData(
        original: broken, newPaths: ["\(synthHome)/Development/ok"], home: synthHome)!
    let obj = try! JSONSerialization.jsonObject(with: out) as! [String: Any]
    assertEqual((obj["entries"] as? [Any])?.count, 2,
                "a linha que o operador precisa ver para consertar e a que sumiria primeiro")
}

// ── T05: Run address decode parity ──────────────────────────────────────────
//
// `branch`/`root`/`project` are additive (T03, `forge-runs.js`): every one of
// the 7 run records live on disk when T03 shipped predates them. Both
// directions are proven against fixture JSON, not by inspection of the
// `Codable` synthesis.

/// Every key a run record written before T03 has — copied from a live record
/// shape (`.gsd/forge/runs/*.json` in this repo) verbatim, minus operator PII,
/// with no `branch`/`root`/`project` key at all (not even `null`) because that
/// is exactly what "written before the field existed" looks like on disk.
let legacyRunFixture = """
{
  "kind": "milestone",
  "id": "M-20260729120052-backlog-itens-projeto",
  "session_id": "faa4abc1-e77a-4737-a72c-57b8d9d99109",
  "active": false,
  "started_at": 1785327373325,
  "last_heartbeat": 1785338419005,
  "worker": null,
  "worker_started": null,
  "isolation_mode": "branch",
  "milestone_dir": ".gsd/milestones/M-20260729120052-backlog-itens-projeto/",
  "cwd": "/Users/tester/Development/forge-agent",
  "account": "lookchina",
  "task_description": null,
  "deactivated_reason": null
}
"""

test("Run: decodifica um registro legado (sem branch/root/project) — nao lanca, campos ficam nil") {
    let run = try! JSONDecoder().decode(Run.self, from: Data(legacyRunFixture.utf8))
    assertEqual(run.id, "M-20260729120052-backlog-itens-projeto")
    assertNil(run.branch, "campo ausente no JSON legado deve decodificar como nil, nao lancar")
    assertNil(run.root)
    assertNil(run.project)
}

test("Run: decodifica os 7 registros legados vivos sem lancar (shape exato de todos)") {
    // Sete variações do shape acima — cada uma reflete um traço real observado
    // nos registros vivos (worker preenchido, deactivated_reason presente,
    // milestone vs task, account nil) para não testar só o caso feliz de um.
    let shapes = [
        legacyRunFixture,
        legacyRunFixture.replacingOccurrences(of: "\"worker\": null", with: "\"worker\": \"execute-task/T05\""),
        legacyRunFixture.replacingOccurrences(of: "\"account\": \"lookchina\"", with: "\"account\": null"),
        legacyRunFixture.replacingOccurrences(of: "\"active\": false", with: "\"active\": true"),
        legacyRunFixture.replacingOccurrences(of: "\"kind\": \"milestone\"", with: "\"kind\": \"task\""),
        legacyRunFixture.replacingOccurrences(of: "\"deactivated_reason\": null", with: "\"deactivated_reason\": \"encerrado\""),
        legacyRunFixture.replacingOccurrences(of: "\"last_heartbeat\": 1785338419005", with: "\"last_heartbeat\": null"),
    ]
    for (i, shape) in shapes.enumerated() {
        let run = try? JSONDecoder().decode(Run.self, from: Data(shape.utf8))
        assertTrue(run != nil, "registro legado #\(i) deveria decodificar sem lancar")
        assertNil(run?.branch, "registro legado #\(i): branch deve ser nil")
        assertNil(run?.root, "registro legado #\(i): root deve ser nil")
        assertNil(run?.project, "registro legado #\(i): project deve ser nil")
    }
}

test("Run: decodifica um registro com branch/root/project presentes — valores chegam intactos") {
    let json = """
    {
      "kind": "task", "id": "T-1", "session_id": "s1", "active": true,
      "started_at": 1000, "last_heartbeat": 2000, "worker": null,
      "worker_started": null, "isolation_mode": "branch", "milestone_dir": null,
      "cwd": "/Users/tester/Development/forge-agent", "account": null,
      "task_description": null, "deactivated_reason": null,
      "branch": "forge/T-1", "root": "~/Development", "project": "forge-agent"
    }
    """
    let run = try! JSONDecoder().decode(Run.self, from: Data(json.utf8))
    assertEqual(run.branch, "forge/T-1")
    assertEqual(run.root, "~/Development")
    assertEqual(run.project, "forge-agent")
}

test("Run: branch/root/project explicitamente null decodificam como nil (forge-runs.js withAddressDefaults)") {
    // `withAddressDefaults` no lado JS grava `null` (nao omite a chave) quando o
    // campo e desconhecido — as duas formas (chave ausente / chave null) tem
    // que chegar iguais do lado Swift.
    let json = legacyRunFixture.replacingOccurrences(
        of: "\"deactivated_reason\": null",
        with: "\"deactivated_reason\": null, \"branch\": null, \"root\": null, \"project\": null")
    let run = try! JSONDecoder().decode(Run.self, from: Data(json.utf8))
    assertNil(run.branch)
    assertNil(run.root)
    assertNil(run.project)
}

// ── T05 · I-20260803132250 — call-site regression for the fileExists guard ──
//
// The invariant ("a save's newPaths must come from the unfiltered resolution,
// never from what happens to exist on disk") is proven twice on purpose:
//
//   1. `WorkspaceRegistry: R2 - ...` (above, S01-REVIEW) proves the mechanism
//      inside `updatedData` in isolation.
//   2. This block proves it at the production CALL SITE — the exact function
//      `Stores.swift`'s `add`/`remove` route their mutation through,
//      `WorkspaceRegistry.mutatedPaths(allResolved:adding:removing:)` — with
//      the specific scenario named in the must-have: an unrelated add/remove
//      must not evict a `quarantine[]` row whose directory is gone.
//
// `ForgeKitTests` cannot import the `Forge` executable target `Stores.swift`
// lives in, so this guards the underlying `WorkspaceRegistry` mechanism that
// `Stores.add`/`Stores.remove` call — not `Stores` itself. Said explicitly
// per T05-PLAN step 6 rather than left implied.

test("I-20260803132250: mutatedPaths ignora existencia em disco por construcao — sem parametro 'visible' para aceitar por engano") {
    // A quarentena tem um diretorio que nao existe mais no disco. resolveStored
    // ainda resolve o caminho (e puro), entao ele aparece em allResolved.
    let reg = regData("""
    {"version": 1,
     "entries": [{"path": "ok", "root": "~/Development", "kind": "project", "repos": []}],
     "quarantine": [{"path": "sumido", "root": "~/Development", "reason": "touched"}]}
    """)
    let allResolved = WorkspaceRegistry.activePaths(from: reg, home: synthHome) ?? []
    assertEqual(allResolved.count, 2, "entry + quarentena, mesmo com o diretorio da quarentena ausente do disco")

    // Um add nao-relacionado, roteado exatamente como Stores.add(_:) roteia.
    let novo = "\(synthHome)/Development/novo-projeto"
    let newPaths = WorkspaceRegistry.mutatedPaths(allResolved: allResolved, adding: novo)

    let out = WorkspaceRegistry.updatedData(original: reg, newPaths: newPaths, home: synthHome)!
    let survivors = WorkspaceRegistry.activePaths(from: out, home: synthHome) ?? []
    assertTrue(survivors.contains("\(synthHome)/Development/sumido"),
               "a linha da quarentena cujo diretorio sumiu tem de sobreviver a um add nao-relacionado")
    assertTrue(survivors.contains("\(synthHome)/Development/ok"))
    assertTrue(survivors.contains(novo))
    assertEqual(survivors.count, 3)
}

test("I-20260803132250: com o mecanismo do bug (newPaths filtrado por existencia), a mesma quarentena e apagada") {
    // Contraste direto do teste acima: se o chamador tivesse montado newPaths a
    // partir do que EXISTE no disco (o que `Workspaces.load()` — nunca
    // `loadAllResolved()` — devolveria), a linha sumida nao sobrevive.
    let reg = regData("""
    {"version": 1,
     "entries": [{"path": "ok", "root": "~/Development", "kind": "project", "repos": []}],
     "quarantine": [{"path": "sumido", "root": "~/Development", "reason": "touched"}]}
    """)
    let allResolved = WorkspaceRegistry.activePaths(from: reg, home: synthHome) ?? []
    let visibleLikeLoad = allResolved.filter { _ in false } // nada "existe" no fixture — o mesmo que load() filtrado veria aqui
    let novo = "\(synthHome)/Development/novo-projeto"
    let buggyNewPaths = WorkspaceRegistry.mutatedPaths(allResolved: visibleLikeLoad, adding: novo)

    let out = WorkspaceRegistry.updatedData(original: reg, newPaths: buggyNewPaths, home: synthHome)!
    let survivors = WorkspaceRegistry.activePaths(from: out, home: synthHome) ?? []
    assertTrue(!survivors.contains("\(synthHome)/Development/sumido"),
               "prova do risco: alimentar mutatedPaths com a lista filtrada apaga a quarentena — e exatamente o que Stores.add/remove NAO fazem")
    assertTrue(!survivors.contains("\(synthHome)/Development/ok"),
               "o registro visivel tambem some — o filtro apaga tudo que nao esta no disco agora, nao so a quarentena")
}

test("I-20260803132250: mutatedPaths remove so o alvo — quarentena e o resto sobrevivem a um remove nao-relacionado") {
    let reg = regData("""
    {"version": 1,
     "entries": [{"path": "ok", "root": "~/Development", "kind": "project", "repos": []},
                 {"path": "outro", "root": "~/Development", "kind": "project", "repos": []}],
     "quarantine": [{"path": "sumido", "root": "~/Development", "reason": "touched"}]}
    """)
    let allResolved = WorkspaceRegistry.activePaths(from: reg, home: synthHome) ?? []
    let alvo = "\(synthHome)/Development/outro"
    let newPaths = WorkspaceRegistry.mutatedPaths(allResolved: allResolved, removing: alvo)

    let out = WorkspaceRegistry.updatedData(original: reg, newPaths: newPaths, home: synthHome)!
    let survivors = WorkspaceRegistry.activePaths(from: out, home: synthHome) ?? []
    assertTrue(survivors.contains("\(synthHome)/Development/sumido"), "quarentena sobrevive a um remove alheio")
    assertTrue(survivors.contains("\(synthHome)/Development/ok"))
    assertTrue(!survivors.contains(alvo), "o alvo do remove de fato sai")
    assertEqual(survivors.count, 2)
}

// ── Declared roots govern the scan ──────────────────────────────────────────
//
// Two halves of one property: the registry can say where to look
// (`Resolution.roots`), and discovery looks exactly there
// (`scan(declaredRoots:)`). Both halves are exercised without reading
// `~/.claude/` or the ambient home — byte fixtures for the first, throwaway
// trees under NSTemporaryDirectory for the second (S02-RISK blocker 3).

let rootsFixture = regData("""
{
  "version": 1,
  "roots": [{"path": "~/Development", "primary": true},
            "~/my roots/dev",
            "/opt/shared/code"],
  "entries": []
}
""")

test("roots: caminhos declarados saem absolutos, nas duas formas de registro") {
    let r = WorkspaceRegistry.resolution(from: rootsFixture, home: synthHome)
    assertEqual(r?.roots, ["\(synthHome)/Development",
                           "\(synthHome)/my roots/dev",
                           "/opt/shared/code"],
                "objeto {path,primary} e string nua sao as duas formas que o JS aceita")
    assertEqual(r?.rejected.count, 0)
}

test("roots: um root com espacos sobrevive — o join nao pode quebrar no primeiro espaco") {
    let r = WorkspaceRegistry.resolution(from: rootsFixture, home: synthHome)
    assertTrue(r?.roots.contains("\(synthHome)/my roots/dev") == true,
               "root com espaco perdido")
}

test("roots: ~ expande contra o home passado, nunca contra o ambiente") {
    let alice = WorkspaceRegistry.resolution(from: rootsFixture, home: "/home/alice")?.roots ?? []
    let bob = WorkspaceRegistry.resolution(from: rootsFixture, home: "/home/bob")?.roots ?? []
    assertTrue(alice.contains("/home/alice/Development"))
    assertTrue(bob.contains("/home/bob/Development"))
    assertTrue(alice != bob, "roots que ignoram o home passado nao sao portaveis")
    assertTrue(alice.contains("/opt/shared/code") && bob.contains("/opt/shared/code"),
               "root absoluto nao depende do home")
}

test("roots: root relativo e rejeitado com motivo — os outros continuam resolvendo") {
    let mixed = regData("""
    {"version": 1, "roots": ["Development", "~/Custom"], "entries": []}
    """)
    let r = WorkspaceRegistry.resolution(from: mixed, home: synthHome)
    assertEqual(r?.roots, ["\(synthHome)/Custom"],
                "root relativo herdaria o diretorio de lancamento — seria varrer outra arvore do disco")
    assertEqual(r?.rejected.count, 1, "rejeitado, nunca descartado em silencio")
    assertTrue(r?.rejected.first?.stored == "Development")
    assertTrue(r?.rejected.first?.reason.contains("neither absolute nor") == true)
}

test("roots: registro malformado vira rejeicao, nao some e nao derruba a leitura") {
    let junk = regData("""
    {"version": 1, "roots": [42, {"primary": true}, "~/Ok"], "entries": []}
    """)
    let r = WorkspaceRegistry.resolution(from: junk, home: synthHome)
    assertTrue(r != nil, "um root ruim nao pode custar o arquivo inteiro")
    assertEqual(r?.roots, ["\(synthHome)/Ok"])
    assertEqual(r?.rejected.count, 2)
}

test("roots: forma legada nao declara root — [] e nao nil") {
    let r = WorkspaceRegistry.resolution(from: legacyFixture, home: synthHome)
    assertEqual(r?.shape, .legacy)
    assertEqual(r?.roots, [], "sem roots declarados; ilegivel continua sendo o Resolution nil")
    assertTrue(r?.paths.isEmpty == false, "a leitura legada em si nao muda")
}

test("roots: root duplicado entra uma vez so") {
    let dup = regData("""
    {"version": 1, "roots": ["~/Development", {"path": "~/Development"}], "entries": []}
    """)
    assertEqual(WorkspaceRegistry.resolution(from: dup, home: synthHome)?.roots,
                ["\(synthHome)/Development"])
}

// ── R1/R2 (S02-REVIEW, conceded) — registry-unreadable must preserve, not blank ──

test("R1 - WorkspaceReloadDecision.split preserva o split anterior quando unreadable") {
    let previous = WorkspaceReloadDecision.Split(
        workspaces: ["/a", "/b"], touchedWorkspaces: ["/c"])
    let result = WorkspaceReloadDecision.split(
        previous: previous,
        outcome: (visible: [], unreadable: true),
        isProject: { _ in true })
    assertEqual(result, previous,
        "unreadable=true deve devolver o split anterior intacto — nunca [] a partir de outcome.visible")

    // Prove the bite: without the early-return this would rebuild from
    // `outcome.visible` (empty on the unreadable path) and blank the list,
    // exactly the regression the notice text ("a lista abaixo NAO foi
    // alterada") promises never happens.
    let buggyRebuild = WorkspaceReloadDecision.Split(workspaces: [], touchedWorkspaces: [])
    assertTrue(result != buggyRebuild, "guarda contra a reconstrucao que apagaria a tela")
}

test("R1 - WorkspaceReloadDecision.split reconstroi normalmente quando legivel") {
    let previous = WorkspaceReloadDecision.Split(workspaces: ["/stale"], touchedWorkspaces: [])
    let result = WorkspaceReloadDecision.split(
        previous: previous,
        outcome: (visible: ["/proj", "/touched"], unreadable: false),
        isProject: { $0 == "/proj" })
    assertEqual(result.workspaces, ["/proj"])
    assertEqual(result.touchedWorkspaces, ["/touched"])
}

test("R2 - arquivo presente mas ilegivel (permissao) deve ser distinguivel de ausente") {
    // `Workspaces.loadOutcome()` lives in the Forge executable target and
    // cannot be imported here (ForgeKitTests imports ForgeKit only — same
    // constraint noted in S01's review-fix). This test instead proves the
    // Foundation-level mechanism the fix depends on: `contents(atPath:)`
    // returns nil for BOTH an absent file and a present-but-unreadable one,
    // and `fileExists(atPath:)` is what tells them apart. That is exactly the
    // distinction the fix (`Stores.swift` loadOutcome guard) now makes.
    let fm = FileManager.default
    let path = NSTemporaryDirectory() + "forge-unreadable-\(UUID().uuidString.prefix(6)).json"
    fm.createFile(atPath: path, contents: Data("[]".utf8))
    defer {
        try? fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: path)
        try? fm.removeItem(atPath: path)
    }
    try? fm.setAttributes([.posixPermissions: 0o000], ofItemAtPath: path)

    // Root can read past 0o000 permissions (e.g. some CI containers); skip
    // rather than false-fail if that is the environment we are in.
    guard fm.contents(atPath: path) == nil else {
        print("  (skipped — process can read 0o000 files in this environment)")
        return
    }

    assertTrue(fm.fileExists(atPath: path),
        "arquivo presente porem ilegivel: fileExists deve continuar true")
    assertTrue(fm.contents(atPath: path) == nil,
        "contents(atPath:) devolve nil tanto para ausente quanto para ilegivel")

    let absentPath = NSTemporaryDirectory() + "forge-absent-\(UUID().uuidString.prefix(6)).json"
    assertTrue(fm.fileExists(atPath: absentPath) == false,
        "caso de controle: arquivo ausente nao deve reportar fileExists — e o par que a distincao separa")
}

/// Builds `<tmp>/<rel>/.gsd/milestones` for each rel, and returns the tmp root.
func discoveryTree(_ rels: [String], tag: String) -> String {
    let tmp = NSTemporaryDirectory() + "forge-droots-\(tag)-\(UUID().uuidString.prefix(6))"
    let fm = FileManager.default
    for rel in rels {
        try? fm.createDirectory(atPath: "\(tmp)/\(rel)/.gsd/milestones",
                                withIntermediateDirectories: true)
    }
    return tmp
}

test("scan(declaredRoots:) varre o root declarado e ignora a lista de nomes fixos") {
    // projA sits under `Development`, the name the hardcoded list would have
    // found. Declaring only `Custom` must leave it out — that is the whole
    // difference between "where we guessed" and "where the operator said".
    let tmp = discoveryTree(["Development/projA", "Custom/projB"], tag: "names")
    defer { try? FileManager.default.removeItem(atPath: tmp) }

    let found = ProjectDiscovery.scan(declaredRoots: ["\(tmp)/Custom"])
    assertTrue(found.contains { $0.hasSuffix("/Custom/projB") }, "projeto do root declarado perdido")
    assertFalse(found.contains { $0.contains("/Development/") },
                "Development so foi encontrado porque o nome esta na lista fixa — a lista nao manda mais")

    // And the seed default still behaves as before: same tree, name scan finds
    // exactly the other one. The two functions are not the same function.
    let seeded = ProjectDiscovery.scan(home: tmp)
    assertTrue(seeded.contains { $0.hasSuffix("/Development/projA") })
    assertFalse(seeded.contains { $0.hasSuffix("/Custom/projB") })
}

test("scan(declaredRoots:) mede profundidade a partir do root — 3 dentro sim, 4 nao") {
    // The measured case: ~/Development/lookchina/services/freyr is 3 segments
    // below the declared root and must be found. Depth counted from anywhere
    // else silently scans more or less of the disk than declared.
    let tmp = discoveryTree(["a/b/c", "a/b/c/d"], tag: "depth")
    defer { try? FileManager.default.removeItem(atPath: tmp) }

    let found = ProjectDiscovery.scan(declaredRoots: [tmp])
    assertTrue(found.contains { $0.hasSuffix("/a/b/c") },
               "3 niveis abaixo do root e o caso freyr — tem de aparecer")
    assertFalse(found.contains { $0.hasSuffix("/a/b/c/d") },
                "maxDepth continua valendo, medido do root declarado")
}

test("scan(declaredRoots:) mantem a descida em aninhados e continua pulando node_modules") {
    let tmp = discoveryTree(["repo", "repo/services",
                             "repo/node_modules/pkg"], tag: "nested")
    defer { try? FileManager.default.removeItem(atPath: tmp) }

    let found = ProjectDiscovery.scan(declaredRoots: [tmp])
    assertTrue(found.contains { $0.hasSuffix("/repo") })
    assertTrue(found.contains { $0.hasSuffix("/repo/services") },
               "monorepo: parar no primeiro acerto continuaria errado")
    assertFalse(found.contains { $0.contains("node_modules") })
}

test("scan(declaredRoots:) ignora root inexistente e nao perde os demais") {
    let tmp = discoveryTree(["Custom/projB"], tag: "missing")
    defer { try? FileManager.default.removeItem(atPath: tmp) }

    let found = ProjectDiscovery.scan(
        declaredRoots: ["\(tmp)/nao-existe", "\(tmp)/Custom", ""])
    assertEqual(found.count, 1, "um root morto nao pode custar a varredura inteira")
    assertTrue(found.first?.hasSuffix("/Custom/projB") == true)
}

test("scan(declaredRoots:) aceita root com espacos e nao oferece diretorio so tocado") {
    let tmp = discoveryTree(["my root/projC"], tag: "spaces")
    let fm = FileManager.default
    defer { try? fm.removeItem(atPath: tmp) }
    try? fm.createDirectory(atPath: "\(tmp)/my root/tocado/.gsd/forge",
                            withIntermediateDirectories: true)
    fm.createFile(atPath: "\(tmp)/my root/tocado/.gsd/forge/events.jsonl",
                  contents: Data("{\"event\":\"verify\"}\n".utf8))

    let found = ProjectDiscovery.scan(declaredRoots: ["\(tmp)/my root"])
    assertEqual(found.count, 1)
    assertTrue(found.first?.hasSuffix("/my root/projC") == true)
}

test("scan(declaredRoots:) sem roots nao varre nada — [] nao vira a lista fixa") {
    assertEqual(ProjectDiscovery.scan(declaredRoots: []).count, 0,
                "cair na lista fixa aqui reintroduziria a varredura adivinhada por baixo")
}

// ─────────────────────────────────────────────────────────────────────────
// ProjectDigest — what a card says about a project
//
// The defect these cover: every card rendered `runsHere.count` and
// `openItems`, both zero almost always, so three different projects read
// identically as "0 perguntas · 0 runs · 0 sessões · 0 itens". The digest
// replaces that with four facts already on disk. Two invariants are worth
// pinning down harder than the parsing: that NO field ever renders blank
// (a blank is indistinguishable from a broken reader, which is the exact
// defect this milestone existed to remove), and that reading the ledger
// costs one file read no matter how big the ledger is.
// ─────────────────────────────────────────────────────────────────────────

/// A project tree under NSTemporaryDirectory with an explicit, isolated root —
/// nothing here ever consults the real `$HOME`, which differs between
/// `swift run ForgeKitTests` by hand and the same binary under
/// `run-tests.js`.
func digestTree(_ tag: String) -> String {
    let tmp = NSTemporaryDirectory() + "forge-digest-\(tag)-\(UUID().uuidString.prefix(8))"
    try? FileManager.default.createDirectory(atPath: tmp + "/.gsd",
                                             withIntermediateDirectories: true)
    return tmp
}

func digestWrite(_ text: String, to path: String, mtime: Date? = nil) {
    let fm = FileManager.default
    try? fm.createDirectory(atPath: (path as NSString).deletingLastPathComponent,
                            withIntermediateDirectories: true)
    fm.createFile(atPath: path, contents: Data(text.utf8))
    if let mtime {
        try? fm.setAttributes([.modificationDate: mtime], ofItemAtPath: path)
    }
}

/// The real shape `/forge-init` writes, and the one measured in
/// `~/Development/lookchina/.gsd/PROJECT.md`.
let digestProjectDoc = """
# Project: lookchina

Workspace raiz que agrupa todos os projetos frontend e backend da Look China.

## Stack
- **Workspace:** Diretório raiz sem monorepo manager próprio
"""

test("ProjectDigest: a linha de identidade é a primeira prosa, não o título nem a stack") {
    let id = ProjectDigest.identityLine(fromProjectDoc: digestProjectDoc)
    assertEqual(id.display,
                "Workspace raiz que agrupa todos os projetos frontend e backend da Look China.",
                "o `# Project: lookchina` é o nome da pasta repetido — não descreve nada")
    assertTrue(id.isPresent)
}

test("ProjectDigest: PROJECT.md que abre direto em ## Stack não vira o primeiro bullet") {
    // Sem a parada no `##`, o card imprimiria "**Workspace:** Diretório raiz…"
    // como se fosse a identidade do projeto: uma linha de configuração
    // apresentada como descrição, que é pior que nenhuma descrição porque
    // parece certa.
    let doc = "# Project: x\n\n## Stack\n- **Workspace:** Diretório raiz\n"
    let id = ProjectDigest.identityLine(fromProjectDoc: doc)
    assertFalse(id.isPresent, "não há prosa aqui")
    assertEqual(id.display, "PROJECT.md sem descrição")
    assertFalse(id.display.isEmpty)
}

test("ProjectDigest: nenhum campo renderiza vazio num projeto sem nada — toda ausência é nomeada") {
    // Este é o teste que a milestone inteira justifica. Um projeto recém-criado
    // não tem PROJECT.md, não tem ledger e não é repo. As três respostas têm de
    // ser FRASES, nunca "" — uma linha em branco no card é indistinguível de um
    // leitor quebrado.
    let tmp = digestTree("vazio")
    defer { try? FileManager.default.removeItem(atPath: tmp) }

    let d = ProjectDigest.load(path: tmp, role: .project, repos: nil, git: .none)

    assertFalse(d.identity.display.isEmpty, "identidade vazia = card mudo")
    assertEqual(d.identity.display, "sem PROJECT.md — nenhuma descrição registrada")

    guard case .absent(let a) = d.activity else {
        return assertTrue(false, "sem ledger deveria ser ausência nomeada")
    }
    assertEqual(a, "nenhuma entrega registrada")
    assertFalse(a.isEmpty)

    // Git tem DUAS ausências e elas não são a mesma frase. `git: .none` é o
    // probe que o card usa no primeiro paint: ninguém perguntou nada ainda,
    // então "sem git" ali seria uma afirmação medida sobre algo não medido —
    // era exatamente essa troca que punha "sem git" em cima de dois
    // repositórios reais na tela do operador.
    guard case .unavailable(let pending) = d.git else {
        return assertTrue(false, "git não consultado deveria ser não-medido, não ausência")
    }
    assertFalse(pending.isEmpty, "e mesmo o não-medido é uma frase, nunca vazio")

    // Medido de verdade num diretório que não é repositório: aí sim.
    guard case .absent(let g) = ProjectDigest.load(path: tmp, role: .project,
                                                   repos: nil, git: .system).git else {
        return assertTrue(false, "diretório sem git deveria ser ausência nomeada")
    }
    assertEqual(g, "sem git")
    assertFalse(g.isEmpty)

    assertEqual(d.roleLine, "projeto", "repos não medidos não podem virar \"0 repos\"")
}

test("Ledger.parseFragment lê `title` pelo mesmo scanner — e a armadilha pós-cerca continua fechada") {
    let f = Ledger.parseFragment("""
    ---
    completed_at: 2026-07-30
    id: T-1
    key_decisions:
      - title: isto é item de lista, não chave raiz
    title: Sidebar e seção de atualizações mais minimalistas
    ---

    title: isto está DEPOIS da cerca e não pode ser lido
    """)
    assertEqual(f.title, "Sidebar e seção de atualizações mais minimalistas")
    assertEqual(f.id, "T-1")
    assertEqual(f.completedDay, "2026-07-30")
}

test("Ledger.newest escolhe por mtime — a ordem de nome devolveria a milestone errada") {
    // A mordida: `M-<ts>-<slug>` e o legado `M001` ordenam por ASCII (`-` <
    // `0`), então TODO nome legado ordena DEPOIS de todo nome com timestamp.
    // Um `tail -1` por nome devolveria aqui a entrega de 2026-04 como "última
    // atividade" de um projeto que entregou ontem. Medido: o ledger real do
    // lookchina tem 48 dos 82 fragmentos nessa forma legada.
    let dir = NSTemporaryDirectory() + "forge-newest-\(UUID().uuidString.prefix(8))"
    defer { try? FileManager.default.removeItem(atPath: dir) }

    let old = Date(timeIntervalSince1970: 1_776_000_000)   // 2026-04-13
    let recent = Date(timeIntervalSince1970: 1_785_000_000) // 2026-07-26

    digestWrite("---\nid: M-20260726120000-novo\ntitle: A entrega recente\ncompleted_at: 2026-07-26\n---\n",
                to: dir + "/M-20260726120000-novo.md", mtime: recent)
    digestWrite("---\nid: M001\ntitle: A entrega antiga · 2026-04-13\ncompleted_at: \n---\n",
                to: dir + "/M001.md", mtime: old)

    // A verdade independente: a ordem por nome é de facto a errada aqui.
    let byName = (try! FileManager.default.contentsOfDirectory(atPath: dir)).sorted().last
    assertEqual(byName, "M001.md",
                "se isto falhar, o fixture parou de exercer a inversão que o teste existe para pegar")

    let newest = Ledger.newest(dir: dir)
    assertEqual(newest?.name, "M-20260726120000-novo.md")
    assertEqual(newest?.fragment.title, "A entrega recente")
}

test("Ledger.newest empatado no mtime é determinístico, não o que o FS enumerar primeiro") {
    let dir = NSTemporaryDirectory() + "forge-newest-tie-\(UUID().uuidString.prefix(8))"
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let same = Date(timeIntervalSince1970: 1_780_000_000)
    for n in ["M001", "M002", "M003"] {
        digestWrite("---\nid: \(n)\ntitle: t-\(n)\n---\n", to: dir + "/\(n).md", mtime: same)
    }
    let a = Ledger.newest(dir: dir)?.name
    let b = Ledger.newest(dir: dir)?.name
    assertEqual(a, "M003.md", "empate desempata por nome — uma migração inteira compartilha um mtime")
    assertEqual(a, b, "duas leituras do mesmo diretório não podem discordar")
}

test("Ledger.readHead é limitado de facto — o excesso não chega") {
    // O limite não é observável pelo retorno de `newest` (uma leitura limitada
    // e uma ilimitada concordam em todo fragmento bem formado), então a única
    // prova é chamar contra um arquivo maior que o limite.
    let path = NSTemporaryDirectory() + "forge-head-\(UUID().uuidString.prefix(8)).md"
    defer { try? FileManager.default.removeItem(atPath: path) }
    digestWrite(String(repeating: "x", count: 100_000), to: path)

    let head = Ledger.readHead(path: path, limit: 1024)
    assertEqual(head?.count, 1024, "uma leitura ilimitada devolveria 100 000")
    assertNil(Ledger.readHead(path: path + ".nao-existe", limit: 1024))
}

test("ProjectDigest: ledger sem completed_at marca a idade como inferida do arquivo") {
    // A forma que `forge-ledger-migrate` produz: `completed_at:` vazio. Datar
    // pelo mtime é uma afirmação mais fraca que a do ledger, e o campo diz
    // qual das duas foi usada em vez de apresentar as duas como iguais.
    let tmp = digestTree("inferida")
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    let now = Date(timeIntervalSince1970: 1_785_000_000)
    digestWrite("---\nid: M001\ntitle: Entrega migrada\ncompleted_at: \n---\n",
                to: tmp + "/.gsd/ledger/M001.md",
                mtime: now.addingTimeInterval(-3 * 86_400))

    let d = ProjectDigest.load(path: tmp, role: .project, repos: nil, now: now, git: .none)
    let e = d.activity.entryValue
    assertEqual(e?.title, "Entrega migrada")
    assertTrue(e?.ageInferred == true, "sem completed_at a data veio do filesystem")

    // E com `completed_at`, a afirmação do ledger vence o mtime do arquivo.
    digestWrite("---\nid: M002\ntitle: Entrega datada\ncompleted_at: 2026-07-25\n---\n",
                to: tmp + "/.gsd/ledger/M002.md", mtime: now)
    let d2 = ProjectDigest.load(path: tmp, role: .project, repos: nil, now: now, git: .none)
    assertEqual(d2.activity.entryValue?.title, "Entrega datada")
    assertTrue(d2.activity.entryValue?.ageInferred == false)
}

test("ProjectDigest: fragmento sem título é ausência nomeada, não um título em branco") {
    let tmp = digestTree("sem-titulo")
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    digestWrite("---\nid: M001\ncompleted_at: 2026-07-25\n---\n",
                to: tmp + "/.gsd/ledger/M001.md")
    let d = ProjectDigest.load(path: tmp, role: .project, repos: nil, git: .none)
    guard case .absent(let a) = d.activity else {
        return assertTrue(false, "título ausente não pode virar entrada com string vazia")
    }
    assertEqual(a, "última entrega sem título")
}

test("ProjectDigest.age: rótulos em dias, e uma data futura não vira contagem negativa") {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone(identifier: "UTC")!
    let now = cal.date(from: DateComponents(year: 2026, month: 8, day: 3))!
    func label(_ daysAgo: Int) -> String {
        ProjectDigest.age(from: cal.date(byAdding: .day, value: -daysAgo, to: now)!,
                          now: now, calendar: cal)
    }
    assertEqual(label(0), "hoje")
    assertEqual(label(1), "ontem")
    assertEqual(label(3), "3d")
    assertEqual(label(6), "6d")
    assertEqual(label(14), "2sem")
    assertEqual(label(150), "5mes")
    assertEqual(label(800), "2a")
    assertEqual(label(-5), "hoje", "relógio adiantado não pode render \"-5d\"")
}

test("Git.parseStatus: um comando devolve branch, sujeira e divergência — e cada forma real de repo") {
    // Três chamadas separadas amostram três instantes e podem discordar (um
    // branch trocado entre a 1a e a 3a renderiza o nome de um ao lado da
    // divergência do outro). Uma chamada não pode. Cada linha abaixo é uma
    // forma que o git realmente emite.
    let diverge = Git.parseStatus("## fix/x...origin/fix/x [ahead 2, behind 1]\n M a.txt\n")
    assertEqual(diverge?.branch, "fix/x")
    assertEqual(diverge?.ahead, 2)
    assertEqual(diverge?.behind, 1)
    assertEqual(diverge?.dirty, true)

    let emDia = Git.parseStatus("## main...origin/main\n")
    assertEqual(emDia?.branch, "main")
    assertEqual(emDia?.ahead, 0, "com upstream, silêncio sobre divergência é ZERO, não desconhecido")
    assertEqual(emDia?.behind, 0)
    assertEqual(emDia?.dirty, false)

    let semUpstream = Git.parseStatus("## feat/local\n")
    assertEqual(semUpstream?.branch, "feat/local")
    assertNil(semUpstream?.ahead, "sem upstream não há com o que comparar — e isso não é \"em dia\"")

    assertEqual(Git.parseStatus("## No commits yet on main\n")?.branch, "main")
    assertEqual(Git.parseStatus("## HEAD (no branch)\n")?.branch, "destacado")
    assertEqual(Git.parseStatus("## main...origin/main [ahead 3]\n")?.ahead, 3)
    assertEqual(Git.parseStatus("## main...origin/main [behind 4]\n")?.behind, 4)
    assertNil(Git.parseStatus("## main...origin/main [gone]\n")?.ahead,
              "upstream apagado não tem contagem a mostrar")
    assertNil(Git.parseStatus(""), "saída vazia não é um repo limpo — é nenhuma resposta")
}

test("DigestGit.line: sem upstream a divergência é dita, não omitida") {
    // Omitir o segmento tornaria "sem remoto configurado" idêntico a "em dia
    // com o remoto" na tela, e são fatos diferentes sobre um branch.
    assertEqual(GitStatusSnapshot(branch: "main", dirty: false, ahead: 3, behind: 0).line,
                "main · limpo · ↑3")
    assertEqual(GitStatusSnapshot(branch: "main", dirty: true, ahead: 0, behind: 2).line,
                "main · alterações · ↓2")
    assertEqual(GitStatusSnapshot(branch: "main", dirty: false, ahead: 0, behind: 0).line,
                "main · limpo", "em dia com o upstream não imprime seta")
    assertEqual(GitStatusSnapshot(branch: "wip", dirty: false, ahead: nil, behind: nil).line,
                "wip · limpo · sem upstream")
}

test("ProjectDigest.load contra um repo git real: branch e sujeira") {
    let tmp = digestTree("git")
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    fixtureGit(["init", "-b", "principal"], at: tmp)
    fixtureWrite("um\n", to: tmp + "/a.txt")
    fixtureGit(["add", "a.txt"], at: tmp)
    fixtureGit(["commit", "-m", "c1"], at: tmp, date: "2026-07-28T10:00:00Z")

    let limpo = ProjectDigest.load(path: tmp, role: .project, repos: nil).git.stateValue
    assertEqual(limpo?.branch, "principal")
    assertEqual(limpo?.dirty, false)
    assertNil(limpo?.ahead, "repo sem remoto não tem com o que divergir")
    assertEqual(limpo.map { $0.line }, "principal · limpo · sem upstream")

    // A mordida: um arquivo NÃO RASTREADO tem de sujar o estado. É exatamente o
    // caso que um cache com chave em `.git/index`/`.git/HEAD` erraria, e a razão
    // documentada de não haver cache aqui.
    fixtureWrite("novo\n", to: tmp + "/nao-rastreado.txt")
    assertEqual(ProjectDigest.load(path: tmp, role: .project, repos: nil).git.stateValue?.dirty, true)
}

test("WorkspaceRegistry.repoCounts: `repos: []` não vira chave — ausência ≠ zero medido") {
    // Medido no registro real desta máquina: TODA entrada carrega `repos: []`,
    // `lookchina` incluída, enquanto contém 33 repos no disco. Ler esse `[]`
    // como "0 repos" poria um zero de aparência medida no card mais denso de
    // repos que existe registrado.
    let json = """
    {"version":1,"roots":[{"path":"~/Dev","primary":true}],"entries":[
      {"path":"vazio","root":"~/Dev","kind":"workspace","repos":[]},
      {"path":"contado","root":"~/Dev","kind":"workspace","repos":["a","b","c"]},
      {"path":"sem-chave","root":"~/Dev","kind":"project"}
    ]}
    """
    let r = WorkspaceRegistry.resolution(from: Data(json.utf8), home: "/home/t")!
    assertNil(r.repoCounts["/home/t/Dev/vazio"], "`[]` é \"nunca medido\", não zero")
    assertNil(r.repoCounts["/home/t/Dev/sem-chave"])
    assertEqual(r.repoCounts["/home/t/Dev/contado"], 3)
}

test("ProjectDigest.roleLine: contagem ausente cala em vez de afirmar zero") {
    func line(_ role: ProjectRole, _ repos: Int?) -> String {
        ProjectDigest(role: role, repos: repos, identity: .absent("x"),
                      activity: .absent("y"), git: .absent("z")).roleLine
    }
    assertEqual(line(.workspace, 33), "workspace · 33 repos")
    assertEqual(line(.workspace, 1), "workspace · 1 repo")
    assertEqual(line(.workspace, nil), "workspace")
    assertEqual(line(.workspace, 0), "workspace", "zero medido e não medido caem na mesma frase honesta")
    assertEqual(line(.project, nil), "projeto")
}

test("ProjectDigest.elide corta em fronteira de palavra e só acima do limite") {
    assertEqual(ProjectDigest.elide("curta", to: 20), "curta")
    let long = "Plataforma de atacado que agrupa apps e services do grupo inteiro"
    let cut = ProjectDigest.elide(long, to: 30)
    assertLessOrEqual(cut.count, 31)
    assertTrue(cut.hasSuffix("…"))
    assertFalse(cut.contains("  "))
    assertTrue(long.hasPrefix(String(cut.dropLast())), "o corte não pode inventar texto")
    // Uma única palavra longa não tem fronteira: corta seco em vez de devolver "…".
    assertEqual(ProjectDigest.elide(String(repeating: "a", count: 50), to: 10),
                String(repeating: "a", count: 10) + "…")
}

test("ProjectDigest.load é injetável de ponta a ponta — nada aqui lê o $HOME real") {
    let tmp = digestTree("injecao")
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    digestWrite(digestProjectDoc, to: tmp + "/.gsd/PROJECT.md")
    digestWrite("---\nid: M-1\ntitle: Kanban local\ncompleted_at: 2026-08-01\n---\n",
                to: tmp + "/.gsd/ledger/M-1.md")
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone(identifier: "UTC")!
    let now = cal.date(from: DateComponents(year: 2026, month: 8, day: 3))!
    let probe = GitProbe(status: { _ in
        .state(GitStatusSnapshot(branch: "main", dirty: false, ahead: 3, behind: 0))
    })

    let d = ProjectDigest.load(path: tmp, role: .workspace, repos: 33,
                               now: now, calendar: cal, git: probe)

    // O card do mockup, campo a campo.
    assertEqual(d.roleLine, "workspace · 33 repos")
    assertTrue(d.identity.display.hasPrefix("Workspace raiz que agrupa"))
    assertEqual(d.activity.entryValue?.title, "Kanban local")
    assertEqual(d.activity.entryValue?.age, "2d")
    assertEqual(d.git.stateValue?.line, "main · limpo · ↑3")
}

// ---------------------------------------------------------------------------
// ProjectAttention — o que uma pasta fechada diz do que esconde, e a ordem
// única em que lista e árvore são desenhadas
// ---------------------------------------------------------------------------

/// WS é workspace (contém os outros); apps/ é uma pasta sintetizada.
private let attnProjects = ["/h/WS", "/h/WS/apps/alfa", "/h/WS/apps/zulu"]

private func attnTree() -> [ProjectTreeNode] {
    ProjectTree.build(projects: attnProjects, roots: [], home: "/h")
}

private func attnNode(_ nodes: [ProjectTreeNode], _ path: String) -> ProjectTreeNode? {
    for n in nodes {
        if n.path == path { return n }
        if let hit = attnNode(n.children, path) { return hit }
    }
    return nil
}

test("ProjectRollup: um run três níveis abaixo continua visível na pasta fechada") {
    let tree = attnTree()
    let attention: (String) -> ProjectAttention = { p in
        p == "/h/WS/apps/zulu" ? ProjectAttention(questions: 0, runs: 1) : .none
    }
    let ws = attnNode(tree, "/h/WS")!
    let apps = attnNode(tree, "/h/WS/apps")!

    assertEqual(ProjectTreeAttention.rollup(apps, attention: attention).runs, 1,
                "a pasta que contém o run tem de contá-lo")
    assertEqual(ProjectTreeAttention.rollup(ws, attention: attention).runs, 1,
                "o rollup é transitivo — o avô conta o neto")
    assertTrue(ProjectTreeAttention.rollup(ws, attention: attention).needsAttention)

    // A regressão que isso trava: o header antigo só somava `pending`, então
    // colapsar a pasta apagava o run da tela inteira.
    assertTrue(ProjectTreeAttention.rollup(apps, attention: attention).summary.contains("1 run"),
               "o resumo da pasta fechada precisa dizer o run: \(ProjectTreeAttention.rollup(apps, attention: attention).summary)")
}

test("ProjectRollup: a pasta conta a si mesma só quando é projeto registrável") {
    let tree = attnTree()
    let ws = attnNode(tree, "/h/WS")!
    let apps = attnNode(tree, "/h/WS/apps")!
    // WS é um projeto E contém dois: 3. `apps` é sintetizada: só os dois.
    assertEqual(ProjectTreeAttention.rollup(ws, attention: { _ in .none }).projects, 3)
    assertEqual(ProjectTreeAttention.rollup(apps, attention: { _ in .none }).projects, 2)
}

test("ProjectRollup.summary: zero nenhum é impresso, e a linha nunca sai vazia") {
    let quiet = ProjectRollup(projects: 5, questions: 0, runs: 0, dirty: 0, dirtyUnmeasured: 5)
    assertEqual(quiet.summary, "5 projetos", "\"0 perguntas\" é exatamente o que essa mudança removeu")
    assertFalse(quiet.summary.contains("0 "))
    assertFalse(quiet.summary.isEmpty)
    assertFalse(quiet.needsAttention)

    let loud = ProjectRollup(projects: 1, questions: 1, runs: 2, dirty: 1, dirtyUnmeasured: 0)
    assertEqual(loud.summary, "1 projeto · 1 pergunta · 2 runs · 1 com alterações")
}

test("ProjectRollup: git não medido não vira \"limpo\"") {
    let unknown = ProjectTreeAttention.single(ProjectAttention(dirty: nil))
    let clean = ProjectTreeAttention.single(ProjectAttention(dirty: false))
    assertEqual(unknown.dirty, 0)
    assertEqual(unknown.dirtyUnmeasured, 1, "nil é \"nunca medido\", como repoCounts")
    assertEqual(clean.dirty, 0)
    assertEqual(clean.dirtyUnmeasured, 0)
    assertTrue(unknown != clean, "medido-limpo e não-medido não podem colapsar num só valor")
    assertFalse(unknown.summary.contains("alterações"),
                "sem medição a pasta cala sobre sujeira em vez de afirmar zero")
}

test("ProjectTreeAttention: lista e árvore usam UM comparador — atenção antes do nome") {
    let attention: (String) -> ProjectAttention = { p in
        p == "/h/WS/apps/zulu" ? ProjectAttention(questions: 2) : .none
    }
    // Plano: zulu passa alfa por causa da pergunta, contra a ordem alfabética.
    let flat = ProjectTreeAttention.ordered(paths: ["/h/WS/apps/alfa", "/h/WS/apps/zulu"],
                                            attention: attention)
    assertEqual(flat.first, "/h/WS/apps/zulu")
    // Árvore: os mesmos dois nós, mesma resposta.
    let apps = attnNode(attnTree(), "/h/WS/apps")!
    let nodes = ProjectTreeAttention.ordered(apps.children, attention: attention)
    assertEqual(nodes.first?.path, "/h/WS/apps/zulu",
                "a árvore ordenava por caminho enquanto a lista ordenava por atenção")
    assertEqual(nodes.map(\.path), flat, "os dois modos não podem discordar de quem vem primeiro")

    // Sem sinal nenhum: nome, e o caminho como desempate estável.
    let quiet = ProjectTreeAttention.ordered(paths: ["/h/WS/apps/zulu", "/h/WS/apps/alfa"],
                                             attention: { _ in .none })
    assertEqual(quiet, ["/h/WS/apps/alfa", "/h/WS/apps/zulu"])
}

test("ProjectTreeAttention: uma pasta silenciosa afunda abaixo da que esconde uma pergunta") {
    // `zzz` vem depois de `aaa` por nome, mas esconde uma pergunta.
    let tree = ProjectTree.build(projects: ["/h/aaa/p1", "/h/zzz/p2"], roots: ["/h"], home: "/h")
    let root = tree.first!
    let ordered = ProjectTreeAttention.ordered(root.children, attention: { p in
        p == "/h/zzz/p2" ? ProjectAttention(questions: 1) : .none
    })
    assertEqual(ordered.first?.path, "/h/zzz",
                "a ordem responde \"para onde eu vou agora?\", não \"como se soletra?\"")
}

test("ProjectWeight: peso vem do papel, não da profundidade") {
    assertEqual(ProjectWeight.of(role: .workspace, depth: 3), .workspace,
                "um workspace fundo continua workspace")
    assertEqual(ProjectWeight.of(role: .project, depth: 0), .project)
    assertEqual(ProjectWeight.of(role: .folder, depth: 0), .root, "pasta no topo é root declarado")
    assertEqual(ProjectWeight.of(role: .folder, depth: 2), .folder)

    // A hierarquia é a propriedade — não os quatro literais.
    assertTrue(ProjectWeight.workspace.opacity > ProjectWeight.project.opacity)
    assertTrue(ProjectWeight.project.opacity > ProjectWeight.root.opacity)
    assertTrue(ProjectWeight.root.opacity > ProjectWeight.folder.opacity)
    assertTrue(ProjectWeight.workspace.titleSize > ProjectWeight.project.titleSize)
    assertTrue(ProjectWeight.project.titleSize > ProjectWeight.folder.titleSize)
    assertTrue(ProjectWeight.workspace.isBold)
    assertFalse(ProjectWeight.folder.isBold)
}

test("CollapseStore: o que ficou fechado volta fechado, e o vazio não vira caminho") {
    let set: Set<String> = ["/h/WS/apps", "/h/outro"]
    assertEqual(CollapseStore.decode(CollapseStore.encode(set)), set)
    assertEqual(CollapseStore.decode(""), [], "defaults virgem é conjunto vazio, não [\"\"]")
    assertEqual(CollapseStore.decode("\n\n/h/a\n"), ["/h/a"])
    // Ordenado: um conjunto inalterado não reescreve os defaults embaralhado.
    assertEqual(CollapseStore.encode(["/h/b", "/h/a"]), "/h/a\n/h/b")
    assertEqual(CollapseStore.encode([]), "")
}

// ═══════════════════════════════════════════════════════════════════════════
print("Git — o que \"sem git\" tem direito de afirmar")

/// Two real repositories on the operator's machine rendered **"sem git"** on
/// their cards while `git status` answered them from the shell in milliseconds.
/// "sem git" is the named-absence wording — it means *measured, and there is
/// none*. So the card was making a confident false claim about the disk, which
/// is the one failure this codebase is least allowed to ship.
///
/// The cause was not in git and not in the parser. Every card probes git from a
/// `Task.detached`, i.e. a thread of the cooperative pool, and `Git.run` used to
/// park that thread on a semaphore signalled from `DispatchQueue.global()`. A
/// screenful of cards parked every cooperative thread there at once and the
/// signalling work could not be scheduled, so the probes hit their 5 s timeout
/// and returned nil — and nil meant "sem git".
///
/// Two properties are pinned below, and they are independent: the probe must
/// SURVIVE that concurrency, and the wording must be honest even when it does
/// not. Either alone leaves the card able to lie.

func gitTmpDir(_ name: String) -> String {
    let dir = NSTemporaryDirectory() + "forge-gitstatus-\(name)-\(UUID().uuidString)"
    try! FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    return dir
}

test("Git.status responde sob a concorrência real da tela — 40 cards de uma vez") {
    let repo = gitTmpDir("concorrencia")
    defer { try? FileManager.default.removeItem(atPath: repo) }
    fixtureGit(["init", "-q", "-b", "main"], at: repo)
    fixtureWrite("x", to: repo + "/a.txt")
    fixtureGit(["add", "."], at: repo)
    fixtureGit(["commit", "-qm", "um"], at: repo)

    // O formato importa tanto quanto o número: `Task.detached` é exatamente o
    // que `ProjectCard.refresh()` usa, e é o pool cooperativo que a versão
    // antiga travava. Medido antes do conserto: 32/40 devolviam nil em 20,1 s.
    // Chamado em série, o mesmo código passava — por isso o defeito chegou à
    // tela com a suíte verde.
    let probes = 40
    let done = DispatchSemaphore(value: 0)
    let box = ResultBox()
    Task {
        await withTaskGroup(of: GitStatus.self) { g in
            for _ in 0..<probes {
                g.addTask(priority: .utility) { Git.status(at: repo) }
            }
            for await r in g { box.append(r) }
        }
        done.signal()
    }
    // Teto generoso: o conserto mede 0,29 s para as 40. Se estourar, é a
    // inanição de volta, não lentidão de máquina.
    let waited = done.wait(timeout: .now() + 60)
    assertTrue(waited == .success, "as sondas não terminaram em 60 s — inanição do pool cooperativo")

    let results = box.all
    assertEqual(results.count, probes)
    let answered = results.filter { $0.snapshot != nil }.count
    assertEqual(answered, probes,
                "\(probes - answered) de \(probes) sondas não obtiveram estado; " +
                "nenhuma delas poderia virar \"sem git\" numa tela")
    assertEqual(results.first(where: { $0.snapshot != nil })?.snapshot?.branch, "main")

    // E nenhuma pode ter virado a afirmação medida.
    assertEqual(results.filter { $0 == .notARepository }.count, 0,
                "um repositório de verdade foi classificado como \"não é repositório\"")
}

/// Collects across the task group without a data race — the harness is
/// synchronous, so the results have to cross back to a blocked main thread.
final class ResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [GitStatus] = []
    func append(_ r: GitStatus) { lock.lock(); items.append(r); lock.unlock() }
    var all: [GitStatus] { lock.lock(); defer { lock.unlock() }; return items }
}

test("Git.classifyStatus: só uma das quatro saídas tem direito a \"não é repositório\"") {
    // A única ausência medida: git recusou E não há .git para contradizê-lo.
    assertEqual(Git.classifyStatus(.failed(128), hasDotGit: false), .notARepository)

    // O mesmo código de saída num diretório que TEM .git é uma medição que
    // falhou (lock, índice corrompido, dubious ownership) — nunca uma ausência.
    // É este par que separa "não tem repo" de "não consegui ler o repo", e era
    // o colapso dos dois que punha "sem git" em cima de dois repositórios.
    assertFalse(Git.classifyStatus(.failed(128), hasDotGit: true) == .notARepository,
                "um repositório que existe e não respondeu não é uma ausência")
    assertEqual(Git.classifyStatus(.timedOut, hasDotGit: true),
                .unavailable("git não respondeu a tempo"))
    assertEqual(Git.classifyStatus(.timedOut, hasDotGit: false),
                .unavailable("git não respondeu a tempo"),
                "timeout não vira ausência nem quando não há .git — não se mediu nada")
    assertFalse(Git.classifyStatus(.launchFailed("no such file"), hasDotGit: false) == .notARepository)

    // Saída ilegível é falha de medição, não estado.
    assertEqual(Git.classifyStatus(.ok("lixo sem cabeçalho ##"), hasDotGit: true),
                .unavailable("git respondeu num formato não reconhecido"))
    assertEqual(Git.classifyStatus(.ok("## main...origin/main [ahead 2]\n M a.txt\n"),
                                   hasDotGit: true),
                .state(GitStatusSnapshot(branch: "main", dirty: true, ahead: 2, behind: 0)))
}

test("Git.status classifica de verdade um diretório sem repositório e um repositório real") {
    let plain = gitTmpDir("sem-repo")
    defer { try? FileManager.default.removeItem(atPath: plain) }
    assertEqual(Git.status(at: plain), .notARepository,
                "um diretório que não é repositório é a única ausência que pode ser afirmada")

    let repo = gitTmpDir("com-repo")
    defer { try? FileManager.default.removeItem(atPath: repo) }
    fixtureGit(["init", "-q", "-b", "main"], at: repo)
    fixtureWrite("x", to: repo + "/a.txt")
    fixtureGit(["add", "."], at: repo)
    fixtureGit(["commit", "-qm", "um"], at: repo)
    // Sujo e sem upstream — a forma de `feirao-do-lu`/`fenrir` no dia do bug.
    fixtureWrite("solto", to: repo + "/untracked.txt")
    assertEqual(Git.status(at: repo).snapshot?.branch, "main")
    assertEqual(Git.status(at: repo).snapshot?.dirty, true)
}

test("loadGit: \"sem git\" sai de um caso só, e o não-medido é retentável") {
    let notRepo = GitProbe(status: { _ in .notARepository })
    assertEqual(ProjectDigest.loadGit(path: "/x", probe: notRepo), .absent("sem git"))

    for probe in [GitProbe(status: { _ in .unavailable("git não respondeu a tempo") }),
                  GitProbe.none] {
        let field = ProjectDigest.loadGit(path: "/x", probe: probe)
        assertFalse(field == .absent("sem git"),
                    "uma medição que não aconteceu foi impressa como ausência medida")
        assertTrue(field.isUnavailable, "e o card precisa saber que vale perguntar de novo")
    }

    // `git: .none` é "ainda não paguei por git", não "não há git": era ele que
    // o card carregava no primeiro paint de cada reload.
    assertFalse(ProjectDigest.load(path: "/x", role: .project, repos: nil, git: .none)
                    .git == .absent("sem git"))
    assertFalse(ProjectDigest.loadGit(path: "/x", probe: notRepo).isUnavailable,
                "uma ausência medida nunca deve ser re-perguntada")
}

test("identityLimit não corta as descrições reais que o card existe para mostrar") {
    // As duas strings do dia do bug, na íntegra. Com o limite antigo de 120 a
    // primeira virava um terço de frase, e numa janela larga esses 120 chars
    // eram UMA linha — a segunda linha que o layout reservou ficava vazia.
    let feirao = "Plataforma web do maior centro de atacado de moda do RJ (Feirão do Lu, Duque de Caxias/RJ). Reúne um site público (landing pages de lojas, eventos, guias/caravanas, institucional, parceiros e cadastro de leads) e um painel administrativo /admin para alimentar todo o conteúdo do site. O público-alvo do negócio são revendedores e lojistas que compram no atacado."
    let look = "Workspace raiz que agrupa todos os projetos frontend e backend da Look China. Contém heimdall (frontend monorepo com Turborepo/pnpm) e loki (backend NestJS), além de futuros projetos."
    assertGreater(feirao.count, 120, "a fixture perdeu a propriedade que a torna útil")

    for prose in [feirao, look] {
        let line = ProjectDigest.identityLine(fromProjectDoc: "# Project: x\n\n\(prose)\n\n## Stack\n")
        assertEqual(line.display, prose,
                    "a descrição chegou cortada ao card — a elisão é do layout, na largura real")
        assertFalse(line.display.hasSuffix("…"))
    }

    // Continua sendo um limite: uma PROJECT.md desgovernada não vai inteira
    // para a view. 400 fica logo acima do que duas linhas comportam num card
    // de 1000 pt (~365 chars medidos), então nunca morde antes do layout.
    assertGreater(ProjectDigest.identityLimit, 365)
    let runaway = String(repeating: "palavra ", count: 200)
    let cut = ProjectDigest.identityLine(fromProjectDoc: "# t\n\n\(runaway)\n").display
    assertTrue(cut.hasSuffix("…"))
    assertLessOrEqual(cut.count, ProjectDigest.identityLimit + 1)
}


// ─────────────────────────────────────────────────────────────────────────────
// ProjectStack — o que o projeto é construído com, e o ícone que diz isso
//
// O caso que governa esta seção é `forge-agent`: seu único sinal de stack é
// `app/Package.swift`, UM NÍVEL ABAIXO da raiz. Um detector que só olha a raiz
// responde "sem stack" para o próprio repositório de onde este código sai — e
// errar com confiança sobre o projeto mais visível do operador é exatamente a
// falha que a milestone anterior existiu para acabar. Por isso a forma do
// forge-agent é fixture, não nota de rodapé.

func stackTree(_ tag: String, _ files: [String]) -> String {
    let tmp = NSTemporaryDirectory() + "forge-stack-\(tag)-\(UUID().uuidString.prefix(8))"
    let fm = FileManager.default
    for f in files {
        let full = tmp + "/" + f
        try? fm.createDirectory(atPath: (full as NSString).deletingLastPathComponent,
                                withIntermediateDirectories: true)
        fm.createFile(atPath: full, contents: Data("{}".utf8))
    }
    try? fm.createDirectory(atPath: tmp, withIntermediateDirectories: true)
    return tmp
}

test("ProjectStack: a forma do forge-agent — assinatura um nível abaixo — é detectada") {
    // A raiz do forge-agent não tem NENHUMA assinatura. Só `app/Package.swift`.
    let tmp = stackTree("forgeagent", ["app/Package.swift", "scripts/forge-ids.js",
                                       "README.md", ".gsd/PROJECT.md"])
    defer { try? FileManager.default.removeItem(atPath: tmp) }

    let d = ProjectStack.detect(path: tmp)
    assertEqual(d.primary, .swift, "assinatura em app/ não pode passar por 'sem stack'")

    // E o ícone que sai disso é o do Swift, não o de papel-neutro do role.
    let g = StackGlyph.of(d, role: .project)
    assertEqual(g.symbol, "swift")
    assertTrue(g.isStack, "stack medida tem de se declarar medida")

    // MORDIDA PROVADA: sem a descida de um nível, este mesmo diretório vira
    // `.none`. É o teste falhando de propósito contra a implementação ingênua.
    let raso = ProjectStack.signatures(in: tmp, fileManager: .default)
    assertTrue(raso.isEmpty, "a raiz sozinha não tem nada — é por isso que a profundidade existe")
}

test("ProjectStack: a forma do message — stack inteira em subpastas irmãs") {
    let tmp = stackTree("message", ["docker-compose.yml",
                                    "platform-backend/package.json",
                                    "platform-frontend/next.config.ts",
                                    "platform-frontend/package.json"])
    defer { try? FileManager.default.removeItem(atPath: tmp) }

    let d = ProjectStack.detect(path: tmp)
    assertEqual(d.kinds, [.next, .node, .docker], "união raiz+nível-1, ordenada por especificidade")
    // Um projeto com três assinaturas não é três projetos: um glifo só.
    assertEqual(StackGlyph.of(d, role: .project).symbol, "triangle")
}

test("ProjectStack: framework ganha do runtime, e ambos ganham do empacotamento") {
    // freyr é um serviço Node que POR ACASO envia em container — não é um
    // "projeto Docker". feirao-do-lu é Next, não Next+Node+Docker.
    let freyr = stackTree("freyr", ["package.json", "Dockerfile", "docker-compose.yml"])
    let feirao = stackTree("feirao", ["package.json", "next.config.ts", "docker-compose.yml"])
    defer {
        try? FileManager.default.removeItem(atPath: freyr)
        try? FileManager.default.removeItem(atPath: feirao)
    }
    assertEqual(ProjectStack.detect(path: freyr).primary, .node)
    assertEqual(ProjectStack.detect(path: feirao).primary, .next)

    // A precedência é total e sem empates — senão o primário de um conjunto
    // dependeria da ordem de iteração de um Set.
    let specs = StackKind.allCases.map(\.specificity)
    assertEqual(Set(specs).count, StackKind.allCases.count, "especificidade tem de ser única")
}

test("ProjectStack: detectar nada é uma ausência NOMEADA, nunca um slot vazio") {
    let tmp = stackTree("vazio", ["README.md", "docs/guia.md"])
    defer { try? FileManager.default.removeItem(atPath: tmp) }

    let d = ProjectStack.detect(path: tmp)
    guard case .none(let why) = d else {
        return assertTrue(false, "diretório legível sem assinatura é .none, não .unmeasured")
    }
    assertFalse(why.isEmpty)

    // O card cai no role — que é a única coisa que continua certamente
    // verdadeira — e nunca desenha vazio.
    let g = StackGlyph.of(d, role: .workspace)
    assertEqual(g.symbol, "square.stack.3d.up")
    assertFalse(g.isStack, "role não é stack medida e não pode se passar por uma")
    assertFalse(g.help.isEmpty, "ausência sem frase = silêncio indistinguível de detector quebrado")
}

test("ProjectStack: 'não medido' é visivelmente diferente de 'medido, e não há'") {
    // Esta é a distinção que a milestone anterior custou três rodadas para
    // firmar. Um diretório ILEGÍVEL não é um projeto sem stack.
    let ilegivel = StackDetection.unmeasured("diretório ilegível — stack não verificada")
    let vazio = StackDetection.none("stack não detectada")

    let gi = StackGlyph.of(ilegivel, role: .project)
    let gv = StackGlyph.of(vazio, role: .project)

    assertFalse(gi.symbol == gv.symbol, "os dois estados NÃO podem desenhar o mesmo glifo")
    assertEqual(gi.symbol, "questionmark.square.dashed")
    assertTrue(ilegivel.isUnmeasured)
    assertFalse(vazio.isUnmeasured, "uma ausência medida não convida a nova tentativa")
    assertFalse(gi.help.isEmpty)
}

test("ProjectStack: diretório inexistente não é medição — é .unmeasured") {
    let d = ProjectStack.detect(path: "/nao/existe/em/lugar/nenhum-\(UUID().uuidString)")
    assertTrue(d.isUnmeasured, "não conseguir ler não é um fato sobre a stack do projeto")
    assertTrue(d.kinds.isEmpty)
}

test("ProjectStack: node_modules e saídas de build nunca são evidência") {
    // node_modules tem milhares de package.json e nenhum diz o que ESTE
    // projeto é. `.build` guarda Package.swift de dependências do SwiftPM —
    // descer ali reportaria a stack dos outros como sendo a nossa.
    let tmp = stackTree("outputs", ["README.md",
                                    "node_modules/package.json",
                                    ".build/checkouts/Package.swift",
                                    "dist/go.mod",
                                    "vendor/Cargo.toml"])
    defer { try? FileManager.default.removeItem(atPath: tmp) }

    let d = ProjectStack.detect(path: tmp)
    assertTrue(d.kinds.isEmpty, "stack de dependência não é stack do projeto: \(d.kinds)")
    guard case .none = d else { return assertTrue(false, "deveria ser ausência medida") }
}

test("ProjectStack: tsconfig.json não é assinatura — presente em quase tudo, não distingue nada") {
    let tmp = stackTree("tsonly", ["tsconfig.json"])
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    assertTrue(ProjectStack.detect(path: tmp).kinds.isEmpty,
               "um sinal que todo card mostra é a pasta azul genérica outra vez")
}

test("ProjectStack: todo símbolo que o card pode desenhar existe de verdade") {
    // Um nome de SF Symbol inválido renderiza como um quadrado em branco — ou
    // seja, exatamente o slot vazio que este arquivo inteiro existe para
    // substituir. Só dá para checar isto com AppKit, e é barato.
    var nomes = StackKind.allCases.map(\.symbolName)
    nomes += ProjectRole.allCases.map(\.symbolName)
    nomes += [StackGlyph.of(.unmeasured("x"), role: .project).symbol, "circle.dashed"]
    for n in nomes {
        assertTrue(NSImage(systemSymbolName: n, accessibilityDescription: nil) != nil,
                   "SF Symbol inexistente: \(n)")
    }
    // E os glifos de stack são distintos entre si: a forma é o que separa,
    // porque o ícone tem 30 pt num canto e vai ser varrido, não lido.
    assertEqual(Set(StackKind.allCases.map(\.symbolName)).count, StackKind.allCases.count)
}

test("ProjectStack: a regra de composição — stack ganha do role, role é o piso") {
    // Role JÁ está escrito em texto logo abaixo do nome (`roleLine`). Stack não
    // está em lugar nenhum do card. Mostrar stack acrescenta um fato; mostrar
    // role duplica um.
    let comStack = StackDetection.detected([.node])
    assertEqual(StackGlyph.of(comStack, role: .workspace).symbol, "hexagon",
                "um workspace COM stack de raiz mostra a stack — roleLine já diz 'workspace'")
    assertEqual(StackGlyph.of(.none("x"), role: .workspace).symbol, "square.stack.3d.up",
                "sem stack, o role é a única coisa certamente verdadeira que resta")
    assertEqual(StackGlyph.of(.none("x"), role: .folder).symbol, "folder")
}

test("ProjectStack: o tooltip preserva tudo que foi detectado, o glifo colapsa em um") {
    let g = StackGlyph.of(.detected([.next, .node, .docker]), role: .project)
    assertEqual(g.symbol, "triangle")
    for esperado in ["Next.js", "Node", "Docker"] {
        assertTrue(g.help.contains(esperado), "tooltip perdeu \(esperado): \(g.help)")
    }
    // Com uma só, o tooltip não inventa uma lista de um item.
    assertEqual(StackGlyph.of(.detected([.swift]), role: .project).help, "Swift")
}

test("ProjectStack.detect é puro e injetável — nada aqui lê o $HOME real") {
    // Mesma razão do ProjectDigest: `swift run ForgeKitTests` vê o home REAL
    // quando lançado à mão e um isolado sob `run-tests.js`, então uma leitura
    // ambiente passa num caminho de lançamento e mente no outro.
    let tmp = stackTree("puro", ["go.mod"])
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    assertEqual(ProjectStack.detect(path: tmp, fileManager: FileManager()).primary, .go)
}

test("ProjectStack: o custo é limitado por construção, não por cache") {
    // O limite existe para que o custo não dependa de quantas pastas alguém
    // guarda na raiz. Com 200 subpastas, apenas `subdirectoryLimit` são
    // examinadas — e a assinatura fora do corte não é encontrada, que é o
    // comportamento declarado, não um acidente.
    var files: [String] = []
    for i in 0..<200 { files.append(String(format: "d%03d/leia.md", i)) }
    files.append("z999-fora-do-corte/go.mod")
    let tmp = stackTree("cap", files)
    defer { try? FileManager.default.removeItem(atPath: tmp) }

    assertEqual(ProjectStack.subdirectoryLimit, 24)
    let d = ProjectStack.detect(path: tmp)
    assertTrue(d.kinds.isEmpty, "assinatura além do teto não é varrida — custo é limitado")

    // E dentro do teto ela É achada: o teto corta a cauda patológica, não a
    // funcionalidade.
    let dentro = stackTree("cap2", ["a-primeira/go.mod", "b/leia.md"])
    defer { try? FileManager.default.removeItem(atPath: dentro) }
    assertEqual(ProjectStack.detect(path: dentro).primary, .go)
}

// MARK: - GitGlyph: o ícone não pode desfazer a distinção de três casos

test("GitGlyph: os quatro estados do card continuam distinguíveis DEPOIS do ícone") {
    // Esta é a razão de o tipo existir. `383412d` consertou um card que
    // imprimia "sem git" para dois repositórios REAIS — a causa raiz foi
    // starvation do pool cooperativo, mas o que levou isso à tela como uma
    // afirmação falsa CONFIANTE foi um tipo que confundia dois fatos. Um ícone
    // ingênuo ("mostra o glifo de git quando há git") transforma três em dois
    // outra vez, agora na camada de desenho.
    let repo = GitStatusSnapshot(branch: "main", dirty: false, ahead: 0, behind: 0)
    let g = [GitGlyph.of(.state(repo)),          // medido: há repositório
             GitGlyph.of(.absent("sem git")),    // medido: NÃO há repositório
             GitGlyph.of(.unavailable("timeout")), // não medido
             GitGlyph.of(nil)]                   // ainda não perguntado

    // Nenhum par empata em NADA que a tela mostre. Tom e texto separam os
    // quatro; se um dia um par colidir nos dois, os estados viraram um só.
    for i in 0..<g.count {
        for j in (i + 1)..<g.count {
            assertFalse(g[i].tone == g[j].tone && g[i].text == g[j].text,
                        "estados \(i) e \(j) desenham igual — três fatos viraram dois")
        }
    }
    // E o glifo de branch é EVIDÊNCIA, não decoração: aparece se e somente se
    // git foi medido e encontrou repositório. Um diretório que não é repo, e um
    // cujo git nunca respondeu, não podem desenhar uma branch.
    assertEqual(g[0].symbol, GitGlyph.branchSymbol)
    assertTrue(g[1].symbol == nil, "'sem git' desenhando branch é a mentira de volta")
    assertTrue(g[3].symbol == nil, "não medido desenhando branch afirma o que ninguém mediu")
    assertFalse(g[2].symbol == GitGlyph.branchSymbol,
                "uma medição que falhou não pode se passar por um repositório")
    // Nenhuma linha em branco, nunca — silêncio é indistinguível de bug.
    for x in g { assertFalse(x.text.isEmpty); assertFalse(x.help.isEmpty) }
}

test("GitGlyph: os quatro casos REAIS do disco do operador") {
    // feirao-do-lu, fenrir, forge-agent e lookchina, como estão medidos hoje.
    let feirao = GitGlyph.of(.state(GitStatusSnapshot(branch: "main", dirty: true,
                                                      ahead: 0, behind: 0)))
    let fenrir = GitGlyph.of(.state(GitStatusSnapshot(branch: "main", dirty: false,
                                                      ahead: 0, behind: 0)))
    let forge = GitGlyph.of(.state(GitStatusSnapshot(branch: "feat/projects-screen-richer",
                                                     dirty: false, ahead: nil, behind: nil)))
    let look = GitGlyph.of(.absent("sem git"))

    // Os três repositórios mostram a MESMA marca de branch — ela diz "isto é
    // git", não "isto é este git" — e se separam por texto e por tom.
    for r in [feirao, fenrir, forge] { assertEqual(r.symbol, GitGlyph.branchSymbol) }
    assertEqual(feirao.tone, .dirty, "árvore suja é o único tom de alerta da linha")
    assertEqual(fenrir.tone, .clean)
    assertEqual(forge.tone, .clean)
    assertEqual(look.tone, .absent)

    // O texto não muda: o ícone ACOMPANHA a linha, não a substitui. "sem
    // upstream" continua dito por extenso, porque um segmento omitido é
    // indistinguível de "em dia" e são fatos diferentes.
    assertEqual(forge.text, "feat/projects-screen-richer · limpo · sem upstream")
    assertEqual(feirao.text, "main · alterações")
    assertTrue(forge.help.contains("sem upstream"), "help: \(forge.help)")
    assertTrue(fenrir.help.contains("em dia"), "ahead=0/behind=0 é 'em dia', não 'sem upstream'")
}

test("GitGlyph: todo símbolo que a linha de git pode desenhar existe de verdade") {
    // Um nome de SF Symbol inválido renderiza como um quadrado em branco — a
    // mesma falha vazia que este trabalho inteiro existe para remover.
    let repo = GitStatusSnapshot(branch: "main", dirty: false, ahead: nil, behind: nil)
    let simbolos = [GitGlyph.of(.state(repo)), GitGlyph.of(.absent("x")),
                    GitGlyph.of(.unavailable("x")), GitGlyph.of(nil)]
        .compactMap(\.symbol)
    assertFalse(simbolos.isEmpty, "nenhum símbolo exercitado = teste cego")
    for n in simbolos {
        assertTrue(NSImage(systemSymbolName: n, accessibilityDescription: nil) != nil,
                   "SF Symbol inexistente: \(n)")
    }
    // Só os nomes que o desenho realmente usa são introduzidos — nenhum glifo
    // não exercitado a mais do que o desenho precisa.
    assertEqual(Set(simbolos).count, 2, "símbolos em uso: \(simbolos)")
}

// MARK: - Branch padrão: main ou master, resolvida e nunca adivinhada

/// Monta um `.git` de mentira — só arquivos, nenhum binário do git.
///
/// A resolução da branch padrão é leitura de refs, então ela é testável sem
/// construir repositório nenhum: é exatamente por isso que ela lê refs em vez de
/// chamar `git symbolic-ref` (que custaria ~40 ms por card e um processo a
/// mais).
func fakeRepo(_ tag: String, _ files: [String: String]) -> String {
    let tmp = NSTemporaryDirectory() + "forge-gitdef-\(tag)-\(UUID().uuidString.prefix(8))"
    let fm = FileManager.default
    try? fm.createDirectory(atPath: tmp, withIntermediateDirectories: true)
    for (f, content) in files {
        let full = tmp + "/" + f
        try? fm.createDirectory(atPath: (full as NSString).deletingLastPathComponent,
                                withIntermediateDirectories: true)
        fm.createFile(atPath: full, contents: Data(content.utf8))
    }
    return tmp
}

test("GitDefaultBranch: a assimetria REAL do disco — origin/HEAD manda, main e master não empatam") {
    // As três formas medidas nos 14 projetos registrados do operador.
    // (a) forge-agent: origin/HEAD solto apontando para master, com main
    //     INEXISTENTE — se a ordem de fallback vencesse o origin/HEAD, este
    //     repositório inteiro seria comparado contra a branch errada.
    let forge = fakeRepo("forge", [
        ".git/refs/remotes/origin/HEAD": "ref: refs/remotes/origin/master\n",
        ".git/refs/heads/master": "abc\n",
        ".git/refs/heads/feat/projects-screen-richer": "def\n",
    ])
    defer { try? FileManager.default.removeItem(atPath: forge) }
    assertEqual(GitDefaultBranch.resolve(repoPath: forge), "master")

    // (b) feirao-do-lu: NENHUM origin/HEAD no disco (o git só o escreve em
    //     clone, e este repo não tem) — cai para o primeiro candidato que
    //     existe de fato.
    let feirao = fakeRepo("feirao", [".git/refs/heads/main": "abc\n"])
    defer { try? FileManager.default.removeItem(atPath: feirao) }
    assertEqual(GitDefaultBranch.resolve(repoPath: feirao), "main")

    // (c) origin/HEAD vence mesmo com main presente: quando o remoto declara
    //     seu padrão, o palpite local não tem o que dizer.
    let ambos = fakeRepo("ambos", [
        ".git/refs/remotes/origin/HEAD": "ref: refs/remotes/origin/master\n",
        ".git/refs/heads/main": "abc\n",
        ".git/refs/heads/master": "def\n",
    ])
    defer { try? FileManager.default.removeItem(atPath: ambos) }
    assertEqual(GitDefaultBranch.resolve(repoPath: ambos), "master",
                "a ordem de fallback passou por cima do que o remoto declara")
}

test("GitDefaultBranch: não resolver é NULO — jamais o palpite 'main'") {
    // O `gitDefaultBranch()` do forge-isolation.js termina em `return 'main'`,
    // porque um script que precisa dar checkout precisa de um nome de qualquer
    // jeito. Um CARD não: imprimir "main" para um repositório que não tem main
    // é a afirmação falsa confiante que `383412d` tirou desta tela.
    let vazio = fakeRepo("vazio", [".git/HEAD": "ref: refs/heads/trunk\n"])
    defer { try? FileManager.default.removeItem(atPath: vazio) }
    assertTrue(GitDefaultBranch.resolve(repoPath: vazio) == nil,
               "resolveu algo num repo sem origin/HEAD, sem main e sem master — é palpite")

    // Não-repositório: o lookchina do operador, que é workspace e não repo.
    let naoRepo = fakeRepo("naorepo", ["README.md": "x"])
    defer { try? FileManager.default.removeItem(atPath: naoRepo) }
    assertTrue(GitDefaultBranch.resolve(repoPath: naoRepo) == nil)
}

test("GitDefaultBranch: packed-refs conta, e 'maintenance' não passa por 'main'") {
    // Um repo repacked não tem refs soltos nenhum. Se packed-refs não fosse
    // lido, todo repositório empacotado (o estado normal de um clone antigo)
    // viraria "padrão indeterminado".
    let packed = fakeRepo("packed", [
        ".git/packed-refs": "# pack-refs with: peeled fully-peeled sorted\n"
            + "aaaa1111 refs/heads/main\naaaa2222 refs/remotes/origin/main\n",
    ])
    defer { try? FileManager.default.removeItem(atPath: packed) }
    assertEqual(GitDefaultBranch.resolve(repoPath: packed), "main")

    // Prefixo não é igualdade. `refs/heads/maintenance` satisfazendo "main"
    // faria o card comparar contra uma branch que o operador nunca nomeou.
    let quase = fakeRepo("quase", [
        ".git/packed-refs": "aaaa1111 refs/heads/maintenance\nbbbb2222 refs/heads/master\n",
    ])
    defer { try? FileManager.default.removeItem(atPath: quase) }
    assertEqual(GitDefaultBranch.resolve(repoPath: quase), "master",
                "'maintenance' passou por 'main' — comparação por prefixo")

    // origin/HEAD também vive em packed-refs depois de um repack.
    let packedHead = fakeRepo("packedhead", [
        ".git/packed-refs": "ref: refs/remotes/origin/develop\ncccc refs/heads/main\n",
    ])
    defer { try? FileManager.default.removeItem(atPath: packedHead) }
    assertEqual(GitDefaultBranch.resolve(repoPath: packedHead), "develop")
}

test("GitDefaultBranch: worktree — o .git é um ARQUIVO e os refs estão no commondir") {
    // A forma que o próprio Forge cria em `forge_isolation.mode: worktree`. Um
    // resolvedor que parasse no primeiro salto não acharia refs/heads/ nenhum
    // dentro de .git/worktrees/<nome>, e TODO worktree do Forge apareceria como
    // "padrão indeterminado" — na tela do operador que mais usa worktree.
    let base = fakeRepo("wt", [
        "principal/.git/refs/remotes/origin/HEAD": "ref: refs/remotes/origin/master\n",
        "principal/.git/refs/heads/master": "abc\n",
        "principal/.git/worktrees/w1/commondir": "../..\n",
        "principal/.git/worktrees/w1/HEAD": "ref: refs/heads/forge/M001\n",
        "arvore/.git": "gitdir: \(NSTemporaryDirectory())PLACEHOLDER\n",
    ])
    defer { try? FileManager.default.removeItem(atPath: base) }
    // Reescrito com o caminho real (absoluto), que só existe depois do mkdtemp.
    try? "gitdir: \(base)/principal/.git/worktrees/w1\n"
        .write(toFile: base + "/arvore/.git", atomically: true, encoding: .utf8)
    assertEqual(GitDefaultBranch.resolve(repoPath: base + "/arvore"), "master")

    // E o caminho relativo, que é como o git escreve quando o worktree é irmão.
    try? "gitdir: ../principal/.git/worktrees/w1\n"
        .write(toFile: base + "/arvore/.git", atomically: true, encoding: .utf8)
    assertEqual(GitDefaultBranch.resolve(repoPath: base + "/arvore"), "master",
                "gitdir relativo não foi resolvido contra a pasta do worktree")
}

test("GitDefaultBranch: este repositório, no disco de verdade, é master") {
    // O fato assimétrico que dá razão à feature: os projetos do operador usam
    // `main`, e ESTE usa `master`. Um resolvedor que devolvesse "main" fixo
    // passaria em todos os testes sintéticos acima e mentiria aqui.
    let repo = URL(fileURLWithPath: #filePath)          // …/app/Sources/ForgeKitTests/main.swift
        .deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().path
    // Dogfood deliberado — mas só quando origin/HEAD nomeia a padrão. Sem ele
    // (fetch manual, alguns CI), `resolve` cai para os candidatos na ordem
    // `main > master`, e o resultado vira fato do CLONE, não do código: uma
    // branch local `main` faria isto falhar sem defeito nenhum. Skip nomeado.
    let dir = GitDefaultBranch.commonDir(repoPath: repo)
    let loose = dir.flatMap {
        try? String(contentsOfFile: $0 + "/refs/remotes/origin/HEAD", encoding: .utf8)
    } ?? ""
    let packed = dir.flatMap {
        try? String(contentsOfFile: $0 + "/packed-refs", encoding: .utf8)
    } ?? ""
    guard loose.contains("ref: refs/remotes/origin/")
            || packed.contains("ref: refs/remotes/origin/") else {
        print("  (skipped — este checkout não tem origin/HEAD; o nome da padrão viria dos candidatos e é fato do clone, não do código)")
        return
    }
    assertEqual(GitDefaultBranch.resolve(repoPath: repo), "master",
                "resolveu em \(repo)")
}

test("Git.parseLeftRight: esquerda é ATRÁS — trocar os dois desenha o oposto plausível") {
    // `git rev-list --left-right --count master...HEAD` sobre este branch
    // imprime "0\t5": 0 commits que master tem e HEAD não, 5 que HEAD tem e
    // master não. Invertido, o card diria "5 atrás de master" para um branch
    // que está 5 À FRENTE — uma afirmação errada que parece perfeitamente
    // normal na tela, que é o que a torna cara.
    let c = Git.parseLeftRight("0\t5\n")
    assertTrue(c != nil)
    assertEqual(c?.behind, 0)
    assertEqual(c?.ahead, 5)
    assertEqual(Git.parseLeftRight("13\t2")?.behind, 13)
    assertTrue(Git.parseLeftRight("") == nil, "vazio não é (0,0) — é formato não reconhecido")
    assertTrue(Git.parseLeftRight("7") == nil, "um número só não é uma comparação")
    assertTrue(Git.parseLeftRight("a\tb") == nil)
}

test("GitBaselineMark: 'não determinado' nunca se passa por 'em dia com a padrão'") {
    // O invariante desta task inteira. A divergência da branch padrão é um
    // QUINTO fato, que pode ser desconhecido de forma independente dos outros
    // quatro — um repo sem origin, ou uma padrão irresolúvel, tem que aparecer
    // como não-determinado, jamais como "nivelado com main".
    let marcas = [
        GitBaselineMark.of(.measured(GitBaselineState(defaultBranch: "master",
                                                      onDefault: true, ahead: 0, behind: 0))),
        GitBaselineMark.of(.measured(GitBaselineState(defaultBranch: "main",
                                                      onDefault: false, ahead: 0, behind: 0))),
        GitBaselineMark.of(.measured(GitBaselineState(defaultBranch: "master",
                                                      onDefault: false, ahead: 5, behind: 0))),
        GitBaselineMark.of(.measured(GitBaselineState(defaultBranch: "main",
                                                      onDefault: false, ahead: 0, behind: 3))),
        GitBaselineMark.of(.measured(GitBaselineState(defaultBranch: "main",
                                                      onDefault: false, ahead: 5, behind: 3))),
        GitBaselineMark.of(.unknown("sem origin/HEAD")),   // medido, irresolúvel
        GitBaselineMark.of(nil),                            // ainda não medido
    ]
    // Sete situações, sete desenhos. Se duas empatarem em tom E texto, dois
    // fatos viraram um — a colisão exata que pôs "sem git" em repos reais.
    for i in 0..<marcas.count {
        for j in (i + 1)..<marcas.count {
            assertFalse(marcas[i].tone == marcas[j].tone && marcas[i].text == marcas[j].text,
                        "marcas \(i) e \(j) desenham igual: \(marcas[i].text)")
        }
    }
    // E o nivelado não pode ser confundido com os dois não-medidos em NENHUMA
    // direção: nem tom, nem texto, nem símbolo.
    let nivelado = marcas[1]
    for x in [marcas[5], marcas[6]] {
        assertFalse(x.tone == nivelado.tone, "não-determinado ganhou o tom de 'nivelado'")
        assertFalse(x.text.contains("main") && x.symbol == GitBaselineMark.levelSymbol,
                    "não-determinado desenhando '= main' afirma o que ninguém mediu")
    }
    // Nenhum silêncio: um segmento omitido é indistinguível de "em dia".
    for m in marcas { assertFalse(m.text.isEmpty); assertFalse(m.help.isEmpty) }

    // O tom é urgência, não direção: ficar ATRÁS da padrão é o acionável.
    assertEqual(marcas[2].tone, .ahead)
    assertEqual(marcas[3].tone, .behind)
    assertEqual(marcas[4].tone, .diverged)
    assertEqual(marcas[0].tone, .level)
    assertEqual(marcas[1].tone, .level)
    assertEqual(marcas[5].tone, .undetermined)
    assertEqual(marcas[6].tone, .pending)

    // Os números aparecem, e do lado certo.
    assertTrue(marcas[2].text.contains("5") && marcas[2].text.contains("master"),
               "texto: \(marcas[2].text)")
    assertTrue(marcas[4].text.contains("5") && marcas[4].text.contains("3"),
               "divergido sem os dois tamanhos não diz quanto trabalho é: \(marcas[4].text)")
}

test("GitBaselineMark: divergência da PADRÃO não é divergência do UPSTREAM") {
    // Os dois números são medidos contra refs diferentes e não se substituem.
    // Este repositório é a prova viva: `feat/projects-screen-richer` não tem
    // upstream NENHUM (ahead/behind = nil) e está 5 commits à frente de master.
    // Um card que só mostrasse o upstream diria "sem upstream" e nada mais —
    // silêncio sobre os 5 commits que existem.
    let semUpstream = GitStatusSnapshot(
        branch: "feat/projects-screen-richer", dirty: false, ahead: nil, behind: nil,
        baseline: .measured(GitBaselineState(defaultBranch: "master", onDefault: false,
                                             ahead: 5, behind: 0)))
    let g = GitGlyph.of(.state(semUpstream))
    assertTrue(g.text.contains("sem upstream"), "a linha não pode perder o fato do upstream")
    assertFalse(g.text.contains("master"),
                "a padrão entrou na linha principal — ela trunca primeiro e é a que some")
    assertEqual(g.baseline?.text, "5 de master")
    assertEqual(g.baseline?.tone, .ahead)
    // O tooltip é o único lugar onde os dois fatos aparecem juntos, e tem que
    // nomear os dois para que ninguém tome um pelo outro.
    assertTrue(g.help.contains("upstream") && g.help.contains("master"), "help: \(g.help)")

    // O inverso: em dia com o upstream E atrasado em relação à padrão. Nenhum
    // dos dois números pode calar o outro.
    let atrasado = GitStatusSnapshot(
        branch: "fix/x", dirty: false, ahead: 0, behind: 0,
        baseline: .measured(GitBaselineState(defaultBranch: "main", onDefault: false,
                                             ahead: 0, behind: 6)))
    let h = GitGlyph.of(.state(atrasado))
    assertTrue(h.help.contains("em dia com o upstream"))
    assertTrue(h.help.contains("6"), "atraso em relação à padrão sumiu do help: \(h.help)")
    assertEqual(h.baseline?.tone, .behind)
}

test("GitBaselineMark: sem repositório não há padrão da qual divergir") {
    // `absent`, `failed` e `pending` não estabeleceram que existe repositório —
    // desenhar uma marca de padrão neles é a mesma classe de afirmação
    // fabricada que a marca de branch já é proibida de fazer.
    assertTrue(GitGlyph.of(.absent("sem git")).baseline == nil)
    assertTrue(GitGlyph.of(.unavailable("timeout")).baseline == nil)
    assertTrue(GitGlyph.of(nil).baseline == nil)
    // E com repositório sempre há marca — inclusive a de "ainda não medida".
    let repo = GitStatusSnapshot(branch: "main", dirty: false, ahead: nil, behind: nil)
    assertTrue(GitGlyph.of(.state(repo)).baseline != nil,
               "silêncio sobre a padrão é indistinguível de 'em dia com ela'")
}

test("GitBaselineMark: todo símbolo da marca de padrão existe de verdade") {
    // Mesmo motivo do teste irmão: um nome inválido de SF Symbol renderiza como
    // um quadrado em branco.
    let todos = [GitBaselineMark.aheadSymbol, GitBaselineMark.behindSymbol,
                 GitBaselineMark.divergedSymbol, GitBaselineMark.levelSymbol,
                 GitBaselineMark.undeterminedSymbol, GitGlyph.branchSymbol]
    for n in todos {
        assertTrue(NSImage(systemSymbolName: n, accessibilityDescription: nil) != nil,
                   "SF Symbol inexistente: \(n)")
    }
    // E são de fato os que o desenho emite — uma constante que ninguém usa não
    // é cobertura de nada.
    let emitidos = Set([
        GitBaselineMark.of(.measured(GitBaselineState(defaultBranch: "m", onDefault: false,
                                                      ahead: 1, behind: 0))),
        GitBaselineMark.of(.measured(GitBaselineState(defaultBranch: "m", onDefault: false,
                                                      ahead: 0, behind: 1))),
        GitBaselineMark.of(.measured(GitBaselineState(defaultBranch: "m", onDefault: false,
                                                      ahead: 1, behind: 1))),
        GitBaselineMark.of(.measured(GitBaselineState(defaultBranch: "m", onDefault: false,
                                                      ahead: 0, behind: 0))),
        GitBaselineMark.of(.unknown("x")),
    ].compactMap(\.symbol))
    assertEqual(emitidos.count, 5, "símbolos emitidos: \(emitidos.sorted())")
    assertTrue(emitidos.isSubset(of: Set(todos)))
}

test("Git.baseline: estar NA padrão não gasta processo nenhum, e é um fato próprio") {
    // O que este teste mede é o ATALHO estrutural (currentBranch == padrão ⇒
    // 0/0 sem rev-list), não o nome da padrão — que é fato do clone: sem
    // origin/HEAD, os candidatos `main > master` decidem diferente. Por isso
    // resolvemos o nome primeiro e passamos o resolvido como currentBranch:
    // a relação vale em qualquer checkout.
    let repo = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().path
    guard let def = GitDefaultBranch.resolve(repoPath: repo) else {
        return assertTrue(false, "não resolveu a padrão deste repositório")
    }
    guard let s = Git.baseline(at: repo, currentBranch: def).state else {
        return assertTrue(false, "baseline não mediu com a padrão resolvida (\(def))")
    }
    // currentBranch == padrão: respondido sem rev-list, e `onDefault` distingue
    // "você ESTÁ na padrão" de "seu branch não tem nada além da padrão".
    assertTrue(s.onDefault)
    assertEqual(s.defaultBranch, def)
    assertEqual(s.ahead, 0); assertEqual(s.behind, 0)
    assertEqual(GitBaselineMark.of(.measured(s)).text, "padrão")

    // Um diretório que não é repositório: nomeia o motivo, não inventa padrão.
    let naoRepo = fakeRepo("semrepo", ["a.txt": "x"])
    defer { try? FileManager.default.removeItem(atPath: naoRepo) }
    guard case .unknown(let why) = Git.baseline(at: naoRepo, currentBranch: "main") else {
        return assertTrue(false, "inventou uma padrão para um diretório sem repositório")
    }
    assertFalse(why.isEmpty)
}

test("Git.status enche a divergência da padrão junto — este repo, medido de verdade") {
    // Ponta a ponta, no disco do operador — mas afirmando SÓ o que independe
    // de onde o operador está parado.
    //
    // A versão anterior terminava com `if !onDefault { assertTrue(ahead > 0) }`,
    // que não é uma afirmação sobre o código: é uma afirmação sobre o hábito de
    // trabalho de quem roda a suíte. Um branch recém-criado tem legitimamente
    // zero commits à frente, então a suíte falhava de forma 100% determinística
    // no primeiro `git checkout -b` — medido: falha na hora, passa depois do
    // primeiro commit. Entrou no item I-20260814142227 como "flaky sensível a
    // contenção"; não é contenção nenhuma, é um assert observando uma
    // superfície viva que o teste não controla (a posição do branch do
    // operador). Mesma família, causa diferente.
    let repo = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().path
    guard let snap = Git.status(at: repo).snapshot else {
        return assertTrue(false, "git não respondeu no próprio repositório")
    }
    guard let b = snap.baseline?.state else {
        return assertTrue(false, "Git.status não mediu a padrão: \(String(describing: snap.baseline))")
    }
    // O NOME da padrão é fato do clone, não do código: sem origin/HEAD (fetch
    // manual, alguns CI), `resolve` cai para os candidatos na ordem
    // `main > master`, e um checkout assim com uma branch local `main`
    // resolveria "main". Afirmamos só relações internas da própria medição.
    assertFalse(b.defaultBranch.isEmpty, "padrão resolvida vazia")
    assertEqual(b.onDefault, snap.branch == b.defaultBranch)
    // Divergência é contagem: nunca negativa, e zero-zero quando se está NA padrão.
    assertTrue(b.ahead >= 0 && b.behind >= 0, "divergência negativa: \(b.ahead)/\(b.behind)")
    if b.onDefault { assertEqual(b.ahead, 0); assertEqual(b.behind, 0) }
}

test("Git.status mede a divergência EXATA num repo sintético — o número, não o sinal") {
    // O que o teste acima perdeu ao parar de afirmar sobre o branch do
    // operador, este devolve com juros: um repo construído com uma divergência
    // CONHECIDA, então a asserção é sobre o número exato em vez de `> 0`.
    // Determinístico, e sem depender de nada fora do tmpdir.
    let repo = gitTmpDir("divergencia-exata")
    defer { try? FileManager.default.removeItem(atPath: repo) }
    fixtureGit(["init", "-q", "-b", "main"], at: repo)
    fixtureGit(["config", "user.email", "t@example.com"], at: repo)
    fixtureGit(["config", "user.name", "T"], at: repo)
    fixtureWrite("base", to: repo + "/a.txt")
    fixtureGit(["add", "."], at: repo)
    fixtureGit(["commit", "-qm", "base"], at: repo)

    // Na padrão: zero-zero, e `onDefault` é um fato próprio.
    guard let naPadrao = Git.status(at: repo).snapshot?.baseline?.state else {
        return assertTrue(false, "não mediu a padrão no repo sintético")
    }
    assertEqual(naPadrao.defaultBranch, "main")
    assertTrue(naPadrao.onDefault)
    assertEqual(naPadrao.ahead, 0); assertEqual(naPadrao.behind, 0)

    // Dois commits à frente, nenhum atrás — números escolhidos, não observados.
    fixtureGit(["checkout", "-q", "-b", "trabalho"], at: repo)
    for n in 1...2 {
        fixtureWrite("c\(n)", to: repo + "/c\(n).txt")
        fixtureGit(["add", "."], at: repo)
        fixtureGit(["commit", "-qm", "c\(n)"], at: repo)
    }
    guard let divergiu = Git.status(at: repo).snapshot?.baseline?.state else {
        return assertTrue(false, "não mediu a divergência no repo sintético")
    }
    assertEqual(divergiu.defaultBranch, "main")
    assertFalse(divergiu.onDefault)
    assertEqual(divergiu.ahead, 2, "à frente medido")
    assertEqual(divergiu.behind, 0, "atrás medido")

    // Controle positivo: um branch SEM nada à frente é legítimo e mensurável —
    // exatamente o estado que o assert antigo chamava de "suspeito".
    fixtureGit(["checkout", "-q", "-b", "recem-criado", "main"], at: repo)
    guard let zero = Git.status(at: repo).snapshot?.baseline?.state else {
        return assertTrue(false, "não mediu um branch recém-criado")
    }
    assertFalse(zero.onDefault, "não está na padrão")
    assertEqual(zero.ahead, 0, "um branch recém-criado tem zero à frente — e isso é normal")
    assertEqual(zero.behind, 0)
}

// MARK: - Marcas vendorizadas: todo nome desenha, e nenhuma marca é um palpite

test("BrandMark: toda marca resolve DE VERDADE no bundle — e vira imagem template") {
    // O mesmo teste que os SF Symbols já têm, pela mesma razão: um nome que não
    // resolve renderiza como um quadrado em branco, que é exatamente o slot
    // vazio que este trabalho existe para remover. Aqui é ainda mais
    // necessário, porque o nome não é validado por ninguém em tempo de
    // compilação — o arquivo pode simplesmente não ter sido copiado.
    assertFalse(BrandMark.allCases.isEmpty, "nenhuma marca exercitada = teste cego")
    for m in BrandMark.allCases {
        guard let u = BrandArt.url(m) else {
            assertTrue(false, "marca sem arquivo no bundle: \(m.assetName)")
            continue
        }
        assertTrue(FileManager.default.fileExists(atPath: u.path), "URL não existe: \(u.path)")
        guard let img = BrandArt.image(m) else {
            assertTrue(false, "arquivo existe mas o AppKit não desenhou: \(m.assetName)")
            continue
        }
        // Template é o que faz a marca aceitar o tom do card (e o modo escuro).
        // Uma marca que ignora o tema é PIOR que o SF Symbol que ela substitui.
        assertTrue(img.isTemplate, "\(m.assetName) não é template — não vai tingir")
        assertTrue(img.size.width > 0 && img.size.height > 0, "\(m.assetName) tem tamanho zero")
        // E rasteriza mesmo: `NSImage(contentsOf:)` aceita arquivos que depois
        // não desenham nada. Forçar o draw é o que separa "carregou" de "aparece".
        let alvo = NSImage(size: NSSize(width: 24, height: 24))
        alvo.lockFocus()
        img.draw(in: NSRect(x: 0, y: 0, width: 24, height: 24))
        alvo.unlockFocus()
        assertTrue(alvo.isValid, "\(m.assetName) não rasterizou")
    }
}

test("BrandMark: o enum e a pasta de recursos não podem divergir — nos DOIS sentidos") {
    // Um caso sem arquivo é o quadrado em branco (coberto acima). Um arquivo sem
    // caso é peso morto que ninguém desenha — e, mais importante, é o sintoma de
    // uma marca renomeada pela metade.
    guard let urls = BrandArt.bundle.urls(forResourcesWithExtension: BrandArt.fileExtension,
                                          subdirectory: BrandArt.directory) else {
        return assertTrue(false, "a pasta de ícones não existe no bundle — recursos não foram copiados")
    }
    let noDisco = Set(urls.map { $0.deletingPathExtension().lastPathComponent })
    let noEnum = Set(BrandMark.allCases.map(\.assetName))
    assertEqual(noDisco, noEnum,
                "só no disco: \(noDisco.subtracting(noEnum).sorted()) — só no enum: \(noEnum.subtracting(noDisco).sorted())")
}

test("BrandMark: a licença MIT dos Octicons viaja JUNTO com as cópias") {
    // MIT exige o aviso junto das cópias. Não é formalidade: `git-branch.svg`
    // é da GitHub, e distribuir o arquivo sem o aviso é a única parte deste
    // trabalho que seria uma violação e não um bug.
    guard let lic = BrandArt.bundle.url(forResource: "LICENSE-octicons",
                                        withExtension: "txt",
                                        subdirectory: BrandArt.directory),
          let texto = try? String(contentsOf: lic, encoding: .utf8) else {
        return assertTrue(false, "LICENSE dos Octicons não está junto dos arquivos")
    }
    assertTrue(texto.contains("MIT License"), "o texto não é a licença MIT")
    assertTrue(texto.contains("GitHub"), "a licença perdeu o detentor do copyright")
}

test("StackGlyph: a marca REAL substitui o símbolo, mas o símbolo continua o piso") {
    // Medido nos 14 projetos do operador antes desta troca: 12 dos 14 caíam em
    // DUAS formas (triângulo e hexágono) a 30 pt. Marcas de verdade são o que
    // separa; o SF Symbol fica como degradação, nunca como o quadrado vazio.
    let g = StackGlyph.of(.detected([.next, .node]), role: .project)
    assertEqual(g.mark, .next, "a marca segue a stack primária, não a lista inteira")
    assertFalse(g.symbol.isEmpty, "o piso sumiu — sem símbolo, um bundle sem recursos desenha nada")
    assertEqual(g.symbol, StackKind.next.symbolName)

    // Toda stack tem marca, e são distintas entre si — uma marca repetida
    // reintroduz exatamente o empate de formas que motivou a troca.
    let marcas = StackKind.allCases.map(\.mark)
    assertEqual(Set(marcas).count, StackKind.allCases.count, "marcas repetidas: \(marcas)")

    // E marca NENHUMA onde não há stack: um fallback de role ou uma medição que
    // falhou usando um logo é a afirmação falsa confiante de volta, só que
    // bonita. O símbolo continua lá, então o slot nunca fica vazio.
    for d in [StackDetection.none("x"), .unmeasured("y")] {
        let f = StackGlyph.of(d, role: .workspace)
        assertTrue(f.mark == nil, "\(d) desenhou uma marca de stack")
        assertFalse(f.symbol.isEmpty)
    }
}

// MARK: - GitRemoteHost: o logo do host é uma AFIRMAÇÃO, não um enfeite

test("GitRemoteHost: as formas de URL que o git realmente escreve") {
    let casos: [(String, String?)] = [
        ("https://github.com/u/r.git", "github.com"),
        ("http://gitlab.com/u/r", "gitlab.com"),
        // scp-like é o que o git escreve por padrão num clone por SSH: tratá-la
        // como ilegível deixaria a MAIORIA dos repositórios reais sem medição.
        ("git@github.com:u/r.git", "github.com"),
        ("ssh://git@bitbucket.org:22/u/r.git", "bitbucket.org"),
        ("https://user:token@github.com/u/r.git", "github.com"),
        ("https://GITHUB.COM/u/r.git", "github.com"),
        // Caminhos são remotos legítimos e não têm host — viram `.unmeasured`,
        // nunca um logo.
        ("/Users/x/repo.git", nil),
        ("../bare.git", nil),
        ("file:///tmp/r.git", nil),
        ("", nil),
    ]
    for (url, esperado) in casos {
        assertEqual(GitRemoteHost.host(ofRemoteURL: url), esperado, "URL: \(url)")
    }
}

test("GitRemoteHost: o casamento de domínio é por RÓTULO, não por substring") {
    // Um `contains` faria `github.com.attacker.example` desenhar o octocat. O
    // mark é uma afirmação sobre onde o código do operador mora.
    assertTrue(GitRemoteHost.matches(host: "github.com", domain: "github.com"))
    assertTrue(GitRemoteHost.matches(host: "ssh.github.com", domain: "github.com"))
    assertFalse(GitRemoteHost.matches(host: "notgithub.com", domain: "github.com"))
    assertFalse(GitRemoteHost.matches(host: "github.com.attacker.example", domain: "github.com"))
    assertFalse(GitRemoteHost.matches(host: "gitlab.com", domain: "github.com"))
}

test("GitRemoteHost: o url lido é o do ORIGIN, não o primeiro que aparecer") {
    // Um config com vários remotes tem vários `url =`, e o primeiro não é
    // necessariamente o do origin. Um grep ingênuo mostraria o logo do fork.
    let config = """
    [core]
    \trepositoryformatversion = 0
    [remote "upstream"]
    \turl = https://gitlab.com/outro/r.git
    \tfetch = +refs/heads/*:refs/remotes/upstream/*
    [remote "origin"]
    \turl = git@github.com:mwtelles/forge.git
    \tfetch = +refs/heads/*:refs/remotes/origin/*
    """
    assertEqual(GitRemoteHost.originURL(inConfig: config), "git@github.com:mwtelles/forge.git")
    // Sem origin nenhum: nada, e não o url do upstream.
    let semOrigin = "[remote \"upstream\"]\n\turl = https://gitlab.com/o/r.git\n"
    assertTrue(GitRemoteHost.originURL(inConfig: semOrigin) == nil)
}

test("GitRemoteHost.origin: os quatro casos, e nenhum se passa por outro") {
    // (a) host conhecido
    let gh = fakeRepo("gh", [".git/config": "[remote \"origin\"]\n\turl = git@github.com:u/r.git\n"])
    defer { try? FileManager.default.removeItem(atPath: gh) }
    assertEqual(GitRemoteHost.origin(at: gh).kind, .github)

    // (b) host REAL sem marca vendorizada: dito por extenso, jamais aproximado
    // com o logo de outro. Um GitHub Enterprise em domínio próprio cai aqui.
    let self_ = fakeRepo("self", [".git/config": "[remote \"origin\"]\n\turl = https://git.company.com/u/r.git\n"])
    defer { try? FileManager.default.removeItem(atPath: self_) }
    guard case .other(let h) = GitRemoteHost.origin(at: self_) else {
        return assertTrue(false, "host desconhecido não deveria virar host conhecido")
    }
    assertEqual(h, "git.company.com")

    // (c) repositório local: ausência MEDIDA
    let local = fakeRepo("local", [".git/config": "[core]\n\tbare = false\n"])
    defer { try? FileManager.default.removeItem(atPath: local) }
    guard case .absent = GitRemoteHost.origin(at: local) else {
        return assertTrue(false, "repo sem remoto deveria ser ausência medida")
    }

    // (d) nem repositório é: NÃO medido. Nunca colapsa em (c) — é a mesma
    // distinção de três casos que `DigestGitField` existe para proteger.
    let nada = fakeRepo("nada", ["a.txt": "x"])
    defer { try? FileManager.default.removeItem(atPath: nada) }
    guard case .unmeasured = GitRemoteHost.origin(at: nada) else {
        return assertTrue(false, "'não é repo' virou 'não tem remoto'")
    }
}

test("GitRemoteHost.origin: um worktree ligado tem host, e não é 'sem remoto'") {
    // Forge CRIA worktrees (`forge_isolation.mode: worktree`). Um resolvedor que
    // parasse no primeiro salto não acharia config nenhum e reportaria TODO
    // worktree que o Forge faz como sem remoto.
    let principal = fakeRepo("wt-main", [
        ".git/config": "[remote \"origin\"]\n\turl = https://gitlab.com/u/r.git\n",
    ])
    defer { try? FileManager.default.removeItem(atPath: principal) }
    let wt = fakeRepo("wt-linked", [
        ".git": "gitdir: \(principal)/.git/worktrees/w\n",
    ])
    defer { try? FileManager.default.removeItem(atPath: wt) }
    let fm = FileManager.default
    try? fm.createDirectory(atPath: principal + "/.git/worktrees/w", withIntermediateDirectories: true)
    fm.createFile(atPath: principal + "/.git/worktrees/w/commondir", contents: Data("../..\n".utf8))

    assertEqual(GitRemoteHost.origin(at: wt).kind, .gitlab,
                "o config vive no dir comum — o worktree não tem um próprio")
}

test("GitRemoteHost: os remotos REAIS do disco do operador, incluindo o que não ganha logo") {
    // Varridos em ~/Development antes deste teste existir. Os quatro formatos
    // que estão lá de verdade hoje:
    assertEqual(GitRemoteHost.host(ofRemoteURL: "https://github.com/mwtelles/feirao-do-lu.git"),
                "github.com")
    assertEqual(GitRemoteHost.host(ofRemoteURL: "https://github.com/LOOK-CHINA/authz.git"),
                "github.com")
    assertEqual(GitRemoteHost.host(ofRemoteURL: "git@github.com:mwtelles/inten.git"), "github.com")

    // `portfolio` usa um APELIDO de host do ~/.ssh/config. É um repositório do
    // GitHub e NÃO vai receber o octocat — vai ler "remoto em github-personal".
    //
    // Declarado como decisão, não descoberto como bug: resolver o apelido
    // exigiria ler o ~/.ssh/config do operador para desenhar um logo, e o
    // caminho barato para "acertar" seria adivinhar pelo prefixo do nome —
    // exatamente o palpite que este tipo existe para proibir. Dizer o nome que
    // está no config é verdadeiro; desenhar o octocat porque o apelido CONTÉM
    // "github" seria a mesma classe de afirmação que "sem git" foi.
    assertEqual(GitRemoteHost.host(ofRemoteURL: "git@github-personal:mwtelles/portfolio.git"),
                "github-personal")
    assertFalse(GitRemoteHost.matches(host: "github-personal", domain: "github.com"),
                "um apelido de SSH que contém 'github' não é github.com")
}

test("GitRemoteHost: este repositório, medido de verdade no disco do operador") {
    let repo = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().path
    // Não afirma QUAL host — afirma que a leitura MEDE alguma coisa. Um repo
    // clonado de outro lugar não deve reprovar este teste, mas um leitor
    // quebrado (que devolvesse `.unmeasured` sempre) deve.
    let r = GitRemoteHost.origin(at: repo)
    if case .unmeasured(let why) = r {
        assertTrue(false, "não mediu o remoto do próprio repositório: \(why)")
    }
}

test("GitHostMark: o logo aparece se e somente se o host foi MEDIDO") {
    let conhecido = GitHostMark.of(.host(.github, "github.com"))
    let outro = GitHostMark.of(.other("git.sr.ht"))
    let semRemoto = GitHostMark.of(.absent("sem remoto"))
    let naoMedido = GitHostMark.of(.unmeasured("config ilegível"))
    let aindaNao = GitHostMark.of(nil)

    assertEqual(conhecido.mark, .github)
    assertTrue(conhecido.isMeasured)
    // Host real sem marca: medido, mas NADA desenhado — dito em palavras.
    assertTrue(outro.mark == nil, "host sem marca vendorizada pegou o logo de outro")
    assertTrue(outro.isMeasured)
    assertTrue(outro.help.contains("git.sr.ht"), "o nome do host sumiu: \(outro.help)")
    // As três ausências não desenham, e nenhuma delas se passa pela outra: as
    // frases são distintas, que é o único jeito de o operador saber qual recebeu.
    for a in [semRemoto, naoMedido, aindaNao] {
        assertTrue(a.mark == nil); assertFalse(a.isMeasured)
    }
    let frases = [semRemoto.help, naoMedido.help, aindaNao.help]
    assertEqual(Set(frases).count, 3, "duas ausências dizem a mesma coisa: \(frases)")
    // Nunca em branco — silêncio é indistinguível de bug.
    for m in [conhecido, outro, semRemoto, naoMedido, aindaNao] { assertFalse(m.help.isEmpty) }
}

test("GitGlyph: o host entra na linha sem desfazer a distinção de quatro estados") {
    let repo = GitStatusSnapshot(branch: "main", dirty: false, ahead: 0, behind: 0)
    let remoto = GitOrigin(remote: .host(.github, "github.com"), repo: "r")
    let g = [GitGlyph.of(.state(repo), origin: remoto),
             GitGlyph.of(.absent("sem git"), origin: remoto),
             GitGlyph.of(.unavailable("timeout"), origin: remoto),
             GitGlyph.of(nil, origin: remoto)]
    for i in 0..<g.count {
        for j in (i + 1)..<g.count {
            assertFalse(g[i].tone == g[j].tone && g[i].text == g[j].text,
                        "estados \(i) e \(j) desenham igual DEPOIS do host")
        }
    }
    // A marca de branch continua sendo EVIDÊNCIA: existe se e somente se há
    // símbolo de branch, e some junto com ele nos estados que não medem repo.
    assertEqual(g[0].mark, GitGlyph.branchMark)
    assertEqual(g[0].symbol, GitGlyph.branchSymbol, "o piso SF Symbol sumiu da linha de git")
    for x in [g[1], g[3]] { assertTrue(x.mark == nil, "estado sem repo desenhou branch") }
    // `failed` mantém o triângulo de aviso, que é SF Symbol e não pode virar
    // marca de branch — a medição que falhou não pode se passar por repositório.
    assertTrue(g[2].mark == nil, "uma medição que falhou virou uma branch")
    assertFalse(g[2].symbol == GitGlyph.branchSymbol)

    // O tooltip da linha COM repositório diz onde ela mora; a que não tem
    // repositório não repete a pergunta que ninguém fez.
    assertTrue(g[0].help.contains("GitHub"), "o host sumiu do tooltip: \(g[0].help)")
    assertFalse(g[1].help.contains("GitHub"), "card sem repositório afirmou hospedagem")

    // Sem remoto informado, a linha NÃO afirma ausência de remoto.
    let semInfo = GitGlyph.of(.state(repo))
    assertTrue(semInfo.host.mark == nil)
    assertFalse(semInfo.host.isMeasured, "'ainda não lido' virou 'não tem'")
}

test("ProjectDigest carrega o remoto no caminho BARATO, junto dos outros campos") {
    // Uma leitura de arquivo com teto (como o PROJECT.md), não um processo. Se
    // isto virasse um spawn, o custo da linha de git dobraria para ganhar um logo.
    let repo = fakeRepo("digest-remoto", [
        ".git/config": "[remote \"origin\"]\n\turl = git@bitbucket.org:u/r.git\n",
    ])
    defer { try? FileManager.default.removeItem(atPath: repo) }
    // `git: .none` = o caller adiou a sonda cara. O remoto vem mesmo assim.
    let d = ProjectDigest.load(path: repo, role: .project, repos: nil, git: .none)
    assertEqual(d.remote.kind, .bitbucket, "o remoto não veio no caminho barato")
    assertTrue(d.git.isUnavailable, "a sonda cara não deveria ter rodado")
}

// MARK: - Segmentos da linha de git: cada fato com seu ícone, sua palavra e sua cor

test("GitRemoteHost.repoName: o nome sai da URL em toda forma que o git aceita") {
    let casos: [(String, String?)] = [
        ("https://github.com/u/r.git", "r"),
        ("https://github.com/u/r", "r"),
        ("https://github.com/u/r/", "r"),           // barra sobrando não vira vazio
        ("ssh://git@github.com:22/u/r.git", "r"),
        ("git@github.com:u/r.git", "r"),            // scp-like: a forma padrão do clone SSH
        ("git@github-personal:u/r.git", "r"),       // ALIAS de host do ~/.ssh/config
        ("git@host:r.git", "r"),                    // sem separador de caminho
        ("/Users/x/repo.git", "repo"),              // caminho local ainda nomeia um repo
        ("https://github.com/", nil),               // não há último componente
        ("", nil),
    ]
    for (url, esperado) in casos {
        assertEqual(GitRemoteHost.repoName(ofRemoteURL: url), esperado,
                    "nome errado para \(url)")
    }
    // O nome NÃO depende do host ser reconhecido: o alias de SSH tem host
    // irreconhecível (`.other`) e nome perfeitamente bom, e é exatamente nele
    // que o nome da pasta tem menos chance de bater com o do repositório.
    let alias = GitOrigin(remote: .other("github-personal"),
                          repo: GitRemoteHost.repoName(ofRemoteURL: "git@github-personal:u/r.git"))
    assertEqual(alias.repo, "r", "o alias de SSH perdeu o nome do repositório")
    assertTrue(alias.remote.kind == nil, "um alias de host ganhou o logo de um host medido")
}

test("GitOrigin: uma leitura de config responde host E nome, e a ausência é nomeada") {
    let comRemoto = fakeRepo("origin-info-com", [
        ".git/config": "[remote \"origin\"]\n\turl = git@github.com:mwtelles/forge-agent.git\n",
    ])
    let semRemoto = fakeRepo("origin-info-sem", [".git/config": "[core]\n\tbare = false\n"])
    defer {
        try? FileManager.default.removeItem(atPath: comRemoto)
        try? FileManager.default.removeItem(atPath: semRemoto)
    }
    let a = GitRemoteHost.originInfo(at: comRemoto)
    assertEqual(a.remote.kind, .github)
    assertEqual(a.repo, "forge-agent", "o nome do repositório não veio da mesma leitura")

    // Repositório sem remoto nenhum: NÃO existe nome. E, sobretudo, o nome da
    // PASTA não é usado como substituto — o título do card já é a pasta, e
    // imprimi-la duas vezes como se fossem dois fatos é a classe de afirmação
    // falsa que esta tela vem removendo.
    let b = GitRemoteHost.originInfo(at: semRemoto)
    assertTrue(b.repo == nil, "inventou um nome de repositório: \(String(describing: b.repo))")
    let pasta = URL(fileURLWithPath: semRemoto).lastPathComponent
    assertFalse(b.repo == pasta, "o nome da pasta se passou por nome do repositório")
    if case .absent = b.remote {} else { assertTrue(false, "sem remoto virou outra coisa") }

    // `origin(at:)` continua respondendo o mesmo host — uma segunda leitura não
    // pode discordar da primeira.
    assertEqual(GitRemoteHost.origin(at: comRemoto), a.remote)
}

test("GitRowSegment: todo segmento tem ícone, palavra e frase — nenhum vem em branco") {
    let sujo = GitStatusSnapshot(branch: "feat/x", dirty: true, ahead: 3, behind: 2)
    let segs = GitRowSegment.compose(sujo, origin: GitOrigin(remote: .host(.github, "github.com"),
                                                             repo: "forge-agent"))
    assertEqual(segs.map(\.kind), [.repo, .branch, .changes, .upstream],
                "a ordem dos segmentos mudou: \(segs.map(\.kind.rawValue))")
    for s in segs {
        assertFalse(s.text.isEmpty, "segmento \(s.kind.rawValue) sem palavra — um vazio na linha")
        assertFalse(s.help.isEmpty, "segmento \(s.kind.rawValue) sem frase — silêncio não interrogável")
        assertTrue(s.symbol != nil || s.mark != nil,
                   "segmento \(s.kind.rawValue) sem ícone — o operador pediu ícone E texto")
    }
    // O ponto inteiro da estrutura: cada par tem SEU tom. Uma string só,
    // desenhada num run só, não consegue colorir o meio.
    assertEqual(segs.first(where: { $0.kind == .changes })?.tone, .dirty)
    assertEqual(segs.first(where: { $0.kind == .upstream })?.tone, .diverged)
    assertFalse(segs.first(where: { $0.kind == .branch })?.tone == .dirty,
                "o nome da branch pegou a cor das alterações — voltou a ser um run só")
    // O repositório leva a marca do host MEDIDO; a branch leva a marca de branch.
    assertEqual(segs[0].mark, GitHostKind.github.mark)
    assertEqual(segs[1].mark, GitGlyph.branchMark)
    assertEqual(segs[1].symbol, GitGlyph.branchSymbol, "o piso SF Symbol sumiu do segmento de branch")
}

test("GitRowSegment: 'sem upstream' nunca desenha como '0 à frente, 0 atrás'") {
    let base = { (a: Int?, b: Int?) in
        GitRowSegment.compose(GitStatusSnapshot(branch: "main", dirty: false, ahead: a, behind: b),
                              origin: nil)
    }
    let semUpstream = base(nil, nil)     // NÃO medido: não há com o que comparar
    let emDia = base(0, 0)               // medido: nivelado

    let s = semUpstream.first(where: { $0.kind == .upstream })
    assertTrue(s != nil, "sem upstream virou silêncio — indistinguível de 'em dia' na tela")
    assertFalse(s!.text.contains("0"), "um fato NÃO medido foi desenhado como zero: \(s!.text)")
    assertEqual(s!.tone, .undetermined)
    // Em dia não gasta pixel — e por isso o de cima não pode gastar zero nenhum.
    assertTrue(emDia.first(where: { $0.kind == .upstream }) == nil,
               "'em dia com o upstream' virou um segmento permanente em todo card")
    // A distinção continua interrogável nas PALAVRAS dos dois casos, que é o
    // que sobra quando um deles não desenha nada.
    let hSem = GitStatusSnapshot(branch: "main", dirty: false, ahead: nil, behind: nil).help
    let hDia = GitStatusSnapshot(branch: "main", dirty: false, ahead: 0, behind: 0).help
    assertFalse(hSem == hDia, "as duas frases colapsaram numa só: \(hSem)")

    // Direção não pode se inverter em silêncio: à frente e atrás têm símbolo,
    // tom e frase distintos.
    let frente = base(3, 0).first(where: { $0.kind == .upstream })!
    let atras = base(0, 3).first(where: { $0.kind == .upstream })!
    assertEqual(frente.symbol, GitBaselineMark.aheadSymbol)
    assertEqual(atras.symbol, GitBaselineMark.behindSymbol)
    assertEqual(frente.tone, .ahead)
    assertEqual(atras.tone, .behind, "atrás perdeu o tom acionável — é o que produz worktree stale")
    assertTrue(atras.help.contains("atrás"), "a frase de 'atrás' não diz atrás: \(atras.help)")
    assertFalse(frente.help.contains("atrás"), "'à frente' diz atrás na frase: \(frente.help)")
}

test("GitRowSegment: 'limpo' é quieto e 'alterações' é colorido — e nada é inventado") {
    let limpo = GitRowSegment.compose(
        GitStatusSnapshot(branch: "main", dirty: false, ahead: 0, behind: 0), origin: nil)
    let sujo = GitRowSegment.compose(
        GitStatusSnapshot(branch: "main", dirty: true, ahead: 0, behind: 0), origin: nil)
    assertTrue(limpo.first(where: { $0.kind == .changes }) == nil,
               "um segmento 'limpo' permanente voltou — 14 cards dizendo que nada aconteceu")
    assertEqual(sujo.first(where: { $0.kind == .changes })?.tone, .dirty)
    // Sem remoto informado, NÃO nasce segmento de repositório: nome nenhum é
    // inventado, e o card não afirma hospedagem que ninguém mediu.
    assertTrue(limpo.first(where: { $0.kind == .repo }) == nil,
               "apareceu um nome de repositório sem remoto medido")
    // A branch é o único segmento que existe sempre — é o que faz a linha ser
    // legível como git.
    for s in [limpo, sujo] { assertTrue(s.contains(where: { $0.kind == .branch })) }
}

test("GitRowSegment: os três estados sem repositório não ganham segmento nenhum") {
    // Segmentos são um refinamento do `.state`. Os outros três continuam dizendo
    // exatamente o que diziam — se ganhassem segmentos, um diretório que não é
    // repositório passaria a desenhar como um que é.
    let origem = GitOrigin(remote: .host(.github, "github.com"), repo: "r")
    for g in [GitGlyph.of(.absent("sem git"), origin: origem),
              GitGlyph.of(.unavailable("timeout"), origin: origem),
              GitGlyph.of(nil, origin: origem)] {
        assertTrue(g.segments.isEmpty, "um estado sem repositório ganhou segmentos: \(g.text)")
        assertFalse(g.text.isEmpty, "o texto do estado sem repositório sumiu junto")
    }
    let comRepo = GitGlyph.of(.state(GitStatusSnapshot(branch: "main", dirty: false,
                                                       ahead: 0, behind: 0)), origin: origem)
    assertFalse(comRepo.segments.isEmpty, "o estado COM repositório perdeu os segmentos")
    // E o repositório medido aparece pelo NOME, que é o pedido do operador.
    assertEqual(comRepo.segments.first?.kind, .repo)
    assertEqual(comRepo.segments.first?.text, "r")
}

test("GitRowSegment: todo símbolo dos segmentos existe de verdade") {
    let sujo = GitStatusSnapshot(branch: "main", dirty: true, ahead: nil, behind: nil)
    var nomes = GitRowSegment.compose(sujo, origin: GitOrigin(remote: .other("git.sr.ht"),
                                                              repo: "r")).compactMap(\.symbol)
    // O host sem marca vendorizada cai no símbolo de repositório — é ele que
    // precisa existir, senão a queda é para um quadrado em branco.
    nomes += [GitRowSegment.repoSymbol, GitRowSegment.changesSymbol,
              GitRowSegment.noUpstreamSymbol]
    assertFalse(nomes.isEmpty, "nenhum símbolo exercitado = teste cego")
    for n in nomes {
        assertTrue(NSImage(systemSymbolName: n, accessibilityDescription: nil) != nil,
                   "SF Symbol inexistente: \(n)")
    }
    // Host medido sem marca: nada de logo emprestado, mas o segmento continua
    // existindo e dizendo o nome do host na frase.
    let seg = GitRowSegment.compose(sujo, origin: GitOrigin(remote: .other("git.sr.ht"), repo: "r"))[0]
    assertTrue(seg.mark == nil, "um host sem marca pegou o logo de outro")
    assertTrue(seg.help.contains("git.sr.ht"), "o nome do host sumiu da frase: \(seg.help)")
}

// MARK: - TouchedRow

/// A directory with a `.gsd/` holding `entries`, plus an optional `.git`.
func touchedTree(_ tag: String, gsd: [String], git: Bool = false) -> String {
    let tmp = NSTemporaryDirectory() + "forge-touched-\(tag)-\(UUID().uuidString.prefix(8))"
    let fm = FileManager.default
    try? fm.createDirectory(atPath: tmp + "/.gsd", withIntermediateDirectories: true)
    for e in gsd { fm.createFile(atPath: tmp + "/.gsd/" + e, contents: Data("x".utf8)) }
    if git { try? fm.createDirectory(atPath: tmp + "/.git", withIntermediateDirectories: true) }
    return tmp
}

test("TouchedRow: a linha diz o NOME da pasta, não só um pedaço do caminho") {
    // O defeito que originou este tipo: a linha imprimia apenas o caminho
    // abreviado, truncado no meio, então o que sobrava na tela era um trecho de
    // um ancestral e nada que identificasse a pasta.
    let r = TouchedRow.load(path: "/Users/x/Development/asgard", home: "/Users/x")
    assertEqual(r.name, "asgard")
    assertEqual(r.location, "~/Development")
    assertFalse(r.name.isEmpty)
    assertFalse(r.location.isEmpty)
}

test("TouchedRow: nome e local nunca ficam vazios, nem para caminhos degenerados") {
    for p in ["/", "/tmp/", "x"] {
        let r = TouchedRow.load(path: p, home: "/Users/x")
        assertFalse(r.name.isEmpty, "nome vazio para \(p) — o slot em branco de volta")
        assertFalse(r.location.isEmpty, "local vazio para \(p)")
    }
}

test("TouchedRow: .gsd/ vazio e .gsd/ ilegível são fatos DIFERENTES") {
    let vazio = touchedTree("vazio", gsd: [])
    defer { try? FileManager.default.removeItem(atPath: vazio) }
    let v = TouchedRow.load(path: vazio, home: "/Users/x").facts[0]
    assertEqual(v.kind, .contents)
    assertEqual(v.text, ".gsd/ vazio")
    assertTrue(v.measured, "diretório vazio FOI medido — cinza diria que não deu para saber")

    // Sem .gsd/ nenhum: leitura falha. Nunca pode virar "vazio".
    let semGsd = NSTemporaryDirectory() + "forge-touched-nao-existe-\(UUID().uuidString.prefix(8))"
    let a = TouchedRow.load(path: semGsd, home: "/Users/x").facts[0]
    assertFalse(a.measured, "falha de leitura marcada como medida")
    assertFalse(a.text == ".gsd/ vazio",
                "não conseguir ler virou 'não tem nada' — a afirmação falsa confiante")
    assertFalse(a.text.isEmpty)
}

test("TouchedRow: o conteúdo do .gsd/ é NOMEADO — é a prova da classificação") {
    let dir = touchedTree("scratch", gsd: ["forge", "STATE.md"])
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let f = TouchedRow.load(path: dir, home: "/Users/x").facts[0]
    assertTrue(f.text.contains("forge"), "o que está dentro sumiu: \(f.text)")
    assertTrue(f.text.contains("STATE.md"), "o que está dentro sumiu: \(f.text)")
    assertTrue(f.measured)
}

test("TouchedRow: excesso de entradas é contado, nunca descartado em silêncio") {
    let dir = touchedTree("muitos", gsd: ["a", "b", "c", "d", "e"])
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let f = TouchedRow.load(path: dir, home: "/Users/x").facts[0]
    assertTrue(f.text.contains("+2"), "duas entradas sumiram sem serem contadas: \(f.text)")
}

test("TouchedRow: a idade responde 'sucata antiga ou coisa viva'") {
    let dir = touchedTree("idade", gsd: ["forge"])
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let hoje = TouchedRow.load(path: dir, home: "/Users/x").facts[1]
    assertEqual(hoje.kind, .age)
    assertTrue(hoje.measured)
    assertTrue(hoje.text.contains("hoje"), "acabou de ser criado e não diz 'hoje': \(hoje.text)")

    // Um `now` no futuro é a mesma coisa que um .gsd/ velho.
    let velho = TouchedRow.load(path: dir, home: "/Users/x",
                                now: Date().addingTimeInterval(60 * 60 * 24 * 40)).facts[1]
    assertTrue(velho.text.contains("mes"), "40 dias não viraram meses: \(velho.text)")
}

test("TouchedRow: idade não medida é dita, não inventada") {
    let f = TouchedRow.load(path: NSTemporaryDirectory() + "nada-\(UUID().uuidString.prefix(8))",
                            home: "/Users/x").facts[1]
    assertFalse(f.measured)
    assertFalse(f.text.isEmpty)
    assertFalse(f.text.contains("hoje"), "ausência de medida virou 'hoje'")
}

test("TouchedRow: 'é repositório' e 'não é' são os dois medidos") {
    let comGit = touchedTree("comgit", gsd: ["forge"], git: true)
    let semGit = touchedTree("semgit", gsd: ["forge"])
    defer {
        try? FileManager.default.removeItem(atPath: comGit)
        try? FileManager.default.removeItem(atPath: semGit)
    }
    let a = TouchedRow.load(path: comGit, home: "/Users/x").facts[2]
    let b = TouchedRow.load(path: semGit, home: "/Users/x").facts[2]
    assertEqual(a.kind, .repo)
    assertEqual(a.text, "repositório git")
    assertEqual(b.text, "sem repositório git")
    assertTrue(a.measured && b.measured, "ambos foram medidos — nenhum é 'não deu para saber'")
    // E NENHUM dos dois afirma branch: isto é um stat, não um `git status`.
    assertFalse(a.symbol == GitGlyph.branchSymbol,
                "a marca de branch é reservada a um git status medido")
}

test("TouchedRow: os três fatos, sempre, nessa ordem, nunca em branco") {
    let dir = touchedTree("ordem", gsd: ["forge"])
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let r = TouchedRow.load(path: dir, home: "/Users/x")
    assertEqual(r.facts.map(\.kind), [.contents, .age, .repo])
    for f in r.facts {
        assertFalse(f.text.isEmpty, "fato \(f.kind) em branco")
        assertFalse(f.symbol.isEmpty, "fato \(f.kind) sem símbolo")
    }
}

test("TouchedRow: o botão promete LISTA, não disco — a claim mais perigosa da seção") {
    // `state.removeWorkspace` tira uma entrada do registro e não apaga um byte.
    // O operador pediu o ícone e a cor de excluir; a palavra tem que carregar o
    // objeto certo, ou a lata de lixo vermelha vira afirmação falsa sobre os
    // arquivos dele.
    assertEqual(TouchedRow.removeLabel, "Remover da lista")
    let proibidas = ["excluir", "apagar", "deletar"]
    for p in proibidas {
        assertFalse(TouchedRow.removeLabel.lowercased().contains(p),
                    "o rótulo promete destruir o disco: \(TouchedRow.removeLabel)")
    }
    let ajuda = TouchedRow.removeHelp("asgard")
    assertTrue(ajuda.contains("asgard"), "a ajuda não diz de qual pasta fala")
    assertTrue(ajuda.lowercased().contains("disco"),
               "a ajuda não desfaz o que o ícone de lixeira afirma: \(ajuda)")
    assertTrue(TouchedRow.removeFootnote.lowercased().contains("disco"),
               "a nota sob a lista não diz o que NÃO acontece")
}

test("TouchedRow: a explicação da seção é duas frases, uma ideia cada") {
    for s in [TouchedRow.sectionTitle, TouchedRow.sectionSummary, TouchedRow.sectionWhy] {
        assertFalse(s.isEmpty)
    }
    assertTrue(TouchedRow.sectionSummary.contains(".gsd/"),
               "o resumo não diz o que essas pastas são")
    assertTrue(TouchedRow.sectionWhy.contains("não cria mais")
               || TouchedRow.sectionWhy.contains("Não cria mais"),
               "o 'porquê' não diz que a causa acabou — a lista pareceria crescer para sempre")
}

test("TouchedRow: todo símbolo da seção existe de verdade") {
    // Um nome inválido renderiza como quadrado em branco. A task anterior
    // embarcou `cloud.slash`, que não existe.
    let dir = touchedTree("simbolos", gsd: ["forge"], git: true)
    defer { try? FileManager.default.removeItem(atPath: dir) }
    var nomes = TouchedRow.load(path: dir, home: "/Users/x").facts.map(\.symbol)
    nomes += [TouchedRow.sectionSymbol, TouchedRow.removeSymbol,
              TouchedRow.contentsSymbol, TouchedRow.ageSymbol, TouchedRow.repoSymbol,
              "folder"]
    assertFalse(nomes.isEmpty, "nenhum símbolo exercitado = teste cego")
    for n in nomes {
        assertTrue(NSImage(systemSymbolName: n, accessibilityDescription: nil) != nil,
                   "SF Symbol inexistente: \(n)")
    }
}

// ─────────────────────────────────────────────────────────────
// TerminalZoom / TerminalInput — zoom e entrada de imagem no terminal
// ─────────────────────────────────────────────────────────────

print("\nTerminalZoom (o tamanho do texto do terminal)")

test("TerminalZoom: os dois extremos são presos, não expandidos") {
    assertEqual(TerminalZoom.clamp(2), TerminalZoom.minimum)
    assertEqual(TerminalZoom.clamp(400), TerminalZoom.maximum)
    assertEqual(TerminalZoom.clamp(14), 14)
}

test("TerminalZoom: ⌘+ e ⌘− arredondam antes de passar") {
    // Depois de uma pinça o tamanho é fracionário. O teclado é o controle que
    // devolve o valor para número inteiro — senão 13.4 vira 14.4 e 12.4.
    assertEqual(TerminalZoom.stepped(13.4, by: 1), 14)
    assertEqual(TerminalZoom.stepped(13.4, by: -1), 12)
    assertEqual(TerminalZoom.stepped(12, by: 1), 13)
}

test("TerminalZoom: o passo nunca escapa do intervalo") {
    assertEqual(TerminalZoom.stepped(TerminalZoom.maximum, by: 1), TerminalZoom.maximum)
    assertEqual(TerminalZoom.stepped(TerminalZoom.minimum, by: -1), TerminalZoom.minimum)
}

test("TerminalZoom: a pinça é um delta que compõe, não uma escala absoluta") {
    // NSEvent.magnification vem como fração pequena por evento; dois eventos
    // seguidos têm que somar na direção dos dedos.
    let umPasso = TerminalZoom.pinched(12, magnification: 0.1)
    assertGreater(umPasso, 12)
    assertGreater(TerminalZoom.pinched(umPasso, magnification: 0.1), umPasso)
    assertTrue(TerminalZoom.pinched(12, magnification: -0.1) < 12,
               "pinça negativa tem que diminuir")
}

test("TerminalZoom: chave ausente lê 0 e NÃO vira um terminal invisível") {
    // UserDefaults.double devolve 0 para chave que nunca foi escrita — o valor
    // é indistinguível de um tamanho gravado, e prendê-lo no mínimo seria
    // aceitar corrupção como preferência.
    assertEqual(TerminalZoom.restored(fromStored: 0), TerminalZoom.standard)
    assertEqual(TerminalZoom.restored(fromStored: 3000), TerminalZoom.standard)
    assertEqual(TerminalZoom.restored(fromStored: -5), TerminalZoom.standard)
    assertEqual(TerminalZoom.restored(fromStored: 16), 16, "um valor legítimo tem que sobreviver")
}

test("TerminalZoom: o rótulo mostra ponto inteiro") {
    assertEqual(TerminalZoom.label(13.4), "13 pt")
    assertEqual(TerminalZoom.label(12), "12 pt")
}

print("\nTerminalInput (o que é digitado quando chega arquivo ou imagem)")

test("TerminalInput: caminho sem nada de especial fica intacto") {
    // A forma que os docs do Claude Code mostram. Envolver em aspas seria
    // ruído dentro do prompt do próprio Claude.
    assertEqual(TerminalInput.escapedPath("/Users/x/foto.png"), "/Users/x/foto.png")
}

test("TerminalInput: espaço é escapado com barra, no estilo do Terminal.app") {
    assertEqual(TerminalInput.escapedPath("/Users/x/Screen Shot.png"),
                "/Users/x/Screen\\ Shot.png")
}

test("TerminalInput: a própria barra é escapada antes de tudo") {
    assertEqual(TerminalInput.escapedPath("/a\\b"), "/a\\\\b")
}

test("TerminalInput: metacaracteres de shell não sobrevivem crus") {
    for c in ["$", "&", ";", "|", "(", ")", "*", "?", "'", "\""] {
        let saida = TerminalInput.escapedPath("/a\(c)b")
        assertEqual(saida, "/a\\\(c)b", "metacaractere \(c) passou sem escape")
    }
}

test("TerminalInput: vários arquivos viram uma linha com espaço no fim") {
    // O espaço final é o que deixa soltar dois arquivos em sequência e
    // continuar digitando sem colar no caminho.
    assertEqual(TerminalInput.insertion(forPaths: ["/a.png", "/b c.png"]),
                "/a.png /b\\ c.png ")
}

test("TerminalInput: nada para inserir devolve nil, não string vazia") {
    // nil é o sinal que faz o ⌘V cair no colar de texto normal. Uma string
    // vazia seria \"inseri nada com sucesso\" e engoliria o colar.
    assertTrue(TerminalInput.insertion(forPaths: []) == nil)
    assertTrue(TerminalInput.insertion(forPaths: ["", "   "]) == nil)
}

test("TerminalInput: dois colares no mesmo segundo não colidem") {
    // Colisão sobrescreveria a primeira imagem com a segunda enquanto o
    // primeiro caminho segue na tela apontando para a figura errada.
    let base = Date(timeIntervalSince1970: 1_770_000_000)
    let a = TerminalInput.pastedImageName(at: base)
    let b = TerminalInput.pastedImageName(at: base.addingTimeInterval(0.4))
    assertTrue(a != b, "nomes iguais dentro do mesmo segundo: \(a)")
    assertEqual(TerminalInput.pastedImageName(at: base), a, "mesma data, mesmo nome")
    assertTrue(a.hasSuffix(".png"), "extensão perdida: \(a)")
}

test("TerminalInput: a limpeza só apaga o que está mesmo velho") {
    let agora = Date(timeIntervalSince1970: 1_770_000_000)
    let velho = agora.addingTimeInterval(-TerminalInput.imageTTL - 60)
    let novo = agora.addingTimeInterval(-60)
    let apagar = TerminalInput.staleImages(
        [("velho.png", velho), ("novo.png", novo)],
        now: agora, ttl: TerminalInput.imageTTL)
    assertEqual(apagar, ["velho.png"])
}

test("TerminalInput: lista vazia não apaga nada") {
    assertEqual(TerminalInput.staleImages([], now: Date(), ttl: 1).count, 0)
}

print("\nTerminalRegistry.entries (o zoom alcança as abas fora da tela)")

test("TerminalRegistry: entries devolve todo terminal vivo") {
    // SwiftUI só reconstrói a aba visível. Sem esse acessor, mudar o zoom
    // deixaria as outras no tamanho antigo até alguém olhar para elas.
    let registry = TerminalRegistry<FakeTerminal>()
    let a = UUID(), b = UUID()
    registry.adopt(a) { FakeTerminal(tag: "a") }
    registry.adopt(b) { FakeTerminal(tag: "b") }
    assertEqual(Set(registry.entries.map(\.tag)), Set(["a", "b"]))
}

test("TerminalRegistry: entries some junto com a sessão fechada") {
    let registry = TerminalRegistry<FakeTerminal>()
    let a = UUID()
    registry.adopt(a) { FakeTerminal(tag: "a") }
    _ = registry.discard(a)
    assertEqual(registry.entries.count, 0)
}

// MARK: - PaletteRanking (⌘K)

test("PaletteRanking: prefixo simples casa") {
    assertEqual(PaletteRanking.score("terminal", "term") != nil, true)
}

test("PaletteRanking: subsequência casa, não só prefixo") {
    // O caso que quebra uma paleta com filtro por prefixo.
    assertEqual(PaletteRanking.score("nova sessao", "nsess") != nil, true)
}

test("PaletteRanking: acento não impede o match") {
    // Metade da UI é pt-BR e ninguém digita o acento numa paleta.
    let folded = PaletteRanking.fold("Preferências")
    assertEqual(PaletteRanking.score(folded, "preferencias") != nil, true)
}

test("PaletteRanking: o que não é subsequência não casa") {
    assertEqual(PaletteRanking.score("runs", "xyz") == nil, true)
}

test("PaletteRanking: início de palavra vale mais que meio de palavra") {
    let start = PaletteRanking.score("quadro grande", "q")!
    let middle = PaletteRanking.score("aqui", "q")!
    assertEqual(start > middle, true)
}

test("PaletteRanking: caracteres seguidos batem espalhados") {
    let run = PaletteRanking.score("abcd", "abcd")!
    let scattered = PaletteRanking.score("axbxcxd", "abcd")!
    assertEqual(run > scattered, true)
}

test("PaletteRanking: rank descarta quem não casa e ordena por score") {
    let items = [(id: "runs", text: "Runs"),
                 (id: "proj", text: "Projetos"),
                 (id: "nope", text: "Contas")]
    let out = PaletteRanking.rank(items, query: "ro")
    assertEqual(out.contains("nope"), false)
    assertEqual(out.isEmpty, false)
}

test("PaletteRanking: query vazia devolve tudo na ordem original") {
    let items = [(id: "a", text: "Alpha"), (id: "b", text: "Beta")]
    assertEqual(PaletteRanking.rank(items, query: "   "), ["a", "b"])
}

// MARK: - Palette: tom, fase, engine e superfície (S01)

// Palette.swift é o vocabulário visual do app inteiro — quatro tipos puros
// (sem SwiftUI, sem tela) que codificam as decisões travadas no CONTEXT desta
// milestone: "ember é reservado" (só o pane em foco/gate pendente pode usá-lo),
// "fase ganha cor, engine ganha tag" (duas dimensões, duas codificações, para
// não competirem na mesma escala) e "superfície vem de SurfaceLevel" (a
// profundidade é nomeada e monótona, nunca inventada por chamada). Cada teste
// abaixo fixa uma dessas frases como dado executável — se algum dia alguém
// editar Palette.swift de um jeito que quebra a frase, é aqui que isso falha.

test("ForgeTone: conjunto fechado de 8 tons") {
    assertEqual(ForgeTone.allCases.count, 8)
}

test("ForgeTone: rawValue faz round-trip em todos os casos") {
    for t in ForgeTone.allCases {
        assertEqual(ForgeTone(rawValue: t.rawValue), t)
    }
}

test("ForgeTone: ember é reservado — nenhuma fase o usa") {
    // `ember` é "isto quer você" — gates, perguntas pendentes, o pane em
    // foco. Nenhuma fase meramente EXISTINDO pode reivindicar esse tom.
    assertTrue(ForgePhase.allCases.allSatisfy { $0.tone != .ember },
               "uma fase está usando o tom reservado para atenção")
}

test("ForgePhase: execute-task/T03 resolve para execute") {
    assertEqual(ForgePhase(unit: "execute-task/T03"), .execute)
}

test("ForgePhase: plan-slice e plan-milestone resolvem para plan") {
    assertEqual(ForgePhase(unit: "plan-slice"), .plan)
    assertEqual(ForgePhase(unit: "plan-milestone"), .plan)
}

test("ForgePhase: nil, vazio e verbo desconhecido caem em unknown") {
    assertEqual(ForgePhase(unit: nil), .unknown)
    assertEqual(ForgePhase(unit: ""), .unknown)
    assertEqual(ForgePhase(unit: "deploy-service"), .unknown)
}

test("ForgePhase: parse ignora caixa") {
    assertEqual(ForgePhase(unit: "EXECUTE-TASK"), .execute)
    assertEqual(ForgePhase(unit: "Discuss-Milestone"), .discuss)
}

test("ForgePhase: tabela de tons — execute é amber, memory e unknown são slate") {
    // A tabela inteira, um par por caso — não só os três nomeados no título,
    // porque um enum com 8 casos e uma tabela parcial é exatamente onde um
    // caso novo escapa sem teste.
    let expected: [ForgePhase: ForgeTone] = [
        .discuss: .violet, .research: .teal, .plan: .indigo, .execute: .amber,
        .review: .rose, .complete: .mint, .memory: .slate, .unknown: .slate,
    ]
    for (phase, tone) in expected {
        assertEqual(phase.tone, tone, "fase \(phase) deveria mapear para \(tone)")
    }
    assertEqual(expected.count, ForgePhase.allCases.count,
                "a tabela do teste não cobre todos os casos do enum")
}

test("ForgePhase: spineOrder é 0…5 único na espinha e nil fora dela") {
    assertNil(ForgePhase.memory.spineOrder)
    assertNil(ForgePhase.unknown.spineOrder)
    let onSpine = ForgePhase.allCases.compactMap(\.spineOrder).sorted()
    assertEqual(onSpine, [0, 1, 2, 3, 4, 5])
}

test("ForgePhase: todo símbolo resolve em NSImage") {
    // Um nome de SF Symbol inválido renderiza como um quadrado em branco —
    // só dá para checar isto com AppKit de verdade, não com o tipo.
    for p in ForgePhase.allCases {
        assertTrue(NSImage(systemSymbolName: p.symbol, accessibilityDescription: nil) != nil,
                   "SF Symbol inexistente para a fase \(p): \(p.symbol)")
    }
}

test("ForgePhase: labels são não-vazios e únicos") {
    let labels = ForgePhase.allCases.map(\.label)
    assertTrue(labels.allSatisfy { !$0.isEmpty }, "toda fase precisa de um rótulo legível")
    assertEqual(Set(labels).count, labels.count, "duas fases não podem ler igual na tela")
}

test("ForgeEngine: claude, codex e agy parseiam ignorando caixa; nil e lixo caem em unknown") {
    assertEqual(ForgeEngine("claude"), .claude)
    assertEqual(ForgeEngine("CLAUDE"), .claude)
    assertEqual(ForgeEngine("Codex"), .codex)
    assertEqual(ForgeEngine("AGY"), .agy)
    assertEqual(ForgeEngine(nil), .unknown)
    assertEqual(ForgeEngine("gpt-5"), .unknown)
}

test("ForgeEngine: toda tag tem exatamente 2 caracteres e é única") {
    // Curta o bastante para caber num header de pane que já carrega nome de
    // projeto e conta — e sem ambiguidade entre os três engines que existem.
    let tags = ForgeEngine.allCases.map(\.tag)
    for tag in tags {
        assertEqual(tag.count, 2, "tag \(tag) não tem 2 caracteres")
    }
    assertEqual(Set(tags).count, ForgeEngine.allCases.count)
}

test("ForgeEngine: labels são únicos e unknown se declara") {
    let labels = ForgeEngine.allCases.map(\.label)
    assertEqual(Set(labels).count, labels.count)
    assertTrue(ForgeEngine.unknown.label.contains("não declarado"),
               "o label de unknown precisa admitir que o engine não foi declarado")
}

test("SurfaceLevel: rawValue é 0…3 na ordem ground, panel, raised, floating") {
    assertEqual(SurfaceLevel.ground.rawValue, 0)
    assertEqual(SurfaceLevel.panel.rawValue, 1)
    assertEqual(SurfaceLevel.raised.rawValue, 2)
    assertEqual(SurfaceLevel.floating.rawValue, 3)
}

test("SurfaceLevel: ground e panel não projetam sombra") {
    // Um chão com sombra é o tell de um design que aplicou profundidade por
    // find-and-replace em vez de decidir onde ela pertence.
    for level in [SurfaceLevel.ground, .panel] {
        assertEqual(level.shadowRadius, 0, "\(level) não deveria projetar sombra")
        assertEqual(level.shadowOpacity, 0, "\(level) não deveria ter opacidade de sombra")
    }
}

test("SurfaceLevel: sombra e raio nunca diminuem ao subir de nível") {
    // Profundidade só lê como profundidade quando é CONSISTENTE — três
    // cartões em três elevações inventadas leem como três erros.
    let levels = SurfaceLevel.allCases.sorted { $0.rawValue < $1.rawValue }
    for i in 1..<levels.count {
        let prev = levels[i - 1]
        let cur = levels[i]
        assertTrue(cur.shadowRadius >= prev.shadowRadius,
                   "shadowRadius caiu de \(prev) para \(cur)")
        assertTrue(cur.shadowOpacity >= prev.shadowOpacity,
                   "shadowOpacity caiu de \(prev) para \(cur)")
        assertTrue(cur.cornerRadius >= prev.cornerRadius,
                   "cornerRadius caiu de \(prev) para \(cur)")
    }
}

// MARK: - BoardLayout e ForgeMark: geometria sem tela (S01)

// BoardLayout.swift e ForgeMark.swift são o chão que S02 pisa: S02 divide a
// cabeça do Mjölnir em três polígonos e promove as bandas para ForgeMark, e
// nenhuma dessas mudanças pode se dar ao luxo de quebrar silenciosamente o
// que já está aqui — placement determinístico, reconcile como fonte única de
// verdade do grafo, e a convenção de orientação (horária, y-up) que S02 vai
// reusar para asserir "arestas coincidentes" nos três polígonos novos. O
// board é o lugar onde "usually não sobrepõe" não serve: cada teste abaixo
// fixa uma garantia geométrica ou de grafo como dado executável.

test("BoardLayout: primeiro nó nasce na origem com defaultSize") {
    var board = BoardLayout()
    board.place("a")
    let n = board.nodes["a"]
    assertTrue(n != nil, "esperado node para 'a'")
    assertEqual(n?.x, 0)
    assertEqual(n?.y, 0)
    assertEqual(n?.w, BoardLayout.defaultSize.w)
    assertEqual(n?.h, BoardLayout.defaultSize.h)
}

test("BoardLayout: quatro nós colocados nunca se sobrepõem") {
    var board = BoardLayout()
    for id in ["a", "b", "c", "d"] { board.place(id) }
    let nodes = Array(board.nodes.values)
    for i in 0..<nodes.count {
        for j in (i + 1)..<nodes.count {
            let a = nodes[i], b = nodes[j]
            let overlap = a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom
            assertFalse(overlap, "\(a.id) e \(b.id) se sobrepõem")
        }
    }
    // A grade tem 3 colunas — o quarto nó não cabe na primeira linha.
    assertTrue(board.nodes.values.contains { $0.y > 0 },
               "o quarto nó deveria cair na segunda linha")
}

test("BoardLayout: reconcile remove nó morto e o fio que o tocava, e cria o que falta") {
    var board = BoardLayout()
    board.place("a"); board.place("b")
    board.connect(from: "a", to: "b")
    board.reconcile(with: ["b", "c"])
    assertTrue(board.nodes["a"] == nil, "'a' deveria ter sido removido")
    assertTrue(board.nodes["b"] != nil, "'b' deveria continuar existindo")
    assertTrue(board.nodes["c"] != nil, "'c' deveria ter sido criado")
    assertTrue(board.edges.isEmpty, "o fio a→b deveria ter sido removido junto com 'a'")
}

test("BoardLayout: connect recusa self-loop, duplicata e nó inexistente, mas aceita ciclo") {
    var board = BoardLayout()
    board.place("a"); board.place("b")
    assertFalse(board.connect(from: "a", to: "a"), "self-loop deveria ser recusado")
    assertTrue(board.connect(from: "a", to: "b"), "primeira conexão a→b deveria ser aceita")
    assertFalse(board.connect(from: "a", to: "b"), "duplicata deveria ser recusada")
    assertFalse(board.connect(from: "a", to: "zz"), "nó inexistente deveria ser recusado")
    assertTrue(board.connect(from: "b", to: "a"), "ciclo b→a deveria ser aceito — CYCLES ARE ALLOWED")
}

test("BoardLayout: targets e sources leem o grafo dos dois lados") {
    var board = BoardLayout()
    board.place("a"); board.place("b"); board.place("c")
    board.connect(from: "a", to: "b")
    board.connect(from: "a", to: "c")
    assertEqual(Set(board.targets(of: "a")), Set(["b", "c"]))
    assertEqual(board.sources(of: "c"), ["a"])
    board.disconnect(BoardEdge(from: "a", to: "b"))
    assertEqual(board.targets(of: "a"), ["c"], "disconnect deveria ter removido a→b")
}

test("BoardLayout: resize respeita minSize e move desloca") {
    var board = BoardLayout()
    board.place("a")
    board.resize("a", dw: -10_000, dh: -10_000)
    let resized = board.nodes["a"]!
    assertEqual(resized.w, BoardLayout.minSize.w)
    assertEqual(resized.h, BoardLayout.minSize.h)
    board.move("a", dx: 15, dy: -5)
    let moved = board.nodes["a"]!
    assertEqual(moved.x, resized.x + 15)
    assertEqual(moved.y, resized.y - 5)
}

test("BoardLayout: nó focado desenha por último e é o que o hit-test acha") {
    var board = BoardLayout()
    board.place("a"); board.place("b")
    assertEqual(board.orderedNodes(focused: "a").last?.id, "a")
    // Sobrepõe os dois de propósito: só o foco decide quem o hit-test acha.
    board.move("a", dx: -board.nodes["a"]!.x, dy: -board.nodes["a"]!.y)
    board.move("b", dx: -board.nodes["b"]!.x, dy: -board.nodes["b"]!.y)
    let hit = board.node(at: 10, y: 10, focused: "a")
    assertEqual(hit?.id, "a", "o nó focado deveria vencer o hit-test quando sobreposto")
}

test("BoardLayout: contentBounds é nil vazio e inclui a margem com nós") {
    let empty = BoardLayout()
    assertTrue(empty.contentBounds() == nil, "board vazio deveria ter contentBounds nil")
    var board = BoardLayout()
    board.place("a")
    let bounds = board.contentBounds()!
    assertEqual(bounds.x, -60)
    assertEqual(bounds.y, -60)
    assertEqual(bounds.w, BoardLayout.defaultSize.w + 120)
    assertEqual(bounds.h, BoardLayout.defaultSize.h + 120)
}

test("BoardLayout: Codable faz round-trip de nós e fios") {
    var board = BoardLayout()
    board.place("a"); board.place("b")
    board.connect(from: "a", to: "b")
    let data = try JSONEncoder().encode(board)
    let decoded = try JSONDecoder().decode(BoardLayout.self, from: data)
    assertEqual(decoded, board)
}

test("ForgeMark: bigorna tem 14 pontos, todos no quadrado unitário") {
    assertEqual(ForgeMark.anvil.count, 14)
    for p in ForgeMark.anvil {
        assertTrue(p.x >= 0 && p.x <= 1, "x fora do quadrado unitário: \(p.x)")
        assertTrue(p.y >= 0 && p.y <= 1, "y fora do quadrado unitário: \(p.y)")
    }
}

test("ForgeMark: cabeça (8) e cabo (6) do Mjölnir estão no quadrado unitário e hammer é a concatenação") {
    assertEqual(ForgeMark.hammerHead.count, 8)
    assertEqual(ForgeMark.hammerHandle.count, 6)
    assertEqual(ForgeMark.hammer.count, 14)
    for p in ForgeMark.hammer {
        assertTrue(p.x >= 0 && p.x <= 1, "x fora do quadrado unitário: \(p.x)")
        assertTrue(p.y >= 0 && p.y <= 1, "y fora do quadrado unitário: \(p.y)")
    }
    for i in 0..<8 {
        assertEqual(ForgeMark.hammer[i].x, ForgeMark.hammerHead[i].x)
        assertEqual(ForgeMark.hammer[i].y, ForgeMark.hammerHead[i].y)
    }
}

test("ForgeMark: cabo toca a cabeça — o Mjölnir não é duas peças soltas") {
    let headMaxY = ForgeMark.hammerHead.map(\.y).max()!
    let headMinX = ForgeMark.hammerHead.map(\.x).min()!
    let headMaxX = ForgeMark.hammerHead.map(\.x).max()!
    let handleMinY = ForgeMark.hammerHandle.map(\.y).min()!
    assertLessOrEqual(handleMinY, headMaxY, "o cabo deveria tocar a cabeça")
    for p in ForgeMark.hammerHandle {
        assertTrue(p.x >= headMinX && p.x <= headMaxX, "x do cabo \(p.x) fora da largura da cabeça")
    }
}

test("ForgeMark: ponto de golpe está na face inferior da cabeça e a pegada dentro do cabo") {
    let headMinY = ForgeMark.hammerHead.map(\.y).min()!
    let headMinX = ForgeMark.hammerHead.map(\.x).min()!
    let headMaxX = ForgeMark.hammerHead.map(\.x).max()!
    assertLessOrEqual(abs(ForgeMark.hammerStrikePoint.y - headMinY), 1e-9)
    assertTrue(ForgeMark.hammerStrikePoint.x >= headMinX && ForgeMark.hammerStrikePoint.x <= headMaxX,
               "ponto de golpe fora da largura da cabeça")
    let handleMinX = ForgeMark.hammerHandle.map(\.x).min()!
    let handleMaxX = ForgeMark.hammerHandle.map(\.x).max()!
    let handleMinY = ForgeMark.hammerHandle.map(\.y).min()!
    let handleMaxY = ForgeMark.hammerHandle.map(\.y).max()!
    assertTrue(ForgeMark.hammerGrip.x >= handleMinX && ForgeMark.hammerGrip.x <= handleMaxX,
               "pegada fora da largura do cabo")
    assertTrue(ForgeMark.hammerGrip.y >= handleMinY && ForgeMark.hammerGrip.y <= handleMaxY,
               "pegada fora da altura do cabo")
}

test("ForgeMark: bigorna tem área não-nula e orientação horária (y-up)") {
    let pts = ForgeMark.anvil
    var area = 0.0
    for i in 0..<pts.count {
        let j = (i + 1) % pts.count
        area += pts[i].x * pts[j].y - pts[j].x * pts[i].y
    }
    area /= 2
    assertGreater(abs(area), 0.1)
    assertTrue(area < 0, "orientação deveria ser horária (área negativa) em y-up — 'clockwise from the horn tip'")
}

test("ForgeMark: constantes do ícone ficam em faixas sãs") {
    assertTrue(ForgeMark.glowCenter.x >= 0 && ForgeMark.glowCenter.x <= 1, "glowCenter.x fora do quadrado unitário")
    assertTrue(ForgeMark.glowCenter.y >= 0 && ForgeMark.glowCenter.y <= 1, "glowCenter.y fora do quadrado unitário")
    assertTrue(ForgeMark.glowRadius > 0 && ForgeMark.glowRadius < 1, "glowRadius fora da faixa sã")
    assertTrue(ForgeMark.plateInset > 0 && ForgeMark.plateInset < 0.5, "plateInset fora da faixa sã")
    assertTrue(ForgeMark.plateCornerRatio > 0 && ForgeMark.plateCornerRatio < 0.5, "plateCornerRatio fora da faixa sã")
}

// MARK: - Palette: piso de cobertura por caso (S01)

// T03 cobriu regra e forma de ForgeTone/ForgeEngine/SurfaceLevel; esta seção
// fecha o piso de contagem que a acceptance do slice exige (≥ 4 testes por
// tipo) sem tocar a seção acima — cada teste aqui verifica uma frase que a
// seção de T03 ainda não tinha fixado como dado executável.

test("ForgeTone: rawValue de cada caso é o próprio nome do caso, minúsculo") {
    // O harness e qualquer serialização futura dependem de rawValue == nome —
    // um rawValue custom quebraria round-trips silenciosamente em outro lugar.
    for t in ForgeTone.allCases {
        assertEqual(t.rawValue, String(describing: t))
    }
}

test("ForgeEngine: rawValue de claude, codex e agy bate com o nome do caso") {
    assertEqual(ForgeEngine.claude.rawValue, "claude")
    assertEqual(ForgeEngine.codex.rawValue, "codex")
    assertEqual(ForgeEngine.agy.rawValue, "agy")
    assertEqual(ForgeEngine.unknown.rawValue, "unknown")
}

test("SurfaceLevel: init(rawValue:) fora de 0...3 retorna nil") {
    // Os quatro níveis nomeados são o conjunto fechado — um rawValue fora
    // deles não deve produzir um nível inventado.
    assertNil(SurfaceLevel(rawValue: -1))
    assertNil(SurfaceLevel(rawValue: 4))
    assertTrue(SurfaceLevel(rawValue: 0) != nil, "rawValue 0 (ground) deveria existir")
    assertTrue(SurfaceLevel(rawValue: 3) != nil, "rawValue 3 (floating) deveria existir")
}

// MARK: - ForgeMark: cabeça em três polígonos e bandas (S02)

// A cabeça do Mjölnir sempre foi desenhada como se fosse três faixas
// horizontais — topo iluminado, corpo neutro, face de golpe em sombra — mas
// esse fato vivia só no código de render, nunca como dado. `ForgeMark` ganha
// `hammerHeadTop/Body/Face`: três polígonos de 4 pontos, construídos SÓ com
// vértices já presentes em `hammerHead` (nenhum ponto interpolado), de modo
// que a união dos três é o polígono original por construção — não por
// coincidência numérica, e é exatamente isso que os testes abaixo verificam
// sem depender de tela: vértice a vértice, aresta de costura a aresta de
// costura, bbox e área da soma.
//
// `hammerBands` e `hammerCollar` também são promovidos aqui. Antes eram
// overlays posicionados por `.offset(y:)` relativo ao FRAME do box da
// animação de abertura — e a aritmética medida no planning de S02 (o box é
// um quadrado de lado `side`, a cabeça ocupa só os 44% de baixo, `y
// 0.559·side … 1.0·side`) mostra que os offsets antigos caíam ACIMA da
// cabeça, então `.clipShape(head)` os apagava silenciosamente. Como
// geometria em `ForgeMark`, bandas e collar são posicionados pela MESMA
// transformação da cabeça (T02 os consome assim) — e as invariantes de
// posição (dentro da bbox da cabeça, dentro da faixa de y da faixa que os
// contém) ficam fixadas aqui, sem tela, como os outros testes desta suíte.
//
// `hammerHead` em si — o literal de 8 pontos — não muda uma vírgula: é o
// `bounds:` que `LaunchCurtain` usa via `hammer` (`hammerHead + hammerHandle`)
// para o `fit` de toda a animação, e os 6 testes de S01 acima seguem
// assertando `hammerHead.count == 8` e `hammer[i] == hammerHead[i]` sem
// edição.

/// Área com sinal de um polígono fechado (shoelace). Negativa = horário em
/// y-up, a mesma convenção de `ForgeMark.anvil`.
func shoelace(_ pts: [(x: Double, y: Double)]) -> Double {
    var area = 0.0
    let n = pts.count
    for i in 0..<n {
        let j = (i + 1) % n
        area += pts[i].x * pts[j].y - pts[j].x * pts[i].y
    }
    return area / 2
}

/// Caixa envolvente de uma lista de pontos.
func bbox(_ pts: [(x: Double, y: Double)]) -> (minX: Double, minY: Double, maxX: Double, maxY: Double) {
    let xs = pts.map(\.x)
    let ys = pts.map(\.y)
    return (xs.min()!, ys.min()!, xs.max()!, ys.max()!)
}

test("ForgeMark: os três polígonos da cabeça têm 4 pontos e ficam no quadrado unitário") {
    for poly in [ForgeMark.hammerHeadTop, ForgeMark.hammerHeadBody, ForgeMark.hammerHeadFace] {
        assertEqual(poly.count, 4)
        for p in poly {
            assertTrue(p.x >= 0 && p.x <= 1, "x fora do quadrado unitário: \(p.x)")
            assertTrue(p.y >= 0 && p.y <= 1, "y fora do quadrado unitário: \(p.y)")
        }
    }
}

test("ForgeMark: todo vértice dos três polígonos é vértice de hammerHead (nenhum interpolado)") {
    let head = ForgeMark.hammerHead
    for poly in [ForgeMark.hammerHeadTop, ForgeMark.hammerHeadBody, ForgeMark.hammerHeadFace] {
        for p in poly {
            let matches = head.contains { abs($0.x - p.x) < 1e-9 && abs($0.y - p.y) < 1e-9 }
            assertTrue(matches, "vértice (\(p.x), \(p.y)) não está em hammerHead")
        }
    }
}

test("ForgeMark: topo e corpo compartilham exatamente dois vértices (costura contínua)") {
    let shared = ForgeMark.hammerHeadTop.filter { top in
        ForgeMark.hammerHeadBody.contains { abs($0.x - top.x) < 1e-9 && abs($0.y - top.y) < 1e-9 }
    }
    assertEqual(shared.count, 2, "topo e corpo deveriam compartilhar exatamente 2 vértices")
}

test("ForgeMark: corpo e face compartilham exatamente dois vértices") {
    let shared = ForgeMark.hammerHeadBody.filter { body in
        ForgeMark.hammerHeadFace.contains { abs($0.x - body.x) < 1e-9 && abs($0.y - body.y) < 1e-9 }
    }
    assertEqual(shared.count, 2, "corpo e face deveriam compartilhar exatamente 2 vértices")
}

test("ForgeMark: a divisão é horizontal — top.minY == body.maxY e body.minY == face.maxY") {
    let top = bbox(ForgeMark.hammerHeadTop)
    let body = bbox(ForgeMark.hammerHeadBody)
    let face = bbox(ForgeMark.hammerHeadFace)
    assertLessOrEqual(abs(top.minY - body.maxY), 1e-9, "top.minY deveria coincidir com body.maxY")
    assertLessOrEqual(abs(body.minY - face.maxY), 1e-9, "body.minY deveria coincidir com face.maxY")
    assertLessOrEqual(abs(top.maxY - 0.445), 1e-9)
    assertLessOrEqual(abs(face.minY - 0.035), 1e-9)
}

test("ForgeMark: união dos três tem bbox idêntica à de hammerHead: (0.070, 0.035)–(0.930, 0.445)") {
    let union = ForgeMark.hammerHeadTop + ForgeMark.hammerHeadBody + ForgeMark.hammerHeadFace
    let unionBox = bbox(union)
    let headBox = bbox(ForgeMark.hammerHead)
    assertLessOrEqual(abs(unionBox.minX - 0.070), 1e-9)
    assertLessOrEqual(abs(unionBox.minY - 0.035), 1e-9)
    assertLessOrEqual(abs(unionBox.maxX - 0.930), 1e-9)
    assertLessOrEqual(abs(unionBox.maxY - 0.445), 1e-9)
    assertLessOrEqual(abs(unionBox.minX - headBox.minX), 1e-9)
    assertLessOrEqual(abs(unionBox.minY - headBox.minY), 1e-9)
    assertLessOrEqual(abs(unionBox.maxX - headBox.maxX), 1e-9)
    assertLessOrEqual(abs(unionBox.maxY - headBox.maxY), 1e-9)
}

test("ForgeMark: soma das áreas dos três == área de hammerHead (shoelace, 1e-9)") {
    let sum = shoelace(ForgeMark.hammerHeadTop) + shoelace(ForgeMark.hammerHeadBody) + shoelace(ForgeMark.hammerHeadFace)
    let headArea = shoelace(ForgeMark.hammerHead)
    assertLessOrEqual(abs(sum - headArea), 1e-9, "soma das áreas deveria bater com a área de hammerHead")
}

test("ForgeMark: os três polígonos são horários em y-up, como a bigorna") {
    assertTrue(shoelace(ForgeMark.hammerHeadTop) < 0, "top deveria ser horário (área negativa)")
    assertTrue(shoelace(ForgeMark.hammerHeadBody) < 0, "body deveria ser horário (área negativa)")
    assertTrue(shoelace(ForgeMark.hammerHeadFace) < 0, "face deveria ser horária (área negativa)")
    assertTrue(shoelace(ForgeMark.anvil) < 0, "anvil deveria ser horária (área negativa)")
}

test("ForgeMark: as duas bandas têm área > 0, cabem na bbox da cabeça e na faixa de y do corpo, e não se sobrepõem") {
    let headBox = bbox(ForgeMark.hammerHead)
    let bodyBox = bbox(ForgeMark.hammerHeadBody)
    for band in ForgeMark.hammerBands {
        assertGreater(band.w * band.h, 0.0, "banda deveria ter área positiva")
        assertTrue(band.x >= headBox.minX && band.x + band.w <= headBox.maxX, "banda fora da bbox da cabeça em x")
        assertTrue(band.y >= bodyBox.minY && band.y + band.h <= bodyBox.maxY, "banda fora da faixa de y do corpo")
    }
    let a = ForgeMark.hammerBands[0]
    let b = ForgeMark.hammerBands[1]
    let overlap = a.y < b.y + b.h && b.y < a.y + a.h
    assertFalse(overlap, "as duas bandas não deveriam se sobrepor")
}

test("ForgeMark: o collar tem área > 0 e cabe na faixa de y do topo e na bbox da cabeça") {
    let headBox = bbox(ForgeMark.hammerHead)
    let topBox = bbox(ForgeMark.hammerHeadTop)
    let collar = ForgeMark.hammerCollar
    assertGreater(collar.w * collar.h, 0.0, "collar deveria ter área positiva")
    assertTrue(collar.x >= headBox.minX && collar.x + collar.w <= headBox.maxX, "collar fora da bbox da cabeça em x")
    assertTrue(collar.y >= topBox.minY && collar.y + collar.h <= topBox.maxY, "collar fora da faixa de y do topo")
}

test("ForgeMark: o ponto de golpe está na aresta inferior da face de golpe") {
    let face = bbox(ForgeMark.hammerHeadFace)
    assertLessOrEqual(abs(ForgeMark.hammerStrikePoint.y - face.minY), 1e-9, "ponto de golpe deveria estar na aresta inferior da face")
    assertTrue(ForgeMark.hammerStrikePoint.x >= 0.135 && ForgeMark.hammerStrikePoint.x <= 0.865,
               "ponto de golpe fora da faixa de x da face de golpe")
}

// MARK: - BoardViewport: pan, clamp e fit sem tela (S02)
//
// A extração de T03: `BoardStore` (app target) ainda faz a própria conta —
// esta seção prova a matemática pura antes de T04 trocar `BoardStore` para
// delegar nela, sem mudar comportamento observável em `BoardView`.

test("BoardViewport: nasce identidade") {
    let v = BoardViewport()
    assertTrue(v.isIdentity)
    assertEqual(v.panX, 0.0)
    assertEqual(v.panY, 0.0)
    assertEqual(v.scale, 1.0)
}

test("BoardViewport: zoom(by:) satura em minScale e maxScale") {
    var up = BoardViewport()
    up.zoom(by: 100)
    assertEqual(up.scale, BoardViewport.maxScale)
    var down = BoardViewport()
    down.zoom(by: 0.001)
    assertEqual(down.scale, BoardViewport.minScale)
}

test("BoardViewport: scale(to:) aplica o mesmo clamp e reset volta à identidade") {
    var v = BoardViewport()
    v.scale(to: 100)
    assertEqual(v.scale, BoardViewport.maxScale)
    v.scale(to: 0.001)
    assertEqual(v.scale, BoardViewport.minScale)
    v.panX = 42
    v.panY = -7
    v.reset()
    assertTrue(v.isIdentity, "reset deveria voltar à identidade")
}

test("BoardViewport: fit reproduz a fórmula do BoardStore") {
    var v = BoardViewport()
    v.fit(content: (x: -60, y: -60, w: 640, h: 480), in: (w: 800, h: 600))
    // s = min(800/640, 600/480) = 1.25
    assertLessOrEqual(abs(v.scale - 1.25), 1e-9)
    // panX = -(-60)·1.25 + (800 - 640·1.25)/2 = 75 + 0 = 75
    assertLessOrEqual(abs(v.panX - 75.0), 1e-9)
    assertLessOrEqual(abs(v.panY - 75.0), 1e-9)
}

test("BoardViewport: fit com conteúdo nil é reset") {
    var v = BoardViewport(panX: 10, panY: 20, scale: 1.5)
    v.fit(content: nil, in: (w: 800, h: 600))
    assertTrue(v.isIdentity, "fit sem conteúdo deveria resetar a identidade")
}

test("BoardViewport: fit satura a escala em maxScale para conteúdo pequeno e minScale para gigante") {
    var small = BoardViewport()
    small.fit(content: (x: 0, y: 0, w: 10, h: 10), in: (w: 800, h: 600))
    assertEqual(small.scale, BoardViewport.maxScale)
    var huge = BoardViewport()
    huge.fit(content: (x: 0, y: 0, w: 10_000, h: 10_000), in: (w: 800, h: 600))
    assertEqual(huge.scale, BoardViewport.minScale)
}

test("BoardViewport: o resultado de fit é ponto fixo de clampedPan") {
    let cases: [((x: Double, y: Double, w: Double, h: Double), (w: Double, h: Double))] = [
        ((x: -60, y: -60, w: 640, h: 480), (w: 800, h: 600)),
        ((x: 0, y: 0, w: 10, h: 10), (w: 800, h: 600)),
        ((x: 0, y: 0, w: 10_000, h: 10_000), (w: 800, h: 600)),
    ]
    for (content, viewport) in cases {
        var v = BoardViewport()
        v.fit(content: content, in: viewport)
        let clamped = v.clampedPan(content: content, in: viewport)
        assertLessOrEqual(abs(clamped.x - v.panX), 1e-9, "fit não é ponto fixo do clamp em x")
        assertLessOrEqual(abs(clamped.y - v.panY), 1e-9, "fit não é ponto fixo do clamp em y")
    }
}

test("BoardViewport: pan(by:) acumula — dois scrolls somam") {
    var v = BoardViewport()
    let content = (x: 0.0, y: 0.0, w: 100.0, h: 100.0)
    let viewport = (w: 10_000.0, h: 10_000.0)
    v.pan(by: 10, 5, content: content, in: viewport)
    v.pan(by: 10, 5, content: content, in: viewport)
    assertLessOrEqual(abs(v.panX - 20.0), 1e-9)
    assertLessOrEqual(abs(v.panY - 10.0), 1e-9)
}

test("BoardViewport: pan(by:) para o vazio é puxado de volta até keepVisible pontos visíveis") {
    let content = (x: 0.0, y: 0.0, w: 100.0, h: 100.0)
    let viewport = (w: 800.0, h: 600.0)
    var right = BoardViewport()
    right.pan(by: 5000, 0, content: content, in: viewport)
    assertLessOrEqual(abs(right.panX - 720.0), 1e-9, "800 - keepVisible(80) = 720")
    var left = BoardViewport()
    left.pan(by: -5000, 0, content: content, in: viewport)
    assertLessOrEqual(abs(left.panX - (-20.0)), 1e-9, "keepVisible(80) - w(100) = -20")
}

test("BoardViewport: clamp com conteúdo nil não altera o pan") {
    let v = BoardViewport(panX: 123, panY: 456, scale: 1)
    let clamped = v.clampedPan(content: nil, in: (w: 800, h: 600))
    assertLessOrEqual(abs(clamped.x - 123.0), 1e-9)
    assertLessOrEqual(abs(clamped.y - 456.0), 1e-9)
}

test("BoardViewport: scrollDelta preciso passa direto e delta de linha multiplica por lineScrollFactor") {
    let precise = BoardViewport.scrollDelta(dx: 5, dy: 7, precise: true)
    assertLessOrEqual(abs(precise.x - 5.0), 1e-9)
    assertLessOrEqual(abs(precise.y - 7.0), 1e-9)
    let line = BoardViewport.scrollDelta(dx: 2, dy: 3, precise: false)
    assertLessOrEqual(abs(line.x - 20.0), 1e-9, "2 · lineScrollFactor(10) = 20")
    assertLessOrEqual(abs(line.y - 30.0), 1e-9, "3 · lineScrollFactor(10) = 30")
}

test("BoardViewport: canvasPoint desfaz scaleEffect(topLeading) + offset — (loc − pan) / scale") {
    let v = BoardViewport(panX: 75, panY: 75, scale: 1.25)
    let p = v.canvasPoint(fromScreen: 200, 137.5)
    assertLessOrEqual(abs(p.x - 100.0), 1e-9)
    assertLessOrEqual(abs(p.y - 50.0), 1e-9)
}

test("BoardViewport: setPan aplica um pan absoluto (arrasto) e clampa o resultado") {
    let content = (x: 0.0, y: 0.0, w: 100.0, h: 100.0)
    let viewport = (w: 800.0, h: 600.0)
    var inside = BoardViewport()
    inside.setPan(30, 40, content: content, in: viewport)
    assertLessOrEqual(abs(inside.panX - 30.0), 1e-9, "dentro do range legal, setPan não deveria mexer no valor")
    assertLessOrEqual(abs(inside.panY - 40.0), 1e-9)
    var outside = BoardViewport()
    outside.setPan(999_999, 0, content: content, in: viewport)
    assertLessOrEqual(abs(outside.panX - 720.0), 1e-9, "800 - keepVisible(80) = 720, mesmo clamp de pan(by:)")
}

test("BoardViewport: zoom(by:) acumula multiplicativamente antes de saturar") {
    var v = BoardViewport()
    v.zoom(by: 1.1)
    assertLessOrEqual(abs(v.scale - 1.1), 1e-9)
    v.zoom(by: 1.1)
    assertLessOrEqual(abs(v.scale - 1.21), 1e-9, "1.1 · 1.1 = 1.21, ainda abaixo de maxScale(1.6)")
}

// MARK: - Sessões vivas: agrupamento por cwd (S04)

test("Sessões: sessão com runId entra no grupo do seu cwd e ordena primeiro") {
    let withRun = SessionSnapshot(id: "a", cwd: "/repo/x", title: "a", runId: "run-1")
    let withoutRun = SessionSnapshot(id: "b", cwd: "/repo/x", title: "b")
    let groups = SessionOrganiser.groups([withoutRun, withRun], home: "/Users/x")
    assertEqual(groups.count, 1)
    assertEqual(groups[0].sessions.map(\.id), ["a", "b"], "com runId ordena primeiro dentro do grupo")
}

test("Sessões: sessão sem runId sobrevive ao agrupamento e ordena depois") {
    let withRun = SessionSnapshot(id: "a", cwd: "/repo/y", title: "a", runId: "run-2")
    let withoutRun = SessionSnapshot(id: "b", cwd: "/repo/y", title: "b")
    let groups = SessionOrganiser.groups([withRun, withoutRun], home: "/Users/x")
    assertEqual(groups.count, 1)
    assertEqual(groups[0].sessions.count, 2, "sessão sem runId não é descartada")
    assertEqual(groups[0].sessions.last?.id, "b")
}

test("Sessões: duas sessões no mesmo cwd dão UM grupo com 2 entradas, não dois grupos") {
    let s1 = SessionSnapshot(id: "a", cwd: "/repo/z", title: "a")
    let s2 = SessionSnapshot(id: "b", cwd: "/repo/z", title: "b")
    let groups = SessionOrganiser.groups([s1, s2], home: "/Users/x")
    assertEqual(groups.count, 1, "mesmo cwd nunca produz dois grupos")
    assertEqual(groups[0].sessions.count, 2)
}

test("Sessões: a saída é função do conjunto — entrada embaralhada dá a mesma ordem") {
    let s1 = SessionSnapshot(id: "a", cwd: "/repo/one", title: "a", runId: "run-a")
    let s2 = SessionSnapshot(id: "b", cwd: "/repo/two", title: "b")
    let s3 = SessionSnapshot(id: "c", cwd: "/repo/one", title: "c")
    let order1 = SessionOrganiser.groups([s1, s2, s3], home: "/Users/x").map { $0.sessions.map(\.id) }
    let order2 = SessionOrganiser.groups([s3, s1, s2], home: "/Users/x").map { $0.sessions.map(\.id) }
    assertEqual(order1, order2, "embaralhar a entrada não pode mudar a saída")
}

test("Sessões: grupos ordenam por nome de projeto, com path como desempate") {
    let s1 = SessionSnapshot(id: "a", cwd: "/repo-b/app", title: "a")
    let s2 = SessionSnapshot(id: "b", cwd: "/repo-a/app", title: "b")
    let groups = SessionOrganiser.groups([s1, s2], home: "/Users/x")
    assertEqual(groups.map(\.path), ["/repo-a/app", "/repo-b/app"], "mesmo lastPathComponent, path desempata")
}

test("Sessões: título do grupo é home-relativo (~/...)") {
    let s = SessionSnapshot(id: "a", cwd: "/Users/x/Development/forge-app", title: "a")
    let groups = SessionOrganiser.groups([s], home: "/Users/x")
    assertEqual(groups.first?.title, "~/Development/forge-app")
}

test("Sessões: lista vazia devolve zero grupos, não um grupo vazio") {
    let groups = SessionOrganiser.groups([], home: "/Users/x")
    assertEqual(groups.count, 0)
}

test("Sessões: runCount conta só as sessões com runId") {
    let s1 = SessionSnapshot(id: "a", cwd: "/repo/w", title: "a", runId: "run-1")
    let s2 = SessionSnapshot(id: "b", cwd: "/repo/w", title: "b")
    let s3 = SessionSnapshot(id: "c", cwd: "/repo/w", title: "c", runId: "run-2")
    let groups = SessionOrganiser.groups([s1, s2, s3], home: "/Users/x")
    assertEqual(groups.first?.runCount, 2)
}

// MARK: - WorkTree: runs sob o projeto do seu cwd (S04)

/// `Run` has no public memberwise init (only `Codable`'s synthesized decoder
/// is exposed) — per T02-PLAN, fixtures decode a JSON literal instead of
/// touching `Models.swift`, which is not in this task's `writes`. Optional
/// fields left out of the literal decode to `nil`.
private func workRun(id: String, cwd: String, active: Bool = true, started_at: Double = 0) -> Run {
    let json = """
    {"kind":"task","id":"\(id)","active":\(active),"started_at":\(started_at),"cwd":"\(cwd)"}
    """
    return try! JSONDecoder().decode(Run.self, from: Data(json.utf8))
}

private func findWorkNode(_ path: String, in nodes: [WorkNode]) -> WorkNode? {
    for node in nodes {
        if node.path == path { return node }
        if let hit = findWorkNode(path, in: node.children) { return hit }
    }
    return nil
}

test("WorkTree: 2 projetos + 3 runs devolvem exatamente 2 raízes e 3 filhos") {
    let projects = ["/repo/a", "/repo/b"]
    let runs = [
        workRun(id: "r1", cwd: "/repo/a", active: true, started_at: 100),
        workRun(id: "r2", cwd: "/repo/a", active: false, started_at: 50),
        workRun(id: "r3", cwd: "/repo/b", active: true, started_at: 10),
    ]
    let forest = WorkTree.build(projects: projects, runs: runs, roots: [], home: "/Users/x")
    assertEqual(forest.roots.count, 2, "2 projetos de topo, sem roots declarados → 2 raízes")
    let total = forest.roots.reduce(0) { $0 + $1.runs.count + $1.runCount }
    assertEqual(total, 3, "as 3 runs devem estar distribuídas na árvore, nenhuma perdida")
    assertTrue(forest.unowned.isEmpty, "todas as 3 runs têm dono — unowned deve ficar vazio")
}

test("WorkTree: run em subdiretório pertence ao projeto mais próximo, nunca ao avô") {
    let projects = ["/dev/mono", "/dev/mono/services/api"]
    let run = workRun(id: "r1", cwd: "/dev/mono/services/api/sub")
    let forest = WorkTree.build(projects: projects, runs: [run], roots: [], home: "/Users/x")
    let api = findWorkNode("/dev/mono/services/api", in: forest.roots)
    let mono = findWorkNode("/dev/mono", in: forest.roots)
    assertEqual(api?.runs.map(\.id), ["r1"], "a run deve pertencer ao projeto mais próximo (api)")
    assertEqual(mono?.runs.count, 0, "o avô (mono) não pode receber a run de um descendente mais próximo")
}

test("WorkTree: run sem projeto dono sai em unowned e não some") {
    let projects = ["/repo/a"]
    let run = workRun(id: "orphan", cwd: "/somewhere/else")
    let forest = WorkTree.build(projects: projects, runs: [run], roots: [], home: "/Users/x")
    assertEqual(forest.unowned.map(\.id), ["orphan"])
    let total = forest.roots.reduce(0) { $0 + $1.runs.count + $1.runCount }
    assertEqual(total, 0, "run órfã não pode ser contada em nenhum nó")
}

test("WorkTree: run com cwd idêntico ao projeto pertence a ele") {
    let projects = ["/repo/x"]
    let run = workRun(id: "r1", cwd: "/repo/x")
    let forest = WorkTree.build(projects: projects, runs: [run], roots: [], home: "/Users/x")
    let node = findWorkNode("/repo/x", in: forest.roots)
    assertEqual(node?.runs.map(\.id), ["r1"])
    assertTrue(forest.unowned.isEmpty)
}

test("WorkTree: pasta sintetizada nunca é dona de run") {
    let projects = ["/dev/proj"]
    let run = workRun(id: "r1", cwd: "/dev")
    let forest = WorkTree.build(projects: projects, runs: [run], roots: ["/dev"], home: "/Users/x")
    let folder = findWorkNode("/dev", in: forest.roots)
    assertEqual(folder?.role, .folder, "raiz declarada sem projeto próprio deve sintetizar folder")
    assertEqual(folder?.runs.count, 0, "folder nunca é dona de run, mesmo com cwd exatamente igual ao seu path")
    assertEqual(forest.unowned.map(\.id), ["r1"], "a run cai em unowned, não em silêncio")
}

test("WorkTree: runs de um nó ordenam active antes de inativa, depois started_at desc") {
    let projects = ["/repo/n"]
    let runs = [
        workRun(id: "b", cwd: "/repo/n", active: false, started_at: 200),
        workRun(id: "a", cwd: "/repo/n", active: true, started_at: 50),
        workRun(id: "c", cwd: "/repo/n", active: true, started_at: 150),
    ]
    let forest = WorkTree.build(projects: projects, runs: runs, roots: [], home: "/Users/x")
    let node = findWorkNode("/repo/n", in: forest.roots)
    assertEqual(node?.runs.map(\.id), ["c", "a", "b"], "ativas por started_at desc, depois inativas")
}

test("WorkTree: a saída é função do conjunto — runs embaralhadas dão a mesma ordem") {
    let projects = ["/repo/n"]
    let runs = [
        workRun(id: "b", cwd: "/repo/n", active: false, started_at: 200),
        workRun(id: "a", cwd: "/repo/n", active: true, started_at: 50),
        workRun(id: "c", cwd: "/repo/n", active: true, started_at: 150),
    ]
    let order1 = WorkTree.build(projects: projects, runs: runs, roots: [], home: "/Users/x")
    let order2 = WorkTree.build(projects: projects, runs: runs.reversed(), roots: [], home: "/Users/x")
    assertEqual(findWorkNode("/repo/n", in: order1.roots)?.runs.map(\.id),
                findWorkNode("/repo/n", in: order2.roots)?.runs.map(\.id),
                "embaralhar a entrada não pode mudar a saída")
}

test("WorkTree: runCount conta descendentes transitivamente") {
    let projects = ["/repo/p", "/repo/p/api"]
    let runs = [
        workRun(id: "r1", cwd: "/repo/p"),
        workRun(id: "r2", cwd: "/repo/p/api"),
        workRun(id: "r3", cwd: "/repo/p/api"),
    ]
    let forest = WorkTree.build(projects: projects, runs: runs, roots: [], home: "/Users/x")
    let p = findWorkNode("/repo/p", in: forest.roots)
    assertEqual(p?.runs.count, 1, "p só é dono direto da sua própria run")
    assertEqual(p?.runCount, 2, "runCount deve somar as 2 runs do descendente api")
}

test("WorkTree: sem projeto nenhum, roots é vazio e toda run é unowned") {
    let runs = [workRun(id: "r1", cwd: "/repo/a"), workRun(id: "r2", cwd: "/repo/b")]
    let forest = WorkTree.build(projects: [], runs: runs, roots: [], home: "/Users/x")
    assertTrue(forest.roots.isEmpty, "nenhum projeto registrado → nenhuma raiz")
    assertEqual(forest.unowned.count, 2, "sem projeto algum, toda run é unowned")
}

// MARK: - Review: turnos tipados a partir do artefato real (S05)
//
// `ReviewDoc`/`ReviewParser` (ForgeKit) provados contra cópias verbatim de
// dois `S##-REVIEW.md` reais deste repo — não um exemplo inventado. As
// contagens abaixo são medidas, não estimadas (S05-PLAN.md § Medido no
// planning): `review-dialectic.md` é `S01-REVIEW.md` (12 headings `### R`, 3
// bullets planos em Resolvidas → 15 objeções); `review-flags.md` é
// `S03-REVIEW.md` (1 objeção `### R1`, aberta, severidade "low").

/// Resolve um fixture de `app/fixtures/` por `#filePath` (mesmo padrão de
/// `labelParityFixtureURL()`), com fallback para o cwd. `nil` quando nenhum
/// dos dois existe — falha alta no chamador, nunca um teste verde silencioso.
func reviewFixtureURL(_ name: String) -> URL? {
    let fromSource = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // ForgeKitTests/
        .deletingLastPathComponent()   // Sources/
        .deletingLastPathComponent()   // app/
        .appendingPathComponent("fixtures/\(name)")
    if FileManager.default.fileExists(atPath: fromSource.path) { return fromSource }

    let fromCwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        .appendingPathComponent("fixtures/\(name)")
    if FileManager.default.fileExists(atPath: fromCwd.path) { return fromCwd }

    return nil
}

/// Candidatos a raiz do repo — via `#filePath` (compile-time, mais confiável)
/// e via cwd/cwd-pai (quando o teste roda de outro diretório). `.gsd/` não é
/// commitado neste repo (CLAUDE.md), então esta varredura é guarda adicional
/// sobre um artefato que pode não existir num checkout limpo — nunca o piso.
func candidateRepoRoots() -> [URL] {
    let fromSource = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // ForgeKitTests/
        .deletingLastPathComponent()   // Sources/
        .deletingLastPathComponent()   // app/
        .deletingLastPathComponent()   // repo root
    let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    return [fromSource, cwd, cwd.deletingLastPathComponent()]
}

func liveReviewArtifactURLs() -> [URL] {
    for root in candidateRepoRoots() {
        let milestonesDir = root.appendingPathComponent(".gsd/milestones")
        guard let enumerator = FileManager.default.enumerator(at: milestonesDir, includingPropertiesForKeys: nil) else {
            continue
        }
        var found: [URL] = []
        for case let url as URL in enumerator {
            if url.lastPathComponent.hasSuffix("-REVIEW.md") { found.append(url) }
        }
        if !found.isEmpty { return found }
    }
    return []
}

test("Review: fixture dialectic existe e parseia 15 objeções") {
    guard let url = reviewFixtureURL("review-dialectic.md") else {
        assertTrue(false, "fixture review-dialectic.md não encontrado — falha, não vácuo verde")
        return
    }
    let doc = ReviewParser.parse(try String(contentsOf: url, encoding: .utf8))
    assertEqual(doc.objections.count, 15, "review-dialectic.md (S01-REVIEW.md verbatim) deve conter 15 objeções")
}

test("Review: contagem por status na fixture dialectic — 1 open, 11 conceded, 3 resolved") {
    guard let url = reviewFixtureURL("review-dialectic.md") else {
        assertTrue(false, "fixture ausente")
        return
    }
    let doc = ReviewParser.parse(try String(contentsOf: url, encoding: .utf8))
    assertEqual(doc.objections(.open).count, 1, "1 objeção aberta (R8)")
    assertEqual(doc.objections(.conceded).count, 11, "11 objeções concedidas")
    assertEqual(doc.objections(.resolved).count, 3, "3 objeções resolvidas no debate")
}

test("Review: R8 (aberta) traz path, line e decisão não-nil") {
    guard let url = reviewFixtureURL("review-dialectic.md") else {
        assertTrue(false, "fixture ausente")
        return
    }
    let doc = ReviewParser.parse(try String(contentsOf: url, encoding: .utf8))
    let r8 = doc.objections.first { $0.id == "R8" }
    assertEqual(r8?.path, "app/Sources/Forge/RouteResolver.swift", "path de R8")
    assertEqual(r8?.line, 96, "line de R8")
    assertEqual(r8?.status, .open, "R8 deve estar aberta")
    assertFalse((r8?.decision ?? "").isEmpty, "R8 tem decisão registrada (deferido para triagem)")
}

test("Review: R2 (concedida) tem defense começando por \"conceded\" e correction citando um commit") {
    guard let url = reviewFixtureURL("review-dialectic.md") else {
        assertTrue(false, "fixture ausente")
        return
    }
    let doc = ReviewParser.parse(try String(contentsOf: url, encoding: .utf8))
    let r2 = doc.objections.first { $0.id == "R2" }
    assertTrue((r2?.defense ?? "").hasPrefix("conceded"), "defense de R2 deve começar por \"conceded\"")
    assertTrue((r2?.correction ?? "").contains("commit"), "correction de R2 deve citar um commit")
}

test("Review: seção Resolvidas — R1 vem por bullet plano, sem defense, um único turno challenger") {
    guard let url = reviewFixtureURL("review-dialectic.md") else {
        assertTrue(false, "fixture ausente")
        return
    }
    let doc = ReviewParser.parse(try String(contentsOf: url, encoding: .utf8))
    let r1 = doc.objections.first { $0.id == "R1" && $0.status == .resolved }
    assertNil(r1?.defense, "bullet plano não tem campo defense nomeado")
    assertEqual(r1?.turns.count, 1, "bullet plano tem um único turno")
    if let turn = r1?.turns.first, case .challenger = turn {
        // ok — único turno é do challenger
    } else {
        assertTrue(false, "o único turno de um bullet plano tem de ser .challenger")
    }
}

test("Review: fixture flags — 1 objeção, aberta, severidade \"low\"") {
    guard let url = reviewFixtureURL("review-flags.md") else {
        assertTrue(false, "fixture review-flags.md não encontrado")
        return
    }
    let doc = ReviewParser.parse(try String(contentsOf: url, encoding: .utf8))
    assertEqual(doc.objections.count, 1, "review-flags.md (S03-REVIEW.md verbatim) deve conter 1 objeção")
    assertEqual(doc.objections.first?.status, .open, "a única objeção está aberta")
    assertEqual(doc.objections.first?.severity, "low", "severidade da objeção")
}

test("Review: objeção multi-linha — corpo da fixture flags carrega texto da 2ª linha da continuação") {
    guard let url = reviewFixtureURL("review-flags.md") else {
        assertTrue(false, "fixture ausente")
        return
    }
    let doc = ReviewParser.parse(try String(contentsOf: url, encoding: .utf8))
    let body = doc.objections.first?.objection ?? ""
    assertTrue(body.contains("SurfaceLevel.raised.cornerRadius"),
               "o corpo deve carregar texto que só existe na 2ª linha da continuação indentada")
}

test("Review: seção \"## Nota sobre …\" não produz objeção") {
    guard let url = reviewFixtureURL("review-flags.md") else {
        assertTrue(false, "fixture ausente")
        return
    }
    let doc = ReviewParser.parse(try String(contentsOf: url, encoding: .utf8))
    assertEqual(doc.objections.count, 1,
                "a fixture flags tem uma seção \"## Nota sobre o que esta rodada NÃO é\" depois da objeção — ela não pode virar objeção nova")
}

test("Review: entrada vazia e entrada só com header não crasham e devolvem objections vazio") {
    let empty = ReviewParser.parse("")
    assertEqual(empty.objections.count, 0, "entrada vazia → 0 objeções")

    let onlyHeader = ReviewParser.parse("**Slice:** S99  **Milestone:** M-teste\n")
    assertEqual(onlyHeader.objections.count, 0, "entrada só com header → 0 objeções")
    assertEqual(onlyHeader.header.sliceId, "S99", "header ainda é lido mesmo sem seções")
}

test("Review: guarda live — todo *-REVIEW.md real do repo com item parseia com >= 1 objeção") {
    let urls = liveReviewArtifactURLs()
    if urls.isEmpty {
        print("      0 artefatos live — as fixtures carregam o piso")
        return
    }
    for url in urls {
        guard let content = try? String(contentsOf: url, encoding: .utf8) else { continue }
        let hasItems = content.range(of: "(?m)^### R", options: .regularExpression) != nil
            || content.range(of: "(?m)^- R[0-9]", options: .regularExpression) != nil
        guard hasItems else { continue }
        let doc = ReviewParser.parse(content)
        assertGreater(doc.objections.count, 0, "\(url.lastPathComponent) tem item mas o parse devolveu 0 objeções")
    }
}

// MARK: - Diff unificado: arquivos, hunks e contagem (S05)
//
// `UnifiedDiff.parse` (ForgeKit) provado contra `app/fixtures/diff-sample.diff`
// — o diff REAL do próprio repo entre `25bf293..69c7920` para `Design.swift`,
// `MetricsView.swift` e `TerminalsView.swift` — e contra o `git diff --numstat`
// pareado do mesmo range, medido no planning (S05-PLAN.md § Medido no
// planning, T02): 3 arquivos, 21 hunks, 284 linhas, numstat
// `Design.swift 49/3 · MetricsView.swift 10/10 · TerminalsView.swift 13/13`.
// Os pares entram literais no teste — não como uma segunda chamada de git em
// runtime — porque o parser é puro.

func diffSampleFixtureURL() -> URL? {
    let fromSource = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // ForgeKitTests/
        .deletingLastPathComponent()   // Sources/
        .deletingLastPathComponent()   // app/
        .appendingPathComponent("fixtures/diff-sample.diff")
    if FileManager.default.fileExists(atPath: fromSource.path) { return fromSource }

    let fromCwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        .appendingPathComponent("fixtures/diff-sample.diff")
    if FileManager.default.fileExists(atPath: fromCwd.path) { return fromCwd }

    return nil
}

test("UnifiedDiff: fixture diff-sample parseia 3 arquivos e 21 hunks") {
    guard let url = diffSampleFixtureURL() else {
        assertTrue(false, "fixture diff-sample.diff não encontrado — falha, não vácuo verde")
        return
    }
    let text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    let files = UnifiedDiff.parse(text)
    assertEqual(files.count, 3, "diff-sample.diff deve conter 3 arquivos")
    assertEqual(files.reduce(0) { $0 + $1.hunks.count }, 21, "diff-sample.diff deve conter 21 hunks no total")
}

test("UnifiedDiff: paridade exata com git diff --numstat, arquivo a arquivo") {
    guard let url = diffSampleFixtureURL() else {
        assertTrue(false, "fixture ausente")
        return
    }
    let text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    let files = UnifiedDiff.parse(text)
    // Medido no planning: git diff --numstat 25bf293..69c7920 -- <3 arquivos>
    let expected: [String: (added: Int, deleted: Int)] = [
        "Design.swift": (49, 3),
        "MetricsView.swift": (10, 10),
        "TerminalsView.swift": (13, 13),
    ]
    for file in files {
        let name = (file.displayPath as NSString).lastPathComponent
        guard let want = expected[name] else {
            assertTrue(false, "arquivo inesperado na fixture: \(file.displayPath)")
            continue
        }
        assertEqual(file.added, want.added, "\(name): added deve bater com --numstat")
        assertEqual(file.deleted, want.deleted, "\(name): deleted deve bater com --numstat")
    }
    assertEqual(Set(files.map { ($0.displayPath as NSString).lastPathComponent }), Set(expected.keys),
                "os 3 arquivos esperados devem estar todos presentes")
}

test("UnifiedDiff: cabeçalho de hunk lê old/new start/count e o texto após o segundo @@") {
    let text = """
    diff --git a/Sources/X.swift b/Sources/X.swift
    index 1111111..2222222 100644
    --- a/Sources/X.swift
    +++ b/Sources/X.swift
    @@ -313,6 +313,7 @@ enum ForgeIconSize {
     a
    +b
     c
    """
    let files = UnifiedDiff.parse(text)
    assertEqual(files.count, 1, "um arquivo")
    let hunk = files.first?.hunks.first
    assertEqual(hunk?.oldStart, 313, "oldStart")
    assertEqual(hunk?.oldCount, 6, "oldCount")
    assertEqual(hunk?.newStart, 313, "newStart")
    assertEqual(hunk?.newCount, 7, "newCount")
    assertEqual(hunk?.header, "enum ForgeIconSize {", "header é o texto após o segundo @@")
}

test("UnifiedDiff: @@ -1 +1 @@ com contagem omitida é lido como count 1") {
    let text = """
    diff --git a/f.swift b/f.swift
    index 1111111..2222222 100644
    --- a/f.swift
    +++ b/f.swift
    @@ -1 +1 @@
    -old
    +new
    """
    let files = UnifiedDiff.parse(text)
    let hunk = files.first?.hunks.first
    assertEqual(hunk?.oldCount, 1, "contagem omitida no lado antigo é 1, não nil nem 0")
    assertEqual(hunk?.newCount, 1, "contagem omitida no lado novo é 1, não nil nem 0")
}

test("UnifiedDiff: tipagem de linhas — sequência context/added/context, texto sem marcador de coluna 1") {
    let text = """
    diff --git a/Sources/X.swift b/Sources/X.swift
    index 1111111..2222222 100644
    --- a/Sources/X.swift
    +++ b/Sources/X.swift
    @@ -313,6 +313,7 @@ enum ForgeIconSize {
     a
    +b
     c
    """
    let files = UnifiedDiff.parse(text)
    let lines = files.first?.hunks.first?.lines ?? []
    assertEqual(lines, [.context("a"), .added("b"), .context("c")],
                "sequência tipada e texto sem o marcador de coluna 1")
}

test("UnifiedDiff: arquivo novo (--- /dev/null) tem oldPath /dev/null, displayPath == newPath, deleted 0") {
    let text = """
    diff --git a/new.swift b/new.swift
    new file mode 100644
    index 0000000..abc1234
    --- /dev/null
    +++ b/new.swift
    @@ -0,0 +1,2 @@
    +line1
    +line2
    """
    let files = UnifiedDiff.parse(text)
    let file = files.first
    assertEqual(file?.oldPath, "/dev/null", "arquivo novo: oldPath é /dev/null")
    assertEqual(file?.displayPath, file?.newPath, "displayPath é newPath quando o arquivo é novo")
    assertEqual(file?.deleted, 0, "arquivo novo não tem linha removida")
    assertEqual(file?.added, 2, "arquivo novo: 2 linhas adicionadas")
}

test("UnifiedDiff: rename devolve oldPath != newPath e isRename true") {
    let text = """
    diff --git a/old.swift b/renamed.swift
    similarity index 100%
    rename from old.swift
    rename to renamed.swift
    """
    let files = UnifiedDiff.parse(text)
    let file = files.first
    assertTrue(file?.isRename ?? false, "isRename deve ser true")
    assertEqual(file?.oldPath, "old.swift", "oldPath do rename")
    assertEqual(file?.newPath, "renamed.swift", "newPath do rename")
    assertTrue(file?.oldPath != file?.newPath, "rename: oldPath e newPath devem diferir")
}

test("UnifiedDiff: arquivo binário vira DiffFile isBinary true, hunks vazio, contagens 0") {
    let text = """
    diff --git a/x.png b/x.png
    index 1111111..2222222 100644
    Binary files a/x.png and b/x.png differ
    """
    let files = UnifiedDiff.parse(text)
    let file = files.first
    assertTrue(file?.isBinary ?? false, "isBinary deve ser true")
    assertTrue(file?.hunks.isEmpty ?? false, "binário não tem hunks")
    assertEqual(file?.added, 0, "binário: added 0")
    assertEqual(file?.deleted, 0, "binário: deleted 0")
}

test("UnifiedDiff: entrada vazia devolve [], diff truncado no meio de um hunk devolve o que leu sem crash") {
    let empty = UnifiedDiff.parse("")
    assertEqual(empty.count, 0, "entrada vazia → []")

    let truncated = """
    diff --git a/f.swift b/f.swift
    index 1111111..2222222 100644
    --- a/f.swift
    +++ b/f.swift
    @@ -1,3 +1,3 @@
     context1
    -removed1
    """
    let files = UnifiedDiff.parse(truncated)
    assertEqual(files.count, 1, "diff truncado ainda devolve o arquivo lido até onde deu")
    assertEqual(files.first?.hunks.first?.lines.count, 2, "hunk truncado devolve as linhas que leu, sem crash")
}

test("UnifiedDiff: +++/--- de cabeçalho nunca contam — 1 hunk com 1 adição tem added == 1, não 2") {
    let text = """
    diff --git a/f.swift b/f.swift
    index 1111111..2222222 100644
    --- a/f.swift
    +++ b/f.swift
    @@ -1,1 +1,2 @@
     context
    +added
    """
    let files = UnifiedDiff.parse(text)
    assertEqual(files.first?.added, 1, "added conta só a linha de conteúdo, não a linha +++ do cabeçalho")
}

// MARK: - Verification e File Audit: resultado por artefato (S05)
//
// `VerificationReport`/`FileAuditReport`/`SliceArtifacts` (ForgeKit) provados
// contra cópias verbatim de artefatos reais deste repo — não exemplos
// inventados. `verification-sample.md` é `S01-VERIFICATION.md` (8 linhas, 3
// tasks); `file-audit-with-unexpected.md` é a seção `## File Audit` de
// `S01-SUMMARY.md` (1 unexpected); `file-audit-clean.md` é a mesma seção de
// `S03-SUMMARY.md` (sem listas — auditoria limpa, não ausência de auditoria).

test("Verification: fixture verification-sample parseia 8 linhas, sources == {T01, T02, T03}") {
    guard let url = reviewFixtureURL("verification-sample.md") else {
        assertTrue(false, "fixture verification-sample.md não encontrado — falha, não vácuo verde")
        return
    }
    let report = VerificationReport.parse(try String(contentsOf: url, encoding: .utf8))
    assertEqual(report.rows.count, 8, "verification-sample.md (S01-VERIFICATION.md verbatim) deve conter 8 linhas")
    let sources = Set(report.rows.map { $0.source })
    assertEqual(sources, Set(["T01", "T02", "T03"]), "sources distintos da fixture")
}

test("Verification: toda linha da fixture tem exists == .pass e substantive == .pass; wired == .skipped") {
    guard let url = reviewFixtureURL("verification-sample.md") else {
        assertTrue(false, "fixture ausente")
        return
    }
    let report = VerificationReport.parse(try String(contentsOf: url, encoding: .utf8))
    for row in report.rows {
        assertEqual(row.exists, .pass, "\(row.path): exists deve ser .pass")
        assertEqual(row.substantive, .pass, "\(row.path): substantive deve ser .pass")
        assertEqual(row.wired, .skipped, "\(row.path): wired deve ser .skipped (non_js_ts)")
    }
}

test("Verification: a linha de T02 tem path DependencySmoke.swift e flag \"wired: non_js_ts\" sem crases") {
    guard let url = reviewFixtureURL("verification-sample.md") else {
        assertTrue(false, "fixture ausente")
        return
    }
    let report = VerificationReport.parse(try String(contentsOf: url, encoding: .utf8))
    let t02 = report.rows.first { $0.source == "T02" }
    assertEqual(t02?.path, "app/Sources/Forge/DependencySmoke.swift", "path da linha T02")
    assertEqual(t02?.flags, ["wired: non_js_ts"], "flags de T02, sem crases no valor")
}

test("Verification: ✗ numa tabela literal inline vira .fail e aparece em failures") {
    let text = """
    | Source | Artifact | Exists | Substantive | Wired | Flags |
    |--------|----------|--------|-------------|-------|-------|
    | T01 | app/x.swift | ✓ | ✗ | — | `stub` |
    """
    let report = VerificationReport.parse(text)
    assertEqual(report.rows.count, 1, "1 linha")
    assertEqual(report.rows.first?.substantive, .fail, "substantive deve ser .fail")
    assertEqual(report.failures.count, 1, "a linha com ✗ deve aparecer em failures")
}

test("Verification: tabela sem a coluna Wired (literal inline) → wired == .skipped, sem crash e sem .pass") {
    let text = """
    | Source | Artifact | Exists | Substantive | Flags |
    |--------|----------|--------|-------------|-------|
    | T01 | app/x.swift | ✓ | ✓ | `nenhuma` |
    """
    let report = VerificationReport.parse(text)
    assertEqual(report.rows.count, 1, "1 linha")
    assertEqual(report.rows.first?.wired, .skipped, "coluna Wired ausente deve virar .skipped, nunca .pass")
}

test("FileAudit: file-audit-with-unexpected → 1 unexpected == app/Sources/Forge/Prefs.swift, 0 missing, compared não-nil") {
    guard let url = reviewFixtureURL("file-audit-with-unexpected.md") else {
        assertTrue(false, "fixture file-audit-with-unexpected.md não encontrado")
        return
    }
    let text = try String(contentsOf: url, encoding: .utf8)
    guard let report = FileAuditReport.parse(text) else {
        assertTrue(false, "FileAuditReport.parse não deveria devolver nil para fixture com seção")
        return
    }
    assertEqual(report.unexpected, ["app/Sources/Forge/Prefs.swift"], "1 unexpected, só o caminho, sem o parêntese")
    assertEqual(report.missing.count, 0, "0 missing")
    assertFalse((report.compared ?? "").isEmpty, "compared não deve ser nil/vazio")
}

test("FileAudit: file-audit-clean → unexpected == [], missing == [], compared não-nil") {
    guard let url = reviewFixtureURL("file-audit-clean.md") else {
        assertTrue(false, "fixture file-audit-clean.md não encontrado")
        return
    }
    let text = try String(contentsOf: url, encoding: .utf8)
    guard let report = FileAuditReport.parse(text) else {
        assertTrue(false, "FileAuditReport.parse não deveria devolver nil para fixture com seção")
        return
    }
    assertEqual(report.unexpected, [], "auditoria limpa: unexpected vazio")
    assertEqual(report.missing, [], "auditoria limpa: missing vazio")
    assertFalse((report.compared ?? "").isEmpty, "compared não deve ser nil/vazio mesmo sem listas")
}

test("FileAudit: SUMMARY literal sem \"## File Audit\" → parse devolve nil, nunca relatório vazio") {
    let text = """
    # S99: exemplo

    ## Outra seção

    conteúdo qualquer, sem nada de file audit aqui.
    """
    let report = FileAuditReport.parse(text)
    assertNil(report, "ausência da seção deve devolver nil, não um relatório vazio indistinguível de auditoria limpa")
}

test("FileAudit: \"## File Audit\" seguida de \"## File Audit (cross-run)\" — lê a primeira, não vaza a segunda") {
    let text = """
    ## File Audit

    **Compared:** 2 paths. 1 unexpected, none missing.

    **Unexpected (changed but not promised):**
    - `app/Sources/Forge/A.swift` (comentário)

    ## File Audit (cross-run)

    **Compared:** 99 paths. 5 unexpected, none missing.

    **Unexpected (changed but not promised):**
    - `app/Sources/Forge/NAO-DEVE-APARECER.swift`
    """
    guard let report = FileAuditReport.parse(text) else {
        assertTrue(false, "seção presente, não deve devolver nil")
        return
    }
    assertEqual(report.unexpected, ["app/Sources/Forge/A.swift"], "só a primeira seção deve ser lida")
    assertFalse((report.compared ?? "").contains("99 paths"), "o conteúdo do cross-run não pode vazar para a primeira seção")
}

test("SliceArtifacts: paths compõe os 4 caminhos canônicos sob <milestoneDir>/slices/<slice>/") {
    let paths = SliceArtifacts.paths(milestoneDir: "/m", slice: "S05")
    assertEqual(paths.review, "/m/slices/S05/S05-REVIEW.md", "review")
    assertEqual(paths.verification, "/m/slices/S05/S05-VERIFICATION.md", "verification")
    assertEqual(paths.summary, "/m/slices/S05/S05-SUMMARY.md", "summary")
    assertEqual(paths.plan, "/m/slices/S05/S05-PLAN.md", "plan")
}

// MARK: - review-fix/S05: R1, R2, R6, R7, R9 conceded review items
//
// Each test below is a regression for exactly one item CONCEDED in
// `S05-REVIEW.md`'s dialectic — see the executor prompt for `review-fix/S05`.
// R3/R4 (SliceInspector.swift, in the `Forge` executable target) cannot be
// imported by this test target and are verified separately by `swift build`
// plus a grep, per the same prompt's instructions.

test("R9 — ReviewDoc Form B (flat bullet) consome continuações indentadas até a linha em branco") {
    guard let url = reviewFixtureURL("review-flat-multiline.md") else {
        assertTrue(false, "fixture review-flat-multiline.md não encontrado — falha, não vácuo verde")
        return
    }
    let doc = ReviewParser.parse(try String(contentsOf: url, encoding: .utf8))
    assertEqual(doc.objections.count, 2, "review-flat-multiline.md (S02-REVIEW.md verbatim) deve conter 2 objeções resolvidas, e nenhuma da seção \"## Nota…\" que a segue")

    let r1 = doc.objections.first { $0.id == "R1" }
    assertTrue((r1?.objection ?? "").contains("OffsetShape<Self>"),
               "R1: o corpo precisa carregar texto que só existe numa linha de continuação indentada")
    assertEqual(r1?.status, .resolved, "R1 está na seção Resolvidas no debate")

    let r2 = doc.objections.first { $0.id == "R2" }
    assertTrue((r2?.objection ?? "").contains("x157/x163"),
               "R2: o corpo precisa carregar texto da última linha de continuação, não só da primeira")
    assertEqual(r2?.path, "app/Sources/Forge/MetricsView.swift", "R2: path lido do bullet plano")
    assertEqual(r2?.line, 282, "R2: line lida do bullet plano")
}

test("R2 — VerificationReport.parse não crasha com coluna de cabeçalho duplicada; primeira ocorrência vence") {
    let text = """
    | Source | Artifact | Exists | Exists | Wired | Flags |
    |--------|----------|--------|--------|-------|-------|
    | T01 | app/x.swift | ✓ | ✗ | — | `stub` |
    """
    let report = VerificationReport.parse(text)
    assertEqual(report.rows.count, 1, "1 linha, sem crash na coluna Exists duplicada")
    assertEqual(report.rows.first?.exists, .pass, "primeira ocorrência de \"Exists\" (índice 2, valor ✓) deve vencer")
}

test("R1 — FileAuditReport reseta a lista corrente em qualquer outro rótulo em negrito, não vaza bullets não relacionados") {
    let text = """
    ## File Audit

    **Compared:** 2 paths. 0 unexpected, none missing.

    **Unexpected (changed but not promised):** None.

    **Missing (declared but not touched):** None.

    **Housekeeping commits (outside task writes):**
    - `abc123` — commit de limpeza
    - `def456` — outro commit

    ## Outra seção depois
    """
    guard let report = FileAuditReport.parse(text) else {
        assertTrue(false, "seção presente, não deve devolver nil")
        return
    }
    assertEqual(report.unexpected, [], "auditoria limpa: os bullets de Housekeeping não podem virar unexpected")
    assertEqual(report.missing, [], "auditoria limpa: os bullets de Housekeeping não podem virar missing")
}

test("R6 — UnifiedDiff: mudança só de modo (chmod) resolve path pelo header \"diff --git\", nunca /dev/null") {
    let text = """
    diff --git a/script.sh b/script.sh
    old mode 100644
    new mode 100755
    """
    let files = UnifiedDiff.parse(text)
    assertEqual(files.count, 1, "1 arquivo")
    let file = files.first
    assertEqual(file?.oldPath, "script.sh", "oldPath vem do header diff --git, não de /dev/null")
    assertEqual(file?.newPath, "script.sh", "newPath vem do header diff --git, não de /dev/null")
    assertEqual(file?.displayPath, "script.sh", "displayPath não pode ser /dev/null para um chmod puro")
    assertTrue(file?.hunks.isEmpty ?? false, "chmod puro não tem hunks")
}

test("R7 — UnifiedDiff: newline final do git diff não vira uma linha de contexto fantasma no último hunk") {
    let text = "diff --git a/f.swift b/f.swift\nindex 1111111..2222222 100644\n--- a/f.swift\n+++ b/f.swift\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n"
    let files = UnifiedDiff.parse(text)
    let lines = files.first?.hunks.first?.lines ?? []
    assertEqual(lines, [.context("a"), .removed("b"), .added("c")],
                "o \\n final do output não pode acrescentar um .context(\"\") fantasma")
}

// MARK: - Descritor de sessão: round-trip, load tolerante e retenção (S06)

print("\nSessionPersistence (SessionDescriptor + SessionStore)")

test("SessionDescriptor round-trip preserva os 5 campos preenchidos") {
    let d = SessionDescriptor(cwd: "/Users/x/repo", title: "repo", engine: "claude", account: "mwtelles", runId: "run-1")
    let data = try SessionStore.encode([d])
    let decoded = SessionStore.decode(data)
    assertEqual(decoded.count, 1, "1 descritor")
    assertEqual(decoded.first, d, "round-trip deve preservar todos os campos")
}

test("SessionDescriptor round-trip preserva nil em account e runId (não vira string vazia)") {
    let d = SessionDescriptor(cwd: "/Users/x/repo", title: "repo", engine: "codex")
    let data = try SessionStore.encode([d])
    let decoded = SessionStore.decode(data)
    assertEqual(decoded.count, 1, "1 descritor")
    assertNil(decoded.first?.account, "account deve continuar nil")
    assertNil(decoded.first?.runId, "runId deve continuar nil")
}

test("SessionStore.path(home:) monta <home>/.claude/forge-sessions.json") {
    assertEqual(SessionStore.filename, "forge-sessions.json")
    assertEqual(SessionStore.path(home: "/Users/synthetic"), "/Users/synthetic/.claude/forge-sessions.json",
                "nunca sob .gsd/, nunca por workspace")
}

test("SessionStore.load devolve [] para arquivo ausente, sem crash") {
    let tmp = NSTemporaryDirectory() + "forge-sessions-\(UUID().uuidString.prefix(8))"
    let path = tmp + "/forge-sessions.json"
    assertEqual(SessionStore.load(path: path), [], "arquivo ausente deve devolver [] sem lançar")
}

test("SessionStore.load devolve [] para bytes que não são JSON") {
    let tmp = NSTemporaryDirectory() + "forge-sessions-\(UUID().uuidString.prefix(8))"
    try? FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    let path = tmp + "/forge-sessions.json"
    try! Data("isto não é json {{{".utf8).write(to: URL(fileURLWithPath: path))
    assertEqual(SessionStore.load(path: path), [], "bytes lixo devem devolver [] sem lançar")
}

test("SessionStore.load devolve [] quando o JSON é válido mas o top-level não é array") {
    let tmp = NSTemporaryDirectory() + "forge-sessions-\(UUID().uuidString.prefix(8))"
    try? FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    let path = tmp + "/forge-sessions.json"
    try! Data("{\"cwd\": \"/x\"}".utf8).write(to: URL(fileURLWithPath: path))
    assertEqual(SessionStore.load(path: path), [], "top-level objeto (não array) deve devolver []")
}

test("SessionStore.decode elemento-a-elemento: 1 de 3 registros inválido não derruba os 2 válidos") {
    let good1 = SessionDescriptor(cwd: "/a", title: "a", engine: "claude")
    let good2 = SessionDescriptor(cwd: "/b", title: "b", engine: "codex")
    // Registro inválido: falta "cwd", que não é opcional em SessionDescriptor.
    let mixedJSON = """
    [
      {"cwd": "/a", "title": "a", "engine": "claude"},
      {"title": "sem cwd", "engine": "agy"},
      {"cwd": "/b", "title": "b", "engine": "codex"}
    ]
    """
    let decoded = SessionStore.decode(Data(mixedJSON.utf8))
    assertEqual(decoded.count, 2, "só os 2 registros válidos devem sobreviver")
    assertTrue(decoded.contains(good1), "registro válido /a deve estar presente")
    assertTrue(decoded.contains(good2), "registro válido /b deve estar presente")
}

test("SessionStore.save→load happy path: lista volta igual") {
    let tmp = NSTemporaryDirectory() + "forge-sessions-\(UUID().uuidString.prefix(8))"
    let path = tmp + "/forge-sessions.json"
    let descriptors = [
        SessionDescriptor(cwd: "/a", title: "a", engine: "claude", account: "mwtelles", runId: "run-1"),
        SessionDescriptor(cwd: "/b", title: "b", engine: "codex"),
    ]
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    SessionStore.save(descriptors, to: path)
    assertEqual(SessionStore.load(path: path), descriptors, "load subsequente deve devolver a lista igual")
}

test("SessionStore.save cria diretórios intermediários que faltarem") {
    let tmp = NSTemporaryDirectory() + "forge-sessions-\(UUID().uuidString.prefix(8))"
    let path = tmp + "/nested/deeper/forge-sessions.json"
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    assertFalse(FileManager.default.fileExists(atPath: tmp + "/nested"), "diretório não deve existir ainda")
    let descriptors = [SessionDescriptor(cwd: "/a", title: "a", engine: "claude")]
    SessionStore.save(descriptors, to: path)
    assertEqual(SessionStore.load(path: path), descriptors, "load do caminho recém-criado deve devolver a lista salva")
}

test("SessionStore.retained deduplica por cwd mantendo a primeira ocorrência (a mais recente)") {
    let recent = SessionDescriptor(cwd: "/a", title: "recente", engine: "claude")
    let stale = SessionDescriptor(cwd: "/a", title: "antiga", engine: "claude")
    let other = SessionDescriptor(cwd: "/b", title: "b", engine: "claude")
    let retained = SessionStore.retained([recent, stale, other])
    assertEqual(retained.count, 2, "cwd duplicado deve colapsar para 1")
    assertTrue(retained.contains(recent), "a primeira ocorrência (mais recente) deve sobreviver")
    assertFalse(retained.contains(stale), "a ocorrência antiga do mesmo cwd deve cair")
    assertTrue(retained.contains(other), "cwd distinto não deve ser afetado")
}

test("SessionStore.retained corta em limit default == 8") {
    let descriptors = (0..<12).map { SessionDescriptor(cwd: "/repo-\($0)", title: "t\($0)", engine: "claude") }
    let retained = SessionStore.retained(descriptors)
    assertEqual(retained.count, 8, "limit default deve ser 8")
    assertEqual(retained.map(\.cwd), descriptors.prefix(8).map(\.cwd), "deve manter os 8 primeiros, em ordem")
}

test("SessionStore.retained respeita limit explícito") {
    let descriptors = (0..<5).map { SessionDescriptor(cwd: "/repo-\($0)", title: "t\($0)", engine: "claude") }
    let retained = SessionStore.retained(descriptors, limit: 3)
    assertEqual(retained.count, 3, "limit explícito deve ser respeitado")
    assertEqual(retained.map(\.cwd), descriptors.prefix(3).map(\.cwd))
}

test("SessionStore.retained(live + restorable): resumir uma sessão não deve derrubar ofertas de outro cwd (R1, S06 review)") {
    // Reproduz a forma do merge que `AppState.persistSessions()` faz: o disco
    // tinha [A, B]; A é resumida (vira live), B permanece em `restorable` e
    // não pode desaparecer do save só porque A foi aberta.
    let a = SessionDescriptor(cwd: "/repo-a", title: "a", engine: "claude")
    let b = SessionDescriptor(cwd: "/repo-b", title: "b", engine: "claude")
    var restorable = [a, b]
    // resumeSession(a) consome `a` de `restorable`...
    restorable.removeAll { $0 == a }
    // ...e o descriptor recém-aberto entra como live, na frente (mais recente).
    let live = [SessionDescriptor(cwd: a.cwd, title: a.title, engine: a.engine)]
    let saved = SessionStore.retained(live + restorable)
    assertEqual(saved.count, 2, "A resumida e B ainda-não-resumida devem sobreviver ao save")
    assertTrue(saved.contains(where: { $0.cwd == "/repo-a" }), "A (agora live) deve sobreviver")
    assertTrue(saved.contains(where: { $0.cwd == "/repo-b" }), "B (ainda restorable) não deve ser perdida")
}

test("SessionStore.retained(live + restorable): live vence colisão de cwd contra restorable obsoleto") {
    // Mesmo cwd nos dois lados (o snapshot de `restorable` ficou desatualizado
    // em relação ao título/engine da sessão live) — live deve vencer porque é
    // passado primeiro, e `retained` mantém a primeira ocorrência.
    let staleRestorable = SessionDescriptor(cwd: "/repo-a", title: "antigo", engine: "claude")
    let freshLive = SessionDescriptor(cwd: "/repo-a", title: "novo", engine: "claude")
    let saved = SessionStore.retained([freshLive] + [staleRestorable])
    assertEqual(saved.count, 1, "mesmo cwd deve colapsar para 1")
    assertEqual(saved.first?.title, "novo", "a entrada live (mais recente) deve vencer sobre o snapshot restorable obsoleto")
}

// MARK: - Retomada de sessão: argv de --continue por engine (S06)
//
// `SessionResume.plan(for:)` é pura: recebe um `SessionDescriptor` (T01) e
// devolve um `SessionResumePlan?` sem tocar disco, ambiente ou processo. Os
// casos abaixo cobrem os quatro engines conhecidos (`claude`, `codex`,
// `agy`, raw desconhecido → `.unknown`), a ordem das flags quando há
// `account`, o tratamento de `account` em branco como ausência de escolha, e
// o par de asserts (positivo + negativo) sobre `cwd`: ele viaja como campo
// do plano e nunca como elemento de `argv` — um positional depois de
// `--continue` seria lido como prompt pela CLI, não como diretório.

print("\nSessionResume (SessionResumePlan + SessionResume.plan(for:))")

test("claude sem conta: argv exato") {
    let d = SessionDescriptor(cwd: "/Users/x/repo", title: "repo", engine: "claude")
    let plan = SessionResume.plan(for: d)
    assertEqual(plan?.argv, ["claude", "--continue"], "sem account, argv não deve carregar --account")
}

test("claude com conta: argv exato, --account antes de --continue") {
    let d = SessionDescriptor(cwd: "/Users/x/repo", title: "repo", engine: "claude", account: "mwtelles")
    let plan = SessionResume.plan(for: d)
    assertEqual(plan?.argv, ["claude", "--account", "mwtelles", "--continue"],
                "--account deve vir antes de --continue")
}

test("conta só com espaços não emite --account (string em branco não é uma escolha)") {
    let d = SessionDescriptor(cwd: "/Users/x/repo", title: "repo", engine: "claude", account: "   ")
    let plan = SessionResume.plan(for: d)
    assertEqual(plan?.argv, ["claude", "--continue"], "account só com espaços deve ser tratado como ausente")
}

test("cwd do plano é igual ao cwd do descritor, verbatim") {
    let d = SessionDescriptor(cwd: "/Users/x/repo-especial", title: "repo", engine: "claude")
    let plan = SessionResume.plan(for: d)
    assertEqual(plan?.cwd, "/Users/x/repo-especial", "cwd do plano deve ser exatamente o do descritor")
}

test("cwd nunca aparece dentro do argv (D5)") {
    let d = SessionDescriptor(cwd: "/Users/x/repo-especial", title: "repo", engine: "claude", account: "mwtelles")
    let plan = SessionResume.plan(for: d)
    assertFalse(plan?.argv.contains("/Users/x/repo-especial") ?? true,
                "cwd é campo próprio do plano, um positional depois de --continue seria lido como prompt")
}

test("engine codex devolve nil — nenhuma flag é adivinhada") {
    let d = SessionDescriptor(cwd: "/Users/x/repo", title: "repo", engine: "codex")
    assertNil(SessionResume.plan(for: d), "codex não tem --continue equivalente conhecido")
}

test("engine agy devolve nil — nenhuma flag é adivinhada") {
    let d = SessionDescriptor(cwd: "/Users/x/repo", title: "repo", engine: "agy")
    assertNil(SessionResume.plan(for: d), "agy não tem --continue equivalente conhecido")
}

test("engine raw desconhecido (\"gpt\") devolve nil") {
    let d = SessionDescriptor(cwd: "/Users/x/repo", title: "repo", engine: "gpt")
    assertNil(SessionResume.plan(for: d), "raw desconhecido resolve para ForgeEngine.unknown, sem palpite")
}

test("engine \"CLAUDE\" maiúsculo resolve para claude (plano válido)") {
    let d = SessionDescriptor(cwd: "/Users/x/repo", title: "repo", engine: "CLAUDE")
    let plan = SessionResume.plan(for: d)
    assertEqual(plan?.argv, ["claude", "--continue"], "ForgeEngine já lowercasa o raw antes de comparar")
}

test("argv de claude sempre começa em \"claude\", com ou sem account") {
    let semConta = SessionDescriptor(cwd: "/Users/x/repo", title: "repo", engine: "claude")
    let comConta = SessionDescriptor(cwd: "/Users/x/repo", title: "repo", engine: "claude", account: "mwtelles")
    assertEqual(SessionResume.plan(for: semConta)?.argv.first, "claude")
    assertEqual(SessionResume.plan(for: comConta)?.argv.first, "claude")
}

test("runId do descritor não influencia o plano de retomada") {
    let comRun = SessionDescriptor(cwd: "/Users/x/repo", title: "repo", engine: "claude", runId: "run-42")
    let semRun = SessionDescriptor(cwd: "/Users/x/repo", title: "repo", engine: "claude", runId: nil)
    assertEqual(SessionResume.plan(for: comRun), SessionResume.plan(for: semRun),
                "runId não é usado em argv ou cwd — o plano é igual com e sem ele")
}

// MARK: - Nome de conta: validador único (S07)

test("pattern é a tradução literal de NAME_RE (forge-accounts.js:77)") {
    assertEqual(AccountName.pattern, "^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$",
                "pattern precisa espelhar NAME_RE sem o flag i (classe já cobre as duas caixas)")
}

test("string vazia é rejeitada") {
    assertFalse(AccountName.isValid(""), "nome vazio nunca é válido")
}

test("espaço interno e nome só de espaços são rejeitados") {
    assertFalse(AccountName.isValid("mw telles"), "espaço interno não é caractere permitido")
    assertFalse(AccountName.isValid("   "), "nome só de espaços não é válido")
}

test("primeiro caractere não-alfanumérico é rejeitado") {
    assertFalse(AccountName.isValid(".mwtelles"), "começar com . é inválido")
    assertFalse(AccountName.isValid("_mwtelles"), "começar com _ é inválido")
    assertFalse(AccountName.isValid("-mwtelles"), "começar com - é inválido")
    assertFalse(AccountName.isValid("--dangerously-x"), "começar com -- é inválido")
}

test("32 caracteres é aceito, 33 é rejeitado") {
    let ok32 = String(repeating: "a", count: 32)
    let bad33 = String(repeating: "a", count: 33)
    assertTrue(AccountName.isValid(ok32), "32 caracteres é o limite superior aceito")
    assertFalse(AccountName.isValid(bad33), "33 caracteres excede o limite")
}

test("maiúsculas, dígitos, ponto, underscore e hífen depois do primeiro caractere são aceitos") {
    assertTrue(AccountName.isValid("Mw.Telles-01_x"), "classe de caracteres pós-primeiro cobre A-Z a-z 0-9 . _ -")
}

test("caracteres de shell são rejeitados (;, |, $, backtick, aspas, /, newline)") {
    for bad in ["a;b", "a|b", "a$b", "a`b", "a'b", "a\"b", "a/b"] {
        assertFalse(AccountName.isValid(bad), "'\(bad)' contém metacaractere de shell")
    }
}

test("nome iniciado por hífen é rejeitado mesmo parecendo uma flag (--dangerously-x.conta)") {
    // T01-SECURITY.md Blocker 1: um regex sem âncoras (^$) casaria isto em
    // qualquer posição via NSRegularExpression.firstMatch. AccountName não
    // usa NSRegularExpression — varre Character a Character — então este
    // caso não depende de âncora nenhuma para ser rejeitado.
    assertFalse(AccountName.isValid("--dangerously-x.conta"),
                "primeiro caractere '-' já reprova antes de qualquer outra checagem")
}

test("nome com quebra de linha embutida é rejeitado (ok\\n--flag)") {
    // T01-SECURITY.md Blocker 1: ICU $ (sem .anchorsMatchLines) casa antes de
    // uma quebra de linha final — um regex ingênuo "^...$" aceitaria
    // "validname\n". A varredura por Character rejeita \n como qualquer
    // outro caractere fora da classe permitida, embutido ou no fim.
    assertFalse(AccountName.isValid("ok\n--flag"), "quebra de linha embutida não é caractere permitido")
    assertFalse(AccountName.isValid("validname\n"), "quebra de linha final não deve ser aceita por um $ frouxo")
}

test("rejection(_:) devolve nil para nome válido") {
    assertNil(AccountName.rejection("mwtelles"), "nome válido não deve carregar razão de rejeição")
}

test("rejection(_:) devolve razão em pt-BR não-vazia para nome inválido") {
    let reason = AccountName.rejection("--dangerously-x.conta")
    assertTrue(reason != nil && !(reason!.isEmpty), "nome inválido precisa de uma razão legível")
}

print("\n" + String(repeating: "─", count: 60))
print("  \(passed) passed, \(failed) failed")
if failed > 0 {
    print("\nFalhas:")
    for f in failures { print("  ✗ \(f.0)\n      \(f.1)") }
}
print("")
exit(failed > 0 ? 1 : 0)
