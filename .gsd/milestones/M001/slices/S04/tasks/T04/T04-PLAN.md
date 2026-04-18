# T04: CLAUDE.md architecture decisions for v1.0

status: DONE

**Slice:** S04  **Milestone:** M001

## Goal

Add five v1.0 architecture decisions to the "Decisoes de arquitetura recentes" section of CLAUDE.md.

## Must-Haves

### Truths
- Five new decision blocks are appended to the "Decisoes de arquitetura recentes" section
- Each block follows the existing format: `### Title` + paragraph explaining the decision and rationale
- Decisions cover: (1) PostCompact hook + compact-signal.json, (2) Lean orchestrator, (3) /forge REPL shell, (4) Skill migration with shims, (5) compact-safe token budget
- No existing decisions are modified or removed
- The section order is preserved (new entries appended at the end of the section, before the next `##` heading if any)

### Artifacts
- `CLAUDE.md` — edited (append ~40-50 lines to the architecture decisions section)

### Key Links
- M001-CONTEXT.md → canonical decisions list (## Decisions section)
- S01-SUMMARY.md → PostCompact hook implementation details
- S02-SUMMARY.md → lean orchestrator implementation details
- S03-SUMMARY.md → /forge REPL and skill migration details

## Steps
1. Read `CLAUDE.md` — find the "Decisoes de arquitetura recentes" section and identify where it ends
2. Read M001-CONTEXT.md `## Decisions` section for the canonical decision list
3. For each of the 5 decisions, write a block following the existing format in CLAUDE.md:
   - **PostCompact hook + compact-signal.json recovery** — PostCompact lifecycle hook writes compact-signal.json when forge-auto is active; orchestrator reads/deletes on next iteration to re-initialize state transparently
   - **Lean orchestrator (workers read own artifacts)** — Worker prompts receive file paths instead of inlined content; workers use Read tool in their isolated context. Reduces orchestrator context growth from ~10-50K/unit to ~500/unit
   - **/forge REPL shell as unified entry point** — Thin router < 5K tokens / < 300 lines. Survives compaction by fitting within Claude Code re-attachment budget. AskUserQuestion loop dispatches skills
   - **Skill migration with command shims** — forge-auto, forge-task, forge-new-milestone moved to skills/ with disable-model-invocation: true. Commands become one-line shims forwarding $ARGUMENTS
   - **Compact-safe token budget** — /forge.md stays under 5K tokens. Skills run in isolated context via Skill() tool. Post-compaction budget accommodates CLAUDE.md + /forge.md + re-attachment overhead
4. Append the 5 blocks at the end of the architecture decisions section
5. Verify no existing content was modified

## Standards
- **Target directory:** repo root (CLAUDE.md)
- **Naming:** section titles in Portuguese, matching existing style (e.g., "### PostCompact hook + compact-signal.json recovery")
- **Lint command:** n/a

## Context
- The existing architecture decisions section has ~30 entries. New entries go at the end.
- Each entry is a `### Title` followed by a short paragraph. No bullet lists within entries (follow existing pattern).
- The ROADMAP draft for T04 lists 5 items — map them to the canonical decisions from M001-CONTEXT.md.
