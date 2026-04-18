# Security Checklist — T03: Retry Handler section in shared/forge-dispatch.md

**Domains in scope:** Secrets management (event log)
**Generated:** 2026-04-16
**Risk level:** LOW

## Analysis

T03 adds a `### Retry Handler` utility section to `shared/forge-dispatch.md` — a Markdown instruction block that tells the orchestrator how to catch `Agent()` exceptions, classify via `scripts/forge-classify-error.js`, apply backoff, and append retry events to `.gsd/forge/events.jsonl`.

The only real security concern is the event log: retry entries may include exception text that contains error bodies from the Anthropic SDK. While low-probability, provider error bodies have historically contained fragments of request payloads or internal IDs that could leak info.

### Keyword scan hits (false positives)
- `"inject"` matched `"memory injection"` in MEM015 reminder — this is prompt-engineering jargon (selective memory injection block), not code/SQL injection.
- `"role"` / `"permission"` / `"crypto"` — none present.

## Blockers — resolve before marking complete

### Secrets Management
- [ ] **Do NOT log raw `errorMsg` in retry events.** The `events.jsonl` entry must include only: `unit`, `class`, `attempt`, `backoff_ms`, `ts`. Never the exception body.
- [ ] **The classification happens via `node scripts/forge-classify-error.js --msg "$errorMsg"`** — verify the Markdown instruction correctly escapes `$errorMsg` so shell injection isn't possible (no raw interpolation into a shell command without quoting).

## Also verify

- [ ] If documenting example event log entries in the Retry Handler section, use placeholder values (`class: "server"`, `attempt: 1`) — not real error strings copy-pasted from an SDK trace.

## Anti-Patterns to Avoid

- **Markdown docs ≠ code safety net.** A Markdown instruction that says "don't log the raw message" cannot enforce itself. T04 must actually implement the redaction at the call site (in `skills/forge-auto/SKILL.md` and `commands/forge-next.md`). T03 documents the contract; T04 enforces it.
- **Shell injection via `--msg "$var"`.** Orchestrator invokes the classifier via Bash. If the Markdown example uses unquoted interpolation, users/implementors may copy it verbatim. Always quote: `--msg "$errorMsg"` with double quotes and recommend base64-encoding if the error can contain backticks or `$`.

## If You Find a Violation

Record in T03-SUMMARY.md under `## Security Flags` with: file, line, pattern, fix applied.
Do NOT mark T03 complete without verifying both Blocker items.
