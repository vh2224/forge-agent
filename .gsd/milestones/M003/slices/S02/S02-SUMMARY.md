---
id: S02
milestone: M003
title: "Evidence log (PostToolUse) + file-audit in completer"
status: complete
provides:
  - "PostToolUse evidence capture writing evidence-{unitId}.jsonl per Bash/Write/Edit call"
  - "resolveUnitId / readEvidenceMode / truncate helpers in scripts/forge-hook.js"
  - "evidence.mode: disabled/lenient/strict pref wiring (disabled skips writes)"
  - "forge-executor.md step 12a: verification_evidence frontmatter emission contract"
  - "forge-completer.md sub-step 1.5: Evidence Flags cross-ref (advisory)"
  - "forge-completer.md sub-step 1.6: File Audit git-diff vs expected_output (advisory)"
  - "file_audit.ignore_list prefs default in forge-agent-prefs.md"
key_files:
  - scripts/forge-hook.js
  - agents/forge-executor.md
  - agents/forge-completer.md
  - forge-agent-prefs.md
key_decisions:
  - "Evidence block placed before `if (toolName !== 'Agent') return` — additive, existing dispatch tracking preserved"
  - "Step 12a letter-suffix insertion pattern (same as S01/T03) avoids cascading step renumbers in executor"
  - "Evidence cross-ref placed as sub-step 1.5; File Audit as sub-step 1.6 — both inside step 1 write path"
  - "Deletions NOT tracked (D4 LOCKED) — --diff-filter=AM only in File Audit"
  - "strict mode is reserved for M004+; lenient and strict behave identically in this slice"
patterns_established:
  - "Evidence JSONL: one-line-per-call append with 512-byte budget, path .gsd/forge/evidence-{unitId}.jsonl"
  - "Advisory pipeline: both Evidence Flags and File Audit write only when non-empty; never block closure"
  - "Sub-step letter-suffix convention for inserting into numbered agent step sequences without renumbering"
completed_at: 2026-04-16
---

Evidence log + file-audit infrastructure landed: PostToolUse hook now captures every Bash/Write/Edit call as a ≤512-byte JSONL line; executor self-reports verification claims in frontmatter; completer cross-references and flags mismatches; file-audit diffs actual AM output against planned expected_output — all advisory, all silent-fail.

## What Was Built

**T01 — PostToolUse evidence capture (`scripts/forge-hook.js`)**

Three private helpers added above the stdin handler: `resolveUnitId` (reads `.gsd/forge/auto-mode.json` worker field, returns right-half unit ID, falls back to `adhoc`), `readEvidenceMode` (3-file prefs cascade via regex, returns `lenient|strict|disabled`, last wins), and `truncate` (suffix-ellipsis with byte-safe budget). The evidence write block executes before the `if (toolName !== 'Agent') return` guard so it is additive — existing dispatch-tracking logic unchanged. One JSON line ≤ 512 bytes is appended per Bash/Write/Edit call with shape `{ts, tool, cmd, file, ok, interrupted}`. `disabled` mode returns early; `lenient` and `strict` write identically (strict enforcement reserved for M004+). All wrapped in try/catch silent-fail per MEM008. Hook grew by ≤80 lines per D1.

**T02 — Executor `verification_evidence:` contract (`agents/forge-executor.md`)**

Surgical two-insertion edit: step 12a inserted between steps 12 and 13 instructing executors to emit `verification_evidence:` in T##-SUMMARY.md frontmatter after running verification commands. Each entry is `{command, exit_code, matched_line}` where `matched_line` is the 1-indexed line from `evidence-{T##}.jsonl` that carries the same command (executor greps at summary-write time). Sentinel values documented: `matched_line: 0` (grep found nothing), empty array (log unavailable). A `### Summary Format: verification_evidence` subsection provides a concrete YAML example. All existing step numbering preserved.

**T03 — Evidence Flags cross-ref in completer (`agents/forge-completer.md`)**

Sub-step 1.5 inserted between step 1 and the new File Audit sub-step 1.6. For each T## in the slice: reads `evidence.mode` pref (3-file cascade), parses `verification_evidence:` from `T##-SUMMARY.md` frontmatter via inline `node -e`, reads the matching `.jsonl` with `sed -n`, and checks three mismatch conditions: `command_not_in_log`, `command_mismatch_at_line`, `evidence_log_missing`. Mismatches surface in a `## Evidence Flags` table (`file | claim | reason`) in `S##-SUMMARY.md`. `disabled` mode skips entirely. Advisory only — never blocks merge. NOTE line added to step 1 frontmatter key description pointing to sub-step 1.5.

