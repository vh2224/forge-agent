---
id: T03
slice: S01
milestone: M003
status: DONE
must_haves:
  truths:
    - "agents/forge-executor.md Step 1 (before `status: RUNNING`) reads the T##-PLAN and shells out to `node scripts/forge-must-haves.js --check <plan>` to classify legacy vs structured"
    - "When structured AND valid → executor proceeds normally (existing flow)"
    - "When structured AND malformed → executor returns `---GSD-WORKER-RESULT---` with `status: blocked`, `blocker_class: scope_exceeded`, reason `missing_must_haves_schema` (including the CLI stderr message as context)"
    - "When legacy → executor continues but records a one-line warn note (`legacy_schema: true`) in T##-SUMMARY.md `## What Happened` — never blocks"
    - "Existing frontmatter (name, description, model, effort, tools) preserved bit-for-bit"
    - "The branch logic is placed BEFORE `status: RUNNING` is set so a blocked task never shows as in-flight"
  artifacts:
    - path: "agents/forge-executor.md"
      provides: "updated executor agent with structured must_haves schema validation at Step 1"
      min_lines: 195
  key_links:
    - from: "agents/forge-executor.md"
      to: "scripts/forge-must-haves.js"
      via: "shell-out `node scripts/forge-must-haves.js --check <plan>` in Step 1"
    - from: "agents/forge-executor.md"
      to: "agents/forge-planner.md"
      via: "consumes the structured must_haves frontmatter contract emitted by planner (T02)"
expected_output:
  - agents/forge-executor.md
---

# T03: Executor reads + validates must_haves schema at Step 1

**Slice:** S01  **Milestone:** M003

## Goal

Add a step-1 schema check to `agents/forge-executor.md`: before marking the task as `RUNNING`, the executor shells out to the `scripts/forge-must-haves.js` CLI to classify the plan as legacy or structured; malformed structured plans fail fast with a clear blocker, while legacy plans pass through with a warn note.

## Must-Haves

### Truths
- `agents/forge-executor.md` Step 1 (before `status: RUNNING`) shells out to `node scripts/forge-must-haves.js --check <plan>` and branches on the JSON output.
- Structured + valid → continue existing flow unchanged.
- Structured + malformed → return `---GSD-WORKER-RESULT---` with `status: blocked`, `blocker_class: scope_exceeded`, reason `missing_must_haves_schema`; include the CLI stderr/error list in the `blocker` field.
- Legacy → continue; record `legacy_schema: true` warn line in T##-SUMMARY.md `## What Happened`. Never block.
- Existing frontmatter bit-for-bit preserved; no new `tools` entries needed (`Bash` already present).
- Check happens **before** `status: RUNNING` is written so a blocked task never leaves its plan marked in-flight.

### Artifacts
- `agents/forge-executor.md` — updated executor agent (surgical edits; ≥ 195 lines total after edits).

### Key Links
- `agents/forge-executor.md` → `scripts/forge-must-haves.js` via CLI shell-out (`--check`).
- `agents/forge-executor.md` consumes the structured `must_haves` frontmatter contract emitted by `agents/forge-planner.md` (T02 sibling task).

## Steps

1. Read `agents/forge-executor.md` fully, focusing on the `## Process` section (steps 1-13).
2. **Preserve frontmatter bit-for-bit** (lines 1-7). Do NOT change `model`, `tools`, `effort`.
3. Insert a NEW **Step 1.5** (or renumber — prefer inserting a sub-step `1a` to avoid cascading renumbers) between the current Step 1 ("Read `T##-PLAN.md` fully") and Step 2 ("Read `## Standards` section"). Place it BEFORE Step 3 ("Mark task as in-flight: add or update `status: RUNNING`").
4. The new step text:
   ```markdown
   1a. **Validate must_haves schema (BEFORE setting `status: RUNNING`):**
       Run:
       ```bash
       node scripts/forge-must-haves.js --check "{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/tasks/{T##}/{T##}-PLAN.md"
       ```
       Parse the JSON on stdout:
       - `{"legacy": true}` → **continue normally**; record `legacy_schema: true` in T##-SUMMARY.md `## What Happened` as a one-line warn note. Do NOT block.
       - `{"legacy": false, "valid": true}` → continue normally.
       - `{"legacy": false, "valid": false}` (exit code 2) → **STOP**. Do NOT set `status: RUNNING`. Return `---GSD-WORKER-RESULT---` with:
         ```
         status: blocked
         blocker_class: scope_exceeded
         blocker: missing_must_haves_schema — <errors joined with "; ">
         ```
         Append the CLI stderr VERBATIM (truncated to 4 KB) inside `blocker`.
       - Any other exit code or malformed JSON → surface as `status: blocked`, `blocker_class: tooling_failure`, `blocker: "forge-must-haves.js CLI error: <stderr>"`.
   ```
5. Reference the schema contract briefly — a pointer line: *"Schema shape is authoritative in `agents/forge-planner.md § Must-Haves Schema`."*
6. In the `## Process` step list, adjust existing step-2 anchor reference only if renumbering required. Otherwise keep all other steps identical (3-13 unchanged).
7. In the Summary Format section (lines 135-151), add `legacy_schema: true` to the list of optional fields documented — one bullet after the `new_helpers` bullet: *"`legacy_schema: true` — set when the T##-PLAN carried a pre-M003 free-text must-haves section; warn only, never a blocker."*
8. Verify:
   - `grep -n "forge-must-haves.js" agents/forge-executor.md` returns ≥ 1 match.
   - `grep -n "missing_must_haves_schema" agents/forge-executor.md` returns ≥ 1 match.
   - `grep -n "legacy_schema" agents/forge-executor.md` returns ≥ 1 match.
   - The `status: RUNNING` line (current step 3) still comes AFTER the new step 1a in file order.

## Standards

- **Target directory:** `agents/` (agent definitions).
- **Naming:** no new files. Edit `forge-executor.md` only.
- **Frontmatter:** preserve existing keys — `name`, `description`, `model`, `effort`, `tools`. `Bash` is already in `tools` (line 6).
- **Pattern:** surgical edit — add one new sub-step, minor amendment to Summary Format. Do NOT touch Helper-First Protocol, DRY Guard, Verification Ladder, Debugging Discipline, Frontend gate, or the Verification Gate (Step 10) sections.
- **Lint:** no Markdown lint configured; verify via grep checks in step 8.
- **Error pattern:** the blocker taxonomy follows CODING-STANDARDS § Orchestrator blocker taxonomy — `scope_exceeded` for schema violations, `tooling_failure` for CLI errors.

## Context

- Prior decisions to respect: D3 (executor blocks if missing/malformed; legacy gets graceful skip per C13).
- Key files to read first: `agents/forge-executor.md` full file, `scripts/forge-must-haves.js` (produced by sibling T01 — its CLI contract is the input here), `.gsd/milestones/M003/slices/S01/S01-PLAN.md` § Schema Shape.
- This step MUST run before `status: RUNNING` is written to the plan — otherwise a blocked plan leaves a dirty in-flight marker. Explicit ordering requirement.
- The shell-out uses `Bash` (already in tools). No agent-tool additions needed.
- Windows compatibility: the command uses forward slashes and quoted path (already the convention throughout the file).
- AUTO-MEMORY relevance: MEM008 (hooks swallow errors) does NOT apply here — the executor shells out a CLI from a Markdown agent; propagation is fine.
