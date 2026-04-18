# M003: Anti-Hallucination Layer — Roadmap

**Planned:** 2026-04-16
**Scope source:** `M003-SCOPE.md` (C1–C14)
**Decisions locked:** `M003-CONTEXT.md` (D1–D4)

## Vision

Make the forge-agent loop honest by replacing self-reported "done" with evidence-backed verification. Every net-new task plan carries a machine-parseable `must_haves` schema; every tool call leaves an auditable evidence line; every slice closure re-derives what was built against what was claimed. Five components — structured must-haves, evidence log, file-audit, goal-backward verifier, plan-checker — compose multiplicatively: the schema (S01) is what the verifier (S03) reads; the evidence log (S02) is what the completer cross-references; the plan-checker (S04) is the upstream signal that catches ambiguous plans before they reach the executor. Everything ships **advisory by default** (flags in SUMMARY, never blockers) except the must_haves schema itself — which is enforced from day one, because a schema nobody writes is worthless. Prefs flags stage the future hardening path without changing defaults.

## Slices (dependency order)

- [x] **S01: Structured must-haves schema + executor validation** `risk:medium` `depends:[]`
  Demo: plan a new task → open `T##-PLAN.md` → see `must_haves: {truths, artifacts[{path,min_lines,stub_patterns?}], key_links}` and `expected_output: [paths]` in frontmatter; delete the block → executor returns `status: blocked` with `blocker_class: scope_exceeded` and reason `missing_must_haves_schema`.

- [x] **S02: Evidence log (PostToolUse) + file-audit in completer** `risk:medium` `depends:[S01]`
  Demo: run a task with 3+ Bash calls → `.gsd/forge/evidence-{T##}.jsonl` exists with one JSON line per tool call (each ≤ 512 bytes); seed a SUMMARY with `npm test → exit 0` not backed by the log → `## Evidence Flags` section appears in `S##-SUMMARY.md`; add a stray file not in any `expected_output` → `## File Audit` lists it under `unexpected`; deliberately break the hook → tool call still succeeds (silent-fail per MEM008).

- [x] **S03: Goal-backward verifier (3-level)** `risk:high` `depends:[S01, S02]`
  Demo: run a slice mixing one legit file and one 3-line stub (`() => null`) → `S##-VERIFICATION.md` shows legit file passing Exists/Substantive/Wired, stub file failing Substantive with the matching regex named; verifier wall-clock on 10-artifact slice stays within the 2s budget; a legacy M001/M002 plan is handled with `skipped: legacy_schema` — no crash.

- [x] **S04: Plan-checker agent (advisory) + CLAUDE.md doc** `risk:medium` `depends:[S01]` **MILESTONE COMPLETE**
  Demo: plan a slice → `S##-PLAN-CHECK.md` exists before the first `execute-task` dispatch with ≥8 scored dimensions (pass/warn/fail); set `plan_check.mode: blocking` in prefs → loop terminates at round 3 or on non-decreasing fail count; default stays `advisory` and loop proceeds regardless of verdict; `grep -n "Anti-Hallucination Layer" CLAUDE.md` returns the new section naming all 3 artifacts and 3 prefs keys.

## Capability Coverage (C1–C14 → slice)

| Capability | Slice |
|------------|-------|
| C1. Structured must-haves schema (planner emits) | S01 |
| C2. Plan-read validation in executor | S01 |
| C3. Evidence log via PostToolUse hook | S02 |
| C4. Evidence hook performance budget (≤15ms p50 / ≤50ms p95) | S02 |
| C5. Evidence cross-ref in `complete-slice` | S02 |
| C6. File-change validator (git-diff vs `expected_output`) | S02 |
| C7. Goal-backward verifier (Exists / Substantive / Wired) | S03 |
| C8. Verifier performance budget (≤2s / 10 artifacts / depth 2) | S03 |
| C9. Plan-checker agent (advisory) | S04 |
| C10. Plan-checker revision loop behind `plan_check.mode: blocking` flag (default advisory) | S04 |
| C11. Prefs flags (`evidence.mode`, `plan_check.mode`, `file_audit.ignore_list`) | S01 (evidence.mode default), S02 (file_audit.ignore_list), S04 (plan_check.mode) |
| C12. Evidence log lifecycle via `milestone_cleanup` | S02 |
| C13. Backward compatibility for legacy plans | S01 (executor skip), S03 (verifier skip), S04 (plan-checker warn) |
| C14. Documentation + CLAUDE.md entry | S04 |

## Boundary Map

### S01 — Structured must-haves schema + executor validation

