# Security Checklist — S02/T04: Wire slice-level gate into forge-completer + S02-CONTEXT.md

**Generated:** 2026-04-16
**Result:** No security-sensitive scope detected. Markdown-only patch to `agents/forge-completer.md` + write `S02-CONTEXT.md`.

## Analysis

T04 inserts a slice-level verification gate call into `agents/forge-completer.md` as step 3, and creates `S02-CONTEXT.md` documenting the task-vs-slice gate split (W4 mitigation). Same hardening inherited from T01.

### Downstream concerns (inherited)
- [ ] Completer must invoke `node scripts/forge-verify.js --cwd "$WORKING_DIR" --unit complete-slice/$S##` with double-quoted interpolation.
- [ ] If verify fails at slice level, completer returns `blocked` (not `done`) — slice cannot merge until gate passes.
- [ ] `S02-CONTEXT.md` must document the trust boundary: task-level gate runs after each execute-task; slice-level gate runs once before merge. They do not conflict with each other.

## If You Find a Violation
Record in T04-SUMMARY.md under `## Security Flags`.
