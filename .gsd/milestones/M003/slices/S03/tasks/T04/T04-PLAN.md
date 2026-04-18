---
id: T04
slice: S03
milestone: M003
title: "Wire forge-completer sub-step 1.8 — invoke verifier + summarise"
status: DONE
planned: 2026-04-16
must_haves:
  truths:
    - "`agents/forge-completer.md` contains a new sub-step 1.8 inserted AFTER sub-step 1.6 (File Audit) and BEFORE step 2 (Write S##-UAT.md)."
    - "Sub-step 1.8 invokes `node scripts/forge-verifier.js --slice {S##} --milestone {M###} --cwd {WORKING_DIR}` and captures stdout JSON."
    - "Sub-step 1.8 reads the generated `S##-VERIFICATION.md`, counts rows by verdict, and writes a `## Verification Summary` paragraph to `S##-SUMMARY.md` (always runs — even when 0 flags; advisory-only)."
    - "Sub-step 1.8 is advisory: never blocks merge, never returns `status: blocked`. Verifier failure (exit 2, CLI crash) is recorded as `## Verification Summary (unavailable)` one-liner — does not abort completer."
    - "Existing sub-steps 1.5 and 1.6 are preserved unchanged; step numbering 2, 3, 4... unchanged."
    - "Frontmatter note in step 1 mentions sub-step 1.8 alongside existing 1.5/1.6 note."
  artifacts:
    - path: agents/forge-completer.md
      provides: "New sub-step 1.8: Verification Summary section — invoke forge-verifier.js + summarise VERIFICATION.md into S##-SUMMARY.md. Advisory-only. Inserted between sub-step 1.6 (File Audit) and step 2 (UAT)."
      min_lines: 320
      stub_patterns: []
  key_links:
    - from: agents/forge-completer.md
      to: scripts/forge-verifier.js
      via: "bash invocation — `node scripts/forge-verifier.js --slice {S##} --milestone {M###} --cwd {WORKING_DIR}`"
expected_output:
  - agents/forge-completer.md
---

# T04: Wire forge-completer sub-step 1.8

**Slice:** S03  **Milestone:** M003

## Goal

Insert a new sub-step 1.8 into `agents/forge-completer.md` that invokes the verifier CLI (shipped by T02+T03) after the existing File Audit sub-step, then writes a `## Verification Summary` paragraph to `S##-SUMMARY.md`. Advisory-only — never blocks the completer.

## Must-Haves

### Truths
- Reading `agents/forge-completer.md` after the edit shows sub-steps 1, 1.5, 1.6, **1.8**, 2, 3, 4, 5, 6, 7, 8, 9 in that order (no renumbering of existing steps).
- Sub-step 1.8 body mentions:
  - The exact CLI command with `{WORKING_DIR}`, `{S##}`, `{M###}` placeholders.
  - Parsing the JSON stdout to get `{rows, duration_ms, legacy_count, malformed_count}`.
  - Reading the generated `S##-VERIFICATION.md` path.
  - Writing a short `## Verification Summary` paragraph to `S##-SUMMARY.md` — with counts of pass/fail/skipped/approximate per level.
  - Advisory posture — never blocks, never returns `status: blocked`.
  - Graceful handling when CLI exits non-zero: write `## Verification Summary (unavailable — <reason>)` one-liner instead.
- The "Note" line under step 1's frontmatter key description is updated to mention sub-step 1.8 alongside 1.5/1.6.

### Artifacts
- `agents/forge-completer.md` — edited. Insertion between current sub-step 1.6 end and `2. Write S##-UAT.md`. Final line count ≥ 320.

### Key Links
- `agents/forge-completer.md` → `scripts/forge-verifier.js` via the Bash invocation in sub-step 1.8.

## Steps

1. Read `agents/forge-completer.md` to confirm current structure. Locate end of sub-step 1.6 (File Audit) — it ends at the advisory disclaimer "This sub-step is advisory. Do NOT return `status: blocked`. Do NOT abort merge. Git failures and malformed plans surface as warn notes, not errors."

2. Insert a new heading `1.8. **Verification Summary — invoke verifier + write `## Verification Summary` section to `S##-SUMMARY.md`** (advisory; always runs).` directly after sub-step 1.6.

   Use sub-step **1.8** (skipping 1.7) to match MEM022 letter/number convention that leaves spacing for future insertions without cascading renumbers — consistent with the S02 pattern which used 1.5/1.6 with room for later additions.

