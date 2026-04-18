# T01: CHANGELOG.md v1.0.0 entry

status: DONE

**Slice:** S04  **Milestone:** M001

## Goal

Add the v1.0.0 release entry at the top of CHANGELOG.md documenting all changes from S01, S02, and S03.

## Must-Haves

### Truths
- CHANGELOG.md starts with a `## v1.0.0` heading (above the existing `## v0.7.3` entry)
- The entry contains three sub-sections: Breaking changes, Features, Architecture
- Breaking changes mentions `/forge` as the new entry point
- Features lists: PostCompact hook recovery, lean orchestrator, /forge REPL shell, skill migration (forge-auto, forge-task, forge-new-milestone)
- Architecture lists: compact-signal.json recovery flow, workers read own artifacts, /forge compact-safe budget

### Artifacts
- `CHANGELOG.md` — edited (add ~20-25 lines at top, no other changes)

### Key Links
- S01-SUMMARY.md → PostCompact recovery details
- S02-SUMMARY.md → lean orchestrator details
- S03-SUMMARY.md → /forge REPL and skill migration details

## Steps
1. Read `CHANGELOG.md` (first 5 lines to confirm current top entry)
2. Read S01-SUMMARY.md, S02-SUMMARY.md, S03-SUMMARY.md for accurate feature descriptions
3. Compose the v1.0.0 entry following the existing format (## version, ### sub-sections, - prefix per item)
4. Use today's date: 2026-04-15
5. Insert the new entry at the very top of the file, before the existing `## v0.7.3` entry
6. Verify the file still has all previous entries intact

## Standards
- **Target directory:** repo root (CHANGELOG.md)
- **Naming:** follow existing changelog format exactly — `## v1.0.0 (YYYY-MM-DD)`, `### Section`, `- item`
- **Lint command:** n/a (markdown file)

## Context
- The ROADMAP provides a draft entry under S04/T01 — use it as a starting template but enrich with details from the three SUMMARY files
- Use conventional commit prefixes in feature descriptions (feat:, fix:, refactor:) matching the existing changelog style
