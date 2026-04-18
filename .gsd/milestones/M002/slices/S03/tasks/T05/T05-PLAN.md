# T05: Add `token_budget:` prefs block + wire Budgeted Section Injection helper

**Slice:** S03  **Milestone:** M002

## Goal

Add a `token_budget:` configuration block to `forge-agent-prefs.md` with
defaults for optional-section caps (`auto_memory: 2000`,
`ledger_snapshot: 1500`, `coding_standards: 3000`) — values in tokens,
NOT chars. Document the two-layer semantics (tokens in prefs → × 4 to
get chars for `truncateAtSectionBoundary`) and the mandatory-section
contract (no cap — overflow surfaces as a `scope_exceeded` blocker).
Light edits to `shared/forge-dispatch.md` if the Budgeted Section
Injection subsection (added in T02) needs the prefs keys finalised or
a wording alignment. No dispatch-template changes — T02 already placed
the helper pseudocode; T05 only ensures prefs ship the defaults it
reads.

## Must-Haves

### Truths

- **Prefs block location:** New section `## Token Budget Settings`
  inserted into `forge-agent-prefs.md` AFTER the existing `## Verification Settings`
  section (around line 184 in the current file, before `## Update Settings`).
- **Block contents:**
  - Short prose paragraph explaining the purpose (pt-BR per rest of file).
  - Fenced YAML-ish block (matches existing `retry:` / `verification:` style):
    ```
    token_budget:
      auto_memory:       2000   # cap em tokens do snippet AUTO-MEMORY injetado em cada worker
      ledger_snapshot:   1500   # cap em tokens do snippet do LEDGER.md (quando injetado)
      coding_standards:  3000   # cap compartilhado entre CS_STRUCTURE e CS_RULES
    ```
  - A short `### Semântica` subsection with THREE bullet points:
    1. **Valores em tokens, não chars.** O orquestrador multiplica por 4 para chamar `truncateAtSectionBoundary` (cuja API é em chars).
    2. **Só aplica a seções OPCIONAIS.** `T##-PLAN`, `S##-CONTEXT`, `M###-SCOPE` são mandatórias — se excederem, o orquestrador levanta blocker `scope_exceeded`, não trunca silenciosamente.
    3. **Fallback silencioso.** Se o bloco estiver ausente ou uma chave faltar, o helper usa os defaults hardcoded (2000/1500/3000 tokens respectivamente).
  - A `### Observação sobre H2 boundary` subsection: menciona que a truncagem sempre termina numa linha de cabeçalho H2 (`## `), H3 (`### `), ou regra horizontal (`---` / `***`), preservando seções atômicas. Marker `[...truncated N sections]` documenta quantas seções foram dropadas.
  - Cross-references at the bottom:
    - `scripts/forge-tokens.js` — implementação de `countTokens` e `truncateAtSectionBoundary`.
    - `shared/forge-dispatch.md ### Token Telemetry` — contrato completo.
    - `skills/forge-status/SKILL.md` — relatório de consumo.
- **Consistency with S01 `retry:` block style:** mirror the prose+block+cross-reference structure of the existing `## Retry Settings` section (lines 118–140).
- **Consistency with S02 `verification:` block style:** mirror the ordered cross-references at the bottom.
- **Defaults match T02 pseudocode exactly:** T02 documented `auto_memory: 2000`, `ledger_snapshot: 1500`, `coding_standards: 3000`. If T02 shipped different numbers, T05 MUST match T02's ACTUALLY-written values. Confirm by reading `shared/forge-dispatch.md ### Token Telemetry` before writing prefs.
- **No edits to dispatch templates.** The `shared/forge-dispatch.md` Budgeted Section Injection helper (added by T02) already references the budget keys. T05 provides the defaults the helper falls back to. If T02's pseudocode has TODOs or placeholder values, T05 may do a ONE-LINE alignment edit to make the pseudocode consistent with the prefs block — but no new logic.
- **NO changes to:**
  - `scripts/forge-tokens.js` (T01 — frozen).
  - `skills/forge-auto/SKILL.md` or `skills/forge-next/SKILL.md` (T03 — frozen).
  - `skills/forge-status/SKILL.md` (T04 — frozen).
  - Any agent file.
  - `.gsd/STATE.md`, `.gsd/DECISIONS.md`, `.gsd/AUTO-MEMORY.md`, `.gsd/CODING-STANDARDS.md`.
