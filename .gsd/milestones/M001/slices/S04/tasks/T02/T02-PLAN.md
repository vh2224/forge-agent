# T02: README.md update for v1.0
status: DONE

**Slice:** S04  **Milestone:** M001

## Goal

Update README.md to reflect `/forge` as the primary entry point, update the commands table, and add architecture highlights for v1.0.

## Must-Haves

### Truths
- Quick start section shows `/forge` as the main command (not `/forge-auto`)
- Commands table lists `/forge` as the primary entry with description "Shell interativo — entry point principal"
- `/forge-auto`, `/forge-task`, `/forge-new-milestone` are listed as aliases/alternatives (not removed)
- Skills table includes `forge-security` (added after the README was last updated)
- No broken links or formatting issues

### Artifacts
- `README.md` — edited (modify Quick start, Commands table, and Skills table sections)

### Key Links
- `commands/forge.md` → new entry point (created in S03)
- `commands/forge-auto.md` → now a shim (modified in S03)

## Steps
1. Read full `README.md`
2. In Quick start section: replace the three-command example with a simpler flow using `/forge`
3. In Commands table: add `/forge` as the first row; keep existing commands but note `/forge-auto` delegates to `/forge`
4. In Skills table: add `forge-security` skill row
5. Verify all existing links still work (docs/architecture.md, docs/commands.md, etc.)
6. Do NOT change the Credits, License, or Atualizar sections

## Standards
- **Target directory:** repo root (README.md)
- **Naming:** keep existing Portuguese language for UI text
- **Lint command:** n/a

## Context
- README.md is 117 lines currently — keep it concise
- The architecture docs live in docs/architecture.md — do NOT duplicate detailed architecture here, just reference it
- The ROADMAP mentions adding an architecture diagram for PostCompact recovery — this is better suited for docs/architecture.md, not the README. Just mention the capability in the commands table or a brief note.
