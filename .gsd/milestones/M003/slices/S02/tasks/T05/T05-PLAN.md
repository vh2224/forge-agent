---
id: T05
slice: S02
milestone: M003
status: DONE
tag: docs
must_haves:
  truths:
    - "forge-agent-prefs.md gains a new `## File Audit Settings` section documenting the `file_audit:` block with `ignore_list:` default array"
    - "The default ignore_list contains exactly: package-lock.json, yarn.lock, pnpm-lock.yaml, dist/**, build/**, .next/**, .gsd/**"
    - "The section is placed between `## Evidence Settings` and `## Token Budget Settings` (natural topical grouping after evidence)"
    - "Section is explicitly marked as consumed by forge-completer sub-step 1.6 (T04 target)"
    - "Existing prefs structure (all other sections) preserved bit-for-bit — only ADDING the new section"
    - "`grep -n '^file_audit:' forge-agent-prefs.md` returns exactly one match"
    - "`grep -c 'ignore_list:' forge-agent-prefs.md` returns ≥ 1"
  artifacts:
    - path: "forge-agent-prefs.md"
      provides: "user-facing prefs template with file_audit.ignore_list default scaffolded (consumed in T04 by completer)"
      min_lines: 330
  key_links:
    - from: "forge-agent-prefs.md"
      to: "agents/forge-completer.md"
      via: "T04 consumer — completer sub-step 1.6 reads file_audit.ignore_list from merged prefs (same cascade as evidence.mode) to filter git diff AM set"
expected_output:
  - forge-agent-prefs.md
---

# T05: Add `file_audit.ignore_list` prefs default

**Slice:** S02  **Milestone:** M003

## Goal

Insert a new `## File Audit Settings` section in `forge-agent-prefs.md` with the `file_audit.ignore_list:` default array. The key is live-consumed by the completer in T04 (no inert period). Pure documentation-template edit — no code changes.

## Must-Haves

### Truths
- `forge-agent-prefs.md` gains a new `## File Audit Settings` section.
- `file_audit.ignore_list:` default contains: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `dist/**`, `build/**`, `.next/**`, `.gsd/**`.
- Placement: between `## Evidence Settings` and `## Token Budget Settings`.
- Explicitly documents that T04 (completer sub-step 1.6) reads this key.
- All other sections preserved bit-for-bit.
- `grep -n "^file_audit:" forge-agent-prefs.md` returns exactly 1 match.
- `grep -c "ignore_list:" forge-agent-prefs.md` returns ≥ 1.

### Artifacts
- `forge-agent-prefs.md` — updated prefs template. Current is 319 lines; min after edit is 330 lines (the new section is ~30–40 lines counting header + body + cross-refs).

### Key Links
- `forge-agent-prefs.md` → `agents/forge-completer.md` — sub-step 1.6 reads this block via inline node `-e` prefs cascade.

## Steps

1. Read `forge-agent-prefs.md` fully to confirm current section ordering. Current order (from inspection): `## Modelos` → `## Phase → Agent Routing` → `## Phase Skip Rules` → `## Dynamic Routing Overrides` → `## Effort Settings` → `## Thinking Settings` → `## Git Settings` → `## Artifact Cleanup` → `## Auto-mode Settings` → `## Retry Settings` → `## Tier Settings` → `## Verification Settings` → `## Evidence Settings` → `## Token Budget Settings` → `## Update Settings` → `## Notes`.

2. Insert the new `## File Audit Settings` section AFTER `## Evidence Settings` (ends around line 279 with `## Token Budget Settings` starting) and BEFORE `## Token Budget Settings`.