- **Does NOT touch the T##-PLAN / S##-CONTEXT / M###-SCOPE mandatory-section enforcement code path** — those are template-side (T02) and raise via `truncateAtSectionBoundary({mandatory: true})`. T05's prefs prose documents the contract; implementation is already in T01's script and T02's pseudocode.
- **Language:** pt-BR for user-visible prose (matches `forge-agent-prefs.md` convention); English for code/key names.
- **Idempotent re-run:** grep for `token_budget:` before inserting; if present, exit 0 with note.

### Artifacts

- `forge-agent-prefs.md` — modified. Net add ~35–50 lines (new `## Token Budget Settings` section + cross-references).
- `shared/forge-dispatch.md` — **possibly** modified (1–3 line alignment edits only, if T02's pseudocode has placeholders that need final values). No new prose here.
- `.gsd/milestones/M002/slices/S03/tasks/T05/T05-SUMMARY.md` — new file with:
  - Diff summary for both files.
  - `grep "token_budget:" forge-agent-prefs.md` output.
  - `grep "PREFS.token_budget" shared/forge-dispatch.md` output (confirms T02's pseudocode references the block).
  - Validation: parse the new block with a small `node -e` snippet to confirm YAML-ish structure is read-friendly (project doesn't use a real YAML parser for prefs — just visual/regex parse — but confirm indentation is consistent with siblings).

### Key Links

- `forge-agent-prefs.md ## Token Budget Settings` (new) → read by the Budgeted Section Injection helper in `shared/forge-dispatch.md ### Token Telemetry` (T02).
- `forge-agent-prefs.md ## Retry Settings` (existing, S01) → style template.
- `forge-agent-prefs.md ## Verification Settings` (existing, S02) → style template.
- `scripts/forge-tokens.js` (T01) → implementation.

## Steps

1. Prereq check: confirm T01 and T02 are done.
   - `test -f scripts/forge-tokens.js && echo T01-OK || echo T01-MISSING`
   - `grep "### Token Telemetry" shared/forge-dispatch.md && echo T02-OK || echo T02-MISSING`
   - If either missing → return `blocked` with `blocker_class: external_dependency`.
2. Read `forge-agent-prefs.md` in full (currently ~198 lines). Identify:
   - Existing `## Retry Settings` (lines ~118–140) — style template.
   - Existing `## Verification Settings` (lines ~142–184) — style template.
   - Insertion point: between `## Verification Settings` and `## Update Settings` (around line 185).
   - Confirm no existing `token_budget` text (grep first — should be 0 hits).
3. Read `shared/forge-dispatch.md ### Token Telemetry → #### Budgeted Section Injection` (T02 output). Note the exact budget keys referenced in the pseudocode. Confirm they are `auto_memory`, `ledger_snapshot`, `coding_standards` as specified. If any differ, treat T02's version as authoritative and match T05's prefs to T02.
4. Draft the new `## Token Budget Settings` section:
   - Heading with `##`.
   - Prose paragraph (pt-BR): one paragraph explaining the block caps optional-section sizes to keep worker prompts bounded. Cite `scripts/forge-tokens.js` by name.
   - Fenced block with the three keys + defaults + pt-BR inline comments.
   - `### Semântica` subsection with the three bullets above.
   - `### Observação sobre H2 boundary` subsection with marker format.
   - Cross-references list at the bottom.
5. Insert via `Edit` tool immediately after `## Verification Settings` and before `## Update Settings`. Use a recognisable anchor: the line containing `- `scripts/forge-verify.js` — implementação completa`) just before the Update Settings header.
6. If T02's pseudocode has any placeholder values that need aligning (e.g., `PREFS.token_budget.plan_max ?? 8000` — this key is NOT in the T05 prefs block), adjust the T02 pseudocode to reflect reality:
   - Either remove the `plan_max` example (mandatory sections don't have a prefs key — the throw is unconditional), OR
   - Add a note in T02's pseudocode: `// Mandatory sections have no prefs key — the throw is unconditional per ## Token Budget Settings`.
   - Keep the edit to 1–3 lines.
7. Inline verification:
   - `grep "token_budget:" forge-agent-prefs.md` → 1 hit.
   - `grep "auto_memory:" forge-agent-prefs.md` → 1 hit.
   - `grep "ledger_snapshot:" forge-agent-prefs.md` → 1 hit.
   - `grep "coding_standards:" forge-agent-prefs.md` → 1 hit.
   - `grep "^## Token Budget Settings" forge-agent-prefs.md` → 1 hit.
   - `grep "scope_exceeded" forge-agent-prefs.md` → 1 hit (in the mandatory-section bullet).
   - Confirm file is still parseable markdown via `node -e "require('fs').readFileSync('forge-agent-prefs.md','utf8').length > 0"`.
8. Write `T05-SUMMARY.md` with diff summary + grep outputs + a one-line verdict.

## Standards

- **Target file:** `forge-agent-prefs.md` (project root) — matches convention for user-facing prefs template.
- **Reuse:**
  - Existing `## Retry Settings` section (S01 T05) — style template.
  - Existing `## Verification Settings` section (S02 T05) — style template.
  - Cross-reference list style at the bottom of `## Verification Settings` — mirror it for Token Budget.
  - Values from T02's Budgeted Section Injection subsection — must match exactly.
- **Naming:**
  - Section heading: `Token Budget Settings` (Title Case, matches surrounding `Retry Settings` / `Verification Settings`).
  - YAML key: `token_budget` (snake_case per existing `max_transient_retries`, `preference_commands`, `command_timeout_ms` convention).
  - Sub-keys: `auto_memory`, `ledger_snapshot`, `coding_standards` (snake_case; semantic names — not numeric identifiers).
  - Subsection headings: `Semântica`, `Observação sobre H2 boundary` — pt-BR (matches existing `Discovery chain`, `Allow-list`, `Timeout`, `Skip semantics`, `Security note`, `Cross-references` subsections in `## Verification Settings`; some English, some pt-BR — match the surrounding file convention).
- **Language:** pt-BR for prose (matches file convention); English for YAML keys and code references.
- **Markdown style:** match existing sections exactly — `##` heading, prose paragraph, fenced block without language tag (matches existing prefs blocks), `###` subsections, bullet lists, cross-references under a `### Cross-references` (optional).
- **Idempotency:** grep `token_budget:` before editing; if present, no-op.
- **Lint command:**
  - `grep -c "^## " forge-agent-prefs.md` — section count increased by exactly 1.
  - `grep "token_budget:" forge-agent-prefs.md` — 1 hit.
  - `node -e "require('fs').readFileSync('forge-agent-prefs.md','utf8')"` — file readable.
  - No markdown linter per CODING-STANDARDS.md.
- **Pattern:** follows the prefs-block pattern established by `## Retry Settings` and `## Verification Settings` — heading + prose + fenced block + subsections + cross-references. No new pattern invented.

## Context

- **T01/T02 dependencies:** script and dispatch section must be live. Prefs block is the LAST piece of the loop (defaults → helper → event → rendering).
- **Dependencies inverted from T04:** T05 does NOT depend on T04 (status rendering). T05 only ships the defaults the Budgeted Section helper (T02) reads. T04 and T05 are independent; both depend only on T01 and T02.
- **MEM018 budget:** `forge-agent-prefs.md` has no hard token budget (it's not a skill injected into workers whole; it's merged into PREFS). File-length check is cosmetic.
- **S04 boundary awareness:** S04 will add a `tier_models:` block to this same file. T05 should NOT preempt that — stick to `token_budget` only.
- **No new deps, no new scripts:** per M002-CONTEXT D1/D6. T05 is pure documentation.
- **Key files to read first:**
  - `forge-agent-prefs.md ## Retry Settings` (S01 style template)
  - `forge-agent-prefs.md ## Verification Settings` (S02 style template)
  - `shared/forge-dispatch.md ### Token Telemetry → #### Budgeted Section Injection` (T02 output — source of truth for budget keys)
  - `scripts/forge-tokens.js` (T01 — implementation cited in cross-references)
  - `.gsd/milestones/M002/M002-CONTEXT.md` D5 (mandatory vs optional contract)
