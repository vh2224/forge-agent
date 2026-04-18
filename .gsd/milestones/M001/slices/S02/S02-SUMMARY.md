---
id: S02
milestone: M001
provides:
  - "shared/forge-dispatch.md: all 7 templates rewritten — {content of ...} placeholders replaced with Read/Read if exists path directives"
  - "commands/forge-auto.md: Step 3 now substitutes placeholders only; artifact inlining removed"
  - "commands/forge-next.md: Step 3 mirrors forge-auto.md; selective memory injection block preserved"
  - "Lean orchestrator pattern: workers read their own artifacts via Read tool in their isolated context"
  - "Optional artifacts use 'Read if exists:' — workers skip gracefully if file absent"
  - "Small preprocessed values (TOP_MEMORIES, CS_*, WORKING_DIR, M###, S##, T##, config vars) remain inlined"
key_files:
  - shared/forge-dispatch.md
  - commands/forge-auto.md
  - commands/forge-next.md
key_decisions:
  - "Workers now read their own artifacts via Read/Read if exists path directives; orchestrator no longer inlines KB of content per unit"
  - "Mandatory artifacts use 'Read and follow:' or 'Read:'; optional ones use 'Read if exists:' with section-extraction notes inline"
  - "The single-line artifact-read instruction in both forge-auto.md and forge-next.md replaced with an explicit 14-line placeholder substitution list"
  - "forge-next.md retains its selective memory injection block (not present in forge-auto.md) — it was untouched"
patterns_established:
  - "Lean template pattern: {content of X} → 'Read: {WORKING_DIR}/path/to/X' keeps templates stable across milestones"
  - "Two-tier artifact classification: always-read (mandatory) vs. read-if-exists (optional) declared per template block"
---

Removed artifact inlining from the orchestrator dispatch loop — workers now read their own context files, cutting per-unit token growth from ~10–50K down to ~500 tokens.

## What Was Built

The orchestrator was the primary cause of context explosion: every unit prompt included the full text of multiple `.gsd/` files, accumulating tokens at every loop iteration. S02 eliminates that inlining entirely.

`shared/forge-dispatch.md` was the single change point for all 7 worker prompt templates. Each template had multiple `{content of path/to/file}` placeholders that the orchestrator expanded before dispatch. T01 rewrote all 24 such placeholders into `Read:` or `Read if exists:` directives — a one-line instruction that the worker's own `Read` tool resolves inside its isolated context. The orchestrator never sees the file content; it only passes the path.

T02 and T03 cleaned up the dispatch loops themselves. Both `forge-auto.md` and `forge-next.md` had a Step 3 instruction that read artifact files and inlined their content. That instruction was replaced with an explicit list of the small values that legitimately remain inlined: path substitutions (`{WORKING_DIR}`, `{M###}`, `{S##}`, `{T##}`), config values (`{auto_commit}`, `{milestone_cleanup}`), and the preprocessed memory/coding-standards snippets (`{TOP_MEMORIES}`, `{CS_LINT}`, `{CS_STRUCTURE}`, `{CS_RULES}`) — collectively a few hundred tokens, not tens of thousands.

The installed copy at `~/.claude/forge-dispatch.md` was updated in T01. Workers function identically — the Read tool is available in every worker context, so switching from inlined content to path directives is transparent to behavior.

## Drill-down Paths

- T01: `.gsd/milestones/M001/slices/S02/tasks/T01/T01-SUMMARY.md` — template rewrite (24 placeholders, all 7 blocks)
- T02: `.gsd/milestones/M001/slices/S02/tasks/T02/T02-SUMMARY.md` — forge-auto.md Step 3 cleanup
- T03: `.gsd/milestones/M001/slices/S02/tasks/T03/T03-SUMMARY.md` — forge-next.md Step 3 cleanup
