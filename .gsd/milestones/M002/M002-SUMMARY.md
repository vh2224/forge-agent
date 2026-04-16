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

## Slices remaining

- S03: Token counter + context budget (risk:low)
- S04: Complexity classifier + tier-only model router (risk:medium)
