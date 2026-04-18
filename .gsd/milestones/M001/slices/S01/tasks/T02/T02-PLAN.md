# T02: merge-settings.js — register PostCompact event

**Slice:** S01  **Milestone:** M001

## Goal

Add `PostCompact` to the lifecycle hooks array in `merge-settings.js` so that running the script registers the PostCompact hook in `settings.json`.

## Must-Haves

### Truths
- After running `node scripts/merge-settings.js /tmp/test-settings.json`, the output file contains a `PostCompact` entry in `hooks` with command `node ~/.claude/forge-hook.js post-compact`
- Running the script twice does not duplicate the PostCompact entry (idempotent)
- Running with `--remove` cleans up the PostCompact entry along with all other forge hooks
- All 5 previous hook events (PreToolUse, PostToolUse, SubagentStart, SubagentStop, PreCompact) remain unchanged

### Artifacts
- `scripts/merge-settings.js` — modified (adds 1 line to the `LIFECYCLE_HOOKS` array)
  - New entry: `{ event: 'PostCompact', phase: 'post-compact' }`

### Key Links
- `scripts/merge-settings.js` generates `~/.claude/settings.json` entries that tell Claude Code to call `scripts/forge-hook.js post-compact` on the PostCompact lifecycle event
- The phase value `post-compact` must match exactly what `forge-hook.js` (T01) expects in `process.argv[2]`

## Steps

1. Read `scripts/merge-settings.js` to confirm current `LIFECYCLE_HOOKS` array location (already read — verify no changes)
2. Add one entry to the `LIFECYCLE_HOOKS` array (after line 38, the PreCompact entry):
   ```javascript
   { event: 'PostCompact',  phase: 'post-compact'  },
   ```
3. Verify syntax: `node -c scripts/merge-settings.js`
4. Verify idempotency: run `node scripts/merge-settings.js /tmp/forge-test-settings.json` twice, then check that `PostCompact` appears exactly once in the output

## Standards
- **Target directory:** `scripts/` (existing file modification)
- **Reuse:** Follow exact pattern of existing entries in `LIFECYCLE_HOOKS` array (object with `event` and `phase` keys, aligned spacing)
- **Naming:** Event name `PostCompact` matches Claude Code hook event naming (PascalCase); phase `post-compact` matches forge-hook.js convention (kebab-case)
- **Lint command:** `node -c scripts/merge-settings.js`
- **Pattern:** Single-line addition following the established array pattern

## Context
- The `LIFECYCLE_HOOKS` array at line 35-39 currently has 3 entries: SubagentStart, SubagentStop, PreCompact
- The `mergeLifecycleHook` function (line 192) handles lifecycle hooks differently from tool hooks — no `matcher` field, just a `hooks` array
- The `--remove` path (line 140-148) iterates over `LIFECYCLE_HOOKS` to clean up — adding to the array automatically includes it in removal logic
- The comment header of `forge-hook.js` says "5 hook events" — after T01 adds the handler, this becomes 6 events. The executor should update that comment in T01, not here
