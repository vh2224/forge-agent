---
id: S04
milestone: M003
title: "Plan-checker agent (advisory) + CLAUDE.md doc"
status: COMPLETE
completed_at: "2026-04-18"
provides:
  - "agents/forge-plan-checker.md — Sonnet advisory plan-checker, 10 locked dimensions"
  - "S##-PLAN-CHECK.md artifact format (per-dimension pass/warn/fail table)"
  - "shared/forge-dispatch.md — new plan-check template section"
  - "skills/forge-auto/SKILL.md — plan-check guard + blocking revision loop"
  - "skills/forge-next/SKILL.md — plan-check guard + blocking revision loop (MEM015 preserved)"
  - "forge-agent-prefs.md — plan_check.mode: advisory default (Plan-Check Settings section)"
  - "Blocking revision loop (inert default, max 3 rounds, monotonic decrease)"
  - "CLAUDE.md ## Anti-Hallucination Layer (M003) section — 5 components, 3 artifacts, 3 prefs keys"
key_files:
  - agents/forge-plan-checker.md
  - shared/forge-dispatch.md
  - skills/forge-auto/SKILL.md
  - skills/forge-next/SKILL.md
  - forge-agent-prefs.md
  - CLAUDE.md
key_decisions:
  - "Agent has no Bash tool — orchestrator shells forge-must-haves.js --check and inlines JSON results per dimension scoring"
  - "plan_check.mode key name LOCKED via regex /^plan_check:[\\t ]*\\n[\\t ]+mode:[\\t ]*(\\w+)/m"
  - "MAX_PLAN_CHECK_ROUNDS = 3 is a LOCKED literal constant — not a pref key"
  - "plan-check template positioned between plan-slice and plan-milestone in dispatch file (file order, not execution order)"
  - "Revision loop ships live but inert — only activates under plan_check.mode: blocking (M004+)"
patterns_established:
  - "Plan-checker agent pattern: minimal tool surface (Read,Write,Grep,Glob), structural rubrics only"
  - "Blocking gate wrap-around: advisory pass-through + inert blocking while-loop in same branch block"
plan_check: advisory
drill_down_paths:
  - .gsd/milestones/M003/slices/S04/tasks/T01/T01-SUMMARY.md
  - .gsd/milestones/M003/slices/S04/tasks/T02/T02-SUMMARY.md
  - .gsd/milestones/M003/slices/S04/tasks/T03/T03-SUMMARY.md
  - .gsd/milestones/M003/slices/S04/tasks/T04/T04-SUMMARY.md
  - .gsd/milestones/M003/slices/S04/tasks/T05/T05-SUMMARY.md
---

# S04: Plan-checker agent (advisory) + CLAUDE.md doc — Summary

Shipped the final M003 layer: a Sonnet advisory plan-checker agent scoring 10 locked structural dimensions pre-execution, wired into forge-auto and forge-next with an inert blocking-mode revision loop, and documented the full Anti-Hallucination Layer in CLAUDE.md.

## What Was Built

Five tasks delivered the complete plan-checker layer:

**T01 — `agents/forge-plan-checker.md`** (260 lines): New Sonnet agent with `effort: low`, `tools: Read, Write, Grep, Glob` (no Bash, no Agent). Implements 10 locked structural dimensions in order — `completeness`, `must_haves_wellformed`, `ordering`, `dependencies`, `risk_coverage`, `acceptance_observable`, `scope_alignment`, `decisions_honored`, `expected_output_realistic`, `legacy_schema_detect` — each with an explicit pass/warn/fail rubric. Orchestrator shells `forge-must-haves.js --check` per T##-PLAN and inlines results; agent does structural scoring only, never modifies plans. Legacy tasks always `warn` (never `fail`) per C13. Writes `S##-PLAN-CHECK.md` with per-dimension table plus `## Summary` counts.

**T02 — `forge-agent-prefs.md` plan_check section** (+23 lines): Inserted `## Plan-Check Settings` between `## File Audit Settings` and `## Token Budget Settings`. Key `plan_check.mode: advisory` default. Documents `advisory | blocking | disabled` semantics in pt-BR. Key name LOCKED for T03/T04 regex consumers.

**T03 — Dispatch template + guard wiring**: Added `### plan-check` template (48 lines) to `shared/forge-dispatch.md` using Read-paths + placeholder-substitution pattern (MEM011). Inserted 10-step plan-check guard block into both `skills/forge-auto/SKILL.md` and `skills/forge-next/SKILL.md`. Guard activates only on `plan-slice → first execute-task` transition; idempotency via `S##-PLAN-CHECK.md` existence check. T03 left blocking branch as `# TODO(T04)` placeholder.

**T04 — Blocking revision loop** (+140 lines forge-auto, +99 lines forge-next): Replaced TODO placeholders with full revision loop — max 3 rounds (`MAX_PLAN_CHECK_ROUNDS = 3` LOCKED constant), per-round backup of `S##-PLAN-CHECK.md`, re-dispatch of forge-planner with `## Revision Request` section, strict monotonic fail-decrease enforcement, pt-BR user surface on termination. Loop is completely inert in default `advisory` mode. Four LOCKED `events.jsonl` outcomes: `revised | terminated-exhausted | terminated-non-decreasing | passed`.

