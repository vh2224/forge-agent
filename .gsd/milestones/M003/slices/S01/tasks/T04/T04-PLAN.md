---
id: T04
slice: S01
milestone: M003
status: DONE
must_haves:
  truths:
    - "forge-agent-prefs.md has a new `## Evidence Settings` section documenting the `evidence:` block with `mode: lenient` as default"
    - "The section documents the three modes (lenient/strict/disabled) with one-liner semantics, explicitly marked as INERT until S02 wires consumption"
    - "Existing prefs structure (version, Modelos, Phase → Agent Routing, Tier Settings, Verification Settings, Token Budget Settings, etc.) is preserved bit-for-bit — only ADDING a new section"
    - "The new section is placed between `## Verification Settings` and `## Token Budget Settings` (natural topical grouping)"
    - "`grep -n 'evidence:' forge-agent-prefs.md` returns exactly the new key"
  artifacts:
    - path: "forge-agent-prefs.md"
      provides: "user-facing prefs template with new evidence.mode default scaffolded (inert)"
      min_lines: 300
  key_links:
    - from: "forge-agent-prefs.md"
      to: "scripts/forge-hook.js"
      via: "S02 future consumer — evidence.mode: disabled skips hook writes, strict blocks, lenient flags"
expected_output:
  - forge-agent-prefs.md
---

# T04: Add `evidence.mode: lenient` prefs default (inert)

**Slice:** S01  **Milestone:** M003

## Goal

Scaffold the `evidence:` prefs block in `forge-agent-prefs.md` with `mode: lenient` as the default, plus documentation of the three modes and a note that the block is inert until S02 wires consumption. No code changes to hooks or agents — purely a prefs-template edit.

## Must-Haves

### Truths
- `forge-agent-prefs.md` gains a new `## Evidence Settings` section.
- The section documents the `evidence:` block with `mode: lenient` as default and describes `lenient`/`strict`/`disabled` semantics in one-liners.
- The section is explicitly marked **INERT until S02** so readers know it does nothing yet.
- Existing prefs structure is preserved bit-for-bit — only ADDING a new section.
- New section placement: between `## Verification Settings` and `## Token Budget Settings` (natural grouping).
- `grep -n "^evidence:" forge-agent-prefs.md` returns exactly one match after edit.

### Artifacts
- `forge-agent-prefs.md` — updated prefs template (≥ 300 lines total after edits).

### Key Links
- `forge-agent-prefs.md` → `scripts/forge-hook.js` via the future consumer relationship — S02 will read `evidence.mode` and alter PostToolUse write behavior (`disabled` skips, `strict` flags as blockers, `lenient` flags advisory).

## Steps

1. Read `forge-agent-prefs.md` fully to confirm section ordering. The current order (per Read) is:
   - `## Modelos disponíveis` → `## Phase → Agent Routing` → `## Phase Skip Rules` → `## Dynamic Routing Overrides` → `## Effort Settings` → `## Thinking Settings` → `## Git Settings` → `## Artifact Cleanup` → `## Auto-mode Settings` → `## Retry Settings` → `## Tier Settings` → `## Verification Settings` → `## Token Budget Settings` → `## Update Settings` → `## Notes`.
2. Insert new section `## Evidence Settings` AFTER `## Verification Settings` and BEFORE `## Token Budget Settings`.
3. Section body:
   ```markdown
   ## Evidence Settings

   Controla o comportamento do evidence log (PostToolUse) para verificação de claims nos summaries. Bloco **inerte até M003/S02** — nenhum código consome essas chaves ainda; documentadas aqui para que operadores possam pré-configurar antes de S02 entrar no ar.

   ```
   evidence:
     mode: lenient        # lenient | strict | disabled
                          # lenient  = escreve evidence-{unitId}.jsonl; mismatches viram "## Evidence Flags"
                          #            advisory em S##-SUMMARY.md (não bloqueia merge)
                          # strict   = mismatches viram blocker em complete-slice (ativa via M004+)
                          # disabled = hook pula escrita — nenhum evidence log gerado
   ```

   ### Semântica (referência — implementação em S02)

   - `lenient` (padrão seguro): gera o log, surfacia divergências como seção advisory no SUMMARY do slice. Forge-completer adiciona `## Evidence Flags` quando detecta claims sem contrapartida no log.
   - `strict`: mesma coleta; mismatches **bloqueiam** o fechamento do slice. Ativação prevista para M004+ após telemetria de falsos-positivos.
   - `disabled`: `scripts/forge-hook.js` PostToolUse branch pula a escrita do arquivo — zero overhead, zero log. Use em sessões de debug curtas ou em ambientes onde o disco está pressionado.

   ### Cross-references

   - `scripts/forge-hook.js` (S02) — consumer; PostToolUse branch lê essa pref antes de gravar `.gsd/forge/evidence-{unitId}.jsonl`.
   - `agents/forge-completer.md` (S02) — consumer em `complete-slice`; lê a pref para decidir entre flag advisory e blocker.
   - `.gsd/milestones/M003/slices/S02/S02-PLAN.md` — tarefa de consumo efetivo.
   ```
4. Do NOT modify any other section — just insertion.
5. Verify:
   - `grep -n "^## Evidence Settings" forge-agent-prefs.md` returns 1 match.
   - `grep -n "^evidence:" forge-agent-prefs.md` returns 1 match (inside the fenced block).
   - `grep -c "mode: lenient" forge-agent-prefs.md` returns ≥ 1.
   - Existing sections intact: `grep -c "^## Verification Settings" forge-agent-prefs.md` == 1; `grep -c "^## Token Budget Settings" forge-agent-prefs.md` == 1.
   - File parseable as Markdown — no broken fences. Confirm with `awk '/^```/ {n++} END {print n}' forge-agent-prefs.md` yields an even number (balanced fences).

## Standards

- **Target directory:** repo root — `forge-agent-prefs.md` is the template. User's actual prefs at `~/.claude/forge-agent-prefs.md` are NOT touched by this task.
- **Naming:** no new files.
- **Pattern:** pure Markdown insertion. Follow the style of existing sections: title, one-paragraph intro in pt-BR, fenced config block, optional Semântica subsection, optional Cross-references subsection.
- **Language:** pt-BR for user-facing prose (matches `## Verification Settings` and `## Token Budget Settings` style).
- **Lint:** no Markdown lint configured. Use the balanced-fence awk check in step 5.

## Context

- Prior decisions to respect: C11 (three prefs keys — `evidence.mode` here; `file_audit.ignore_list` + `plan_check.mode` come in S02/S04). SCOPE says default for `evidence.mode` is `lenient` — LOCKED.
- Key files to read first: `forge-agent-prefs.md` existing sections (especially `## Verification Settings` around line 212 and `## Token Budget Settings` around line 256) for style matching.
- This is purely scaffolding — NO code path consumes the key yet. S02 wires `scripts/forge-hook.js` to read it.
- Language convention (per CODING-STANDARDS § Language): user-facing messages and prefs prose = pt-BR; code + comments = English.
- AUTO-MEMORY relevance: none directly; but MEM004 (skill conventions) and MEM017 (no new deps) are respected by default since this task is prose-only.
