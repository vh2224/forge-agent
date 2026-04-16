# M002 — Context Engineering Upgrades (GSD-2 Port) — Summary

**Milestone:** M002  **Started:** 2026-04-16  **Completed:** 2026-04-16  **Status:** done

---

## Vision & Scope

M002 ported four high-impact context engineering features from the GSD-2 TypeScript extension into Forge's shell-first, skill-first architecture. The goal was to make `/forge-auto` resilient to API failures, self-verifying on every task, observable at the token level, and intelligently cost-aware through tier-based model routing — all without introducing npm runtime dependencies and without breaking the compact-safe design established in M001.

The milestone delivered four composing layers: a retry backbone (S01), a verification gate that rides on top of it (S02), a token telemetry layer that instruments every dispatch (S03), and a tier router that uses telemetry data to validate cost savings (S04). Each layer is independently useful and together they close the "black box" nature of long forge-auto runs.

---

## What Was Built

### S01 — Error Classifier + Retry Integration

The orchestrator previously crashed on any transient provider error — rate limits, 503 responses, connection resets, stream truncations. S01 introduced `scripts/forge-classify-error.js`, a zero-dependency CommonJS module that ports GSD-2's six error-classification regex groups verbatim. The module exposes `classifyError(errorMsg) → {kind, retry, backoffMs}` and `isTransient()` as both a programmatic API and a CLI (`node scripts/forge-classify-error.js "<error text>"`). A 161-line `### Retry Handler` section added to `shared/forge-dispatch.md` documents the 10-step algorithm: catch → classify → branch → backoff → sleep → log → retry → exhaust. Both dispatch loops (`skills/forge-auto/SKILL.md`, `skills/forge-next/SKILL.md`) were patched with a guarded-dispatch block that references the handler without duplicating it. User-visible defaults (`max_transient_retries: 3`, `base_backoff_ms: 2000`, `max_backoff_ms: 60000`) landed in `forge-agent-prefs.md`.

**Deliverables:** `scripts/forge-classify-error.js` (new), `shared/forge-dispatch.md` (+161 lines), `skills/forge-auto/SKILL.md` (guarded dispatch), `skills/forge-next/SKILL.md` (guarded dispatch), `forge-agent-prefs.md` (`## Retry Settings`).

### S02 — Verification Gate Executable

Previously, a task could return `done` even when typecheck, lint, or tests were broken. S02 introduced `scripts/forge-verify.js` (508 lines, CommonJS dual-mode), a zero-dependency gate that executes a 3-step discovery chain: T##-PLAN `verify:` frontmatter → `prefs.verification.preference_commands` → auto-detected `package.json` allow-list (`typecheck`, `lint`, `test`). Repos with no detectable stack receive a clean `skipped:no-stack` result rather than a false pass or a halt. Stderr is truncated to 10 KB per command (3 KB head + 7 KB tail strategy) and a 120-second per-command timeout enforces exit code 124 on hangs. `agents/forge-executor.md` gained step 10 (task-level gate before T##-SUMMARY write); `agents/forge-completer.md` gained step 3 (slice-level gate before security scan). `shared/forge-dispatch.md` gained a `## Verification Gate` section (8 subsections). The gate is production-ready on Windows (win32), where smoke dirs use `C:/temp/`.

**Deliverables:** `scripts/forge-verify.js` (new, 508 lines), `agents/forge-executor.md` (step 10), `agents/forge-completer.md` (step 3), `shared/forge-dispatch.md` (`## Verification Gate`), `forge-agent-prefs.md` (`verification:` block).

### S03 — Token Counter + Context Budget

