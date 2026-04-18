---
id: T02
slice: S02
milestone: M003
status: DONE
must_haves:
  truths:
    - "agents/forge-executor.md documents the new verification_evidence: YAML frontmatter block that executors emit in T##-SUMMARY.md"
    - "The documented shape matches D2 exactly: `verification_evidence: [{command: string, exit_code: number, matched_line: number}]`"
    - "A new step (12a, between the existing step 12 summary-write and step 13 mark-DONE) instructs the executor to derive each entry by greping .gsd/forge/evidence-{T##}.jsonl for the verification command text and recording its 1-indexed line number as matched_line"
    - "The documentation explicitly notes that matched_line=0 means the claim could not be located in the log (acceptable — advisory only, completer will flag in T03)"
    - "Existing step numbering and content of all other steps in forge-executor.md are preserved bit-for-bit — only documenting the new frontmatter field and the derivation sub-step"
    - "A new short section `### Summary Format: verification_evidence` is added near the existing `## Summary Format`-adjacent docs (or at the end of the Process block) with a concrete YAML example"
  artifacts:
    - path: "agents/forge-executor.md"
      provides: "executor instructions for emitting verification_evidence frontmatter + worked YAML example"
      min_lines: 140
  key_links:
    - from: "agents/forge-executor.md"
      to: ".gsd/milestones/M###/slices/S##/tasks/T##/T##-SUMMARY.md"
      via: "executor writes verification_evidence: YAML block as part of step 12 summary-write"
    - from: "agents/forge-executor.md"
      to: ".gsd/forge/evidence-{T##}.jsonl"
      via: "executor reads log at summary-write time (grep for command string) to compute matched_line"
expected_output:
  - agents/forge-executor.md
---

# T02: Executor emits verification_evidence: in T##-SUMMARY frontmatter

**Slice:** S02  **Milestone:** M003

## Goal

