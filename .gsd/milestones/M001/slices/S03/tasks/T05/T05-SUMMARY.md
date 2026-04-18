---
id: T05
parent: S03
milestone: M001
provides:
  - Verified install.sh skills glob covers forge-auto, forge-task, forge-new-milestone
  - Verified install.ps1 skills glob covers the same three directories
  - Verified commands/forge.md is picked up by forge*.md glob
  - Confirmed no form-feed (0x0C) bytes in install.ps1
requires: []
affects: []
key_files:
  - install.sh
  - install.ps1
key_decisions:
  - "No edits required: existing broad globs in both scripts already cover all new skill directories"
duration: 5min
verification_result: pass
completed_at: 2026-04-15T16:38:00Z
---

Both install scripts already handle the three new skill directories via existing broad globs — no changes required.

## What Happened

1. Read `install.sh` lines 149-161: glob `"${REPO_DIR}/skills"/*/` iterates every subdirectory under `skills/`, copying to both `~/.agents/skills/` and `~/.claude/skills/`. This already covers `forge-auto`, `forge-task`, and `forge-new-milestone`.

2. Read `install.ps1` lines 121-133: `Get-ChildItem "$RepoDir\skills" -Directory` enumerates every skills subdirectory. Same coverage.

3. Confirmed `commands/forge.md` exists and is picked up by the `forge*.md` glob used in both scripts (the filename starts with `forge`).

4. Ran `bash install.sh --dry-run --update` — dry-run output explicitly listed all three new skills: `forge-auto`, `forge-new-milestone`, `forge-task`, and `commands/forge.md`.

5. Scanned `install.ps1` for form-feed bytes (0x0C) using Node.js binary read — zero occurrences found.

## Deviations

None. Task was verification-only as predicted by MEM016 and the task context.

## Files Created/Modified

- No files modified (verification task)
- `T05-PLAN.md` — status updated to DONE
- `T05-SUMMARY.md` — created (this file)
