# S04: Release v1.0.0 — UAT Script

**Slice:** S04  **Milestone:** M001  **Written:** 2026-04-15

## Prerequisites

- Git repository with tag `v1.0.0` present (run `git tag` to confirm)
- Working directory is the root of `forge-agent`

## Test Cases

| # | Action | Expected | Pass? |
|---|--------|----------|-------|
| 1 | Run `git describe --tags` | Output is exactly `v1.0.0` (or `v1.0.0-N-gXXX` if commits were added after tagging) | |
| 2 | Open `CHANGELOG.md` and check the first heading | First entry is `## v1.0.0` — appears before the `## v0.7.3` entry | |
| 3 | In `CHANGELOG.md` v1.0.0 entry, verify three sub-sections exist | `### Breaking Changes`, `### Features`, `### Architecture` sub-sections are all present under v1.0.0 | |
| 4 | In `CHANGELOG.md` Breaking Changes, confirm two items listed | Items reference removal of artifact inlining from orchestrator and `/forge-auto` promoted to skill | |
| 5 | Open `README.md` Quick Start section | Code block shows `/forge` as the primary command (not `/forge-auto`) | |
| 6 | In `README.md` commands table, check first row | `/forge` is the first entry with description "Shell interativo — entry point principal" (or equivalent) | |
| 7 | In `README.md` commands table, check `/forge-auto` and `/forge-new-milestone` rows | Both rows include a note indicating they delegate to `/forge` | |
| 8 | In `README.md` skills table, search for `forge-security` | Row for `forge-security` is present with description about security analysis | |
| 9 | Open `CLAUDE.md`, search for "PostCompact" in the architecture decisions section | A `### PostCompact` (or equivalent) decision block exists in "Decisões de arquitetura recentes" | |
| 10 | In `CLAUDE.md`, search for "Lean Orchestrator" (or "lean orchestrator") | A decision block describing workers reading their own artifacts is present | |
| 11 | In `CLAUDE.md`, search for "/forge REPL" | A decision block describing the unified REPL entry point is present | |
| 12 | In `CLAUDE.md`, verify the five new decision blocks appear before `## Convenções de código` | All five v1.0 decision blocks are in the "Decisões de arquitetura recentes" section | |

## Notes

- Test cases 1 through 4 validate T03 (git tag) and T01 (CHANGELOG).
- Test cases 5 through 8 validate T02 (README).
- Test cases 9 through 12 validate T04 (CLAUDE.md).
- If `git describe --tags` returns a value like `v1.0.0-3-gabc1234`, the tag exists and is correct — the suffix indicates commits added after tagging (this is expected if slice-completion commits were made after T03).
- This UAT does not require running the forge agent itself — all checks are static file reads.
