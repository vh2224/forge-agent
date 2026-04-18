---
id: M001
title: "Forge v1.0: Autonomous, Shell-first, Context-aware"
status: complete
version: v1.0.0
slices:
  - S01: PostCompact Recovery
  - S02: Lean Orchestrator
  - S03: /forge REPL Shell
  - S04: Release v1.0.0
provides:
  - PostCompact lifecycle hook writes compact-signal.json when forge-auto is active
  - forge-auto dispatch loop detects signal, re-initializes from disk, continues transparently
  - Lean orchestrator: all 24 artifact-inline placeholders replaced with Read path directives
  - Per-unit orchestrator token growth reduced from ~10-50K to ~500 tokens
  - /forge unified REPL entry point (126 lines, <5K tokens, compact-safe)
  - forge-auto, forge-task, forge-new-milestone migrated to skills/ with disable-model-invocation
  - commands/ shims forward $ARGUMENTS — backward compatibility preserved
  - v1.0.0 CHANGELOG, README update, annotated git tag, CLAUDE.md architecture records
key_files:
  - scripts/forge-hook.js
  - scripts/merge-settings.js
  - commands/forge.md
  - commands/forge-auto.md
  - shared/forge-dispatch.md
  - skills/forge-auto/SKILL.md
  - skills/forge-task/SKILL.md
  - skills/forge-new-milestone/SKILL.md
  - CHANGELOG.md
  - README.md
key_decisions:
  - PostCompact handler is a no-op unless auto-mode.json has active:true — zero interference with non-auto sessions
  - Workers read their own artifacts via Read tool; orchestrator substitutes only small scalar values
  - /forge REPL kept under 300 lines so it survives context compaction within the re-attachment token budget
  - Command-to-skill migration: body moves to skills/forge-*/SKILL.md; command file becomes a 6-7 line shim
  - CHANGELOG sourced from slice summaries rather than ROADMAP draft — accurate implementation-level descriptions
patterns_established:
  - Disk-signal recovery: hook writes JSON signal → orchestrator reads/deletes on next loop iteration
  - Lean template: "{content of X}" → "Read: {WORKING_DIR}/path/to/X" keeps orchestrator token-stable
  - Compact-safe REPL: bootstrap guard + compact recovery check per iteration + AskUserQuestion dispatch
  - Command/skill split: heavy logic in skills/, thin shims in commands/ for backward compatibility
---

M001 transformed forge-auto from a loop that silently died after ~11 units into a system that runs an entire milestone autonomously — by fixing context explosion at the architectural level rather than relying on behavioral prompting.

## What Was Built

M001 addressed a single critical failure: `forge-auto` stopped working after roughly 11 units because the orchestrator inlined full artifact file contents into every worker prompt, accumulating ~10-50K tokens per unit until Claude Code auto-compacted the context and erased the orchestrator's in-memory state. There was no recovery mechanism. The loop simply died.

Four slices attacked this problem at three layers: recovery infrastructure, token reduction, entry point redesign, and release documentation.

**S01 — PostCompact Recovery** wired a new Claude Code lifecycle hook (`PostCompact`) to a disk-based signal file. When Claude Code fires the event, `forge-hook.js` checks whether forge-auto is active (via `auto-mode.json`) and writes `.gsd/forge/compact-signal.json` if so. On the next dispatch loop iteration, `forge-auto.md` reads this signal, re-initializes all in-memory state from disk (STATE, PREFS, EFFORT_MAP, THINKING_OPUS, ALL_MEMORIES), deletes the signal, emits one recovery line, and continues. The `▶ AUTO` indicator never goes dark. The behavioral COMPACTION RESILIENCE rule was kept as fallback for Claude Code versions without PostCompact support.

**S02 — Lean Orchestrator** eliminated the root cause of token growth. All 24 `{content of path/to/file}` placeholders across the seven worker prompt templates in `shared/forge-dispatch.md` were replaced with `Read:` or `Read if exists:` path directives. Workers already had access to the `Read` tool in their isolated contexts — switching from inlined content to path directives is transparent to behavior but means the orchestrator never sees file content. Per-unit orchestrator token growth dropped from ~10-50K to ~500 tokens. The only values that remain inlined are small scalars: path tokens (`{WORKING_DIR}`, `{M###}`, `{S##}`, `{T##}`), config flags, and preprocessed memory/coding-standards snippets — collectively a few hundred tokens, not tens of thousands.

**S03 — /forge REPL Shell** introduced the new primary entry point: `commands/forge.md` (126 lines, well under the 5K-token compaction budget). It is a compact-safe REPL router: bootstrap guard → load STATE.md → auto-resume check → persistent `AskUserQuestion` menu with compact recovery check per iteration. The three heaviest commands — `forge-auto`, `forge-task`, `forge-new-milestone` — were migrated bodily into `skills/forge-*/SKILL.md` files with `disable-model-invocation: true`. Their original command files became 6-7 line shims that forward `$ARGUMENTS`, preserving full backward compatibility. The install scripts required zero edits — existing broad globs already covered the new skill directories.

**S04 — Release v1.0.0** produced the documentation layer: a structured CHANGELOG entry (sourced from slice summaries, not the ROADMAP draft), a README update positioning `/forge` as the primary entry point, five architecture decision blocks appended to CLAUDE.md, and an annotated git tag `v1.0.0` on the release commit (13 files, 1375 insertions). The `forge-statusline.js` version indicator required no change — it already reads from `git describe --tags --always`.

## Architecture Decisions

| Decision | Choice | Discarded alternative |
|----------|--------|-----------------------|
| Context management | Lean orchestrator (workers read their own artifacts) | Unit-orchestrators via Agent() — subagents cannot spawn subagents |
| Post-compact recovery | PostCompact hook → compact-signal.json | Inline compaction resilience only — fragile |
| Entry point | `/forge` REPL thin router (<5K tokens) | Keep 20 separate commands |
| Compact survival | `/forge` < 5K tokens (within compaction re-attachment budget) | Dispatch table in CLAUDE.md |
| Command migration | `skills/` with `disable-model-invocation: true` + shims in `commands/` | Full big-bang migration |

## drill_down_paths

- S01: `.gsd/milestones/M001/slices/S01/S01-SUMMARY.md`
- S02: `.gsd/milestones/M001/slices/S02/S02-SUMMARY.md`
- S03: `.gsd/milestones/M001/slices/S03/S03-SUMMARY.md`
- S04: `.gsd/milestones/M001/slices/S04/S04-SUMMARY.md`
