---
id: T02
slice: S01
milestone: M003
status: DONE
must_haves:
  truths:
    - "agents/forge-planner.md has a new section titled `## Must-Haves Schema (required on every T##-PLAN)` documenting the locked schema shape"
    - "The planner's per-task emission template includes a YAML `must_haves:` block with truths/artifacts/key_links sub-keys AND a top-level `expected_output:` array — embedded verbatim in the planner's instructions"
    - "The planner instructions state UNCONDITIONALLY: every net-new T##-PLAN must emit the structured block — no conditional logic, no `if applicable`"
    - "Existing frontmatter fields (name, description, model, thinking, effort, tools) are preserved bit-for-bit"
    - "The pre-existing `## For slice planning` task-template block is updated so `## Must-Haves` human-readable section matches the new structured frontmatter (keep both; frontmatter is authoritative)"
  artifacts:
    - path: "agents/forge-planner.md"
      provides: "updated planner agent definition emitting structured must_haves schema unconditionally"
      min_lines: 90
  key_links:
    - from: "agents/forge-planner.md"
      to: "agents/forge-executor.md"
      via: "structured must_haves frontmatter contract — planner emits, executor validates"
    - from: "agents/forge-planner.md"
      to: "scripts/forge-must-haves.js"
      via: "schema shape is authoritative here; parser consumes it"
expected_output:
  - agents/forge-planner.md
---

# T02: Planner emits structured must_haves schema unconditionally

**Slice:** S01  **Milestone:** M003

## Goal

Update `agents/forge-planner.md` so every T##-PLAN it writes carries a structured `must_haves:` YAML block + a top-level `expected_output:` array in frontmatter — unconditionally, no branches — and document the schema inline in the planner instructions so future plans match the locked shape.

## Must-Haves

### Truths
- `agents/forge-planner.md` has a new `## Must-Haves Schema (required on every T##-PLAN)` section (or equivalent heading) documenting the locked schema.
- The per-task template embedded in the planner's instructions includes the `must_haves:` block + `expected_output:` array verbatim.
- The planner's instructions state UNCONDITIONALLY that every net-new T##-PLAN must emit the structured block.
- Existing frontmatter fields (`name`, `description`, `model`, `thinking`, `effort`, `tools`) are preserved bit-for-bit.
- The existing `## For slice planning` task-template markdown section is kept for human readability but annotated that **YAML frontmatter is authoritative**.

### Artifacts
- `agents/forge-planner.md` — updated agent definition (surgical edits; ≥ 90 lines total after edits).

### Key Links
- `agents/forge-planner.md` → `agents/forge-executor.md` via the shared `must_haves` frontmatter contract (planner writes, executor reads).
- `agents/forge-planner.md` → `scripts/forge-must-haves.js` via the schema shape (parser consumes what planner emits — same shape lives in both places, so any future shape change updates both).

## Steps

1. Read `agents/forge-planner.md` fully to identify the current task-template section (inside `## For slice planning`).
2. **Preserve frontmatter bit-for-bit.** Do NOT touch lines 1-8 (frontmatter + body-start).
3. Insert a new section AFTER `## For slice planning` (before `Then return the '---GSD-WORKER-RESULT---' block.`) titled `## Must-Haves Schema (required on every T##-PLAN)`.
4. In that section, embed the **exact** schema shape below as a fenced `yaml` code block, with the instruction that **every net-new T##-PLAN must include this block in its frontmatter with no branches**:
   ```yaml
   must_haves:
     truths:
       - "Observable outcome (used for verification)"
     artifacts:
       - path: "path/to/file.ts"
         provides: "one-line description of what this file exports/does"
         min_lines: 20
         stub_patterns: ["return null"]   # optional — per-artifact overrides
     key_links:
       - from: "path/a.ts"
         to: "path/b.ts"
         via: "import of functionX"
   expected_output:
     - path/to/file.ts
     - path/to/other.ts
   ```
5. Add a short paragraph explaining the contract:
   - `must_haves` is a **map** with exactly three keys: `truths`, `artifacts`, `key_links`.
   - `artifacts[].path` + `min_lines` + `provides` REQUIRED per entry; `stub_patterns` OPTIONAL.
   - `key_links[]` REQUIRES `from`, `to`, `via`.
   - `expected_output` is a **top-level sibling** of `must_haves` (not nested), a flat array of path strings.
   - **Unconditional** — emit the block on every net-new T##-PLAN, even when artifacts are minor. The executor blocks on absence.
6. In the existing per-task markdown template inside `## For slice planning`, add an annotation: *"YAML frontmatter `must_haves:` is authoritative — the human-readable `## Must-Haves` section mirrors it for readability but both must agree."*
7. Verify parseability:
   - `node --check` is not applicable to Markdown. Manually confirm the YAML example in the doc parses: run `node -e "const yaml = require('fs').readFileSync('agents/forge-planner.md','utf8'); const m = yaml.match(/\`\`\`yaml\n([\s\S]*?)\n\`\`\`/); console.log(m[1].split('\n').length, 'lines')"` or similar sanity check.
   - Grep for the required tokens: `grep -n "must_haves:" agents/forge-planner.md` returns ≥ 1; `grep -n "expected_output:" agents/forge-planner.md` returns ≥ 1.

## Standards

- **Target directory:** `agents/` (agent definitions).
- **Naming:** no new files. Edit `forge-planner.md` only.
- **Frontmatter:** preserve existing keys — `name`, `description`, `model`, `thinking`, `effort`, `tools`. Do NOT reorder, do NOT retype.
- **Pattern:** surgical edit — add section, do NOT rewrite existing sections. Keep the `## For milestone planning`, `## For slice planning`, and any other pre-existing sections untouched except for the single annotation in step 6.
- **Lint:** no Markdown lint configured; verify via `grep` checks in step 7.

## Context

- Prior decisions to respect: D3 (planner emits always), S01-PLAN schema shape (above — LOCKED).
- Key files to read first: `agents/forge-planner.md` (to locate insertion point), `.gsd/milestones/M003/slices/S01/S01-PLAN.md` § Schema Shape (authoritative shape reference).
- The executor (T03) reads exactly this schema — any shape change here cascades to T03 and T01.
- Do NOT invent new schema keys. The shape is LOCKED in CONTEXT D3 + SCOPE C1.
- AUTO-MEMORY note: MEM011 — dispatch templates / agent instructions use inline content for authoritative shapes (the schema is the contract).
