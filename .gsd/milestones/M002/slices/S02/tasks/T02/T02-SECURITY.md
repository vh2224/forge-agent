# Security Checklist — S02/T02: Verification Gate section in shared/forge-dispatch.md

**Generated:** 2026-04-16
**Result:** No security-sensitive scope detected in this task. No checklist required.

## Analysis

T02 adds a `## Verification Gate` section (~150 lines) to `shared/forge-dispatch.md` — Markdown instruction block that documents how the orchestrator invokes `scripts/forge-verify.js` and consumes its JSON output. No new code execution, no I/O.

### Keyword scan hits (false positives)
- `"inject"` matched `"template injection"` (prompt-engineering jargon) and `"how to inject"` (referring to Markdown template substitution). Not SQL/command injection.
- `"token"` matched `"token budget"` — LLM context budget, not auth tokens.

### Downstream security concerns

T01 already shipped the hardened `scripts/forge-verify.js`. T02 only documents the CLI contract. The Markdown must preserve these constraints:

- [ ] **Events.jsonl schema documented as `{ts, event:"verify", unit, discovery_source, commands:[], passed, skipped?, duration_ms}`** — no `stderr`, no `errorMsg` at the top level (per-check stderr is inside `checks[]` array with head+tail truncation).
- [ ] **Invocation examples use explicit argv quoting:** `node scripts/forge-verify.js --plan "$PLAN_PATH" --cwd "$CWD"` (double-quoted shell interpolation, NOT `--plan $PLAN_PATH`).
- [ ] **`--from-verify` sentinel documented:** anti-recursion rule from S02-RISK W3. The Retry Handler section (T03 of S01) must NOT re-invoke the verification gate if the gate itself triggered the retry. Document clearly.
- [ ] **Token budget check:** T02 plan step 7 requires measuring `shared/forge-dispatch.md` size after edits. If > 950 lines, extract to `shared/forge-verify-gate.md` with stub pointer in dispatch.md (W6 mitigation).

## If You Find a Violation

Record in T02-SUMMARY.md under `## Security Flags` with: file, line, pattern, fix applied.
