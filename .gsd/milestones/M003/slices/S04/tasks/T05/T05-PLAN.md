---
id: T05
slice: S04
milestone: M003
tag: docs
title: "Add ## Anti-Hallucination Layer section to CLAUDE.md"
status: DONE
planned: 2026-04-18
must_haves:
  truths:
    - "`CLAUDE.md` gains a new top-level section `## Anti-Hallucination Layer (M003)` placed IMMEDIATELY BEFORE `## Estado atual` (the last existing section)."
    - "The section is ≥ 40 lines and ≤ 100 lines. Documents the 5 components, 3 artifact files, 3 prefs keys, and the advisory-by-default posture."
    - "All 5 components named: (1) structured must_haves schema, (2) executor schema validation, (3) evidence log via PostToolUse, (4) file-audit in completer, (5) goal-backward verifier, (6) plan-checker agent. (Enumerated as 5 or 6 per the final shipped topology — spec mentions 5 components but the plan-checker is commonly called the 5th or 6th; resolve during writing: the 5 components are [1] schema, [2] evidence log, [3] file-audit, [4] verifier, [5] plan-checker — executor validation is the enforcement mechanism for schema, not a separate component. LOCKED list of 5: `structured must_haves schema + executor validation`, `evidence log`, `file-audit`, `goal-backward verifier`, `plan-checker`.)"
    - "All 3 artifact files named with their paths: `.gsd/forge/evidence-{unitId}.jsonl`, `.gsd/milestones/{M###}/slices/{S##}/{S##}-VERIFICATION.md`, `.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-CHECK.md`."
    - "All 3 prefs keys named with their defaults: `evidence.mode: lenient`, `file_audit.ignore_list: [7 defaults]`, `plan_check.mode: advisory`."
    - "Advisory-by-default posture stated explicitly: only executor schema-validation is enforcing; evidence flags, file-audit, verifier, and plan-checker all ship as advisory."
    - "Section includes a short \"How to flip to strict/blocking\" subsection pointing users to the prefs keys (without recommending it for M003)."
    - "`grep -n \"Anti-Hallucination Layer\" CLAUDE.md` returns exactly one match (the new heading)."
    - "The existing `## Estado atual` section and all sections above are NOT modified — T05 is purely additive."
    - "The new section is indexed in CLAUDE.md's implicit TOC (the `## ` H2 heading ordering) and flows naturally between `## Forge Auto-Rules` and `## Estado atual`."
  artifacts:
    - path: CLAUDE.md
      provides: "New ## Anti-Hallucination Layer (M003) section documenting 5 components, 3 artifact files, 3 prefs keys, and advisory-by-default posture. Placed immediately before ## Estado atual."
      min_lines: 420
      stub_patterns: []
  key_links:
    - from: CLAUDE.md
      to: scripts/forge-must-haves.js
      via: "documentation reference — names the schema parser shipped in S01"
    - from: CLAUDE.md
      to: scripts/forge-verifier.js
      via: "documentation reference — names the goal-backward verifier shipped in S03"
    - from: CLAUDE.md
      to: agents/forge-plan-checker.md
      via: "documentation reference — names the plan-checker agent shipped in S04"
    - from: CLAUDE.md
      to: forge-agent-prefs.md
      via: "documentation reference — names the 3 prefs keys (evidence.mode, file_audit.ignore_list, plan_check.mode)"
expected_output:
  - CLAUDE.md
---

# T05: Add `## Anti-Hallucination Layer` section to CLAUDE.md

**Slice:** S04  **Milestone:** M003

## Goal

Add a `## Anti-Hallucination Layer (M003)` section to `CLAUDE.md` naming all 5 components shipped across M003/S01–S04, the 3 new artifact files, the 3 new prefs keys with defaults, and the advisory-by-default posture. Purely additive — no other changes to `CLAUDE.md`. This task is `tag: docs` so it routes to the `light` tier (haiku).

## Must-Haves

### Truths

