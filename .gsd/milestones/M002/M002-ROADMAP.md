# M002 — Context Engineering Upgrades (GSD-2 Port)

**Planned:** 2026-04-16
**Status:** Ready for execution
**Approach:** Hybrid C — Node helpers in `scripts/forge-*.js` for determinism/execution; inline Markdown in `shared/forge-dispatch.md` + skill/command bodies for pure regex/heuristic logic.
**Sequencing:** 4 sequential slices, each one commits before the next begins.

---

## Vision

Port four high-impact Context Engineering features from the GSD-2 TypeScript extension into Forge's shell-first + skill-first architecture so the orchestrator gains: (1) automatic recovery from transient provider errors via regex-classified retry with exponential backoff, (2) an executable verification gate that blocks "done" until typecheck/lint/test pass via a discovery chain that degrades gracefully in docs-only repos, (3) coarse-grained token telemetry and section-boundary context budget truncation for observability without new dependencies, and (4) a tier-only complexity classifier + model router that downgrades routine units (memory-extract, run-uat, complete-slice) to lighter models while keeping planner/executor at configured ceiling — all gated behind the existing prefs system, fully auditable via `events.jsonl`, and free of runtime npm dependencies (Math.ceil/4 heuristic for tokens per discuss decision).

---

## Slices

- [x] **S01: Error classifier + retry integration** `risk:medium` `depends:[]`
  Demo: force a mock 503/429/ECONNRESET in a forge-auto unit dispatch; orchestrator auto-recovers with correct exponential backoff (2s/4s/8s) for up to 3 attempts, logs each retry to `events.jsonl`, and surfaces a clean error after exhaustion. Smoke test on kickoff confirms the exception text reaching the orchestrator catch block is classifier-legible (validates assumption A1).

- [x] **S02: Verification gate executable** `risk:high` `depends:[S01]`
  Demo: task with `verify: npm run typecheck && npm test` in T##-PLAN.md frontmatter executes the commands via `scripts/forge-verify.js`, blocks worker result when any exits non-zero, and injects truncated stderr into the next retry prompt. Gate is also exercised against (a) a Node repo with auto-detected `package.json` scripts and (b) a docs-only repo where it skips gracefully with `skipped:no-stack` in `events.jsonl`.

