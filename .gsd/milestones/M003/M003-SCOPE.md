# Scope Contract: M003 — Anti-Hallucination Layer

**Defined:** 2026-04-16

## In Scope

| Capability | Success Criterion | Verifiable by |
|------------|-------------------|---------------|
| **C1. Structured must-haves schema** | `forge-planner` emits T##-PLAN frontmatter with a `must_haves:` block containing `truths: []`, `artifacts: [{path, min_lines, stub_patterns?}]`, `key_links: []`, plus an `expected_output: [paths]` field. Schema is non-empty for every net-new task. | Open any T##-PLAN.md created after M003/S01 ships — `must_haves` and `expected_output` keys present; `artifacts[].path` and `min_lines` present for each entry; zero free-text `must_haves` strings. |
| **C2. Plan-read validation in executor** | `forge-executor` refuses to start a task whose T##-PLAN.md lacks the structured `must_haves` block (net-new plans only); dispatches `blocked` with reason `missing_must_haves_schema`. | Create a task with legacy free-text must-haves → executor returns `---GSD-WORKER-RESULT---` with status `blocked` and reason naming the missing keys. |
| **C3. Evidence log via PostToolUse hook** | `forge-hook.js` PostToolUse branch appends one JSON line per Bash/Write/Edit tool call to `.gsd/forge/evidence-{unitId}.jsonl`. Each line ≤ 512 bytes. Hook failures are swallowed (try/catch) and never abort the tool call. | Run any task with ≥3 Bash calls → `evidence-{unitId}.jsonl` exists with ≥3 lines, each parseable JSON, each ≤ 512 bytes; deliberately corrupt the hook → tool call still succeeds. |
| **C4. Evidence hook performance budget** | PostToolUse hook adds ≤ 15 ms wall-clock per tool call on median (p50) and ≤ 50 ms p95, measured over a 50-call task. | Time 50 Write/Edit/Bash calls with and without hook enabled; diff median and p95; both within budget. |
| **C5. Evidence cross-ref in complete-slice** | `forge-completer` reads `evidence-{unitId}.jsonl` for all tasks in the slice, compares against SUMMARY claims (e.g. "ran `npm test`"), writes `## Evidence Flags` section to S##-SUMMARY.md. Advisory only — never blocks merge. | Seed a SUMMARY claiming `npm test → exit 0` with no matching evidence line → `## Evidence Flags` section appears listing the unverified claim; complete still succeeds. |
| **C6. File-change validator (git-diff based)** | `forge-completer` diffs changed files against the union of `expected_output` from all tasks' T##-PLAN.md. Writes `## File Audit` section listing `unexpected` (changed but not planned) and `missing` (planned but not changed), honoring the default ignore list (package-lock, lockfiles, dist/, build/, .next/, .gsd/**). Advisory only. | Add a stray file not in any `expected_output` → File Audit lists it under `unexpected`. Plan a file, don't touch it → lists it under `missing`. Touch only ignored paths → section lists zero entries. |
| **C7. Goal-backward verifier (3-level)** | `forge-completer` runs verifier consuming `must_haves` from each T##-PLAN: **Exists** (file at `artifact.path`), **Substantive** (line count ≥ `min_lines` AND no `stub_patterns` match), **Wired** (for each artifact, at least one import or call reference exists in another file within the slice). Writes S##-VERIFICATION.md with pass/fail per level per artifact. | Create a slice with one legit file and one deliberately stubbed file (3-line arrow function `() => null`) → VERIFICATION.md shows stubbed file failing Substantive; legit file passes all 3. |
| **C8. Verifier performance budget** | Verifier completes in ≤ 2 s for a slice containing up to 10 artifacts across 10 files, import-chain depth capped at 2. | Time `complete-slice` on a 10-file slice; diff with and without verifier enabled; delta ≤ 2 s. |
| **C9. Plan-checker agent in advisory mode** | New `forge-plan-checker` Sonnet agent invoked between `plan-slice` and first `execute-task`. Reads S##-PLAN.md + per-task T##-PLAN.md + M###-CONTEXT + S##-CONTEXT. Writes S##-PLAN-CHECK.md with ≥8 named dimensions (e.g. completeness, must_haves-wellformed, ordering, dependencies, risk-coverage, acceptance-observable, scope-alignment, decisions-honored) each scored pass/warn/fail with one-line justification. Never blocks the loop. | Plan a slice → S##-PLAN-CHECK.md exists before first execute-task dispatch; contains ≥8 dimension rows; loop proceeds regardless of warn/fail verdicts. |
| **C10. Plan-checker revision loop behind prefs flag (off)** | `plan_check.mode` pref with values `advisory` (default) \| `blocking`. In `blocking` mode, revision loop enforces max 3 rounds AND requires monotonic decrease in fail count between rounds; otherwise surfaces to user. Default remains `advisory` — blocking mode ships inert. | Grep prefs file → `plan_check.mode: advisory` present as default; set to `blocking` → loop terminates at round 3 OR on non-decreasing fail count; grep orchestrator code for the cap constant `3`. |
| **C11. Prefs flags for evidence + advisory modes** | `forge-agent-prefs.md` gains three new keys: `evidence.mode: strict\|lenient\|disabled` (default `lenient`), `plan_check.mode: advisory\|blocking` (default `advisory`), `file_audit.ignore_list` (default list with package-lock, lockfiles, dist/, build/, .next/, .gsd/**). | Open prefs template → all three keys present with documented defaults; set `evidence.mode: disabled` → hook skips writes; set `evidence.mode: strict` → mismatches become blockers in SUMMARY. |
| **C12. Evidence log lifecycle** | `evidence-{unitId}.jsonl` files live under `.gsd/forge/` for the active milestone only; cleaned up by existing `milestone_cleanup` pref (archive/delete/keep) with no new logic. | Complete a milestone with `milestone_cleanup: delete` → all `evidence-*.jsonl` removed; with `archive` → moved to `.gsd/archive/M###/forge/`. |
| **C13. Backward compatibility for legacy plans** | Plans written before M003/S01 (free-text must-haves) do NOT cause executor crashes or completer errors. Plan-checker flags them as `warn` (schema_outdated); verifier skips Substantive/Wired levels and emits `skipped: legacy_schema` entry. | Run any M001/M002 archived task plan through the new pipeline → no crash; SUMMARY/VERIFICATION/PLAN-CHECK each note `legacy_schema` skip; no blockers raised. |
| **C14. Documentation + CLAUDE.md entry** | CLAUDE.md gains a "Anti-Hallucination Layer" section describing the 5 components, the prefs flags, the artifact files (EVIDENCE.jsonl, VERIFICATION.md, PLAN-CHECK.md), and the advisory-by-default posture. | `grep -n "Anti-Hallucination Layer" CLAUDE.md` returns a match; section names all 3 new artifact files and all 3 new prefs keys. |

## Out of Scope

| Item | Reason |
|------|--------|
| Mutation testing, coverage gates, type-coverage checks | Non-goal per brainstorm — M003 catches lies in the summary, not code quality. Belongs to a separate QA-platform initiative if ever. |
| Static analysis beyond regex stub-detection | Same as above; brings tool/lang complexity without addressing the hallucination class. |
| Retroactive verification of M001/M002 slices | Non-goal per brainstorm. Archived milestones are arqueologia; new milestones onward are the scope. A one-shot migration script is not required for done. |
| Evidence-log-based retry or auto-recovery in executor | Evidence is read-only signal consumed at complete-slice. Feeding it back into executor would create a new control loop outside M003's charter. |
| AI/LLM-based plan review ("is this plan good?") | Non-goal per brainstorm — plan-checker is deterministic dimension-by-dimension to avoid prompt injection and opinion loops. |
| Blocking evidence mismatches by default | Non-goal per brainstorm — all flags are documentation by default. `evidence.mode: strict` is the opt-in; default stays advisory for the entire milestone. |
| Mutating DECISIONS.md / AUTO-MEMORY.md / LEDGER.md formats | Non-goal per brainstorm — new signals write to NEW artifact files (EVIDENCE, VERIFICATION, PLAN-CHECK) and append to SUMMARY; core memory substrate is untouched. |
| Evidence log archival/rotation policy independent of `milestone_cleanup` | Non-goal per brainstorm — evidence piggybacks on existing cleanup; no new retention system. |
| Pluggable language matchers for the verifier's "Wired" level (Python/Go/Rust import-chain walkers) | Forge codebase is JS/TS; adding multi-language matchers is speculative surface area. JS-only v1; pluggability deferred. |
| `/forge-verify` user-facing command for on-demand re-verification | Deferred per brainstorm Q7; adds surface area without addressing core gap. Revisit post-M003 if verifier proves valuable. |
| Migration script for existing M001/M002 T##-PLAN files to new schema | Non-goal — legacy plans handled via the backward-compat skip (C13), not rewritten. |

## Deferred

| Item | Target milestone |
|------|-----------------|
| Plan-checker blocking mode + revision loop enforcement (flipping `plan_check.mode` default to `blocking`) | M004 or later — after 1-2 real milestones of advisory data confirm low thrash rate |
| Pluggable language matchers for verifier's "Wired" level (Python/Go/Rust) | Post-M003 — triggered only if a non-JS codebase becomes a target |
| `/forge-verify` user command for on-demand re-verification of any slice | Post-M003 — evaluate after observing verifier utility in normal flow |
| Blocking evidence mismatch mode as default (flipping `evidence.mode` default to `strict`) | Post-M003 — after false-positive rate measured <10% across first 2 milestones |
| One-shot migration script to rewrite legacy T##-PLAN files into new schema | Post-M003 — only if a user asks; archived milestones stay as-is |
| AI-based plan review (second-opinion LLM pass on plan quality) | Not currently planned — re-evaluate only if deterministic plan-checker proves insufficient |

## Open Questions (for discuss)

- **Q1 (Plan-checker default mode):** Ship plan-checker in `advisory` mode by default as recommended, or enforce `blocking` from day 1? Locks the default for `plan_check.mode` pref.
- **Q2 (Evidence hook placement):** Extend the existing `scripts/forge-hook.js` PostToolUse branch, or add a new `scripts/forge-evidence.js` script registered separately in settings.json?
- **Q3 (Evidence table format in T##-SUMMARY):** Markdown table under `## Evidence Flags` heading (gsd-2 parity, human-first) or frontmatter block (machine-parseable, changes human read)?
- **Q4 (Planner must_haves emission):** Does `forge-planner` emit `must_haves:` unconditionally (schema-level required output), or does `forge-plan-checker` catch the omission as a dimension failure? Affects where the enforcement lives.
- **Q5 (File-audit on deleted files):** Does `## File Audit` also warn on files that were removed but not in the plan's `expected_output`? Minor scope decision — defaults to yes unless discuss rejects.
- **Q6 (Verifier min_lines source of truth):** Is `min_lines` required in every `artifacts[]` entry, or optional with a global default (e.g., 5)? Affects planner verbosity vs. verifier false-positive rate.
- **Q7 (Stub pattern list location):** Are regex stub patterns hardcoded in the verifier script, listed per-artifact in `must_haves.artifacts[].stub_patterns`, or both (defaults + per-artifact additions)?
- **Q8 (Legacy plan handling verdict):** Is `legacy_schema` a soft skip (warn + proceed, as specified in C13) or a hard block on first encounter with a net-new milestone? Confirms the backward-compat stance.
