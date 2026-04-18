---
id: T01
slice: S04
milestone: M003
title: "Create agents/forge-plan-checker.md — Sonnet advisory plan-checker with 10 locked dimensions"
status: RUNNING
planned: 2026-04-18
must_haves:
  truths:
    - "`agents/forge-plan-checker.md` exists and begins with YAML frontmatter `name: forge-plan-checker`, `model: claude-sonnet-4-6`, `effort: low`, `tools: Read, Write, Grep, Glob` (no `Bash`, no `Agent`)."
    - "Agent body instructs the worker to read S##-PLAN.md, every T##-PLAN.md in the slice, M###-CONTEXT.md (read-if-exists), S##-CONTEXT.md (read-if-exists), and an injected `MUST_HAVES_CHECK_RESULTS` JSON block (one entry per T## produced by orchestrator shelling `node scripts/forge-must-haves.js --check`)."
    - "Agent scores exactly these 10 named dimensions (LOCKED, in this order): `completeness`, `must_haves_wellformed`, `ordering`, `dependencies`, `risk_coverage`, `acceptance_observable`, `scope_alignment`, `decisions_honored`, `expected_output_realistic`, `legacy_schema_detect`."
    - "Each dimension has a one-sentence rubric in the agent body plus pass/warn/fail triggers. Rubrics are structural predicates — not subjective."
    - "Agent writes `S##-PLAN-CHECK.md` at `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-CHECK.md` with: YAML frontmatter (id, milestone, slice, generated_at, mode), a dimension table (`| Dimension | Verdict | Justification |`), and a `## Summary` block with counts (`pass: N, warn: N, fail: N`)."
    - "Agent never writes STATE.md, never dispatches agents, never edits T##-PLAN.md or S##-PLAN.md."
    - "Agent returns `---GSD-WORKER-RESULT---` with `status: done` and a `plan_check_counts: {pass, warn, fail}` field so the orchestrator can read verdict totals without re-parsing the file."
    - "Legacy plans (plans with `legacy: true` in the MUST_HAVES_CHECK_RESULTS entry) score `warn` on `must_haves_wellformed` — never `fail` — AND score `warn` on `legacy_schema_detect` with justification naming the legacy T## IDs. C13 honored."
  artifacts:
    - path: agents/forge-plan-checker.md
      provides: "Sonnet advisory plan-checker agent definition. Reads slice + task plans and injected MUST_HAVES_CHECK_RESULTS; scores 10 locked dimensions; writes S##-PLAN-CHECK.md; returns plan_check_counts in worker result."
      min_lines: 220
      stub_patterns: ["return null", "TODO", "FIXME"]
  key_links:
    - from: agents/forge-plan-checker.md
      to: scripts/forge-must-haves.js
      via: "consumption of the injected MUST_HAVES_CHECK_RESULTS JSON block (produced by orchestrator running the CLI on each T##-PLAN.md)"
    - from: agents/forge-plan-checker.md
      to: .gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-CHECK.md
      via: "Write tool — creates the per-slice plan-check artifact"
expected_output:
  - agents/forge-plan-checker.md
---

# T01: Create agents/forge-plan-checker.md — Sonnet advisory plan-checker

**Slice:** S04  **Milestone:** M003

## Goal

Create the `agents/forge-plan-checker.md` file — a Sonnet agent that scores a slice plan across 10 locked structural dimensions and writes `S##-PLAN-CHECK.md`. Read-only inputs, never modifies plans or STATE.md. This task creates the agent definition; T03 wires it into dispatch, T04 wires the revision loop.

## Must-Haves

### Truths

- `agents/forge-plan-checker.md` exists with frontmatter: `name: forge-plan-checker`, `description: ...`, `model: claude-sonnet-4-6`, `effort: low`, `tools: Read, Write, Grep, Glob`.
- Agent body instructs reading: `S##-PLAN.md`, every `T##-PLAN.md` in the slice (via `Glob`), `M###-CONTEXT.md` (read-if-exists), `S##-CONTEXT.md` (read-if-exists), and parsing the injected `MUST_HAVES_CHECK_RESULTS` JSON block.
- Scores the 10 LOCKED dimensions in order: `completeness`, `must_haves_wellformed`, `ordering`, `dependencies`, `risk_coverage`, `acceptance_observable`, `scope_alignment`, `decisions_honored`, `expected_output_realistic`, `legacy_schema_detect`.
- Each dimension has a one-line rubric + pass/warn/fail triggers documented in the agent body.
- Writes `S##-PLAN-CHECK.md` at `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/` with YAML frontmatter, a dimension table, and a `## Summary` counts block.
- Never writes STATE.md, never calls `Agent()`, never edits plans.
- Returns `---GSD-WORKER-RESULT---` with `status: done` and `plan_check_counts: {pass, warn, fail}`.
- Legacy plans: `warn` on `must_haves_wellformed` AND `warn` on `legacy_schema_detect` (never `fail`). C13 honored.