- [x] **S03: Token counter + context budget** `risk:low` `depends:[S01]`
  Demo: every dispatched unit writes `{event:"dispatch", unit, model, input_tokens, output_tokens}` to `events.jsonl` using the `Math.ceil(chars/4)` heuristic from `scripts/forge-tokens.js`; `/forge-status` renders a "Token usage" block summing tokens for the active milestone; injecting a 10k-token AUTO-MEMORY dump with budget 2k produces truncated output ending at an H2 boundary with a `[...truncated N sections]` marker; mandatory sections (T##-PLAN, S##-CONTEXT) error explicitly if they exceed budget instead of silently truncating.

- [x] **S04: Complexity classifier + tier-only model router** `risk:medium` `depends:[S01, S03]`
  Demo: `memory-extract` unit dispatches at `light` tier (Haiku), `plan-slice` dispatches at `heavy` tier (Opus), `execute-task` with `tag: docs` frontmatter dispatches at `light`, and `execute-task` with `tier: heavy` override in frontmatter forces heavy regardless of tags; each dispatch logs `{tier, model, reason}` to `events.jsonl`; changing `tier_models.light` in `claude-agent-prefs.md` from Haiku to Sonnet re-routes light units to Sonnet on next dispatch without code changes.

---

## Boundary Map

Tracks what each slice **produces** (new/modified files) and what it **consumes** (files that must exist from prior slices). Keeps integration contracts explicit so downstream slices don't guess upstream shape.

### S01 — Error classifier + retry integration

**Produces:**
- `scripts/forge-classify-error.js` — Node CLI + module. Exports `classifyError(errorMsg, retryAfterMs?)` returning `{kind, retry, backoffMs}`; CLI accepts stdin or arg, prints JSON to stdout.
- `shared/forge-dispatch.md` (modified) — new section **Retry Handler** with instruction block that: (a) catches `Agent()` exception, (b) shells out to `node scripts/forge-classify-error.js`, (c) applies backoff + up to `max_transient_retries` per class, (d) appends `{event:"retry", unit, class, attempt, backoff_ms}` to `events.jsonl`.
- `commands/forge-auto.md` + `skills/forge-auto/SKILL.md` (modified) — wrap the dispatch call in the retry handler from `shared/forge-dispatch.md`.
- `commands/forge-next.md` (modified) — same retry handler wrapper (MEM015: structurally divergent from forge-auto; patch both independently).
- `forge-agent-prefs.md` (modified) — new prefs block `retry:` with `max_transient_retries: 3` default and documentation of per-class retry behavior.
- Smoke-test artifact (inline in S01-SUMMARY.md) — transcript of forcing a mock 503/429/ECONNRESET and observing auto-recovery.

**Consumes:**
- None (first slice).

---

### S02 — Verification gate executable

**Produces:**
- `scripts/forge-verify.js` — Node CLI + module. Implements discovery chain (plan.verify → prefs.verification.preference_commands → auto-detect package.json scripts / pyproject.toml / go.mod → `skipped:no-stack`). Uses `spawnSync` with `cmd`/`sh` dispatch per `process.platform`, truncates stderr to 10KB per command and 10KB total, exits non-zero on any check fail.
- `agents/forge-executor.md` (modified) — new step before writing T##-SUMMARY.md: invoke `node scripts/forge-verify.js --plan {T##-PLAN path} --cwd {WORKING_DIR}`. On non-zero exit, refuse to return `done` — return `partial` with truncated failure context injected into the prompt for the next retry.
- `agents/forge-completer.md` (modified) — same gate invocation at slice level before squash-merge (step 3, before existing lint gate); records `## Verification Gate` section in S##-SUMMARY.md with commands + exit codes + discovery source.
- `forge-agent-prefs.md` (modified) — new block `verification:` with `preference_commands: []` default and inline docs describing the discovery chain.
- `shared/forge-dispatch.md` (modified) — `execute-task` template and `complete-slice` template gain `## Verification Gate` instruction block that reads the prefs and T##-PLAN `verify:` frontmatter field.
- Manual test transcripts (inline in S02-SUMMARY.md) — three runs: Node repo with package.json scripts, task with explicit `verify:` frontmatter, docs-only repo with graceful skip.

**Consumes:**
- `scripts/forge-classify-error.js` (S01) — if verify command itself throws a transient error (e.g., flaky network in `npm test`), classifier applies retry before marking the check failed.
- `shared/forge-dispatch.md` Retry Handler section (S01) — verify gate failures that are transient errors use the same retry path.

---

### S03 — Token counter + context budget

**Produces:**
- `scripts/forge-tokens.js` — Node CLI + module. Exports `countTokens(text)` = `Math.ceil(text.length / 4)` (no tiktoken import per discuss D1), `truncateAtSectionBoundary(content, budgetChars, {mandatory?: boolean})` that splits on `^## `/`^### `/`^---$` boundaries and appends `[...truncated N sections]`. CLI: `node scripts/forge-tokens.js --file <path>` prints `{tokens, chars, method:"heuristic"}`.
- `shared/forge-dispatch.md` (modified) — every template gains a **Token Telemetry** footer that computes `input_tokens` after all `{...}` substitutions are resolved (but before dispatch) and logs `{event:"dispatch", unit, model, input_tokens, output_tokens, ts}` to `events.jsonl`. Output tokens read from worker result metadata.
- `shared/forge-dispatch.md` (modified) — optional-section injections (AUTO-MEMORY, ledger snapshot, CODING-STANDARDS) wrapped in a helper that calls `forge-tokens.js truncate` with the configured `token_budget.*` values. Mandatory sections (T##-PLAN, S##-CONTEXT, SCOPE) raise explicit error if they exceed their individual budget.
- `commands/forge-status.md` (modified) — new **Token usage** section reads `.gsd/forge/events.jsonl`, filters for current milestone, sums input+output tokens per phase and grand total.
- `forge-agent-prefs.md` (modified) — new block `token_budget:` with keys `auto_memory`, `ledger_snapshot`, `coding_standards` (default 2000/1500/3000 tokens respectively). Inline comment explains these are *optional-section caps*, not per-unit limits.
- Unit test artifact (inline in S03-SUMMARY.md) — feed a known 10k-token file through truncation with budget 2k and verify output ends at H2 boundary.

**Consumes:**
- `scripts/forge-classify-error.js` (S01) — wrapped in retry path if telemetry write to `events.jsonl` hits an I/O error (unlikely but documented).

---

### S04 — Complexity classifier + tier-only model router

**Produces:**
- `shared/forge-tiers.md` (new) — canonical `unit_type → tier` table (light/standard/heavy) + `tier → default_model` table (light=Haiku, standard=Sonnet, heavy=Opus) + escalation rules + documentation of manual override precedence (T##-PLAN `tier:` frontmatter > `tag: docs`-based downgrade > unit_type default). No Node code — pure reference doc.
- `shared/forge-dispatch.md` (modified) — new **Tier Resolution** block before each dispatch that: (a) reads `unit_type`, (b) if `execute-task`, reads T##-PLAN frontmatter for explicit `tier:` or `tag:`, (c) resolves `tier → model` via PREFS `tier_models` with fallback to `shared/forge-tiers.md` defaults, (d) logs `{event:"dispatch", tier, model, reason}` to `events.jsonl`. Tier resolution is inline Markdown instructions — no new script (per discuss D7: Hybrid C approach).
- `commands/forge-auto.md` + `skills/forge-auto/SKILL.md` (modified) — consume new Tier Resolution block from `shared/forge-dispatch.md`.
- `commands/forge-next.md` (modified) — same Tier Resolution consumption (MEM015 reminder: forge-next has its own memory injection block; patch carefully).
- `forge-agent-prefs.md` (modified) — new block `tier_models:` with entries for `light`, `standard`, `heavy` defaulting to current model IDs + inline docs pointing to `shared/forge-tiers.md`.
- `CLAUDE.md` (modified) — new "Tier-only model routing" decision in the Decisions section (summarizes S04 behavior for future agents).
- `/forge-status` (modified) — **Tier usage** breakdown (units dispatched per tier in current milestone).
- Demo transcripts (inline in S04-SUMMARY.md) — (a) memory-extract on Haiku, (b) plan-slice on Opus, (c) execute-task with `tag: docs` downgraded to Haiku, (d) same task with `tier: heavy` override keeping Opus, (e) prefs override of `tier_models.light` → Sonnet taking effect on next dispatch.

**Consumes:**
- `scripts/forge-classify-error.js` (S01) — on dispatch failure, retry handler chooses same tier by default; optional future escalation pref (OUT of M002) would read `escalateTier()` helper.
- `scripts/forge-tokens.js` (S03) — tier routing decisions logged alongside input/output tokens so `/forge-status` can compute cost approximations from tier × tokens.
- `shared/forge-dispatch.md` Token Telemetry block (S03) — extends the dispatch log line with `tier` and `reason` fields (same event, two contributions).

---

## Risk Notes

- **S01 kickoff smoke test is non-negotiable.** Assumption A1 from brainstorm: if `Agent()` exception text is opaque to the orchestrator catch block, the entire milestone architecture collapses. First action of S01 is a mock-error smoke test; if opaque, abort and escalate before writing classifier code.
- **S02 is the only `risk:high` slice.** Multi-stack discovery chain must be exercised against three repo shapes (Node, Python, docs-only) before commit — otherwise the default behavior will either silently pass broken code or halt docs-only work. Risk-radar gate will auto-trigger before plan-slice S02.
- **S04 is behind S01+S03 by design.** Tier routing needs (a) retry infrastructure from S01 to recover when a downgraded model fails, (b) token telemetry from S03 to validate the downgrade economy. Resist the urge to start S04 early.

---

## Out-of-scope reminders (from SCOPE.md)

Capability scoring (7-dim), cross-provider routing, reactive graph / worktree parallelism, adaptive learning from routing history, budget-pressure downgrade, runtime error capture (bg-shell + browser console), `npm audit` post-task, full `auto-model-selection.js` port. All deferred to M003+ or declared out of scope entirely.