**Produces**
- `must_haves:` + `expected_output:` YAML frontmatter schema in every net-new `T##-PLAN.md` (D3 — emitted unconditionally by `forge-planner`).
- Planner-side schema emission: updates to `agents/forge-planner.md` so every task plan carries the block.
- Executor-side schema read + fail-fast: step-1 check in `agents/forge-executor.md` returning `status: blocked`, `blocker_class: scope_exceeded`, reason `missing_must_haves_schema` when block is absent or malformed on net-new plans.
- Backward-compat skip: free-text legacy plans do NOT block (C13) — executor passes through with a warn note; detection logic used again by S03/S04.
- Prefs scaffolding: `evidence.mode: lenient` default key added to `forge-agent-prefs.md` (inert until S02 consumes it).
- Minimal documentation stub in the planner/executor frontmatter docs describing the new schema.

**Consumes**
- Existing `agents/forge-planner.md` and `agents/forge-executor.md` (edits, not rewrites).
- Existing YAML frontmatter parsing idiom from `scripts/forge-verify.js` lines 420–466 (Asset Map — "YAML frontmatter key-extract") for the executor-side read.
- Worker return contract (`---GSD-WORKER-RESULT---` with `status` + `blocker_class` + `reason`) from Code Rules.
- Blocker taxonomy (`scope_exceeded` class) from CODING-STANDARDS "Orchestrator blocker taxonomy".

### S02 — Evidence log + file-audit