### Artifacts

- `agents/forge-plan-checker.md` — new file. ≥ 220 lines. Stub patterns forbidden: `return null`, `TODO`, `FIXME`.

### Key Links

- `agents/forge-plan-checker.md` → `scripts/forge-must-haves.js` via the injected `MUST_HAVES_CHECK_RESULTS` block (orchestrator shells `--check`, inlines JSON; agent consumes).
- `agents/forge-plan-checker.md` → `.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-CHECK.md` via the `Write` tool.

## Steps

1. **Read these files first** (understand agent conventions):
   - `agents/forge-planner.md` (lines 1–60) — Opus planner; note frontmatter shape (`thinking: adaptive`, `effort: medium`, tool list).
   - `agents/forge-executor.md` (lines 1–40) — Sonnet executor; note `effort: low`, `tools: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch`.
   - `agents/forge-memory.md` (lines 1–30) — Haiku agent; clean and minimal.
   - `agents/forge-completer.md` (lines 1–80) — Sonnet completer; note sub-step decimal-suffix insertion patterns and `## Constraints` section style.
   - `scripts/forge-must-haves.js` CLI output contract (from S01-SUMMARY): exit 0 (legacy), 0 (valid), 2 (malformed); JSON stdout shape.
   - `.gsd/milestones/M003/slices/S04/S04-PLAN.md § Boundary Map + § Non-Goals` — scope and contracts.

2. **Write frontmatter.** Exact shape:
   ```yaml
   ---
   name: forge-plan-checker
   description: Advisory plan-checker agent. Scores a slice plan across 10 structural dimensions (completeness, must_haves_wellformed, ordering, dependencies, risk_coverage, acceptance_observable, scope_alignment, decisions_honored, expected_output_realistic, legacy_schema_detect). Read-only — never modifies plans or STATE.md. Writes S##-PLAN-CHECK.md. Invoked by the orchestrator between plan-slice and the first execute-task.
   model: claude-sonnet-4-6
   effort: low
   tools: Read, Write, Grep, Glob
   ---
   ```
   Note: NO `thinking:` (Sonnet does not support extended thinking). NO `Bash`, NO `Agent`, NO `WebSearch`/`WebFetch` in tools — minimal surface.

3. **Write `## Constraints` section** listing:
   - Never modify `T##-PLAN.md`, `S##-PLAN.md`, or any other plan file.
   - Never modify `STATE.md`.
   - Never spawn sub-agents (no `Agent` tool).
   - Never run Bash commands (no `Bash` tool).
   - All dimension scoring is deterministic / structural — no opinion. Each dimension has locked pass/warn/fail triggers.
   - Legacy plans are always `warn` on `must_haves_wellformed`, never `fail`.

4. **Write `## Input (from prompt)` section** documenting:
   - `WORKING_DIR` — absolute path.
   - `M###` — milestone ID.
   - `S##` — slice ID.
   - `MODE` — `advisory` or `blocking` (read for metadata only; agent behavior is identical in both modes).
   - `MUST_HAVES_CHECK_RESULTS` — array of objects (inlined as JSON in the prompt by the orchestrator):
     ```json
     [
       {"task_id": "T01", "legacy": false, "valid": true, "errors": []},
       {"task_id": "T02", "legacy": false, "valid": false, "errors": ["artifacts[0].min_lines — required number field missing"]},
       {"task_id": "T03", "legacy": true,  "valid": true, "errors": []}
     ]
     ```
   - Round number (for blocking mode — future; in advisory mode always 1).

