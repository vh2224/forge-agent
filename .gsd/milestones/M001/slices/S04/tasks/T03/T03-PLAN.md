# T03: Version bump to v1.0.0

status: DONE

**Slice:** S04  **Milestone:** M001

## Goal

Create a git tag `v1.0.0` so that `git describe --tags` returns the correct version string, which the statusline script uses to display the Forge version.

## Must-Haves

### Truths
- Running `git describe --tags` in the repo root returns `v1.0.0` (or `v1.0.0-N-gXXX` if commits follow)
- The statusline script (`scripts/forge-statusline.js`) requires NO code changes — it already reads version from `git describe`
- The tag is an annotated tag (not lightweight) for consistency with existing tags

### Artifacts
- Git tag `v1.0.0` — created via `git tag -a v1.0.0 -m "Release v1.0.0"`

### Key Links
- `scripts/forge-statusline.js` line 162 → uses `git describe --tags --always` to get version

## Steps
1. Read `scripts/forge-statusline.js` lines 160-172 to confirm it uses `git describe --tags`
2. Run `git tag -l "v*"` to see existing tags and confirm v1.0.0 does not exist yet
3. Ensure all S04 changes (T01, T02, T04) are committed first — if not, note this task should run last
4. Create annotated tag: `git tag -a v1.0.0 -m "Release v1.0.0 — PostCompact recovery, lean orchestrator, /forge REPL shell"`
5. Verify: `git describe --tags` outputs `v1.0.0`
6. Do NOT push the tag — that happens via the completer or manually

## Standards
- **Target directory:** n/a (git operation, no file changes)
- **Naming:** `v1.0.0` — lowercase v, semver format, matching existing tag pattern
- **Lint command:** n/a

## Context
- The statusline version display uses `git describe --tags --always` with a regex reformat: `v0.19.0-3-gabcdef` becomes `v0.19.0.3`. For a clean tag on HEAD, it just returns `v1.0.0` as-is.
- This task MUST run after T01, T02, and T04 are committed, so the tag points to the final release commit. The executor should check and stage/commit any pending changes before tagging.
- Do NOT edit forge-statusline.js — no code change needed.
