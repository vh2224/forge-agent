---
id: S01
milestone: M001
provides:
  - PostCompact lifecycle hook handler in forge-hook.js
  - compact-signal.json written on context compaction when forge-auto is active
  - PostCompact registered in merge-settings.js LIFECYCLE_HOOKS array
  - Idempotent hook registration and removal for PostCompact event
  - Compact recovery check at the start of every forge-auto dispatch loop iteration
  - Transparent re-initialization of PREFS, EFFORT_MAP, THINKING_OPUS, ALL_MEMORIES from disk
  - Single-line recovery emission before resuming the loop
  - AUTO indicator remains active throughout recovery (auto-mode.json never set to false)
key_files:
  - scripts/forge-hook.js
  - scripts/merge-settings.js
  - commands/forge-auto.md
  - .gsd/milestones/M001/slices/S01/S01-PLAN.md
key_decisions:
  - PostCompact handler writes compact-signal.json only when auto-mode.json has active:true — no-op otherwise
  - Signal file is deleted immediately after recovery to prevent re-triggering on the next iteration
  - Recovery is transparent: emits one status line and continues, never pausing to ask the user
  - COMPACTION RESILIENCE behavioral rule retained in forge-auto.md as fallback for Claude Code versions without PostCompact support
  - PostCompact follows the same try/catch silent-failure pattern as PreCompact — hooks must never crash
patterns_established:
  - Disk-signal recovery pattern: hook writes JSON signal → orchestrator reads/deletes on next iteration
  - All new lifecycle hooks follow the LIFECYCLE_HOOKS array pattern in merge-settings.js for idempotent registration
---

PostCompact Recovery wires a new Claude Code lifecycle hook to a disk signal that lets forge-auto transparently re-initialize its in-memory state and continue the dispatch loop after an automatic context compaction, with no user intervention required.

## What Was Built

Three files were modified to implement a complete round-trip recovery path for forge-auto after Claude Code auto-compacts the conversation context.

**T01 — forge-hook.js PostCompact handler:** A new `post-compact` phase block was added after the existing `pre-compact` block. When Claude Code fires the PostCompact lifecycle event, the handler reads `.gsd/forge/auto-mode.json`. If `active === true`, it writes `.gsd/forge/compact-signal.json` with three fields: `recovered_at` (epoch ms timestamp), `milestone` (from auto-mode state), and `worker` (the unit that was running). If forge-auto is not active, the handler exits without writing anything. The handler follows the same silent try/catch pattern as all other hooks — it never throws or crashes Claude Code.

**T02 — merge-settings.js PostCompact registration:** A single entry `{ event: 'PostCompact', phase: 'post-compact' }` was appended to the `LIFECYCLE_HOOKS` array after the existing `PreCompact` entry. The existing `mergeLifecycleHook` function handles registration and the existing `--remove` path handles cleanup — both already iterated over `LIFECYCLE_HOOKS`, so no additional logic was needed. Registration is idempotent: running `node merge-settings.js` multiple times produces exactly one PostCompact hook entry in `settings.json`.

**T03 — forge-auto.md compact-signal detection:** A "Compact recovery check" subsection was inserted as the very first step inside `#### 1. Derive next unit`. On each loop iteration, the orchestrator runs `cat .gsd/forge/compact-signal.json 2>/dev/null`. If the file exists, the orchestrator: (1) re-reads STATE.md, all three pref layers, AUTO-MEMORY.md, and CODING-STANDARDS.md; (2) re-derives EFFORT_MAP and THINKING_OPUS; (3) resets `session_units = 0`; (4) deletes the signal file; (5) emits `↺ Recovery pós-compactação — retomando de: {next_action}` and continues the loop normally. The existing COMPACTION RESILIENCE behavioral rule was intentionally kept as a fallback for Claude Code versions that do not fire the PostCompact event.

## Acceptance Criteria Status

| # | Criterion | Status |
|---|-----------|--------|
| 1 | PostCompact hook writes compact-signal.json with recovered_at, milestone, worker when active | PASS |
| 2 | PostCompact handler is a no-op when forge-auto is not active | PASS |
| 3 | merge-settings.js registers PostCompact hook event | PASS |
| 4 | forge-auto detects signal, re-reads all context, deletes signal, emits recovery message, continues | PASS |
| 5 | AUTO indicator remains active throughout recovery | PASS |

## drill_down_paths

- T01 detail: `.gsd/milestones/M001/slices/S01/tasks/T01/T01-SUMMARY.md`
- T02 detail: `.gsd/milestones/M001/slices/S01/tasks/T02/T02-SUMMARY.md`
- T03 detail: `.gsd/milestones/M001/slices/S01/tasks/T03/T03-SUMMARY.md`
