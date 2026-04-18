# Scope Contract: M002 — Context Engineering Upgrades (GSD-2 Port)

**Defined:** 2026-04-16
**Approach:** Hybrid C — Node helpers where determinism matters (tokens, verify, error classify) + inline Markdown instructions where regex/heuristics suffice (complexity/tier routing).
**Sequencing:** 4 sequential slices — S01 error-classifier → S02 verification-gate → S03 token-counter → S04 complexity/tier router.

## In Scope

| Capability | Success Criterion | Verifiable by |
|------------|-------------------|---------------|
| Error classifier | Orchestrator can classify an `Agent()` exception into one of {rate_limit, network, server, context_overflow, model_refusal, tooling_failure, external_dependency, unknown} and apply a per-class retry strategy with exponential backoff. | `node scripts/forge-classify-error.js "HTTP 429 rate limit"` returns JSON `{class:"rate_limit", retry:true, backoff_ms:N}`; forcing a mock 503 during forge-auto shows auto-recovery and `.gsd/forge/events.jsonl` contains `{event:"retry", class, attempt}`. |
| Retry integration in forge-auto | forge-auto survives transient exceptions (rate_limit/network/server) without user intervention up to `max_transient_retries` (default 3); aborts with surfaced error after exhaustion. | Mock a transient 503 on first `Agent()` call; loop continues to next unit. Mock 4 consecutive 503s; loop halts with explicit error message, auto-mode deactivated. |
| Verification gate executor | `forge-executor` can run verify commands from T##-PLAN.md `verify:` field (or auto-detected from package.json/pyproject.toml/go.mod), collect exit codes, and block `done` result unless all exit 0. | `node scripts/forge-verify.js --plan path/to/T##-PLAN.md` exits non-zero when any command fails; truncated stderr is injected into next retry prompt; task with intentionally-broken code cannot be marked done. |
| Verify discovery chain | Gate resolves commands via chain: T##-PLAN `verify:` field → prefs `verification.preference_commands` → auto-detect (package.json scripts, pyproject.toml, go.mod) → skip gracefully (exit 0, log `skipped:no-stack`). | Run in docs-only repo (no package.json/pyproject/go.mod): gate exits 0 with `skipped:no-stack` in events.jsonl. Run in Node repo: gate runs `typecheck`/`lint`/`test` from package.json scripts if present. |
| Token counter | `scripts/forge-tokens.js` can count tokens of a given string using tiktoken when available and fallback `Math.ceil(chars/4)` when native binding fails; emits `{tokens, method}` JSON. | `node scripts/forge-tokens.js --file path` returns JSON with tokens count; running on Windows without Visual Studio Build Tools still returns a value using the fallback path. |
| Context budget truncation | `truncateAtSectionBoundary()` can truncate an injection to a configured token budget cutting only at Markdown section boundaries (`##`/`###`), never mid-paragraph; only applied to OPTIONAL sections (auto-memory, ledger snapshot, coding-standards). | Unit test: feed a 10k-token memory dump with budget 2k; output ends at an H2 boundary and token count <= 2k. Mandatory sections (plan, scope, slice-context) raise explicit error if they exceed budget instead of truncating. |
| Token telemetry | Every dispatched unit writes a `{event:"dispatch", unit, model, input_tokens, output_tokens}` line to `events.jsonl`; `/forge-status` renders a "Token usage" section summing tokens for the active milestone. | After running a slice, `grep '"input_tokens"' .gsd/forge/events.jsonl` returns rows; `/forge-status` output contains "Token usage:" block with non-zero totals. |
| Complexity classifier (tier-only) | Orchestrator can classify each unit into `{light, standard, heavy}` tier using inline Markdown rules (unit_type table + T##-PLAN inspection: file count, has-auth/crypto keywords, docs-only tag). | Running a docs-only task with `tag: docs` dispatches at `light` tier; running `plan-slice` dispatches at `heavy`; events.jsonl records `{tier, reason}` for each dispatch. |
| Tier-only model router | `shared/forge-tiers.md` table maps `tier → model` (light=Haiku, standard=Sonnet, heavy=Opus) with prefs override `tier_models:` in `claude-agent-prefs.md`; orchestrator selects model per unit based on classifier output. | Changing `tier_models.light` in prefs to `claude-sonnet-4-x` and re-running a light unit dispatches Sonnet instead of Haiku. Auditable in events.jsonl `model` field. |
| Manual tier override | User can set `tier: heavy` in a T##-PLAN.md frontmatter to force upgrade regardless of classifier output. | Task plan with `tier: heavy` and `tag: docs` still dispatches at heavy tier; override logged with `reason:"manual-override"` in events.jsonl. |
| Docs + prefs updates | `claude-agent-prefs.md` template documents new fields: `verification.preference_commands`, `tier_models`, `max_transient_retries`, `token_budget.*`. CLAUDE.md records architectural decisions for each slice. | Install a fresh repo via `forge-init`; `.gsd/claude-agent-prefs.md` contains all 4 new config blocks with sane defaults and inline comments. |

## Out of Scope

| Item | Reason |
|------|--------|
| Capability scoring (7-dim model profiles) | Over-engineering for current Forge use (Claude-only). Tier-only routing covers 95% of cases; scoring deferred to future milestone if multi-provider lands. |
| Cross-provider routing (GPT, Gemini, Deepseek) | Forge runs inside Claude Code only — no adapter layer for other SDK providers. Would require full runtime rearchitecture. |
| Reactive graph / worktree orchestrator (parallelism) | Explicitly deferred per user brief. Sequential dispatch is current contract; parallelism requires state-engine redesign. |
| Adaptive learning (`routing-history.js` — tier bump from historical failure rate) | Depends on mature telemetry that does not yet exist; premature optimization without baseline data. |
| Budget pressure downgrade (> 75% budget → lower tier) | Forge has no per-milestone budget concept yet; adding it is a separate product decision. |
| Runtime error capture (bg-shell, browser console scan from GSD-2 verification-gate.js) | Not applicable — Forge workers run in Claude Code sandbox with no persistent background shell; browser console is out of reach. |
| Dependency audit (`npm audit` post-task) | Isolated concern; belongs in a future `forge-audit` skill, not verification-gate. |
| `auto-model-selection.js` full port (capability profiles, scoring matrix) | Superseded by tier-only approach. Keeping GSD-2 code as reference only. |

## Deferred

| Item | Target milestone |
|------|-----------------|
| Capability scoring (7-dim) + multi-provider routing | M003 (only if multi-provider need surfaces) |
| Reactive graph / worktree parallel execution | M003 |
| Adaptive learning from routing history | M004+ |
| Per-milestone token budget + pressure downgrade | M004+ |
| `forge-audit` skill (npm audit, pip audit, etc.) | Future standalone milestone |
| Runtime error capture via background shell | Blocked on Claude Code platform support |

## Open questions (for discuss)

- **Q1:** Accept optional `tiktoken` native dep with `gpt-tokenizer` fallback, or force pure-JS `gpt-tokenizer` across the board (~10% precision loss, zero Windows build-tools risk)?
- **Q2:** When no verify commands are resolvable (no plan field, no prefs, no stack detected), should the gate skip gracefully (pass) or fail-closed (force user config)? Proposal: skip gracefully with logged `skipped:no-stack`.
- **Q3:** Default `UNIT_TYPE_TIERS` table — fixed defaults (planner=heavy, discusser=standard, memory=light) with prefs override, or require user to define from day 1? Proposal: fixed defaults + override.
- **Q4:** `max_transient_retries` default — 3 with exponential backoff (1s, 2s, 4s)? Confirm before halting.
- **Q5:** Confirm capability scoring stays OUT for M002 (M003 if multi-provider need appears).
- **Q6:** Final mandatory-vs-optional injection list. Proposal — mandatory: T##-PLAN, SCOPE, S##-CONTEXT. Optional (truncatable): AUTO-MEMORY, LEDGER snapshot, CODING-STANDARDS.
- **Q7:** Does Claude Code expose full exception text to the orchestrator catch block? Needs smoke test at S01 kickoff before writing classifier code; if opaque, S01 aborts.
