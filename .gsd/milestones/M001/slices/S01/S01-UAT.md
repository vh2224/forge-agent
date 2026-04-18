# S01: PostCompact Recovery — UAT Script

**Slice:** S01  **Milestone:** M001  **Written:** 2026-04-15

## Prerequisites

- Forge Agent installed (`install.sh` or `install.ps1` run successfully)
- `~/.claude/settings.json` updated via `node scripts/merge-settings.js ~/.claude/settings.json`
- A GSD project initialized in a test directory with `.gsd/STATE.md` present
- At least one active milestone in the test project
- `node` available on PATH

## Test Cases

| # | Action | Expected | Pass? |
|---|--------|----------|-------|
| 1 | Open `~/.claude/settings.json` and check `hooks.PostCompact` | Entry `{ "hooks": [{ "type": "command", "command": "node ~/.claude/forge-hook.js post-compact" }] }` is present under `PostCompact` key | |
| 2 | Run `node scripts/merge-settings.js ~/.claude/settings.json` a second time, then recheck `hooks.PostCompact` | Exactly one PostCompact entry — no duplicates | |
| 3 | Run `node scripts/merge-settings.js ~/.claude/settings.json --remove`, then check `hooks.PostCompact` | PostCompact key is absent from `settings.json` | |
| 4 | Re-run `node scripts/merge-settings.js ~/.claude/settings.json` to restore | PostCompact entry is present again | |
| 5 | In the test project, create `.gsd/forge/auto-mode.json` with `{"active":false}`, then simulate PostCompact by running `echo '{"cwd":"<test_project_path>"}' \| node ~/.claude/forge-hook.js post-compact` | `.gsd/forge/compact-signal.json` does NOT exist | |
| 6 | Update `.gsd/forge/auto-mode.json` to `{"active":true,"milestone":"M001","worker":"execute-task/T02"}`, then run the same `echo ... \| node ~/.claude/forge-hook.js post-compact` command | `.gsd/forge/compact-signal.json` exists with keys `recovered_at`, `milestone: "M001"`, `worker: "execute-task/T02"` | |
| 7 | Corrupt `.gsd/forge/auto-mode.json` with invalid JSON (`{"broken`), then run the PostCompact command | No error output, no crash, no signal file written | |
| 8 | Start `/forge-auto` in a real project session. While it is running, check `auto-mode.json` shows `active: true`. Let it complete one unit normally | Dispatch loop continues, AUTO indicator stays visible | |
| 9 | Open `commands/forge-auto.md` and locate `#### 1. Derive next unit` | "Compact recovery check" subsection appears as the very first content in that section, before any dispatch table logic | |
| 10 | With a valid `compact-signal.json` present (from test 6), inspect the forge-auto.md recovery instructions | Signal file is deleted (`rm -f`) after recovery, recovery message starts with `↺ Recovery pós-compactação` | |

## Notes

- Tests 5–7 exercise the hook script directly via stdin injection — this simulates what Claude Code does when the lifecycle event fires.
- Test 8 is an integration smoke test; a true PostCompact event requires Claude Code to actually compact the context (typically happens at ~100-128K accumulated tokens). End-to-end verification in a long autonomous run is the definitive test.
- Tests 1–4 verify merge-settings idempotency and can be run on any machine after install.
- The `<test_project_path>` placeholder in tests 5–7 should be replaced with the absolute path of the test GSD project.