- New `## Anti-Hallucination Layer (M003)` section inserted immediately before `## Estado atual`.
- Section ≥ 40 lines, ≤ 100 lines.
- 5 components named (LOCKED list): (1) structured `must_haves` schema + executor validation, (2) evidence log, (3) file-audit, (4) goal-backward verifier, (5) plan-checker agent.
- 3 artifact files named with paths: `.gsd/forge/evidence-{unitId}.jsonl`, `S##-VERIFICATION.md`, `S##-PLAN-CHECK.md`.
- 3 prefs keys with defaults: `evidence.mode: lenient`, `file_audit.ignore_list: [...]`, `plan_check.mode: advisory`.
- Advisory-by-default posture stated: only executor schema-validation is enforcing.
- "How to flip to strict/blocking" subsection points users to the prefs keys.
- `grep -n "Anti-Hallucination Layer" CLAUDE.md` returns exactly one match.
- `## Estado atual` and all prior sections unchanged.
- Final CLAUDE.md length ≥ 420 lines (currently ~390; +~40–60 lines expected).

### Artifacts

- `CLAUDE.md` — edited; new section added.

### Key Links

- `CLAUDE.md` → `scripts/forge-must-haves.js` (schema parser, S01).
- `CLAUDE.md` → `scripts/forge-verifier.js` (goal-backward verifier, S03).
- `CLAUDE.md` → `agents/forge-plan-checker.md` (plan-checker agent, S04).
- `CLAUDE.md` → `forge-agent-prefs.md` (3 prefs keys).

## Steps

1. **Read current `CLAUDE.md`** fully (or at least the last 60 lines covering `## Forge Auto-Rules` and `## Estado atual`). Confirm the insertion point — the blank line immediately after `## Forge Auto-Rules` content ends and BEFORE the `## Estado atual` heading begins.

2. **Read slice summaries to confirm component + file + pref inventories:**
   - `.gsd/milestones/M003/slices/S01/S01-SUMMARY.md` — schema + executor validation + `evidence.mode` pref.
   - `.gsd/milestones/M003/slices/S02/S02-SUMMARY.md` — evidence log + file-audit + `file_audit.ignore_list` pref.
   - `.gsd/milestones/M003/slices/S03/S03-SUMMARY.md` — goal-backward verifier.
   - `.gsd/milestones/M003/slices/S04/S04-PLAN.md` — plan-checker + `plan_check.mode` pref.

