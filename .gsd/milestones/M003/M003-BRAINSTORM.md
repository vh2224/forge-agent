# Brainstorm: M003 — Anti-Hallucination Layer

**Date:** 2026-04-16
**Prepared for:** discuss phase

## Problem

The forge-agent currently trusts the `forge-executor`'s self-reported `T##-SUMMARY.md` and the `forge-completer`'s self-reported `done` status. There is no independent mechanism to detect when the summary *lies*:

- Executor claims `npm test → exit 0` but never ran the command (or ran it and got exit 1).
- Executor claims a file was created but it's a stub (`return <div/>`, `onClick={() => {}}`, TODO-body function).
- Executor silently expands scope: touches 8 files when the plan listed 3, with no mention in summary.
- Planner produces a plan where `must_haves` are vague prose instead of falsifiable artifacts, so "done" is unprovable.

All four failure modes are **silent**: the orchestrator records `done`, AUTO-MEMORY absorbs the lie as precedent, the next slice is planned on false ground. Integrity of the milestone log decays turn by turn.

Five components from sibling projects (GSD v1 + gsd-2) address distinct facets of this gap. They can be composed because each operates at a different seam:

| # | Component | Seam | Blocks? |
|---|-----------|------|---------|
| 1 | Evidence cross-ref (gsd-2) | PostToolUse hook → complete-slice read | No — flags only |
| 2 | Plan-checker agent (GSD v1) | Between plan-slice and execute-task | Yes — max 3 revision rounds |
| 3 | Verifier goal-backward (GSD v1) | complete-slice, before merge | Documentation + optional gate |
| 4 | Must-haves structured (GSD v1) | T##-PLAN frontmatter schema | Yes — plan-checker rejects free-text |
| 5 | File-change validator (gsd-2) | complete-slice, post-impl | No — flags only |

## Alternatives Considered

### Approach A — Do nothing, trust the summary (status quo)

**Tradeoff:** Zero cost, fast iteration. But compounding drift: each lie becomes training signal for AUTO-MEMORY and context for future slices. User catches errors only at UAT or in production. Already identified as tech debt — not acceptable going forward.

### Approach B — Integrate all 5 components (full layer)

**Tradeoff:** Maximum coverage — each component addresses a different failure class, and they compose multiplicatively (structured must-haves feed verifier, which reads evidence log, etc.). Cost: more moving parts; risk of plan-checker thrashing; new hook I/O overhead per tool call. Estimated ~4 slices (1 per GSD v1 component + 1 for gsd-2 evidence/file-audit bundle).

### Approach C — Evidence + file-audit only (lightweight, flag-only)

**Tradeoff:** Ship fast; zero blocking behavior. Catches the biggest class (lying about tool calls and silent file changes) without touching planner/executor contracts. Cost: leaves stub-detection and plan-completeness gaps unsolved. Good v1 if we're worried about scope creep; leaves M004 to close the loop.

### Approach D — Plan-checker + verifier only (contract-first)

**Tradeoff:** Hardens the planning→execution→completion contract but doesn't address evidence fabrication. A lying executor can still claim `exit 0` without running anything and the verifier won't know unless it re-runs commands itself. Inversion of the problem — tightens "what to build" and "what was built" but not "what was done during building."

### Approach E — Integrate 4 of 5 (defer plan-checker revision loop)

