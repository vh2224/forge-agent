# S01 — PostCompact Recovery

**Milestone:** M001 — Forge v1.0  
**Risk:** low  
**Depends:** (none)

## Objective

After Claude Code auto-compacts the conversation context, forge-auto detects a disk signal and resumes the dispatch loop without user intervention.

## Acceptance Criteria

1. When forge-auto is active (`auto-mode.json` has `active: true`) and Claude Code fires the PostCompact lifecycle event, `forge-hook.js` writes `.gsd/forge/compact-signal.json` with `recovered_at`, `milestone`, and `worker` fields
2. When forge-auto is NOT active, the PostCompact handler does nothing (no signal file written)
3. `merge-settings.js` registers the PostCompact hook event so `settings.json` includes the `PostCompact` entry after running `node merge-settings.js`
4. At the start of each dispatch loop iteration in `forge-auto.md`, the orchestrator checks for `compact-signal.json`, re-reads all context from disk, deletes the signal, emits a recovery message, and continues
5. The `AUTO` indicator in the status line remains active throughout the recovery (because `auto-mode.json` is never set to `active: false`)

## Tasks

- [x] **T01: forge-hook.js — PostCompact handler** `depends:[]`
- [x] **T02: merge-settings.js — register PostCompact event** `depends:[]`
- [x] **T03: forge-auto.md — compact-signal detection in dispatch loop** `depends:[T01]`

## Dependency Map

```
T01 (hook handler)  ──┐
                      ├──► T03 (forge-auto detection)
T02 (settings reg.) ──┘
```

T01 and T02 are independent and can execute in parallel. T03 depends on T01 conceptually (the signal file it reads is produced by T01's handler) but can be implemented independently since it only reads a JSON file from disk.