Update `agents/forge-executor.md` so every executor includes a `verification_evidence:` YAML block in the frontmatter of each `T##-SUMMARY.md`. The block lists `{command, exit_code, matched_line}` for each verification command the executor ran, where `matched_line` is the 1-indexed line in `.gsd/forge/evidence-{T##}.jsonl` that carries the same command (or `0` if the executor can't locate a match). D2 shape LOCKED.

## Must-Haves

### Truths
- `agents/forge-executor.md` documents the `verification_evidence:` YAML frontmatter block.
- Shape matches D2 exactly: `[{command: string, exit_code: number, matched_line: number}]`.
- A new sub-step (12a) between steps 12 and 13 instructs the executor to populate it.
- `matched_line: 0` documented as the "not found in log" sentinel (advisory — completer flags in T03).
- All other steps preserved bit-for-bit — only ADDING documentation for the new field + derivation instructions.
- A `### Summary Format: verification_evidence` subsection with a concrete YAML example lands somewhere in the Process-adjacent section.

### Artifacts
- `agents/forge-executor.md` — executor agent definition with new frontmatter documentation. Current file is ~140+ lines; min total after edit is 140 lines (additive only).

### Key Links
- `agents/forge-executor.md` → `T##-SUMMARY.md` via step 12a: emit `verification_evidence:` YAML block.
- `agents/forge-executor.md` → `.gsd/forge/evidence-{T##}.jsonl` via step 12a grep: `grep -n "<command substring>" <evidence-file>` to derive `matched_line`.

## Steps

1. Read `agents/forge-executor.md` fully. Confirm the current step numbering: step 10 = verification gate, step 11 = git commit, step 12 = write `T##-SUMMARY.md`, step 13 = mark DONE in frontmatter.

2. Insert a new sub-step **12a** BETWEEN the existing step 12 and step 13. Suggested text:
   ```markdown
   12a. **Emit `verification_evidence:` frontmatter block** (inside the YAML frontmatter of `T##-SUMMARY.md`). For each command you ran in step 10 (verification gate), produce one entry:
       ```yaml
       verification_evidence:
         - command: "npm run typecheck"
           exit_code: 0
           matched_line: 42
         - command: "npm test"
           exit_code: 0
           matched_line: 43
       ```
       Derivation:
       - `command`: the exact shell string you ran (or a stable substring — see below).
       - `exit_code`: the numeric exit code you observed in your conversation (Claude Code surfaces it in the Bash tool result).
       - `matched_line`: the 1-indexed line number in `.gsd/forge/evidence-{T##}.jsonl` whose `cmd` field contains your command (or a recognisable substring). Derive with:
         ```bash
         grep -n -m 1 -F "<command-substring>" .gsd/forge/evidence-{T##}.jsonl | cut -d: -f1
         ```
         - If grep finds a line → use that number.
         - If grep returns nothing (evidence log missing, disabled mode, or the command string doesn't match) → record `matched_line: 0`. This is a valid sentinel — the slice completer (forge-completer) will surface it as an advisory flag, not a blocker.
       - If the evidence log file does not exist at all (evidence.mode is `disabled`, or the hook failed silently), emit `verification_evidence: []` (empty array). Do NOT omit the key — the completer expects it.

       `command` string rules:
       - Must be ≤ 180 chars. Truncate at word boundary if the real command is longer.
       - Must not contain raw newlines. Collapse to a single line.
       - Quote the string in YAML with double quotes to avoid edge-case parser issues.

       This block is advisory — it is not a verification gate. Emission is mandatory (completer reads it); content accuracy is best-effort.
   ```

3. Below the numbered Process steps (or near the existing summary-format documentation in the file), add a new subsection:
   ```markdown
   ### Summary Format: verification_evidence

   Every `T##-SUMMARY.md` MUST carry a `verification_evidence:` field in its YAML frontmatter. Shape:

   ```yaml
   ---
   id: T##
   slice: S##
   milestone: M###
   status: DONE
   verification_evidence:
     - command: "npm run typecheck"
       exit_code: 0
       matched_line: 42
     - command: "npm test"
       exit_code: 0
       matched_line: 43
   # ... other fields (provides, key_files, etc.) ...
   ---
   ```

   - Empty array (`verification_evidence: []`) is valid — means no verification commands were run OR the evidence log was unavailable (`evidence.mode: disabled`).
   - `matched_line: 0` is the "claim not found in evidence log" sentinel — valid, advisory only.
   - The slice completer (`forge-completer`) reads this block to produce `## Evidence Flags` in `S##-SUMMARY.md`. Mismatches are flagged but never block merge (M003 is advisory; strict-mode blocker is reserved for M004+).
   ```

4. Do NOT modify any existing step's numbering or text. Step 13 remains step 13. Ensure the 12a insertion is strictly between 12 and 13 — use "12a" (not renumber) per CODING-STANDARDS § Error Patterns — preserve BEFORE-RUNNING invariant pattern established in S01/T03.

5. Verify:
   - `grep -n "^12a\." agents/forge-executor.md` returns exactly one match.
   - `grep -c "verification_evidence:" agents/forge-executor.md` returns ≥ 3 (docstring + example in step 12a + Summary Format subsection).
   - `grep -n "^### Summary Format: verification_evidence" agents/forge-executor.md` returns exactly one match.
   - No existing step was modified: run `diff` mentally or with git to confirm only insertions.
   - Frontmatter (`name`, `description`, `model`, `tools`) unchanged.
   - File parseable: balanced code fences (`awk '/^```/{n++} END{print n}' agents/forge-executor.md` even number).

## Standards

- **Target directory:** `agents/` (existing file).
- **Naming:** preserve existing file name.
- **Pattern:** documentation edit — pure Markdown insertion. Style: match existing step prose (English, imperative, concrete examples in fenced blocks).
- **Language:** English for the instructions (CODING-STANDARDS § Language — executor agent prompts are in English).
- **Reuse:** the S01/T03 precedent of inserting a sub-step with letter suffix (1a between 1 and 2) — same trick here for 12a between 12 and 13. Preserves existing numbering, no cascading renames (MEM044-adjacent — schema/step-order stability).
- **Lint:** no Markdown lint configured — verify balanced fences with `awk` per step 5.
- **No code changes:** this task is prose-only. Do NOT run `node --check` on anything — no JS modified.

## Context

- **Prior decisions to respect:**
  - D2 (M003-CONTEXT) — `verification_evidence:` is YAML frontmatter, shape `[{command, exit_code, matched_line}]`. LOCKED.
  - S01 precedent — inserted step 1a between 1 and 2 for must_haves validation. Mirror the convention here.
  - MEM004 / MEM005 — documentation-only changes to agents preserve existing structure; add, don't rewrite.
- **Key files to read first:**
  - `agents/forge-executor.md` lines 17–59 (full Process block — identify insertion point between step 12 and 13).
  - `agents/forge-executor.md` frontmatter (lines 1–7) — confirm unchanged after edit.
  - `agents/forge-planner.md § Must-Haves Schema` (referenced by the executor) — style reference for how schema is documented.
- **Relationship to T01:** T02 is the producer side of the evidence contract. T01 writes the log; T02 teaches the executor to reference the log in its SUMMARY; T03 teaches the completer to cross-check T02's references against T01's log. T02 is independent of T01 — the SUMMARY field is written even if the log is missing (sentinel is `matched_line: 0` or empty array).
- **Not in scope:** modifying the verification gate itself (step 10). The gate stays untouched; T02 only adds summary-emission docs.
- **Forward intelligence for T03:** the completer reads `verification_evidence:` via the YAML frontmatter extract idiom (same pattern as `scripts/forge-verify.js` lines 420–466). It parses the inline object array. The shape LOCKED here is what T03 depends on — do NOT add/remove fields.