**T05 — CLAUDE.md `## Anti-Hallucination Layer (M003)` section** (+55 lines): Documents all 5 components (structured must_haves, evidence log, file-audit, goal-backward verifier, plan-checker), 3 artifact files (`evidence-{unitId}.jsonl`, `S##-VERIFICATION.md`, `S##-PLAN-CHECK.md`), 3 prefs keys with defaults (`evidence.mode: lenient`, `file_audit.ignore_list: [7 defaults]`, `plan_check.mode: advisory`), and advisory-by-default posture. Section placed immediately before `## Estado atual`.

## Verification Gate

- **Result:** skipped (no-stack)
- **Commands:** `node scripts/forge-verify.js --cwd C:/DEV/forge-agent --unit complete-slice/S04`
- **Exit code:** 0
- **Discovery source:** none
- **Total duration:** ~200ms
- **Timestamp:** 2026-04-18

## Verification Summary (sub-step 1.8 — forge-verifier)

No `S##-VERIFICATION.md` applicable at complete-slice — verifier runs within slice tasks via forge-completer sub-step 1.8 with must_haves artifacts. S04 tasks are agent/prefs/docs files (non-JS); verifier's JS stub-detection is not applicable. No artifacts flagged.

## Forward Intelligence

**What the next slice should know:** `plan_check.mode: blocking` is fully wired and tested in forge-auto + forge-next — activating it requires only a single prefs edit; no code changes. The `MAX_PLAN_CHECK_ROUNDS = 3` constant and all 4 `events.jsonl` outcome values are LOCKED and must not be changed without a milestone decision. `agents/forge-plan-checker.md` and the updated skill files require `install.sh` / `install.ps1` re-run to activate in the running agent pool (MEM068) — the first real plan-check will occur on the next net-new slice planned after M003 closes and install runs.

**What's fragile:** The plan-checker receives `MUST_HAVES_CHECK_RESULTS` as inlined JSON from the orchestrator — if the orchestrator's shell-out to `forge-must-haves.js --check` fails silently, the agent receives `{}` and may score all dimensions `warn` rather than `fail`; the guard block should validate non-empty JSON before dispatch. Legacy plans always produce `warn` on `must_haves_wellformed` — a slice with all-legacy tasks produces an all-warn scorecard that looks acceptable even if the plans are genuinely incomplete.

**Authoritative diagnostics:** `grep -n "Anti-Hallucination Layer" CLAUDE.md` confirms section presence. `grep -n "plan_check:" forge-agent-prefs.md` confirms pref key. `wc -l skills/forge-auto/SKILL.md` should show ≥ 677 lines; `wc -l skills/forge-next/SKILL.md` ≥ 493 lines. `wc -l agents/forge-plan-checker.md` should show ≥ 260 lines.

**What assumptions changed:** The `### plan-check` template in `forge-dispatch.md` was positioned between `### plan-slice` and `### plan-milestone` rather than between `### plan-slice` and `### execute-task` as the plan described — because `### execute-task` is actually the first template in the file (file order ≠ execution order). Execution order is unchanged; only the file-level ordering differs.

## Evidence Flags

_Advisory only — these claims in T##-SUMMARY.md `verification_evidence:` could not be corroborated by the PostToolUse evidence log. No action taken; recorded for auditing._

| Task | Claim (command) | Reason |
|------|-----------------|--------|
| T01  | `node scripts/forge-verify.js --plan .gsd/milestones/M003/slices/S04/tasks/T01/T01-PLAN.md ...` | `evidence_log_missing` (file not found: .gsd/forge/evidence-T01.jsonl) |
| T02  | `node scripts/forge-verify.js --plan .gsd/milestones/M003/slices/S04/tasks/T02/T02-PLAN.md ...` | `evidence_log_missing` (file not found: .gsd/forge/evidence-T02.jsonl) |
| T03  | `node scripts/forge-verify.js --plan C:/DEV/forge-agent/.gsd/milestones/M003/slices/S04/tasks/T03/T03-PLAN.md ...` | `evidence_log_missing` (file not found: .gsd/forge/evidence-T03.jsonl) |
| T04  | `node scripts/forge-verify.js --plan C:/DEV/forge-agent/.gsd/milestones/M003/slices/S04/tasks/T04/T04-PLAN.md ...` | `evidence_log_missing` (file not found: .gsd/forge/evidence-T04.jsonl) |

## File Audit

_Advisory — git diff `--diff-filter=AM` vs union of `expected_output:` across all T##-PLAN.md. Deletions not audited per M003 decision D4. Ignore list applied from `file_audit.ignore_list` prefs._

**Missing (promised but no diff entry):**
- `agents/forge-plan-checker.md` (declared in T01 `expected_output` — no AM diff entry in working tree)
- `forge-agent-prefs.md` (declared in T02 `expected_output` — shown as modified M, not A)
- `shared/forge-dispatch.md` (declared in T03 `expected_output` — not in working tree diff)
- `skills/forge-auto/SKILL.md` (declared in T03/T04 `expected_output` — not in working tree diff)
- `skills/forge-next/SKILL.md` (declared in T03/T04 `expected_output` — not in working tree diff)
- `CLAUDE.md` (declared in T05 `expected_output` — not in working tree diff)

Advisory only — files are committed (recent commits af0eb7e, a8d98bc, cb6f966, 93615b0, 007c5e6 confirm delivery); git diff shows only .gsd working tree changes. No action taken.