3. Sub-step 1.8 body:
   ```markdown
   a. **Invoke the verifier CLI:**
      ```bash
      node scripts/forge-verifier.js \
        --slice {S##} \
        --milestone {M###} \
        --cwd {WORKING_DIR}
      ```
      Capture stdout into a variable; capture exit code separately. If exit code is non-zero OR stdout is not valid JSON, skip to step (d) below — write the "unavailable" fallback line.

   b. **Parse the JSON output:**
      ```javascript
      // Expected shape:
      // { slice, milestone, generated_at, duration_ms, rows: [...],
      //   legacy_count, malformed_count, error_count }
      ```
      Count rows by verdict:
      - `exists_pass`, `exists_fail`
      - `substantive_pass`, `substantive_fail`
      - `wired_pass`, `wired_fail`, `wired_skipped`, `wired_approximate`

   c. **Read the generated VERIFICATION.md:**
      Confirm the file exists at
      `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-VERIFICATION.md`.
      This is diagnostic — no content is inlined into the summary; the VERIFICATION.md stands on its own as the detailed audit artifact.

   d. **Write `## Verification Summary` section to `S##-SUMMARY.md`:**
      Always append this section (never omit — unlike Evidence Flags/File Audit which are omit-when-clean). Template:
      ```markdown
      ## Verification Summary

      _Advisory — goal-backward audit of `must_haves.artifacts[]` across all tasks. Heuristic (regex stub detection + depth-2 import walker), JS/TS only. See `{S##}-VERIFICATION.md` for per-artifact detail._

      - **Artifacts audited:** N
      - **Exists:** P pass, F fail
      - **Substantive:** P pass, F fail (K stub matches)
      - **Wired:** P pass, F fail, S skipped (non-JS/TS or placeholder), A approximate (depth-limit)
      - **Legacy plans:** L (schema-skip)
      - **Malformed plans:** M
      - **Duration:** D ms (budget ≤ 2000 ms for 10 artifacts hot-cache)

      No action taken; flags are documentation-only.
      ```

   e. **Fallback (verifier unavailable):**
      If the CLI failed (exit != 0, missing script, missing S01 dependency, etc.), append this one-liner instead:
      ```markdown
      ## Verification Summary (unavailable)

      _Verifier failed to run: {reason from stderr or "unknown"}. VERIFICATION.md not generated this slice. Advisory — does not block closure._
      ```

   This sub-step is **advisory**. Do NOT return `status: blocked` based on verifier output. Do NOT abort merge. The section is purely documentation. If `scripts/forge-verifier.js` does not exist (e.g., running against a pre-M003/S03 checkout), write the fallback line and proceed.
   ```

4. Update the step 1 frontmatter guidance. Current text (around the Note line): "Note: `## Evidence Flags` section (written by sub-step 1.5 below) may appear in the body if evidence cross-ref flagged any claims."

   Change to: "Note: `## Evidence Flags` (sub-step 1.5), `## File Audit` (sub-step 1.6), and `## Verification Summary` (sub-step 1.8) sections may appear in the body — written by the sub-steps below."

5. Verify no other step numbers changed. Run a visual/grep check — ensure `2. Write S##-UAT.md`, `3. Verification gate`, `4. Security scan`, `5. Lint gate`, `6. Git squash-merge`, `7. Update M###-SUMMARY.md`, `8. Mark slice [x]`, `9. Update CLAUDE.md` are all intact.

6. Verify Markdown still renders: `---` frontmatter fence still well-formed, no orphan code fences.

7. Note on install propagation (MEM068): the edit to `agents/forge-completer.md` here lives in the repo. The running completer agent uses `~/.claude/agents/forge-completer.md`. The new sub-step only fires after the next `install.sh` / `install.ps1` run. This is expected — same as S02's self-test observation. Document this in the task's SUMMARY under "Activation timing".

## Standards

- **Target directory:** `agents/` (editing existing file).
- **Reuse:** sub-step letter-suffix convention from S01/T03 (step 1a) and S02/T03/T04 (sub-steps 1.5, 1.6). Continue the pattern with sub-step 1.8.
- **Naming:** sub-step 1.8 heading format matches 1.5/1.6 — bold section name, quoted file, advisory tag in parens.
- **Lint command:** visual read-through + `grep -n "^[0-9]\." agents/forge-completer.md` to confirm top-level step numbering is unchanged.
- **Pattern:** `follows: Hook script lifecycle` is not quite right (this is an agent, not a hook); closest is the S02 sub-step insertion pattern — "letter-suffix / decimal-suffix insertion into numbered agent step sequences without renumbering".
- **Path handling:** use `{WORKING_DIR}`, `{M###}`, `{S##}` placeholders (MEM010 — orchestrator substitutes at dispatch).
- **Error handling:** advisory — if verifier CLI fails, write the fallback one-liner. Never surface as completer blocker.

## Context

- **Read first:** `agents/forge-completer.md` — full file. Understand current step structure (1, 1.5, 1.6, 2–9) and the Forward Intelligence template.
- **Read:** S02-SUMMARY.md "Self-Test Observation (S02 Feature Dogfood)" — gives the template for the MEM068 activation-timing note.
- **Prior decisions to respect:**
  - M003/D3 + S02 LOCKED sub-step letter-suffix convention — use 1.8 (skip 1.7 for future-proofing).
  - Advisory posture across M003 — no enforcement in v1.
  - MEM068: agent edits propagate on next install — document in task SUMMARY.
  - S02/T03 + T04 advisory-vs-blocker separation: Evidence Flags and File Audit are omit-when-clean; Verification Summary **always writes** (because 0-artifact or 0-flag is still meaningful signal for reviewers). Consistency rationale: VERIFICATION.md is a LOCKED deliverable per S03 Acceptance Criteria #6.
- **Non-goals:**
  - Running the verifier CLI as part of this task (T02/T03 ship that).
  - Testing end-to-end (T05 smoke does).
  - Measuring perf (T06).