5. **Write `## Process` section with 5 steps:**

   - **Step 1 — Read plan artifacts.**
     - Read `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN.md`.
     - Use `Glob` to find all `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/tasks/T*/T*-PLAN.md` files. Read each.
     - Read if exists: `{WORKING_DIR}/.gsd/milestones/{M###}/{M###}-CONTEXT.md`.
     - Read if exists: `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-CONTEXT.md`.

   - **Step 2 — Parse `MUST_HAVES_CHECK_RESULTS` from the prompt.**
     - Iterate tasks. Map `task_id` → `{legacy, valid, errors}`.

   - **Step 3 — Score the 10 dimensions (LOCKED order).** For each dimension, emit one row `{dimension, verdict, justification}`. Rubrics:

     1. **`completeness`** — every T## declared in `S##-PLAN.md § Task Breakdown` has a corresponding `T##-PLAN.md` file AND a non-empty `## Goal` section.
        - `pass` if 100% match; `warn` if ≤ 1 missing file or empty-Goal T##; `fail` if ≥ 2 missing.

     2. **`must_haves_wellformed`** — every **non-legacy** T## has `MUST_HAVES_CHECK_RESULTS[*].valid == true` AND `errors: []`.
        - `pass` if all non-legacy valid; `warn` if legacy present (but non-legacy all valid); `fail` if any non-legacy has `valid: false` OR non-empty `errors`.

     3. **`ordering`** — task execution order in `S##-PLAN.md` respects declared `depends:` relationships.
        - `pass` if every `depends: [Tx]` entry appears before the dependent task in the execution order; `warn` if ambiguous (e.g., graph allows multiple valid orders and one is chosen); `fail` on any back-dependency (`T03 depends: [T05]` with T03 ordered before T05).

     4. **`dependencies`** — every `depends:` entry references a task that exists in the same slice.
        - `pass` if all refs resolve; `warn` on 1 unresolved; `fail` on ≥ 2 OR any external-slice reference without explicit cross-slice annotation.

     5. **`risk_coverage`** — if `S##-RISK.md` exists, every risk has at least one mitigation step appearing in some T##-PLAN's `## Steps` OR `## Standards` OR `## Context`.
        - `pass` if all mitigations present OR no RISK file; `warn` if 1 missing; `fail` if ≥ 2 missing.

     6. **`acceptance_observable`** — every acceptance criterion in `S##-PLAN.md § Acceptance Criteria` is phrased as an observable outcome (starts with a verb like "Run", "Open", "Grep", "Inspect", OR contains a file path / exit code / regex anchor).
        - `pass` if all observable; `warn` if 1 ambiguous; `fail` if ≥ 2 ambiguous.

     7. **`scope_alignment`** — every task's `## Goal` and `must_haves.truths[]` refer to capabilities listed in `M###-SCOPE.md` (if exists) OR in `S##-PLAN.md § Boundary Map § Produces` (if no SCOPE).
        - `pass` if all in-scope; `warn` if 1 task introduces an apparently-new capability; `fail` if ≥ 2 OR any task references an explicit `## Out of Scope` item.

     8. **`decisions_honored`** — every decision in `M###-CONTEXT.md § Implementation Decisions` (D1/D2/...) and in `S##-CONTEXT.md § Decisions` (if exists) is NOT contradicted by any T##-PLAN step or standard.
        - `pass` if no contradictions detected; `warn` if 1 task appears to restate-and-tweak a decision; `fail` if ≥ 1 task directly contradicts a locked decision.

     9. **`expected_output_realistic`** — the union of `expected_output:` paths across all tasks contains no duplicates, no invalid-looking paths (paths starting with `/`, paths containing Windows backslashes, paths to non-existent parent directories the plans do not explicitly create).
        - `pass` if clean union; `warn` if 1 suspicious path; `fail` if ≥ 2.

     10. **`legacy_schema_detect`** — count of T##s with `legacy: true` in MUST_HAVES_CHECK_RESULTS.
         - `pass` if 0 legacy tasks; `warn` if ≥ 1 (never `fail` — C13). Justification names the legacy task IDs.

   - **Step 4 — Write `S##-PLAN-CHECK.md`.**
     Format:
     ```markdown
     ---
     id: S##
     milestone: M###
     slice: S##
     generated_at: <ISO-8601>
     mode: {advisory | blocking}
     ---

     # S##: Plan Check — Advisory

     Structural scorecard for the slice plan. Scores 10 locked dimensions. **This is advisory** — the orchestrator proceeds regardless in `advisory` mode. In `blocking` mode, the orchestrator enforces a revision loop (max 3 rounds, monotonic fail-count decrease).

     ## Dimensions

     | # | Dimension | Verdict | Justification |
     |---|-----------|---------|---------------|
     | 1 | completeness | pass | All 5 T## have present plan files and non-empty goals. |
     | 2 | must_haves_wellformed | warn | 1 legacy T## (T03); non-legacy all valid. |
     | ... | ... | ... | ... |

     ## Summary

     - **pass:** 7
     - **warn:** 2
     - **fail:** 1

     ## Advisory Notes

     <optional section — at most 4 lines summarizing the most-severe fails>
     ```

   - **Step 5 — Return `---GSD-WORKER-RESULT---`.**
     Shape:
     ```
     ---GSD-WORKER-RESULT---
     status: done
     plan_check_counts:
       pass: <N>
       warn: <N>
       fail: <N>
     ```
     No `blocker_class` — plan-checker never blocks. The orchestrator interprets the counts per the active mode.

