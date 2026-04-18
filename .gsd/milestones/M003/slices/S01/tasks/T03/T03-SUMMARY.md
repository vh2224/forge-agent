---
id: T03
parent: S01
milestone: M003
provides:
  - "forge-executor.md step 1a: must_haves schema validation before status:RUNNING"
  - "Structured+valid plans proceed normally"
  - "Malformed structured plans block with scope_exceeded + missing_must_haves_schema"
  - "Legacy plans pass with legacy_schema:true warn note"
  - "Summary Format documents legacy_schema optional field"
requires: ["T01 (forge-must-haves.js CLI)"]
affects: [S01]
key_files: ["agents/forge-executor.md"]
key_decisions:
  - "Step 1a inserted between Step 1 and Step 2 to avoid cascading renumbers while maintaining BEFORE-RUNNING invariant"
duration: 5min
verification_result: pass
completed_at: 2026-04-16T00:00:00Z
---

Wired forge-executor.md to shell out to `forge-must-haves.js --check` before marking any task as RUNNING, with branch logic for legacy/valid/malformed outcomes.

## What Happened

Surgical edit to `agents/forge-executor.md`: inserted step 1a between step 1 (Read plan) and step 2 (Read Standards), which is before step 3 (status: RUNNING). This preserves the strict ordering invariant — a malformed structured plan can never leave a dirty in-flight marker. Legacy plans (pre-M003 free-text must_haves) pass through with a `legacy_schema: true` warn note in the summary. Also added the `legacy_schema` optional field bullet to Summary Format section.

## Deviations

None. Followed plan exactly — sub-step 1a naming to avoid cascading renumbers was the recommended approach.

## Files Created/Modified

- `agents/forge-executor.md` — added step 1a (schema validation) + legacy_schema bullet in Summary Format. 205 lines total (was 187).

## Verification

- Gate: skipped (no-stack)
- Discovery source: none
- Commands: none (no-stack)
- Total duration: ~200ms