Every dispatch was previously a black box: no record of how many tokens were consumed, and optional sections (AUTO-MEMORY, LEDGER snapshot, CODING-STANDARDS) could silently overflow worker prompts. S03 introduced `scripts/forge-tokens.js` (255 lines), porting the `Math.ceil(chars/4)` heuristic from GSD-2. The module exposes `countTokens(text)` and `truncateAtSectionBoundary(content, budgetChars, opts)`, which splits on `^## `/`^### `/`^---$` boundaries and appends a `[...truncated N sections]` marker rather than cutting mid-sentence. Mandatory sections (T##-PLAN, S##-CONTEXT, SCOPE) throw a `scope_exceeded` blocker on overflow; optional sections truncate gracefully. A `### Token Telemetry` section in `shared/forge-dispatch.md` instructs the orchestrator to log `{event:"dispatch", unit, model, input_tokens, output_tokens, ts}` to `events.jsonl` after every `Agent()` call. `skills/forge-status/SKILL.md` gained a `### Token usage` block that aggregates these events and renders a milestone-scoped summary. User-tunable caps (`auto_memory: 2000`, `ledger_snapshot: 1500`, `coding_standards: 3000` tokens) landed in `forge-agent-prefs.md`.

**Deliverables:** `scripts/forge-tokens.js` (new, 255 lines), `shared/forge-dispatch.md` (`### Token Telemetry` + `#### Budgeted Section Injection`), `skills/forge-auto/SKILL.md` + `skills/forge-next/SKILL.md` (token-telemetry-integration markers), `skills/forge-status/SKILL.md` (`### Token usage`), `forge-agent-prefs.md` (`## Token Budget Settings`).

### S04 — Complexity Classifier + Tier-Only Model Router

Previously all model selection was hardcoded per phase in the prefs. S04 introduced a tier-based routing layer where every unit type maps to `light` / `standard` / `heavy`, and those tiers resolve to model IDs via a single `tier_models:` YAML block in `forge-agent-prefs.md`. A new canonical reference (`shared/forge-tiers.md`, ~80 lines) maps all 10 unit types to tiers and documents the 3-item override precedence chain: explicit `tier:` frontmatter in T##-PLAN > `tag: docs`-based downgrade to `light` > unit-type default. A `### Tier Resolution` section (248 lines) in `shared/forge-dispatch.md` implements the 5-step algorithm with prefs contract, frontmatter override table, event schema extension, and 3 worked examples. Both dispatch skills were patched with a step 1.5 block; dispatch events were extended additively with `tier` and `reason` fields (S03 readers unaffected). Operators can re-route an entire tier by changing one key in prefs — no code changes required.

**Deliverables:** `shared/forge-tiers.md` (new), `shared/forge-dispatch.md` (`### Tier Resolution`, 248 lines), `skills/forge-auto/SKILL.md` + `skills/forge-next/SKILL.md` (step 1.5 block), `forge-agent-prefs.md` (`## Tier Settings`), `CLAUDE.md` (tier routing decision entry).

---

## Key Architectural Decisions

1. **`{kind, retry, backoffMs}` output shape** — deviates from GSD-2's `{kind, retryAfterMs}` for an explicit boolean and renamed field; `unknown` kind is always `retry: false` to surface opaque tooling errors (GSD-2 bug #3588) as non-retryable.

2. **Verification gate split: task vs. slice** — task-level gate reads T##-PLAN `verify:` frontmatter with both `--plan` and `--cwd`; slice-level reads prefs `preference_commands` with `--cwd` only. Slice-level failure returns `blocked + tooling_failure` — not routed through the Retry Handler (anti-recursion rule).

3. **`Math.ceil(chars/4)` only** — no tiktoken, no npm deps (M002-CONTEXT D1). Heuristic is "good enough" for budgeting optional sections; mandatory sections are protected by explicit overflow errors.

4. **Pure Markdown Tier Resolution (Hybrid C)** — tier classifier is heuristic/regex-level so no new Node script is needed; the `### Tier Resolution` block lives entirely in `shared/forge-dispatch.md` as control-flow instructions (M002-CONTEXT D7).

5. **Additive event schema** — S04 extends S03's dispatch log line with `tier` and `reason` fields. No field renames, no breaking changes; compatibility documented in `shared/forge-dispatch.md`.

---

## Integration Story

The four slices compose as a vertical stack. S01's retry handler is the safety net at the base: if any command — including those from S02 or S04 — throws a transient error, the classifier catches it before the milestone is declared blocked. S02's verification gate sits above the retry layer: commands run by `forge-verify.js` can themselves trigger transient retries if they fail with network errors, but gate-level failures (broken code) are not retried — they block and surface. S03's token telemetry instruments every `Agent()` call at the dispatch level, providing the observability foundation that S04's tier router can use for cost validation: operators can see `input_tokens × tier` breakdowns in `/forge-status` and tune the `tier_models:` mapping accordingly. The result is a self-healing (S01), self-verifying (S02), self-reporting (S03), cost-aware (S04) dispatch pipeline built without any new runtime dependencies.

---

## Quantitative Deliverables

| Metric | Value |
|--------|-------|
| New scripts | 3 (`forge-classify-error.js`, `forge-verify.js`, `forge-tokens.js`) |
| New shared docs | 2 (`shared/forge-tiers.md`, `shared/forge-dispatch.md` +570 net lines) |
| Agents modified | 2 (`forge-executor.md`, `forge-completer.md`) |
| Skills modified | 3 (`forge-auto`, `forge-next`, `forge-status`) |
| Prefs sections added | 4 (`## Retry Settings`, `verification:`, `## Token Budget Settings`, `## Tier Settings`) |
| Slices completed | 4 / 4 |
| Tasks completed | 23 / 23 |
| Smoke scenarios passed | 18 |

---

## Drill-Down Paths

- S01: `.gsd/milestones/M002/slices/S01/S01-SUMMARY.md`
- S02: `.gsd/milestones/M002/slices/S02/S02-SUMMARY.md`
- S03: `.gsd/milestones/M002/slices/S03/S03-SUMMARY.md`
- S04: `.gsd/milestones/M002/slices/S04/S04-SUMMARY.md`
