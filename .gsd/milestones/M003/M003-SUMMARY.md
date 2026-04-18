---
id: M003
title: Anti-Hallucination Layer
status: complete
completed_at: "2026-04-18"
slices_completed: [S01, S02, S03, S04]
slices_pending: []
last_updated: 2026-04-18
key_files:
  - scripts/forge-must-haves.js
  - scripts/forge-verifier.js
  - scripts/forge-hook.js
  - agents/forge-plan-checker.md
  - agents/forge-executor.md
  - agents/forge-completer.md
  - shared/forge-dispatch.md
  - forge-agent-prefs.md
key_decisions:
  - "Advisory-by-default posture: only S01 must_haves schema enforcement is a hard blocker; S02/S03/S04 all ship as documentation flags"
  - "D4 LOCKED — --diff-filter=AM only in File Audit (deletions intentionally not tracked)"
  - "Wired v1 uses static import-chain scan only — evidence log corroboration deferred to M004+"
  - "plan_check.mode and MAX_PLAN_CHECK_ROUNDS=3 are LOCKED constants — not configurable without a milestone decision"
  - "All four components stay within Node built-ins (zero npm deps rule from M002)"
---

# M003: Anti-Hallucination Layer — Final Milestone Summary

Replace self-reported "done" with evidence-backed verification: four components (structured schema, evidence log, goal-backward verifier, plan-checker) compose multiplicatively so every future task plan is machine-auditable from declaration through execution through closure.

## What Was Built

### S01 — Structured must-haves schema + executor validation

Established the `must_haves:` + `expected_output:` YAML frontmatter schema as the single machine-parseable contract between planner and executor. Five tasks shipped:

- `scripts/forge-must-haves.js` — hand-rolled CommonJS parser (no external deps). Exports `hasStructuredMustHaves()` + `parseMustHaves()`. CLI `--check` exits 0/0/2 for legacy/valid/malformed.
- `agents/forge-planner.md` — added `## Must-Haves Schema` section with locked schema shape and unconditional emit contract.
- `agents/forge-executor.md` — step 1a validation: malformed structured plans block (`status: blocked / scope_exceeded / missing_must_haves_schema`); legacy plans pass with warn note.
- `forge-agent-prefs.md` — `evidence: {mode: lenient}` pref scaffolded (inert until S02).
- Three smoke fixtures validate end-to-end parser round-trip (legacy / structured-valid / structured-malformed).

**Key decisions:** `[ \t]*` not `\s*` in regex (prevents cross-line capture); `extractSubBlock + dedent` for nested YAML; step 1a naming avoids cascading renumbers.

### S02 — Evidence log + file-audit

Evidence capture + file-audit infrastructure across 5 tasks:

- `scripts/forge-hook.js` — extended PostToolUse branch with 3 private helpers (`resolveUnitId`, `readEvidenceMode`, `truncate`) and evidence-line writer. Appends one ≤512-byte JSONL line per Bash/Write/Edit call to `.gsd/forge/evidence-{unitId}.jsonl`. `disabled` mode skips writes. Silent-fail per MEM008.
- `agents/forge-executor.md` — step 12a: executor emits `verification_evidence: [{command, exit_code, matched_line}]` in T##-SUMMARY.md frontmatter after verification.
- `agents/forge-completer.md` — sub-step 1.5 (Evidence Flags cross-ref) and sub-step 1.6 (File Audit) inserted. Both advisory: write sections to S##-SUMMARY.md only when non-empty, never block closure.
- `forge-agent-prefs.md` — `## File Audit Settings` section added with `file_audit.ignore_list` default (7 patterns).

**Key decisions:** evidence block placed before `if (toolName !== 'Agent') return` (additive); D4 LOCKED — `--diff-filter=AM` only; `strict` mode reserved for M004+.

### S03 — Goal-backward verifier (3-level)

Shipped `scripts/forge-verifier.js` (975 lines) — CommonJS dual-mode module implementing the 3-level `verifyArtifact` API, CLI writer, and `forge-completer` sub-step 1.8 integration. Six tasks delivered:

- `scripts/forge-verifier.js` — `verifyArtifact(mustHaves, sliceFiles)` with `checkExists`, `checkSubstantive` (4-pattern stub regex library in locked precedence order), `checkWired` (depth-2 BFS import-chain walker supporting ESM/CJS/re-exports/barrels).
- CLI `--slice/--milestone/--cwd/--help`; writes `S##-VERIFICATION.md` per-artifact table with `exists | substantive | wired | flags` columns.
- `agents/forge-completer.md` sub-step 1.8 — invokes verifier after File Audit, reads VERIFICATION.md, writes `## Verification Summary` paragraph (always, even 0-artifact result).
- Smoke fixtures (legit/stub/legacy/non-JS) + RESULTS.md regression record.
- Perf harness — hot-cache mean ~3.5ms / 10 artifacts (budget: 2000ms).

**Key decisions:** stub detection is heuristic (per-artifact `stub_patterns:[]` override); Wired v1 uses static import-chain scan only; depth-2 emits `approximate` on barrel depth-limit, not failure.

### S04 — Plan-checker agent + CLAUDE.md doc

Shipped the final M003 layer: advisory plan-checker agent scoring 10 locked structural dimensions pre-execution, dispatch wiring in forge-auto + forge-next, inert blocking-mode revision loop (max 3 rounds, monotonic decrease), and full documentation in CLAUDE.md. Five tasks:

- `agents/forge-plan-checker.md` (260 lines) — Sonnet agent, 10 dimensions, no Bash tool, orchestrator inlines `--check` JSON.
- `shared/forge-dispatch.md` — new `### plan-check` template section.
- `skills/forge-auto/SKILL.md` + `skills/forge-next/SKILL.md` — plan-check guard + blocking revision loop (+140/+99 lines each).
- `forge-agent-prefs.md` — `plan_check.mode: advisory` default.
- `CLAUDE.md` — `## Anti-Hallucination Layer (M003)` section (+55 lines, 5 components, 3 artifacts, 3 prefs keys).

**Key decisions:** `plan_check.mode` key name LOCKED via regex; `MAX_PLAN_CHECK_ROUNDS = 3` LOCKED literal; legacy plans always `warn` (never `fail`) per C13; plan-checker has no Bash tool.

## Capability Coverage (C1–C14)

All 14 capabilities delivered:

| Capability | Slice | Status |
|------------|-------|--------|
| C1. Structured must-haves schema (planner emits) | S01 | Done |
| C2. Plan-read validation in executor | S01 | Done |
| C3. Evidence log via PostToolUse hook | S02 | Done |
| C4. Evidence hook performance budget (≤15ms p50 / ≤50ms p95) | S02 | Done |
| C5. Evidence cross-ref in complete-slice | S02 | Done |
| C6. File-change validator (git-diff vs expected_output) | S02 | Done |
| C7. Goal-backward verifier (Exists / Substantive / Wired) | S03 | Done |
| C8. Verifier performance budget (≤2s / 10 artifacts / depth 2) | S03 | Done |
| C9. Plan-checker agent (advisory) | S04 | Done |
| C10. Plan-checker revision loop behind plan_check.mode: blocking | S04 | Done (inert default) |
| C11. Prefs flags (evidence.mode, plan_check.mode, file_audit.ignore_list) | S01/S02/S04 | Done |
| C12. Evidence log lifecycle via milestone_cleanup | S02 | Done |
| C13. Backward compatibility for legacy plans | S01/S03/S04 | Done |
| C14. Documentation + CLAUDE.md entry | S04 | Done |

## Activation Note

`agents/forge-plan-checker.md` and updated skill files (`forge-auto`, `forge-next`) require `install.sh` / `install.ps1` re-run to activate in the running agent pool. The first live plan-check occurs on the next net-new slice planned after install.

## Drill-Down Paths

- S01: `.gsd/milestones/M003/slices/S01/S01-SUMMARY.md`
- S02: `.gsd/milestones/M003/slices/S02/S02-SUMMARY.md`
- S03: `.gsd/milestones/M003/slices/S03/S03-SUMMARY.md`
- S04: `.gsd/milestones/M003/slices/S04/S04-SUMMARY.md`