3. Section body (match the style of `## Evidence Settings` exactly — pt-BR intro, fenced config block, Semântica subsection, Cross-references subsection):
   ```markdown
   ## File Audit Settings

   Controla o filtro do file-audit (seção `## File Audit` em `S##-SUMMARY.md`) executado pelo `forge-completer` no fechamento de cada slice. O file-audit compara `git diff --name-only --diff-filter=AM` com a união dos `expected_output:` de todos os `T##-PLAN.md` — paths que batem com qualquer padrão em `ignore_list` são excluídos antes do diff (evita ruído de lockfiles e diretórios de build).

   ```
   file_audit:
     ignore_list:
       - "package-lock.json"
       - "yarn.lock"
       - "pnpm-lock.yaml"
       - "dist/**"
       - "build/**"
       - ".next/**"
       - ".gsd/**"
   ```

   ### Semântica

   - **Padrões suportados:** prefix exato (`package-lock.json`), prefix com wildcard (`dist/**` cobre qualquer path abaixo de `dist/`), e simples `*` como `[^/]*` dentro de um segmento. NÃO usa `minimatch` — parser hand-rolled, zero dependências externas.
   - **Aplicação:** tanto o conjunto AM quanto o conjunto `expected_output` são filtrados pelo mesmo matcher antes do diff. Isso garante que um `expected_output: [".gsd/milestones/..."]` também seja desconsiderado se o ignore list cobrir `.gsd/**`.
   - **Fallback silencioso:** se o bloco estiver ausente ou a chave `ignore_list` estiver vazia, o consumer usa o default hardcoded idêntico ao mostrado acima. Nenhum erro é levantado.
   - **Deleções não auditadas:** `--diff-filter=AM` cobre apenas additions e modifications (decisão M003 D4). Arquivos deletados não aparecem no audit independente do `ignore_list`.

   ### Cross-references

   - `agents/forge-completer.md` sub-step 1.6 — consumer do `file_audit.ignore_list`; escreve a seção `## File Audit` em `S##-SUMMARY.md`.
   - `scripts/forge-must-haves.js --check` — fornece a classificação legacy/valid usada pelo completer para decidir se o `expected_output` de um plano entra na união.
   - `.gsd/milestones/M003/slices/S02/tasks/T04/T04-PLAN.md` — tarefa que implementa o consumer.
   ```

4. Do NOT touch any other section. Insertion-only.

5. Verify:
   - `grep -n "^## File Audit Settings" forge-agent-prefs.md` → 1 match.
   - `grep -n "^file_audit:" forge-agent-prefs.md` → 1 match (inside the fenced block).
   - `grep -c "ignore_list:" forge-agent-prefs.md` → ≥ 1.
   - `grep -n "package-lock.json" forge-agent-prefs.md` → 1 match.
   - `grep -n "pnpm-lock.yaml" forge-agent-prefs.md` → 1 match.
   - Existing sections intact: `grep -c "^## Evidence Settings" forge-agent-prefs.md` == 1; `grep -c "^## Token Budget Settings" forge-agent-prefs.md` == 1.
   - `awk '/^```/{n++} END{print n}' forge-agent-prefs.md` returns an even number (balanced fences).

## Standards

- **Target directory:** repo root — `forge-agent-prefs.md`. User's actual prefs at `~/.claude/forge-agent-prefs.md` are untouched by this task (installer propagates template edits downstream).
- **Naming:** no new files.
- **Pattern:** pure Markdown insertion. Follow the exact style of `## Evidence Settings` (the section that landed in S01/T04 — same shape, same tone, same subsection structure: title → pt-BR intro → fenced block → Semântica → Cross-references).
- **Language:** pt-BR for user-facing prose (CODING-STANDARDS § Language — prefs are user-facing).
- **Lint:** no Markdown lint configured; verify balanced fences with `awk` per step 5.
- **Tier:** `tag: docs` frontmatter above — per `CLAUDE.md § Tier-only model routing`, this downgrades the executor to `light` (haiku). Documentation-only tasks qualify.

## Context

- **Prior decisions to respect:**
  - SCOPE C11 — `file_audit.ignore_list` prefs default is explicitly required by this milestone.
  - S01/T04 precedent — identical scaffolding approach for `## Evidence Settings`; T05 mirrors it for file_audit.
  - D4 — deletions not audited; `ignore_list` only affects AM paths.
- **Key files to read first:**
  - `forge-agent-prefs.md` lines 255–280 (existing `## Evidence Settings` block — style reference; same subsection structure).
  - `forge-agent-prefs.md` lines 280–306 (existing `## Token Budget Settings` block — insertion target boundary).
  - `.gsd/milestones/M003/slices/S01/tasks/T04/T04-PLAN.md` (S01 task that shipped `## Evidence Settings` — exact template for this task).
- **Why placement between Evidence and Token Budget:** evidence + file_audit are the two advisory-pipeline prefs added by M003; grouping them topically. Token Budget is unrelated (context management).
- **Not in scope:**
  - Implementing the ignore matcher — that's T04 (completer consumer).
  - Adding the prefs key elsewhere (install.sh template). The template file is the source of truth; installer copies it as-is.
- **Forward intelligence for T04:** T04 reads this exact key shape. If the YAML structure in step 3 is altered (e.g., changing `ignore_list:` to `ignore:`), T04's regex breaks. Keep the key name `file_audit.ignore_list` LOCKED.