**Produces**
- `.gsd/forge/evidence-{unitId}.jsonl` files — one JSON line per Bash/Write/Edit tool call, each ≤ 512 bytes (C3).
- Extended `scripts/forge-hook.js` PostToolUse branch (D1 — single hook file, no new script, no `merge-settings.js` entry needed).
- Evidence-capture perf budget verified (C4) — documented measurement in `S02-SUMMARY.md`.
- `verification_evidence:` YAML frontmatter block emitted in `T##-SUMMARY.md` by `forge-executor` (D2 — shape: `[{command, exit_code, matched_line}]`).
- `## Evidence Flags` section appended to `S##-SUMMARY.md` by `forge-completer` when claims don't cross-ref the log (C5 — advisory).
- `## File Audit` section in `S##-SUMMARY.md` comparing `git diff --name-only --diff-filter=AM` against union of `expected_output` (D4 — AM only, no deletions), honoring `file_audit.ignore_list` prefs default (C6).
- Prefs additions: `file_audit.ignore_list` default (package-lock, lockfiles, dist/, build/, .next/, .gsd/**) in `forge-agent-prefs.md`; `evidence.mode` semantics wired (lenient = flag, strict = block, disabled = skip hook writes).
- Evidence log lifecycle confirmed in existing `milestone_cleanup` flow (C12) — archive/delete/keep handle `evidence-*.jsonl` without new logic.

**Consumes**
- `must_haves.expected_output` field from S01 (file-audit input).
- `scripts/forge-hook.js` existing 6-phase dispatcher + try/catch silent-fail convention (MEM008).
- `verification_evidence:` consumer side lives in `forge-completer` — reads `T##-SUMMARY.md` frontmatter via the same YAML extract idiom.
- `forge-completer` existing git-diff plumbing used by current file-check logic.
- Hook registration table in `merge-settings.js` (already registers PostToolUse — no new entries per D1).

### S03 — Goal-backward verifier (3-level)

**Produces**
- `scripts/forge-verifier.js` (new CommonJS dual-mode script per Pattern Catalog "Node CLI + module dual-mode") exporting `verifyArtifact(mustHaves, sliceFiles) → {exists, substantive, wired, flags[]}` + CLI `--slice S## --milestone M###`.
- `S##-VERIFICATION.md` artifact written by `forge-completer` — per-artifact rows with pass/fail per level + matched stub regex when Substantive fails (C7).
- Stub-detection regex defaults (JS/TS — `return <div/>`, `return null`, `onClick={() => {}}`, empty function body) plus per-artifact `stub_patterns` override from `must_haves`.
- `min_lines` enforcement sourced from `must_haves.artifacts[].min_lines` (planner-owned per risk-#5 mitigation — verifier does not hardcode).
- Import-chain walker ("Wired" level) — depth capped at 2, JS/TS only, scoped to files changed in the slice.
- Performance budget verified (C8): ≤ 2s wall-clock per 10-artifact slice; single-file read cache + short-circuit on first fail per level.
- Backward-compat skip wired: legacy plans (no `must_haves`) emit `skipped: legacy_schema` row per artifact instead of crashing (C13).

**Consumes**
- `must_haves:` schema from S01 (artifact list + min_lines + stub_patterns).
- `evidence-{T##}.jsonl` from S02 (Wired level may use it as corroborating signal for call reachability — optional; primary signal is static import-chain scan).
- YAML frontmatter extract idiom from `scripts/forge-verify.js` (Asset Map).
- Cross-platform shell dispatch + spawnSync pattern (Asset Map — for any shell-outs; avoid `shell: true`).
- `forge-completer` existing post-impl step to invoke the verifier and write VERIFICATION.md.

### S04 — Plan-checker agent (advisory) + CLAUDE.md doc

**Produces**
- `agents/forge-plan-checker.md` — new Sonnet agent with `effort: low`, `tools: Read, Write, Grep, Glob` (no Agent/Bash). Reviews ≥8 named dimensions (e.g., completeness, must_haves-wellformed, ordering, dependencies, risk-coverage, acceptance-observable, scope-alignment, decisions-honored, expected-output-realistic, legacy-schema-detect).
- `S##-PLAN-CHECK.md` artifact — one row per dimension, pass/warn/fail + one-line justification.
- Dispatch wiring: `shared/forge-dispatch.md` gains a `plan-check` template + invocation step between `plan-slice` and the first `execute-task` (both `forge-auto` and `forge-next` call it).
- Prefs flag: `plan_check.mode: advisory|blocking` default `advisory` (C10) added to `forge-agent-prefs.md`.
- Revision loop logic behind the `blocking` flag — max 3 rounds, monotonic decrease in fail count, surfaces to user otherwise. Ships inert by default.
- Legacy-schema dimension: plans with free-text `must_haves` get a `warn` (never fail) on `must_haves-wellformed` + an info row naming the legacy skip (C13).
- `## Anti-Hallucination Layer` section in `CLAUDE.md` naming all 5 components, 3 artifact files (EVIDENCE, VERIFICATION, PLAN-CHECK), and 3 prefs keys with defaults (C14).

**Consumes**
- `must_haves:` + `expected_output:` schema from S01 (primary input for dimension scoring).
- `M###-CONTEXT.md` + `S##-CONTEXT.md` (decisions honored, scope alignment) — read via existing per-phase decision injection (`execute-task` reads slice-context already; new template reads both).
- Dispatch template pattern from Pattern Catalog ("Dispatch template (shared)" + "Dispatch control-flow section").
- Skill/agent frontmatter conventions — Sonnet agent with `effort: low`.
- Existing `CLAUDE.md` structure — appended section, no reflows of existing content.

## Notes

- **Hard deps honored:** S03 depends on S01 (schema) and on S02's evidence log for optional Wired-level corroboration. S02 depends on S01 for `expected_output`. S04 depends only on S01 (reads the schema to score dimensions). Plan-checker is independent of S02/S03 so it can ship last without blocking.
- **Tier hints:** S03 is the only `risk:high` — stub regex calibration + 3-level checks + 2s perf budget compose non-trivially, and MEM038 (regex precedence) already taught us that regex-heavy control paths need risk-radar. Everything else is `medium`. No `risk:low` slices in this milestone.
- **No new deps:** All four slices stay within Node built-ins + CommonJS (MEM017, MEM038, M002 zero-deps rule). No `package.json`, no new npm installs.
- **Windows paths:** Hook writes use `path.join(...)`; evidence files live under `.gsd/forge/` which is already cross-platform.
- **Hook safety:** S02 extends `forge-hook.js` PostToolUse branch inside try/catch silent-fail (MEM008); evidence write failure never aborts a tool call. Verified per C3 acceptance criterion.
- **Telemetry appends:** evidence writes are append-only JSONL, pattern matching the "events.jsonl append (canonical)" Asset Map entry — but note the exception: hooks swallow errors (MEM008), whereas telemetry writes in `forge-verify.js` propagate. Evidence writes side with the hook convention, not the telemetry convention (file is diagnostic, not control-flow signal).
- **Backward compat:** C13 is shared across S01/S03/S04. S01 introduces the detection predicate ("is this plan legacy?"); S03 and S04 both reuse it to skip levels / emit warn rows. Plan the predicate as a small helper in S01 to avoid duplication.
- **Advisory posture:** Only S01's executor block (missing schema → blocked) is enforcing. S02/S03/S04 all ship as documentation-only in SUMMARY sections. Future M004+ can flip `evidence.mode: strict` or `plan_check.mode: blocking` without code changes.
- **CLAUDE.md entry lives in S04 completer:** per instructions, C14 piggybacks on the final slice rather than getting its own S05.
- **Research budget per slice (planner-suggested):** S02 and S03 deserve a `research-slice` pass — S02 for hook timing/perf measurement methodology, S03 for JS stub-detection regex calibration against the existing codebase (known-good baseline). S01 and S04 can likely skip research given the schema and agent shapes are already spelled out in CONTEXT.
