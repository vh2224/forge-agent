# M002 — Context Engineering Upgrades (GSD-2 Port) — Summary

**Milestone:** M002  **Started:** 2026-04-16  **Status:** in-progress

---

## S01 — Error classifier + retry integration

All 5 tasks completed (2026-04-16). The Forge orchestrator now has automatic recovery from transient provider errors. A zero-dependency CommonJS classifier (`scripts/forge-classify-error.js`) ports GSD-2's six regex groups verbatim and exposes `classifyError(errorMsg) → {kind, retry, backoffMs}` plus `isTransient()` as both a Node module and a CLI. A 161-line `### Retry Handler` section in `shared/forge-dispatch.md` documents the 10-step algorithm (catch → classify → branch → backoff → sleep → log → retry → exhaust) with worked examples for all three transient classes. Both dispatch-loop skill files (`skills/forge-auto/SKILL.md`, `skills/forge-next/SKILL.md`) wrap their `Agent()` call with a guarded-dispatch block that references the handler without duplicating it. `forge-agent-prefs.md` ships a `## Retry Settings` block with `max_transient_retries: 3`, `base_backoff_ms: 2000`, `max_backoff_ms: 60000` defaults. Development took place directly on `master` (commits 97017ab–6c658dc); no per-slice branch was used per project convention.

**Key decisions:**
- Output shape `{kind, retry, backoffMs}` deviates from GSD-2's `{kind, retryAfterMs}` — explicit boolean and renamed field for clarity.
- `errorMsg` is never written to `events.jsonl`; only `class/attempt/backoff_ms/model`.
- `unknown` kind is always `retry: false` — opaque tooling strings (GSD-2 bug #3588) surface as non-retryable.
- `commands/forge-next.md` does not exist; step-mode loop lives at `skills/forge-next/SKILL.md`.

---

## S02 — Verification gate executable

All 6 tasks completed (2026-04-16). The Forge orchestrator now has a zero-dependency verification gate (`scripts/forge-verify.js`, 508 lines, CommonJS dual-mode) that blocks `done` until typecheck/lint/test commands pass. The gate discovers commands via a 3-step chain (T##-PLAN `verify:` frontmatter → `prefs.verification.preference_commands` → auto-detected `package.json` allow-list `[typecheck, lint, test]`); skips cleanly with `skipped:"no-stack"` on docs-only repos; truncates stderr to 10 KB per command using a 3 KB head + 7 KB tail strategy; enforces a 120 s per-command timeout with synthetic exit code 124; and appends telemetry to `events.jsonl` on every run (pass, fail, or skip). `agents/forge-executor.md` gained step 10 (task-level gate before T##-SUMMARY write) and `agents/forge-completer.md` gained step 3 (slice-level gate before security scan). `forge-agent-prefs.md` documents the `verification:` settings block. `shared/forge-dispatch.md` gained a `## Verification Gate` section (8 subsections) covering invocation shape, failure handling, anti-recursion rule, and events schema. Five smoke scenarios + dogfood run on forge-agent itself all passed; gate is production-ready on Windows (win32).

**Key decisions:**
- Task-level gate reads T##-PLAN `verify:` frontmatter first; slice-level reads prefs `preference_commands` (no `--plan` flag at slice level).
- Slice-level gate failure returns `blocked + tooling_failure` — not routed through the Retry Handler (anti-recursion).
- `events.jsonl` I/O errors throw (not swallowed) — telemetry is a hard contract.
- Windows smoke dirs use `C:/temp/` (not `/tmp/`) due to platform constraints.

---

## S03 — Token counter + context budget

All 6 tasks completed (2026-04-16). The Forge orchestrator now has coarse-grained context observability and safe budget truncation for optional sections. A zero-dependency CommonJS helper (`scripts/forge-tokens.js`, 255 lines) ports the `Math.ceil(chars/4)` heuristic from GSD-2, exposing `countTokens(text)` and `truncateAtSectionBoundary(content, budgetChars, opts)` as both a Node module and a CLI. `shared/forge-dispatch.md` gained a `### Token Telemetry` control-flow section (with `#### Budgeted Section Injection` subsection) that instructs the orchestrator to compute `input_tokens` after placeholder substitution and log `{event:"dispatch", unit, model, input_tokens, output_tokens, ts}` to `events.jsonl` after every `Agent()` call. Both `skills/forge-auto/SKILL.md` and `skills/forge-next/SKILL.md` were patched with `<!-- token-telemetry-integration -->` markers wiring this flow. `skills/forge-status/SKILL.md` gained a `### Token usage` block that aggregates dispatch events for the active milestone and renders a pt-BR summary (total input/output tokens, dispatch count, per-phase breakdown). `forge-agent-prefs.md` gained `## Token Budget Settings` with keys `auto_memory: 2000`, `ledger_snapshot: 1500`, `coding_standards: 3000` (tokens; multiply by 4 for char budget). Four smoke scenarios all passed; pipeline is production-ready. S04's Tier Resolution block extends the dispatch event schema additively with `tier` and `reason` — no existing fields change.

**Key decisions:**
- `Math.ceil(chars/4)` is the sole counting method — no tiktoken, no npm deps (M002-CONTEXT D1).
- Mandatory sections throw `scope_exceeded` blocker on overflow; optional sections truncate at H2 boundary with `[...truncated N sections]` marker — no silent truncation ever.
- Token Telemetry is control-flow (not data-flow) — lives after fenced template blocks per MEM011.
- `BOUNDARY_RE` lookahead retains leading boundary line; frontmatter stripped before split to avoid false section boundaries.

---

## S04 — Complexity classifier + tier-only model router

All 6 tasks completed (2026-04-16). The Forge orchestrator now routes every dispatch through a tier-based model classifier: `light` (Haiku) for memory-extract / complete-* aggregation tasks, `standard` (Sonnet) for execute-task / research / discuss, and `heavy` (Opus) for plan-milestone / plan-slice. A new canonical reference doc (`shared/forge-tiers.md`, ~80 lines) maps all 10 unit types to tiers, defines the three tier→model defaults, and locks the 3-item override precedence chain (`tier:` frontmatter > `tag: docs` downgrade > unit-type default). A `### Tier Resolution` control-flow section (248 lines) was added to `shared/forge-dispatch.md` after `### Token Telemetry`, implementing the 5-step algorithm, prefs contract, frontmatter override table, and 3 worked examples. Both dispatch skills (`skills/forge-auto/SKILL.md`, `skills/forge-next/SKILL.md`) were patched with a step 1.5 block that runs tier resolution before every `Agent()` call; the existing dispatch event echo was extended with `tier` and `reason` fields (additive — S03 readers unaffected). `forge-agent-prefs.md` gained a `## Tier Settings` section with a `tier_models:` YAML block (defaults: haiku/sonnet/opus) so operators can re-route an entire tier by editing one key. Five smoke demos confirmed all 5 acceptance criteria; all events were JSON-valid and appended to `events.jsonl`. MEM015's selective memory injection block in forge-next was preserved intact at line 166 post-patch.

**Key decisions:**
- Pure Markdown `### Tier Resolution` block (no new Node script) per M002-CONTEXT D7 Hybrid C — tier classifier is heuristic/regex-level.
- Dispatch event extended additively with `tier` + `reason`; no field renames; compatibility paragraph documents S03 reader safety.
- T03 (forge-auto) and T04 (forge-next) derived independently per MEM015 — forge-next's step-mode layout diverges structurally from forge-auto's loop.
- Single `tier_models:` block in prefs as source of truth — model IDs referenced verbatim from `shared/forge-tiers.md` to prevent drift.