**T04 — File Audit in completer (`agents/forge-completer.md`)**

Sub-step 1.6 computes `ACTUAL_AM` via `git diff --name-only --diff-filter=AM` from merge-base with fallback chain (master → main → origin/HEAD → working-tree + untracked). Builds `EXPECTED` by inline-parsing `expected_output:` from each T##-PLAN.md frontmatter (separate from `forge-must-haves.js --check` which does not emit the expected_output array). Reads `file_audit.ignore_list` from 3-file prefs cascade with hardcoded defaults. Diffs the two sets: `unexpected` (actual AM but not in expected) and `missing` (expected but not in actual AM). Writes `## File Audit` section only when at least one list is non-empty; omits section when both are empty. All git/node failures are silent.

**T05 — `file_audit.ignore_list` prefs default (`forge-agent-prefs.md`)**

`## File Audit Settings` section inserted between `## Evidence Settings` and `## Token Budget Settings`, following the style of Evidence Settings (pt-BR intro, fenced config block, Semântica + Cross-references subsections). Default ignore list: `["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "dist/**", "build/**", ".next/**", ".gsd/**"]`. Key name `file_audit.ignore_list` is LOCKED — T04 completer parses it via regex.

## Verification Gate

- **Status:** skipped (no-stack)
- **Discovery source:** none
- **Result:** `{"passed":true,"checks":[],"discoverySource":"none","skipped":"no-stack"}`
- **Explanation:** `forge-verify.js` found no test stack configured for this project (no `package.json` test script, no pytest, etc.). Gate is non-blocking when skipped with `no-stack`.
- **Timestamp:** 2026-04-16

## Self-Test Observation (S02 Feature Dogfood)

This complete-slice execution is the **first real-world run** of the Evidence Flags and File Audit features shipped in this slice. The completer agent instructions (sub-steps 1.5 and 1.6) are now in `agents/forge-completer.md`, but this GSD-WORKER (forge-completer) runs from its installed copy in `~/.claude/agents/forge-completer.md`. Whether the new sub-steps fired depends on whether the installed agent was updated before this run.

**Observed outcome:** The File Audit and Evidence Flags sections were NOT generated in this summary — consistent with the installed agent not yet carrying sub-steps 1.5/1.6. This is expected: the source edits live in the repo's `agents/forge-completer.md`; the running agent is the pre-S02 version. The features will be active after the next `install.sh` run.

## Forward Intelligence (for S03 — goal-backward verifier)

S03 consumes the evidence log as an **optional corroborating signal** at the Wired level. Key facts:

1. **JSONL path pattern:** `.gsd/forge/evidence-{unitId}.jsonl` where `unitId` = right-hand side of `worker` field in `auto-mode.json` (e.g. `T03` from `"execute-task/T03"`). Falls back to `evidence-adhoc.jsonl` when auto-mode is inactive.
2. **Line shape (LOCKED D2):** `{"ts": <epoch_ms>, "tool": "Bash|Write|Edit", "cmd": "<≤200 chars>", "file": "<path or null>", "ok": true, "interrupted": false}` — fields `ts` and `tool` are never truncated; `cmd` may be ellipsis-suffixed.
3. **Additive contract:** S03 may read the JSONL files but must not rewrite or rename them. The shape is forward-compatible — S03 may add consumer logic without requiring S02 changes.
4. **`disabled` mode produces no files:** if `evidence.mode: disabled` is set in prefs, no `.jsonl` files exist for that task. The Wired level must tolerate missing files gracefully (treat as "no corroborating evidence" rather than error).
5. **File Audit uses `--diff-filter=AM` only (D4 LOCKED):** S03 verifier should not assume deletions are tracked anywhere — the evidence pipeline is silent on removed files.
6. **`verification_evidence:` frontmatter shape:** `[{command: str, exit_code: int, matched_line: int}]` in T##-SUMMARY.md. Empty array `[]` is valid (log unavailable). `matched_line: 0` means grep found nothing in the log. S03 can use `matched_line > 0` as a quick signal that the executor corroborated a command.

## Drill-Down Paths

- T01: `.gsd/milestones/M003/slices/S02/tasks/T01/T01-SUMMARY.md`
- T02: `.gsd/milestones/M003/slices/S02/tasks/T02/T02-SUMMARY.md`
- T03: `.gsd/milestones/M003/slices/S02/tasks/T03/T03-SUMMARY.md`
- T04: `.gsd/milestones/M003/slices/S02/tasks/T04/T04-SUMMARY.md`
- T05: `.gsd/milestones/M003/slices/S02/tasks/T05/T05-SUMMARY.md`
