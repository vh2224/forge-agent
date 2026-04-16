# Security Checklist — T04: Wire Retry Handler into forge-auto + forge-next

**Generated:** 2026-04-16
**Result:** No security-sensitive scope detected in this task. No checklist required.

## Analysis

T04 is pure Markdown patching of `skills/forge-auto/SKILL.md` and (if present) `commands/forge-next.md` / `skills/forge-next/SKILL.md` to insert a reference to the `### Retry Handler` section added in T03. No new code, no new I/O.

### Keyword scan hits (false positives)
- `"inject"` matched `"selective memory injection"` and `"memory injection block"` in MEM015 references — same prompt-engineering jargon as T03. Not code/SQL injection.

### Downstream security concerns
- T04 adds the `while(true)` retry block into the skill files. The Markdown code exemplifying `node scripts/forge-classify-error.js --msg "$errorMsg"` must preserve the double-quoted interpolation pattern from T03 (verified in T03-SECURITY.md). Do NOT rewrite the example to use unquoted `--msg $errorMsg`.
- The `events.jsonl` retry write (documented in T03 Retry Handler §Event log format) must NOT include `errorMsg`. T04 must not alter that schema.

## Reviewer checklist (for T04 executor)

- [ ] Confirmed: the inserted retry block references `shared/forge-dispatch.md` `### Retry Handler` section (not inlined content)
- [ ] Confirmed: example invocations in the skill use `--msg "$errorMsg"` (double-quoted)
- [ ] Confirmed: MEM015 divergence preserved — forge-next retains its selective memory injection block; forge-auto does not gain one

## If You Find a Violation

Record in T04-SUMMARY.md under `## Security Flags` with: file, line, pattern, fix applied.
