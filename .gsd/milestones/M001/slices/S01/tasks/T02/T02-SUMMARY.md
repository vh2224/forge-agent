---
id: T02
parent: S01
milestone: M001
provides: [PostCompact entry in LIFECYCLE_HOOKS array in merge-settings.js]
requires: []
affects: [scripts/merge-settings.js]
key_files: [scripts/merge-settings.js]
key_decisions: ["Added PostCompact after PreCompact entry, following identical object shape {event, phase} with aligned spacing"]
duration: 5min
verification_result: pass
completed_at: 2026-04-15T00:00:00Z
---

Single-line addition to `LIFECYCLE_HOOKS` in `scripts/merge-settings.js` registers the PostCompact lifecycle hook.

## What Happened

Added `{ event: 'PostCompact', phase: 'post-compact' }` to the `LIFECYCLE_HOOKS` array after the existing `PreCompact` entry. The `--remove` path iterates over `LIFECYCLE_HOOKS` automatically, so removal works without further changes. Verified idempotency (ran twice, PostCompact appears exactly once), verified all 5 previous hook events unchanged, and verified `--remove` cleans up PostCompact.

## Deviations

None.

## Files Created/Modified

- `scripts/merge-settings.js` — added one entry to `LIFECYCLE_HOOKS` array