**Tradeoff:** Ship plan-checker as **advisory only** (writes S##-PLAN-CHECK.md, does NOT block) on first release. Collect data on issue rates for 1-2 milestones before enabling the revision loop. Lowest risk of thrashing (the main failure mode of plan-checker) while still delivering the signal. Evidence + verifier + must-haves + file-audit all ship with their normal semantics.

**Sources consulted:** Component #1 (evidence log) and #5 (file-change validator) are already proven in gsd-2 production; components #2 (plan-checker), #3 (verifier), #4 (structured must-haves) are proven in GSD v1. No new libraries; this is pure re-integration. Web search skipped — no external tech decisions.

## Recommended Approach

**Approach E — Integrate all 5, but ship plan-checker in advisory mode first.**

Rationale:
- The 5 components compose: structured must-haves (#4) are the schema the verifier (#3) reads; the verifier's "Wired" level benefits from evidence log (#1) showing which imports/calls actually executed during implementation; file-audit (#5) reuses the same git-diff plumbing complete-slice already calls. Shipping less than all 5 leaves detectable gaps.
- The single highest risk in the set is **plan-checker revision loop thrashing** — where the checker and planner disagree indefinitely. Shipping the checker in advisory mode (writes S##-PLAN-CHECK.md, never blocks) for 1-2 real milestones de-risks the blocking version without losing signal. A prefs flag (`plan_check.mode: advisory|blocking`) lets us flip it later.
- All 5 components are **documentation-first by default** (flags in SUMMARY, not hard blockers) except structured must-haves, which is a schema change and *must* be enforced to have value. This keeps M003 safe to roll out — existing milestones keep working; new milestones gain signal; hard enforcement comes once we trust the signal.
- Slice order aligns dependencies: must-haves schema (#4) must land before plan-checker (#2) and verifier (#3) can read it; evidence hook (#1) must land before complete-slice consumes the log; file-audit (#5) can ship anywhere but naturally bundles with evidence.

## Key Alternatives Table

| Approach | Coverage | Risk | Cost | Verdict |
|----------|----------|------|------|---------|
| A — Do nothing | 0% | Drift compounds | 0 | Rejected (accepted tech debt) |
| B — All 5, full blocking | 100% | Plan-checker thrashing | 4 slices | Rejected — risky v1 |
| C — Evidence + file-audit only | ~40% | Low | 1-2 slices | Candidate if M003 must ship fast |
| D — Plan-checker + verifier only | ~50% | Medium | 2-3 slices | Rejected — misses evidence class |
| **E — All 5, plan-checker advisory** | **100%, soft** | **Low** | **4 slices** | **Recommended** |

## Top Risks (Ranked)

1. **Plan-checker revision loop thrashing** — checker reports 5 issues, planner revises, checker now reports 4 different issues, ad infinitum. *Early signal:* issue count doesn't decrease between iterations (already in motivation). *Mitigation:* max 3 rounds + ship advisory-mode first (recommended approach) + require issue-count monotonic decrease to continue loop.
2. **Evidence hook performance overhead** — PostToolUse fires on every Bash/Write/Edit. A task with 50 tool calls writes 50 lines to `evidence-{unitId}.jsonl`. *Early signal:* measurable dispatch slowdown or hook timeout errors in events.jsonl. *Mitigation:* hook writes are append-only, 1 JSON line each (~200 bytes); should be <1ms. Guard with try/catch swallow per MEM008; disable hook if errors spike.
3. **False-positive evidence mismatches (user friction)** — executor claims "ran lint" but the log shows `npx eslint` while planner wrote `npm run lint`. Normalization becomes a moving target. *Early signal:* mismatch rate >30% across first 10 slices. *Mitigation:* lenient string match (substring + normalized whitespace); surface as `## Evidence Flags` (info-level), never blocker; escape hatch via `evidence.mode: strict|lenient|disabled`.
4. **Structured must-haves schema breaks existing planners** — T##-PLAN frontmatter change is backward-incompatible. Old plans with free-text must-haves fail validation. *Early signal:* forge-executor blocks on plan-read. *Mitigation:* migration scan at /forge-init; plan-checker accepts both forms during a deprecation window; auto-migrate when possible; fail-loud only for net-new plans.
5. **Verifier false negatives on legitimate minimal code** — "Substantive" regex flags a 3-line utility as a stub because it lacks a body >5 lines, or flags `const noop = () => {}` intended as a real export. *Early signal:* verifier flag rate on known-good milestones (M001/M002 retroactive run). *Mitigation:* min_lines comes from `must_haves.artifacts[].min_lines` set BY THE PLANNER (not hardcoded) — if planner says 3 lines is enough, verifier accepts; stub regex patterns are listed in prefs and user-editable.
6. **Scope creep — "let's also add static analysis, type coverage, mutation testing"** — M003 becomes a QA platform instead of an anti-hallucination layer. *Early signal:* plan-slice draft exceeds 6 tasks for any component, or ROADMAP lists >5 slices. *Mitigation:* explicit non-goals below; discuss phase locks scope before planning.
7. **File-audit noise from auto-generated files** — package-lock.json, dist/, .next/, .gsd/STATE.md updates flagged as "unexpected". *Early signal:* every slice has >5 unexpected files in audit. *Mitigation:* default ignore list (package-lock, lockfiles, dist, build, .gsd/**, .next) in prefs; user-extendable.
8. **Complete-slice wall-clock time increases** — running verifier (file exists + regex + import-chain) adds seconds per slice. *Early signal:* completer dispatch duration doubles post-M003. *Mitigation:* verifier reads files once, short-circuits on first fail per level; import-chain traversal capped at depth 2.

## Explicit Non-goals

- **No mutation testing, no coverage gates, no static analysis beyond regex stub-detection.** M003 is about catching lies in the summary — not about code quality.
- **No retroactive verification of M001/M002 slices.** Scope is new milestones onward. A one-shot migration script is welcome but not required for M003 done.
- **No evidence-log-based retry or auto-recovery.** Evidence is read-only signal at complete-slice time; no feedback loop into executor.
- **No AI-based plan review.** Plan-checker is deterministic dimension-by-dimension; no LLM second-opinion on "is this plan good." (Prevents prompt injection and opinion loops.)
- **No blocking evidence mismatches by default.** All flags are documentation. A prefs flag can enable blocking, but default is advisory for the entire M003.
- **Not changing DECISIONS.md, AUTO-MEMORY.md, or LEDGER.md formats.** Anti-hallucination writes into NEW artifact files (EVIDENCE, VERIFICATION, PLAN-CHECK) and appends to existing SUMMARY files — never mutates the core memory substrate.
- **No evidence log archival or rotation.** `evidence-{unitId}.jsonl` lives under `.gsd/forge/` for the active milestone and is discarded with `milestone_cleanup`.

## Open Questions for Discuss

1. **Plan-checker mode default: advisory or blocking?** Recommended brainstorm answer is advisory on v1, but the user may want immediate enforcement. Decision locks the prefs default.
2. **Where does the evidence hook live in the hook config?** Current `forge-hook.js` handles 5 events; do we extend it (single file, 5→5 events with richer PostToolUse branch) or add a new `forge-evidence.js` hook script? Extension is simpler but grows the file; new file is cleaner but adds install complexity.
3. **How do structured must-haves interact with existing T##-PLAN files?** Are we migrating M001/M002 task plans (archived anyway), or only enforcing on new ones? If migrating: write a one-shot script; if not: document the cutover.
4. **Does the verifier's "Wired" level need to handle non-JS codebases?** Forge is JS-heavy but the verifier pattern ("import chain connects, call appears in a consumer") is less clear for Python/Go/Rust. First impl JS-only, or pluggable language matchers from day 1?
5. **Evidence table format in T##-SUMMARY — markdown table or frontmatter?** gsd-2 uses a markdown "Verification Evidence" table under a heading. Keeping that for consistency is simple; frontmatter is machine-parseable but changes the human-read format. Lean toward markdown table with a parser.
6. **Should plan-checker also flag that the `must_haves:` block is present at all?** If the block is missing from the T##-PLAN frontmatter, is that a plan-checker issue or a schema-level planner-side rejection? Decision: does the planner emit must_haves unconditionally, or does plan-checker catch omission?
7. **Do we need a `/forge-verify` command for user-initiated re-verification?** Useful for UAT and for retroactive checks, but adds surface area. Defer to post-M003 unless trivially cheap.
8. **Does file-audit warn on **removed** files too?** The motivation covers missing/unexpected. A file deleted but not in plan is arguably scope creep too. Minor scope decision.

## Slice Draft (for planner context)

Proposed 4 slices, ordered by dependency:

- **S01 — Structured must-haves schema + planner update** — T##-PLAN frontmatter gains `must_haves: {truths, artifacts, key_links}` block; `expected_output: [paths]` field added. forge-planner writes the new schema. forge-executor reads and validates presence. No verification yet — just the data substrate. **User demo:** plan a task, see structured frontmatter in T##-PLAN.md. **Risk: medium** (schema change).

- **S02 — Evidence log + file-audit (gsd-2 bundle)** — PostToolUse hook logs Bash/Write/Edit to `.gsd/forge/evidence-{unitId}.jsonl`. forge-completer reads evidence log at complete-slice, writes `## Evidence Flags` and `## File Audit` sections to S##-SUMMARY.md. Both flag-only. **User demo:** run a slice, see evidence log populated, see flags section in SUMMARY if mismatches. **Risk: high** (hook performance + format contract — validate first).

- **S03 — Verifier goal-backward** — forge-completer runs 3-level verifier (Exists / Substantive / Wired) consuming `must_haves` from S01. Writes S##-VERIFICATION.md. Regex stub patterns + min_lines enforcement. **User demo:** run a slice with a deliberately stubbed file, see VERIFICATION.md flag it. **Risk: medium** (regex calibration, JS-only scope).

- **S04 — Plan-checker agent (advisory mode)** — new `forge-plan-checker` Sonnet agent; invoked between plan-slice and execute-task; writes S##-PLAN-CHECK.md; reviews ~10 dimensions. Ships in advisory-only mode (does NOT block). Revision loop behind `plan_check.mode: blocking` flag off by default. **User demo:** plan a slice, see PLAN-CHECK.md with dimension scores. **Risk: high** (new agent, revision loop is the known failure mode — defer loop enforcement).

**Highest-risk slice to validate first:** S02 — if the evidence hook can't cleanly capture tool calls without perf overhead or format issues, everything downstream loses its data source. Worth a risk-radar run before planning.