3. **Write the new section** between `## Forge Auto-Rules` and `## Estado atual`. Use this template (adjust counts/numbers as needed during writing):

   ```markdown
   ## Anti-Hallucination Layer (M003)

   Conjunto de 5 componentes que substituem "self-reported done" por verificação com evidência. Shipped ao longo de M003 (S01–S04). Quatro componentes são **advisory por padrão** (documentam flags em SUMMARY, não bloqueiam). Apenas o schema check do executor é enforcing desde o dia 1 — um schema que ninguém escreve é inútil.

   ### Componentes

   1. **Structured `must_haves` schema + executor validation (S01)** — todo `T##-PLAN.md` novo carrega um bloco YAML `must_haves: {truths, artifacts, key_links}` + `expected_output: [paths]` no frontmatter. Parser/validator: [`scripts/forge-must-haves.js`](scripts/forge-must-haves.js). Executor lê no step 1a; `valid: false` → block, `legacy: true` → warn. **Enforcing** — bloqueia tasks sem schema. Planner emite incondicionalmente.

   2. **Evidence log via PostToolUse hook (S02)** — cada chamada Bash/Write/Edit grava uma linha JSONL (≤512 bytes) em `.gsd/forge/evidence-{unitId}.jsonl`. Hook: [`scripts/forge-hook.js`](scripts/forge-hook.js) PostToolUse branch. `unitId` vem de `auto-mode.json`. Silent-fail (MEM008) — um erro no hook nunca aborta a tool call. Pref: `evidence.mode: lenient | strict | disabled` (default `lenient`).

   3. **File-audit em complete-slice (S02)** — `forge-completer` faz `git diff --name-only --diff-filter=AM` contra a união de `expected_output` de todas as tasks. Escreve `## File Audit` em `S##-SUMMARY.md` listando `unexpected` e `missing`. AM-only (D4) — deletions não são auditadas. Pref: `file_audit.ignore_list` (default: lockfiles + dist/build/.next/.gsd/**).

   4. **Goal-backward verifier 3-level (S03)** — [`scripts/forge-verifier.js`](scripts/forge-verifier.js) audita cada artefato declarado em `must_haves.artifacts[]` em três níveis: **Exists** (arquivo presente), **Substantive** (≥ `min_lines` linhas + nenhum `stub_patterns` regex casa), **Wired** (≥ 1 import/call em outro JS/TS do slice, depth-2 walker). Artefato: `S##-VERIFICATION.md` (advisory). `forge-completer` invoca no sub-step 1.8. Heurístico — regex + static import-chain scan. JS/TS only; non-JS artifacts emitem `wired: skipped`.

   5. **Plan-checker agent (S04)** — [`agents/forge-plan-checker.md`](agents/forge-plan-checker.md) é um agente Sonnet advisory que roda entre `plan-slice` e o primeiro `execute-task`. Pontua 10 dimensões estruturais (completeness, must_haves_wellformed, ordering, dependencies, risk_coverage, acceptance_observable, scope_alignment, decisions_honored, expected_output_realistic, legacy_schema_detect) com pass/warn/fail + justificativa de uma linha. Artefato: `S##-PLAN-CHECK.md`. Nunca bloqueia em modo `advisory`. Idempotente — se `S##-PLAN-CHECK.md` existe, skip.

   ### Artefatos gerados

   | Arquivo | Origem | Advisory | Cleanup |
   |---------|--------|----------|---------|
   | `.gsd/forge/evidence-{unitId}.jsonl` | S02 PostToolUse hook | sim (cross-ref em completer) | via `milestone_cleanup` (C12) |
   | `.gsd/milestones/{M###}/slices/{S##}/{S##}-VERIFICATION.md` | S03 verifier (escrito no complete-slice) | sim (never blocks) | junto com a milestone |
   | `.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-CHECK.md` | S04 plan-checker (escrito no gate) | sim em `advisory` (default) | junto com a milestone |

   ### Prefs keys

   ```
   evidence:
     mode: lenient           # lenient | strict | disabled   (default lenient)
   file_audit:
     ignore_list: [package-lock.json, yarn.lock, pnpm-lock.yaml, dist/**, build/**, .next/**, .gsd/**]
   plan_check:
     mode: advisory          # advisory | blocking | disabled   (default advisory)
   ```

   Todos scaffoldados em `forge-agent-prefs.md` e cascateados pela precedência padrão (user → repo → local, last wins).

   ### Postura advisory por padrão

   Somente o check de schema do executor (S01, componente #1) é enforcing em M003. Os outros quatro componentes emitem seções documentais em SUMMARY/VERIFICATION/PLAN-CHECK — nunca bloqueiam o loop. Isso é deliberado: permite que M003 ganhe cobertura sem thrash em falsos positivos enquanto as heurísticas (stub regex, import-chain depth, dimensões de plan-check) amadurecem com uso real.

   ### Como ativar modos stricter

   - `evidence.mode: strict` — reservado para M004+. Em M003 `strict` e `lenient` se comportam de forma idêntica no hook; a diferença no completer é futura.
   - `plan_check.mode: blocking` — ativa o revision-loop (max 3 rodadas, decremento monotônico em `fail`). Código já instalado em `skills/forge-auto/SKILL.md` + `skills/forge-next/SKILL.md`, inerte até o pref ser trocado.
   - `file_audit.ignore_list` — customize adicionando/removendo globs. Não muda a postura advisory — só o que é flagged.

   Antes de ativar qualquer um destes em um projeto de produção: rode ≥ 1 milestone completo em modo advisory para medir a taxa de falsos positivos das heurísticas (regex stub, depth-2 walker, dimension scoring). M003 explicitamente não recomenda flipping defaults em v1.
   ```

4. **Verify grep hit:**
   ```bash
   grep -n "Anti-Hallucination Layer" CLAUDE.md
   ```
   Expected: exactly one match (the new `## Anti-Hallucination Layer (M003)` heading).

5. **Verify structural integrity:**
   - `## Estado atual` section is still present and unchanged.
   - `## Forge Auto-Rules` section is unchanged.
   - The H2 heading order is: ... → `## Ao editar este projeto` → `## Forge Auto-Rules` → `## Anti-Hallucination Layer (M003)` → `## Estado atual`.

6. **Verify line count:** final CLAUDE.md length ≥ 420 lines.

7. **Verify Markdown renders:** no orphan code fences, table alignment clean, no missing `---` separators.

## Standards

- **Target file:** `CLAUDE.md` (repo root).
- **Reuse:**
  - `## Decisões de arquitetura recentes` existing section as a reference for the documentation voice (pt-BR, concise, with file references in backticks and Markdown links where applicable).
  - Slice SUMMARY files as fact sources — do not restate things that are not in S01/S02/S03 SUMMARY or S04-PLAN.
- **Naming:** section heading is EXACTLY `## Anti-Hallucination Layer (M003)` (the `(M003)` suffix anchors the section to the milestone so future M### layers have clear visual parallel).
- **Lint command:** none for `.md`. Manual grep + visual check.
- **Pattern:** this is a pure documentation task — no pattern-catalog entry directly applies. Closest analog: `CLAUDE.md § Decisões de arquitetura recentes` where milestone-level decisions are summarized durably.
- **Language:** pt-BR for the section body (consistent with existing CLAUDE.md sections). Key names, file paths, and pref values stay verbatim (English).
- **Tier:** `tag: docs` in the frontmatter downgrades this task to `light` tier (haiku) per the tier-routing rules in `forge-agent-prefs.md § Tier Settings`. Docs-only tasks do not need code generation.
- **Path handling:** file paths in the doc use relative paths from repo root (`scripts/...`, `agents/...`, `.gsd/...`) — NOT `{WORKING_DIR}` placeholders (CLAUDE.md is not a dispatch template).

## Context

- **Read first:**
  - `CLAUDE.md` lines 340–395 (last sections: `## Ao editar este projeto`, `## Forge Auto-Rules`, `## Estado atual`) — understand insertion point and voice.
  - `.gsd/milestones/M003/slices/S01/S01-SUMMARY.md` — 5-task summary for component #1.
  - `.gsd/milestones/M003/slices/S02/S02-SUMMARY.md` — 5-task summary for components #2 + #3.
  - `.gsd/milestones/M003/slices/S03/S03-SUMMARY.md` — 6-task summary for component #4.
  - `.gsd/milestones/M003/slices/S04/S04-PLAN.md` — 5-task plan for component #5 + acceptance criteria.
  - `forge-agent-prefs.md § Evidence Settings`, `§ File Audit Settings`, `§ Plan-Check Settings` (after T02 lands) — defaults for the 3 prefs keys.

- **Prior decisions to respect:**
  - SCOPE C14 — the CLAUDE.md section must name all 5 components, 3 artifact files, 3 prefs keys.
  - Advisory posture LOCKED across M003 — only executor step 1a blocks.
  - `(M003)` suffix in the heading — this is the first Anti-Hallucination layer; future milestones may add additive layers with their own `(M###)` suffix.
  - MEM068 — `CLAUDE.md` is not an agent, so no install propagation concern. The docs go live on the next commit / doc-browse.

- **What NOT to do:**
  - Do NOT modify `## Forge Auto-Rules` — memory auto-promotion maintains that section.
  - Do NOT modify `## Decisões de arquitetura recentes` — that's a long-running registry; adding M003 entries there is a SEPARATE concern handled by memory extraction after this milestone closes.
  - Do NOT modify `## Estado atual` — the orchestrator updates that field.
  - Do NOT rename the milestone or renumber anything. The section is purely additive.
  - Do NOT invent components or prefs that weren't shipped. Only reference: `scripts/forge-must-haves.js`, `scripts/forge-hook.js`, `scripts/forge-verifier.js`, `agents/forge-plan-checker.md`, `agents/forge-completer.md` (sub-steps 1.5/1.6/1.8), `agents/forge-executor.md` (step 1a, step 12a), `forge-agent-prefs.md § Evidence Settings / File Audit Settings / Plan-Check Settings`.
  - Do NOT create a new `.md` file — T05 is a single-file edit.
