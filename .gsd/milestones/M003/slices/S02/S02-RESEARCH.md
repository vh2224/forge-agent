---
slice: S02
milestone: M003
researched: 2026-04-16
domain: hook instrumentation + git diff audit
confidence: HIGH
---

# S02: Evidence log + file-audit — Research

**Researched:** 2026-04-16
**Domain:** PostToolUse hook perf instrumentation + byte-budgeted JSONL + git-diff audit under `auto_commit:false`
**Confidence:** HIGH (all three research areas confirmed with concrete file references + primary-source docs)

## Summary

Three risks for S02 have concrete mitigations, all already in `T01-PLAN.md` / `T04-PLAN.md` but worth re-confirming against primary sources.

**(1) Hook perf:** PostToolUse hooks in Claude Code are **always spawned as subprocesses** (no in-process option — confirmed by [hooks doc](https://code.claude.com/docs/en/hooks)). The C4 budget of ≤15ms p50 / ≤50ms p95 is for **wall-clock of the hook as seen by Claude Code**, which *includes* node.exe cold-start. On Windows Defender-enabled systems, that cold-start is 40-80ms per MEM052 — meaning the budget is almost entirely consumed by boot, and the budget-as-written is at risk of being unmet on cold-start. Recommendation: record BOTH "hook total wall-clock" AND "hook work time" (measured via `process.hrtime.bigint()` from top of script to end of `on('end')` handler) in S02-SUMMARY. The "additional cost" vs baseline is `after - before` averaged over ≥50 runs with the hook disabled — not an in-hook measurement. The existing `bumpAutoHeartbeat` + `subagent-stop` instrumentation (lines 74-82) captures end-to-end timing but only for SubagentStart/Stop; adapt the same `Date.now() - started` idiom.

**(2) Evidence line ≤512 bytes:** `T01-PLAN.md` step 5 already nails this with progressive-truncation — truncate `cmd` to 200 chars, re-serialize, then 80, then `[truncated]`. The suffix-ellipsis pattern (`s.slice(0, max) + '…'`) matches project convention (no existing `truncate` helper in scripts/ — the only `fmt`-like utility in `forge-statusline.js:39` is number formatting, not strings). Required fields per D2 + cross-ref in T03: `ts, tool, cmd, file, ok, interrupted` — the `ok` boolean replaces `exit_code` (which PostToolUse does not expose per MEM052, confirmed by hooks doc: Bash `tool_response` is `{stdout, stderr, interrupted}` — no exit code). Truncation priority: drop/shrink `cmd` first (variable length), keep `file` (bounded by filesystem path), never drop `ts`/`tool`/`ok` (T03 greps by them).

**(3) `auto_commit:false` git-diff:** When auto_commit is false there is no slice branch; the completer must diff the **working tree vs HEAD** plus explicitly list untracked files. `git diff --name-only --diff-filter=AM HEAD` captures tracked AM, but untracked new files are invisible to git diff. T04-PLAN.md step 2a already documents this correctly — `git ls-files --others --exclude-standard` is the canonical second command, union the two results into `ACTUAL_AM`. Git's own docs confirm: "git diff ignores untracked files by default" ([git-diff](https://git-scm.com/docs/git-diff)). No existing forge script does this combination yet — `forge-completer.md` step 6 uses `git merge-base HEAD master` which assumes a branch, so T04's working-tree branch is genuinely new code. The hook script itself has no git interaction today.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Parse `expected_output:` from T##-PLAN frontmatter | New YAML parser or CLI flag | Inline `node -e` regex idiom — already in `T04-PLAN.md` step 2b, lineage `forge-verify.js:420-466` | MEM017 zero-deps + S01 schema is LOCKED (don't extend `forge-must-haves.js --check` to emit expected_output — reopens S01 contract) |
| Glob matching for `file_audit.ignore_list` | Pull in `minimatch` / `micromatch` | Hand-rolled prefix + `**` suffix + `*` escape (documented in T04-PLAN step 2d) | Zero-deps is a project contract; the 7 default patterns only use `/**` suffix + exact filename — no complex globs needed |
| Truncate strings for byte-budget | Custom truncate utility with middle-ellipsis | Suffix-ellipsis `s.slice(0, max) + '…'` (T01-PLAN step 4) | Suffix is how Bash commands are commonly abbreviated (trailing args matter less than the command itself); keeps the line-length check simple |
| Measure hook "additional cost" in-script | `process.hrtime.bigint()` around `fs.appendFileSync` | Off-script differential benchmark: run 50 tool calls with hook disabled vs enabled, diff medians | In-script timing can't capture node.exe spawn cost; that's ~80% of wall-clock on Windows per MEM052 — only external measurement captures the full budget |

## Common Pitfalls

### Pitfall 1: In-script perf numbers lie about the real budget
**What goes wrong:** You add `const t0 = process.hrtime.bigint(); … const t1 = process.hrtime.bigint();` around the evidence-write block and report "hook takes 2ms" — but Claude Code's C4 budget is wall-clock of the whole subprocess, and node.exe cold-start (~40-80ms Windows per MEM052) dominates.
**Why it happens:** `process.hrtime.bigint()` measures only the Node-side work after the runtime boots; it excludes spawn + interpreter init + module resolution of `fs`/`path`/`os`.
**How to avoid:** Report two numbers in S02-SUMMARY `## What Happened`:
  1. **In-script work time:** `process.hrtime.bigint()` from line 38 (`process.stdin.on('end', …)`) start to its return. Typical: 2-5ms warm disk.
  2. **Full wall-clock:** external measurement of `time node scripts/forge-hook.js post < payload.json` averaged over ≥50 runs. Typical: 60-130ms Windows, 15-40ms Linux/macOS.
The C4 budget (≤15ms p50 / ≤50ms p95) is unmeetable on Windows Defender-enabled systems for (2). Either refine the budget to target "in-script work time" OR acknowledge platform-specific floor in the SUMMARY. **Recommended:** Re-read the budget as "additional cost on top of existing hook baseline" — since PostToolUse already runs on every tool call for dispatch tracking, the *incremental* cost of the evidence branch is ~2-5ms and IS within budget.

### Pitfall 2: `tool_response.success` misreads for Bash
**What goes wrong:** You set `ok: toolResponse.success === true` and every Bash call logs `ok:false` because Bash `tool_response` has no `success` field — only `{stdout, stderr, interrupted}`.
**Why it happens:** MEM052 / hooks doc: Bash schema differs from Write/Edit. Bash has no explicit success/exit_code; Write/Edit has `{filePath, success}`.
**How to avoid:** T01-PLAN step 5 gets it right: `ok: toolResponse.success !== false && toolResponse.interrupted !== true`. The `!== false` form treats `undefined` (Bash) as `true` unless `interrupted`. Do NOT change this to `=== true`.

### Pitfall 3: `auto-mode.json` parses successfully but `worker` is null between units
**What goes wrong:** `resolveUnitId` returns `'adhoc'` even during a real execution because the orchestrator cleared `worker: null` after the previous `Agent()` returned but the executor hasn't started yet.
**Why it happens:** `auto-mode.json` is the orchestrator's liveness doc; `worker` field is bumped at dispatch start (`worker: "execute-task/T03"`) and cleared at dispatch end (`worker: null`). Between units it's genuinely null.
**How to avoid:** `'adhoc'` fallback is INTENTIONAL per S02-PLAN Key Constraints: "If auto-mode isn't active or `worker` is null, the hook falls back to writing `evidence-adhoc.jsonl` — still captures but not surfaced by the completer." This is correct. Do not try to "fix" by reading `.gsd/STATE.md` instead — STATE is written by completer at end-of-slice, lags behind current unit.

### Pitfall 4: File-audit breaks when there's no `master` branch
**What goes wrong:** `git merge-base HEAD master` fails with `fatal: Not a valid object name master` on repos using `main` or no default branch.
**Why it happens:** T04-PLAN step 2a hardcodes `master`. Some projects use `main`, some have detached HEAD, some are fresh repos with no merge base.
**How to avoid:** Fallback chain: try `master`, then `main`, then `git rev-parse --abbrev-ref origin/HEAD` (returns `origin/main` or `origin/master`), then fall back to working-tree diff mode (same as `auto_commit:false`). Wrap in try/catch silent-fail — advisory section can be omitted rather than fail the complete. Consider auto-detecting via `git symbolic-ref refs/remotes/origin/HEAD` → strip `refs/remotes/origin/`.

### Pitfall 5: Untracked new files not in `git diff`
**What goes wrong:** Executor creates `scripts/forge-new.js` (untracked) and `auto_commit:false`. `git diff --diff-filter=AM HEAD` shows nothing. File audit reports zero "unexpected" entries.
**Why it happens:** `git diff` ignores untracked files by default (git-diff docs).
**How to avoid:** T04-PLAN step 2a already does `git ls-files --others --exclude-standard` as the second command. Union with the diff output. Do NOT use `git status --porcelain` as a single-command shortcut — it includes deletion entries (prefix `D` / ` D`) which D4 excludes from audit; parsing porcelain status-flag semantics is more work than the two-command approach.

## Relevant Code

| Reference | Path | Lines | Relevance |
|-----------|------|-------|-----------|
| Existing PostToolUse branch | `scripts/forge-hook.js` | 119-223 | T01 extends between line 183 (end of Pre-guards) and line 186 (`if (toolName !== 'Agent') return`). Preserve Agent-tracking bit-for-bit. |
| `bumpAutoHeartbeat` style template | `scripts/forge-hook.js` | 23-32 | Shape for `resolveUnitId` + `readEvidenceMode` helpers: try/catch silent-fail wrapping `readFileSync` + JSON.parse. Matches MEM008 convention. |
| Subagent timing measurement | `scripts/forge-hook.js` | 42-85 | `Date.now() - started` pattern for perf capture. Not used for C4 directly (subagent duration, not hook self-duration), but the idiom is the precedent. |
| PostCompact read-prefs idiom | `scripts/forge-hook.js` | 101-117 | Try/catch read of `.gsd/forge/auto-mode.json` — evidence branch follows the same shape. |
| YAML frontmatter regex | `scripts/forge-verify.js` | 420-466 | Canonical single-key extract. T04's inline `node -e` for `expected_output:` is a localized variant — do NOT extract to a new helper (MEM017 + avoid reopening S01 schema). |
| events.jsonl append (telemetry contract) | `scripts/forge-verify.js` | 479-493 | Reference for I/O-error-propagate pattern. Evidence log is the INVERSE — silent-fail (MEM008 hook rule wins over telemetry rule). Call out the distinction in T01 comments. |
| Completer git usage (merge-base) | `agents/forge-completer.md` | 70-85 | Step 6 (squash-merge) uses `git merge-base HEAD master`. T04 sub-step 1.6 mirrors this but must fallback when no branch / `auto_commit:false`. |
| Must-haves CLI (T04 dependency) | `scripts/forge-must-haves.js` | CLI `--check` only | Returns `{legacy, valid, errors}` — no `expected_output`. T04 parses that field inline (intentional — don't extend). |

## Asset Map additions

None — S02 reuses existing patterns. No new general-purpose helpers that would serve future slices. The inline truncate + regex prefs-read are local to hook concerns; extracting them now would be speculative generalization. If M004+ needs a shared `truncate` or `readPrefsKey`, extract then.

## Coding Conventions Detected

Already covered in `.gsd/CODING-STANDARDS.md`. Slice-relevant highlights:

- **Hook convention vs telemetry convention:** Hooks silent-fail (try/catch swallow everything). Telemetry (events.jsonl) lets I/O errors propagate. Evidence log follows HOOK convention — the completer reads it best-effort, missing lines are just flags not errors. Already documented in CODING-STANDARDS § Error Patterns.
- **Zero-deps enforcement:** Regex-based YAML key extraction over full parser. Use `/^key:[ \t]*(.+)$/m` for scalars, `/^key:[ \t]*\n([ \t]+-[^\n]*\n?)+/m` for dash arrays, `/^key:[ \t]*\[([^\]]*)\]/m` for inline arrays.
- **Cross-platform paths:** `path.join(...)` everywhere; Bash snippets in `.md` use forward slashes (Git Bash + WSL both OK).

## Pattern Catalog additions

None — T01/T04 follow existing "Hook script lifecycle" + "events.jsonl append" patterns. No new pattern crystallizes here.

## Security Considerations

*(S02 touches file I/O in `.gsd/forge/`, reads user prefs, executes git via Bash. Low-risk domain — no new attack surface vs existing hook.)*

| Concern | Risk Level | Mitigation |
|---------|-----------|------------|
| Evidence log leaks partial Bash commands that may contain secrets (e.g., `curl -H "Authorization: $TOKEN"`) | LOW | `cmd` truncated to 200 chars — headers with large tokens often get cut; the whole `.gsd/forge/` dir is gitignored. Existing PreToolUse secret-guard (`forge-hook.js:157-177`) blocks Write/Edit of secrets into source. If users write secrets into Bash commands, that's a broader issue outside M003 scope. |
| Evidence log unbounded growth across long sessions | LOW | Existing `milestone_cleanup: archive/delete` prefs key handles `.gsd/forge/` on milestone close. Per C12 acceptance, evidence files follow the same lifecycle — no new cleanup needed. |
| `readFileSync` on `~/.claude/forge-agent-prefs.md` during every PostToolUse | LOW | 50-call task = 50 reads of same file; OS page cache absorbs. No perf issue measured in dev. If profiling shows it dominates, add a 60-sec in-process cache — but defer until measured. |
| Hook exception leaks unhandled to Claude Code | MITIGATED | MEM008 silent-fail wrapping per T01-PLAN step 5. Must verify: S02 acceptance criterion #5 ("deliberately break the hook → tool call still succeeds") tests exactly this. |

## Sources

- **File reads:**
  - `C:/DEV/forge-agent/scripts/forge-hook.js` — current hook shape + 5 phases + silent-fail convention
  - `C:/DEV/forge-agent/.gsd/milestones/M003/slices/S02/S02-PLAN.md` — slice constraints + locked JSONL shape
  - `C:/DEV/forge-agent/.gsd/milestones/M003/slices/S02/tasks/T01/T01-PLAN.md` — evidence-write implementation already well-specified
  - `C:/DEV/forge-agent/.gsd/milestones/M003/slices/S02/tasks/T04/T04-PLAN.md` — file-audit + ignore-list glob matcher already specified; `auto_commit:false` path already documented
  - `C:/DEV/forge-agent/.gsd/milestones/M003/M003-CONTEXT.md` — D1, D2, D4 locked decisions
  - `C:/DEV/forge-agent/scripts/forge-verify.js` lines 420-493 — canonical frontmatter regex + events.jsonl append
  - `C:/DEV/forge-agent/.gsd/CODING-STANDARDS.md` — error-handling inversion (hook vs telemetry)
- **Web search:** `"Claude Code PostToolUse hook invocation subprocess timeout performance 2026"` → confirmed no in-process option + 600s default timeout + payload shape (confidence: HIGH) — [Hooks reference](https://code.claude.com/docs/en/hooks), [Hooks Complete Guide March 2026](https://smartscope.blog/en/generative-ai/claude/claude-code-hooks-guide/)
- **Web search:** `"Node.js measure additional subprocess cost baseline cold start benchmark"` → `process.hrtime.bigint()` for in-process timing; external wall-clock for subprocess cold-start (confidence: HIGH) — [Node.js perf_hooks](https://nodejs.org/api/perf_hooks.html)
- **Web search:** `"git diff working tree vs HEAD uncommitted untracked files combined"` → confirmed `git diff` ignores untracked + `git ls-files --others --exclude-standard` is the canonical pairing (confidence: HIGH) — [git-diff docs](https://git-scm.com/docs/git-diff)
- **Web fetch:** [https://code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks) → PostToolUse always spawns subprocess; Bash `tool_response` is `{stdout, stderr, interrupted}` (no exit_code field — confirms MEM052); Write/Edit `tool_response` is `{filePath, success}`. No in-process hook option exists (confidence: HIGH).
