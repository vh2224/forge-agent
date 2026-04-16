---
id: T01
slice: S04
milestone: M002
status: DONE
---

# T01: Create `shared/forge-tiers.md` reference

**Slice:** S04  **Milestone:** M002

## Goal
Create a new canonical reference doc that locks the `unit_type → tier` mapping, the `tier → default_model` defaults, the override precedence rules, and the `tag: docs` downgrade semantics — a single source of truth consumed by the Tier Resolution block and any future telemetry report.

## Must-Haves

### Truths
- `shared/forge-tiers.md` exists at project root and parses as plain Markdown (no YAML frontmatter).
- File contains exactly three tables and one ordered-list section in this order: **Unit Type → Default Tier**, **Tier → Default Model**, **Frontmatter Overrides**, **Override Precedence**.
- Every unit_type present in the Forge dispatch table (`plan-milestone`, `plan-slice`, `discuss-milestone`, `discuss-slice`, `research-milestone`, `research-slice`, `execute-task`, `complete-slice`, `complete-milestone`, `memory-extract`) appears in the Unit Type → Tier table with exactly one assigned tier.
- The Tier → Default Model table uses the three model aliases already documented in `forge-agent-prefs.md` (`claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, `claude-opus-4-7[1m]`).
- Override Precedence section is a 3-item numbered list ordered highest-precedence first: (1) T##-PLAN frontmatter `tier:`, (2) T##-PLAN frontmatter `tag: docs` (downgrade to light), (3) unit_type default.
- File ends with a "Cross-references" section listing the four consumers: `forge-agent-prefs.md § Tier Settings`, `shared/forge-dispatch.md § Tier Resolution`, `skills/forge-auto/SKILL.md`, `skills/forge-next/SKILL.md`.

### Artifacts
- `shared/forge-tiers.md` — new reference doc (~80–130 lines, no code).

### Key Links
- `shared/forge-tiers.md` ← referenced by `shared/forge-dispatch.md ### Tier Resolution` (T02) via inline Markdown link.
- `shared/forge-tiers.md` ← referenced by `forge-agent-prefs.md ## Tier Settings` (T05).

## Steps
1. Read `forge-agent-prefs.md` lines 8–18 to confirm the three canonical model IDs and aliases.
2. Read `shared/forge-dispatch.md ### Retry Handler` (lines 289–446) to match the prose/heading style of existing `shared/forge-*.md` reference sections.
3. Draft `shared/forge-tiers.md` with sections in this order:
   - Title + 2-sentence intro paragraph ("Canonical reference for tier-based model routing. Consumed by `### Tier Resolution` in `shared/forge-dispatch.md`.").
   - `## Unit Type → Default Tier` table.
     - `memory-extract` → light
     - `complete-slice` → light
     - `complete-milestone` → light
     - `research-milestone` → standard
     - `research-slice` → standard
     - `discuss-milestone` → standard
     - `discuss-slice` → standard
     - `execute-task` → standard (default; can be downgraded or overridden)
     - `plan-milestone` → heavy
     - `plan-slice` → heavy
   - `## Tier → Default Model` table (3 rows: light=haiku, standard=sonnet, heavy=opus) with a column for "Intended workloads" and a column for "Operator override key" (`tier_models.light`, etc.).
   - `## Frontmatter Overrides` section: table describing the two T##-PLAN frontmatter fields `tag:` (string, with `docs` being the only value that triggers a tier change in M002) and `tier:` (enum: `light | standard | heavy`).
   - `## Override Precedence` section: 3-item numbered list (highest first).
   - `## Cross-references` section with 4 links.
4. Verify Markdown parses cleanly (table syntax is GitHub Flavored, no trailing whitespace in table rows).

## Standards
- **Target directory:** `shared/` — this is a reference doc consumed by multiple skills (matches "Directory Conventions" table row for `shared/`).
- **Reuse:** Follow the prose style and heading conventions of the existing sibling reference `shared/forge-dispatch.md` (see Asset Map "Dispatch template section" row). Do NOT import or duplicate its content.
- **Naming:** `forge-<topic>.md` prefix (MEM pattern: `forge-` prefix everywhere). Topic is `tiers`.
- **Lint command:** `node --check` does not apply (no JS). Manual verification: open the file and eyeball tables render in a Markdown preview; ensure no `---` lines appear immediately after the title (would be misparsed as frontmatter).
- **Pattern:** No direct catalog match — this is a brand-new reference doc with three tables. Closest precedent is `shared/forge-dispatch.md`'s section layout but this file is structurally simpler (no templates, no control-flow blocks).

## Context
- **M002-CONTEXT D3:** "Tier defaults: mapping `unit_type → tier` fica fixo em `shared/forge-tiers.md`. Usuário só sobrescreve `tier → model` via `tier_models:` nas prefs."
- **ROADMAP S04 boundary map:** "shared/forge-tiers.md (new) — canonical `unit_type → tier` table (light/standard/heavy) + `tier → default_model` table ... + documentation of manual override precedence (T##-PLAN `tier:` frontmatter > `tag: docs`-based downgrade > unit_type default). No Node code — pure reference doc."
- **GSD-2 reference (for mapping intuition only — do NOT port the code):** `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/complexity-classifier.js` lines 10–27 shows the `UNIT_TYPE_TIERS` table. Our Forge mapping diverges: GSD-2 puts `execute-task` as standard and `plan-*` as heavy, which matches ours. GSD-2 has `run-uat` and `replan-slice` that don't exist in Forge yet — omit them.
- **MEM004 (skills):** Does NOT apply here — this is not a skill file.
- **Frontmatter:** This file has NO frontmatter (reference docs under `shared/` are plain Markdown).
