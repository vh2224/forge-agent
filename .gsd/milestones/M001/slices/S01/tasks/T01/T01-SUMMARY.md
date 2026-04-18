---
id: T01
parent: S01
milestone: M001
provides: [post-compact handler in forge-hook.js that writes compact-signal.json when forge-auto is active]
requires: []
affects: [S01]
key_files: [scripts/forge-hook.js]
key_decisions: ["PostCompact handler placed after pre-compact block and before PreToolUse/PostToolUse section for logical grouping"]
duration: 5min
verification_result: pass
completed_at: 2026-04-15T00:00:00Z
---

Added `post-compact` handler to `forge-hook.js` that writes `.gsd/forge/compact-signal.json` with `recovered_at`, `milestone`, and `worker` fields when `auto-mode.json` has `active: true`.

## What Happened

1. Updated comment header to document `PostCompact → node ~/.claude/forge-hook.js post-compact`
2. Updated `phase` variable comment to include `'post-compact'` in the valid values list
3. Added `post-compact` handler block after the `pre-compact` block, following the same pattern (read `data.cwd`, try/catch fs reads, early return)
4. Verified syntax with `node -c` — passes cleanly

## Deviations

None.

## Files Created/Modified

- `scripts/forge-hook.js` — modified: added PostCompact handler (~18 lines)
