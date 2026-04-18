---
id: S04
milestone: M001
provides:
  - v1.0.0 CHANGELOG entry with Breaking Changes, Features, and Architecture sections
  - README.md updated with /forge as primary entry point and commands/skills tables
  - git tag v1.0.0 on release commit covering all M001 changes (13 files)
  - CLAUDE.md updated with 5 v1.0 architecture decision blocks
key_files:
  - CHANGELOG.md
  - README.md
  - CLAUDE.md
key_decisions:
  - "CHANGELOG enriched from slice summaries rather than ROADMAP draft — accurate implementation-level descriptions"
  - "/forge added as first row in commands table; /forge-auto and /forge-new-milestone annotated as aliases"
  - "All M001 pending changes committed in a single release commit before tagging v1.0.0"
  - "Five new ### blocks appended to CLAUDE.md before Convenções de código — no existing content touched"
  - "git tag is annotated (not lightweight) with full release message"
patterns_established:
  - Release documentation sourced from slice summaries, not ROADMAP drafts
  - Single release commit bundles all pending changes before tag creation
---

S04 sealed the v1.0.0 release by documenting all M001 deliverables — CHANGELOG updated, README modernized, git tag created, and architecture decisions recorded in CLAUDE.md.

## What Was Built

S04 is the documentation and release-finalization slice for M001. All functional work was complete at the end of S03; this slice produced the artifacts that make v1.0.0 a durable, discoverable release.

T01 added a structured v1.0.0 entry at the top of CHANGELOG.md. The entry was composed from the actual slice summaries (S01–S03) rather than the ROADMAP draft, so the breaking changes and feature descriptions reflect the real implementation. Three sub-sections cover: Breaking Changes (two items — `/forge-auto` promoted to skill, orchestrator no longer inlines artifacts), Features (four items — PostCompact recovery, lean orchestrator, `/forge` REPL, skill migration), and Architecture (three items documenting the mechanism behind each pillar).

T02 updated README.md to reflect the new entry point. `/forge` replaced `/forge-auto` in the Quick Start block, `/forge` was added as the first row in the commands table with aliases noted for `/forge-auto` and `/forge-new-milestone`, and `forge-security` was added to the skills table.

T03 committed all M001 pending changes (13 files, 1375 insertions, including 3 new skill directories) in a single release commit, then created annotated tag `v1.0.0`. No code change to `forge-statusline.js` was needed — it already reads version from `git describe --tags --always`. The tag was not pushed; user pushes manually.

T04 appended five architecture decision blocks to CLAUDE.md's "Decisões de arquitetura recentes" section, covering PostCompact hook recovery, lean orchestrator (workers read own artifacts), `/forge` REPL as unified entry point, compact-safe token budget, and skill migration with command shims. All five blocks follow the existing `### Title` + paragraph style; no existing content was modified.

## Drill-down Paths

- T01 — CHANGELOG.md v1.0.0 entry: `.gsd/milestones/M001/slices/S04/tasks/T01/T01-SUMMARY.md`
- T02 — README.md update: `.gsd/milestones/M001/slices/S04/tasks/T02/T02-SUMMARY.md`
- T03 — git tag v1.0.0: `.gsd/milestones/M001/slices/S04/tasks/T03/T03-SUMMARY.md`
- T04 — CLAUDE.md architecture decisions: `.gsd/milestones/M001/slices/S04/tasks/T04/T04-SUMMARY.md`
