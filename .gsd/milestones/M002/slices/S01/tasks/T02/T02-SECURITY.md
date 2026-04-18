# Security Checklist — T02: Port error classifier to scripts/forge-classify-error.js

**Generated:** 2026-04-16
**Result:** No security-sensitive scope detected in this task. No checklist required.

## Analysis

T02 creates a deterministic, dependency-free Node CLI + module that:
- Accepts an error string via `--msg` flag or stdin
- Runs it through six regex constants (ported verbatim from GSD-2)
- Emits JSON `{kind, retry, backoffMs}` to stdout
- Has zero I/O beyond stdin/stdout (no filesystem, no network, no logging)

### Keyword scan hits (false positives)
- `"unauthorized"` appears once on line 49 of T02-PLAN.md — purely as a **test case input string** (`node scripts/forge-classify-error.js --msg "401 unauthorized"`), not as authentication logic.

### Domain check
| Domain | Status | Rationale |
|--------|--------|-----------|
| Authentication | ❌ not active | No auth implementation — classifier consumes auth-error *strings* but does not perform auth |
| Authorization | ❌ not active | No permission/role logic |
| Data handling | ❌ not active | No encryption, hashing, or PII touched |
| Input validation | ⚠ minimal | CLI reads string from argv/stdin; regex-matched only, no exec/eval |
| Secrets management | ⚠ downstream | Concern about error body leakage lives in T03/T04 (event log writers), not T02 (which never writes anywhere) |
| Injection (SQL/cmd) | ❌ not active | No database, no shell-out |
| Frontend XSS | ❌ not active | Not a UI component |
| Transport / headers | ❌ not active | No HTTP layer |

## Note for downstream tasks

**T03/T04:** the retry handler in `shared/forge-dispatch.md` and its integration into `skills/forge-auto/SKILL.md` **will** write retry events to `.gsd/forge/events.jsonl`. Per S01 research + T01 findings, those writes **must not** include raw error bodies (low-risk secret leakage prevention). That is a T03/T04 security concern captured in DECISIONS.md — tracked separately from T02.
