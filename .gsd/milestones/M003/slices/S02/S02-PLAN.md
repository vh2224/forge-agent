---
id: S02
milestone: M003
risk: medium
depends: [S01]
tasks: 5
---

# S02: Evidence log (PostToolUse) + file-audit in completer

**Slice:** S02  **Milestone:** M003  **Risk:** medium  **Depends:** S01
**Planned:** 2026-04-16

## Goal

Ship the evidence-capture + file-audit infrastructure. Every Bash/Write/Edit tool call drops one JSON line into `.gsd/forge/evidence-{unitId}.jsonl` via the existing hook; the executor self-reports the claims it wants credited as `verification_evidence:` in the task summary's YAML frontmatter; the completer cross-refs claims against the log (producing `## Evidence Flags`) and runs `git diff --name-only --diff-filter=AM` against the union of `expected_output` (producing `## File Audit`). Both sections are **advisory** — never block closure (C5, C6). The `file_audit.ignore_list` prefs default lands alongside.

## Capability Coverage (from ROADMAP)

- **C3** — Evidence log via PostToolUse hook (T01)
- **C4** — Hook performance budget ≤15 ms p50 / ≤50 ms p95 (T01 — documented measurement in S##-SUMMARY)
- **C5** — Evidence cross-ref in complete-slice (T03)
- **C6** — File-change validator (T04)
- **C11 partial** — `file_audit.ignore_list` prefs default (T05); `evidence.mode` consumption (T01)
- **C12** — Evidence log lifecycle via existing `milestone_cleanup` (implicit — no new logic; verified by demo)

## Tasks

- [ ] **T01: PostToolUse evidence capture in `scripts/forge-hook.js`** — `risk:medium`
  Extend the PostToolUse branch with evidence-line writer. Reads `auto-mode.json` for `worker` field → unitId; reads `.gsd/claude-agent-prefs.md` / `prefs.local.md` for `evidence.mode` (fallback `lenient`); writes one JSON line ≤ 512 bytes per Bash/Write/Edit call to `.gsd/forge/evidence-{unitId}.jsonl`. `disabled` mode skips; `strict` mode currently behaves identically to `lenient` (reserved for M004+). Wrapped in try/catch swallow (MEM008). Target perf ≤15 ms p50 / ≤50 ms p95 — verified by inline micro-benchmark documented in S02-SUMMARY.

- [ ] **T02: Executor emits `verification_evidence:` in T##-SUMMARY frontmatter** — `risk:low`
  Update `agents/forge-executor.md` — new step in the summary-writing path: after running verification commands, record each in the YAML frontmatter as `verification_evidence: [{command, exit_code, matched_line}]` where `matched_line` is the 1-indexed line number in `evidence-{T##}.jsonl` that carries the same command (executor greps the log at summary-write time). Add a "Summary Format" snippet showing the block.

- [ ] **T03: Completer writes `## Evidence Flags` to S##-SUMMARY** — `risk:medium`
  Update `agents/forge-completer.md` step 1 (summary writing). For each T## in the slice: parse `verification_evidence:` from `T##-SUMMARY.md` frontmatter; read `evidence-{T##}.jsonl`; for each claim, confirm the `matched_line` (or line-number-free grep fallback) points at a log entry whose `command`/`tool_name` matches. Mismatches → `## Evidence Flags` section with `file | claim | reason`. Advisory only — no status change. Honors `evidence.mode: disabled` by skipping the section entirely (no log files exist).

- [ ] **T04: Completer writes `## File Audit` to S##-SUMMARY** — `risk:medium`
  Update `agents/forge-completer.md` step 1 (same summary-write path). Parse `expected_output:` (top-level) from every `T##-PLAN.md` in the slice via `node scripts/forge-must-haves.js --check …` (reuse the existing CLI — parse JSON stdout). Union into a Set. Run `git diff --name-only --diff-filter=AM master...HEAD` (or working tree vs HEAD when not on a branch). Filter out entries matching `file_audit.ignore_list` glob patterns from prefs. Diff the actual AM set against expected: items in actual AM but not in expected → `unexpected`; items in expected but not in actual → `missing`. Write `## File Audit` section with both sub-lists. Deletions are NOT audited (D4). Advisory only.

- [ ] **T05: `file_audit.ignore_list` prefs default in `forge-agent-prefs.md`** — `risk:low`
  Insert new `## File Audit Settings` section with `file_audit.ignore_list:` YAML array default: `["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "dist/**", "build/**", ".next/**", ".gsd/**"]`. Placed after `## Evidence Settings`, before `## Token Budget Settings`. Purely scaffolding — T04 consumes.

## Dependencies (task-level)

```
T01 ─► T03 (completer reads the log T01 writes)
T02 ─► T03 (completer reads the frontmatter T02 writes)
T05 ─► T04 (completer reads the prefs default T05 ships; works without T05 via hardcoded fallback)
T04 independent of T01/T02/T03 (pure git-diff vs expected_output)
```

Execution order: **T01 → T02 → T05 → T04 → T03**. T05 before T04 so the prefs key is live when the completer doc references it. T03 last because it's the most "integrative" (reads everything the prior tasks produced).

## Acceptance Criteria (slice-level demo — from ROADMAP)

1. Run a task with ≥ 3 Bash calls → `.gsd/forge/evidence-{T##}.jsonl` exists with one JSON line per call (each ≤ 512 bytes when measured with `wc -c`).
2. Seed a `T##-SUMMARY.md` with `verification_evidence: [{command: "npm test", exit_code: 0, matched_line: 999}]` where line 999 doesn't exist → running complete-slice produces `## Evidence Flags` in `S##-SUMMARY.md` listing the bogus claim.
3. Create a stray file (e.g. `scripts/forge-stray.js`) not referenced by any `expected_output` → `## File Audit` lists it under `unexpected`.
4. Delete a source file during the slice → does NOT appear in `## File Audit` (D4 — AM only).
5. Deliberately break the hook (throw inside the try block) → a Bash/Write/Edit call still succeeds (MEM008 silent-fail holds).
6. Set `evidence.mode: disabled` in `.gsd/prefs.local.md` → no `evidence-*.jsonl` file is produced for the next task.

## Key Constraints (LOCKED)

- **Zero new deps.** Node built-ins only, CommonJS. (MEM017, M002 zero-deps rule.)
- **Hook is try/catch swallow.** Evidence write failure must never abort a tool call. (MEM008.)
- **Each evidence line ≤ 512 bytes.** Truncate long `command` strings and omit large `stdout`/`stderr` payloads — keep only the first 200 chars of each.
- **`expected_output` parse reuses `scripts/forge-must-haves.js --check`.** Do NOT reimplement YAML parsing in the completer. CLI exit 0 + `legacy:true` → treat task's `expected_output` as empty set (legacy plan).
- **Windows paths:** `path.join(...)` in the hook; forward slashes in completer Bash snippets (Git Bash + WSL both OK).
- **Unit ID source:** the hook reads `.gsd/forge/auto-mode.json` and parses the `worker` field (shape `"unit_type/UNIT_ID"`, e.g. `"execute-task/T03"`). `unitId` in the evidence filename is the right-hand side (`T03`). If auto-mode isn't active or `worker` is null, the hook falls back to writing `evidence-adhoc.jsonl` — still captures but not surfaced by the completer.
- **Evidence line JSON shape** (canonical, enforced by T01):
  ```json
  {"ts": 1713312000000, "tool": "Bash|Write|Edit", "cmd": "<truncated 200>", "file": "<path or null>", "ok": true, "interrupted": false}
  ```
- **Line-count budget for T01:** hook file may grow by ≤ 80 lines. If bigger, factor into helper in same file (private fn), never a new file per D1.

## Research Notes

- **Claude Code PostToolUse schema** (confirmed via docs 2026-04): payload includes `session_id`, `cwd`, `tool_name`, `tool_input`, `tool_response`, `tool_use_id`. Bash `tool_response` has `stdout`, `stderr`, `interrupted` (no explicit `exit_code` field — inferred from `interrupted` + stderr presence). Write/Edit `tool_response` has `filePath`, `success`. See `https://code.claude.com/docs/en/hooks`.
- **Why `ok` (not `exit_code`) in the JSONL:** the hook can't observe `exit_code` directly for Bash — `tool_response.success` is the cross-tool boolean we can trust. The executor's `verification_evidence` self-reports `exit_code: N` from its own conversation state; the completer cross-refs `command` string only, not `exit_code`.
- **Perf note:** stdin JSON parse + one `fs.appendFileSync` + one `JSON.stringify` ≈ 2–5 ms on warm disk; worst case ≈ 15 ms on cold NTFS. Budget is comfortable. Micro-bench via `console.time`/`console.timeEnd` in a scratch script (delete before commit).

## Context

- **Locked decisions:** D1 (single hook file), D2 (verification_evidence YAML frontmatter), D3 (planner always emits must_haves — already shipped in S01), D4 (file-audit AM only).
- **S01 outputs consumed:**
  - `scripts/forge-must-haves.js` CLI `--check` — the completer shells out to parse `expected_output` from each T##-PLAN (T04).
  - `verification_evidence` is a new frontmatter key on `T##-SUMMARY.md` (executor emits in T02; completer reads in T03). Shape LOCKED by CONTEXT D2.
  - `evidence.mode` prefs key (shipped inert in S01 T04). T01 wires consumption.
- **Asset Map reuse:**
  - `scripts/forge-hook.js` (extend PostToolUse branch — NOT a new script).
  - `scripts/forge-must-haves.js --check` (T04 shell-out).
  - YAML frontmatter extract idiom from `scripts/forge-verify.js` lines 420–466 (T03 — adapt for `verification_evidence:` field).
- **Pattern Catalog:** "Hook script lifecycle" (extend) + "events.jsonl append" (hook convention is the silent-fail variant; evidence log follows hook convention, NOT telemetry convention).
- **Forward intelligence for S03:** evidence-{T##}.jsonl becomes optional corroborating input for the verifier's Wired level. Keep the JSONL shape additive — S03 may read it, not rewrite it.

## Notes

- **No new hook registration.** D1 keeps evidence inside the existing PostToolUse branch — `merge-settings.js` already registers it.
- **`strict` mode is reserved.** SCOPE describes `strict` as "mismatches block complete-slice" for M004+. In M003, T01 writes the log identically for lenient and strict; T03 writes `## Evidence Flags` identically. The actual "block" behavior is not shipped in this slice — the pref flag exists and is read, but the conditional is inert.
- **`disabled` mode is shipped live.** T01 must check `evidence.mode: disabled` and return early from the PostToolUse evidence branch. Still writes dispatch-tracking state for the Agent tool (that branch is separate).