6. **Write `## Output Contract` section** restating the LOCKED shape of the worker result and of `S##-PLAN-CHECK.md`. Note that future M004+ revisions may extend the dimension list but the 10 listed here are LOCKED by this task.

7. **Write `## Non-Goals` section:**
   - Plan rewriting.
   - Blocking / retry logic (orchestrator owns that; agent returns counts only).
   - LLM-based "is this plan good?" critique — all rubrics are structural.
   - Cross-slice verification — this agent scores ONE slice's plan.
   - Reading T##-SUMMARY.md or any post-execution artifact — plan-checker runs PRE-execute.

8. **Verify syntax** (MD frontmatter + table alignment). Ensure no unintended trailing whitespace and that the `tools:` line lists exactly `Read, Write, Grep, Glob` (no `Bash`, no `Agent`).

9. **Note activation timing** (MEM068): document in T01-SUMMARY that this agent file must be installed via `install.sh` / `install.ps1` to activate in running agent pool. Orchestrator wiring (T03) is separate and also needs install re-run.

## Standards

- **Target directory:** `agents/` (new file).
- **Reuse:** frontmatter shape from `agents/forge-executor.md` (Sonnet, `effort: low`); `## Constraints` + `## Process` structure from `agents/forge-memory.md` / `agents/forge-executor.md`; worker-result contract from Code Rules.
- **Naming:** `forge-plan-checker` (kebab-case) — matches all other agents. File: `forge-plan-checker.md`.
- **Lint command:** none — `.md` file; manually verify YAML frontmatter with `node -e "const fs=require('fs');const raw=fs.readFileSync('agents/forge-plan-checker.md','utf8');const fm=raw.match(/^---\\n([\\s\\S]*?)\\n---/);console.log(fm?fm[1]:'NO FRONTMATTER')"`.
- **Pattern:** `follows: Skill frontmatter + body` from Pattern Catalog (agent variant — frontmatter + body; no `<objective>`/`<essential_principles>`/`<process>` XML tags, uses Markdown section headings instead).
- **Path handling:** use `{WORKING_DIR}`, `{M###}`, `{S##}` placeholders in the agent body (MEM010 — orchestrator substitutes at dispatch).
- **Error handling:** if a read fails (e.g., `S##-CONTEXT.md` missing), continue — that file is read-if-exists. If `S##-PLAN.md` is missing, return `status: blocked`, `blocker_class: scope_exceeded`, `blocker: "S##-PLAN.md missing — plan-checker cannot score an absent plan"`. (This is the one blocking condition — the plan file itself must exist.)

## Context

- **Read first:**
  - `agents/forge-executor.md` lines 1–40 — Sonnet frontmatter template.
  - `agents/forge-memory.md` lines 1–30 — minimal agent body style.
  - `.gsd/milestones/M003/slices/S01/S01-SUMMARY.md § Forward Intelligence` — `parseMustHaves` throws; CLI exit codes; schema shape LOCKED.
  - `.gsd/CODING-STANDARDS.md § Frontmatter Conventions` — Sonnet agents add `effort: low`.
  - `.gsd/milestones/M003/M003-SCOPE.md § C9` — the acceptance criterion for the plan-checker (≥ 8 dimensions, one-line justification).

- **Prior decisions to respect:**
  - M003/D3 — schema LOCKED; plan-checker consumes the exact shape.
  - Advisory posture — never block; return counts only.
  - C13 — legacy plans warn, never fail.
  - MEM068 — activation via install.sh.
  - S04-PLAN § Risk Callouts item 1 — agent has NO `Bash`; orchestrator shells `--check`.
  - S04-PLAN § Boundary Map § Produces — 10 dimensions LOCKED in the order listed.

- **Non-goals (reiterated):**
  - No new `scripts/forge-plan-checker.js`.
  - No modifications to `forge-completer` / `forge-executor` / `forge-planner` in THIS task (T03 handles dispatch wiring).
  - No CLAUDE.md edit (T05).
