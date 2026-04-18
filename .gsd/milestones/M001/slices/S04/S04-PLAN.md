# S04 — Release v1.0.0

**Milestone:** M001  
**Depends:** S01, S02, S03  
**Risk:** low

## Goal

Document, version, and validate the v1.0.0 release. All functional work is done in S01-S03; this slice updates documentation, changelog, version string, and architecture decisions.

## Tasks

- [ ] **T01: CHANGELOG.md v1.0.0 entry** — Add v1.0.0 entry at top of CHANGELOG.md with breaking changes, features, and architecture sections
- [ ] **T02: README.md update** — Update entry point from /forge-auto to /forge, update commands table, add architecture notes
- [ ] **T03: forge-statusline.js version bump** — Tag the repo as v1.0.0 so git describe returns the correct version
- [ ] **T04: CLAUDE.md architecture decisions** — Add v1.0 architecture decisions to the "Decisoes de arquitetura recentes" section

## Acceptance Criteria

- CHANGELOG.md has a v1.0.0 entry at the top with breaking changes, features, and architecture sub-sections
- README.md shows /forge as the primary entry point and documents the new architecture
- `git describe --tags` returns v1.0.0 (or v1.0.0-N-gXXX if commits follow the tag)
- CLAUDE.md documents PostCompact recovery, lean orchestrator, /forge REPL, and skill migration decisions

## Notes

- All four tasks are independent of each other — no ordering required
- T03: the statusline reads version from `git describe --tags`, not from a hardcoded string or package.json. The correct action is to create a git tag, not edit the JS file.
