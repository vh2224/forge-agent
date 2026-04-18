# Decisions

Append-only log of significant architectural decisions.

---

| Date | Milestone | Decision | Rationale |
|------|-----------|----------|-----------|
| 2026-04-15 | M001 | PostCompact hook writes compact-signal.json; forge-auto detects and recovers automatically | PreCompact cannot signal recovery because state is lost during compaction; PostCompact runs after with disk state intact |
| 2026-04-15 | M001 | Lean orchestrator: workers read own artifacts via Read tool, not inlined content | Reduces orchestrator context from ~10-50K/unit to ~500/unit; workers already have Read access |
| 2026-04-15 | M001 | /forge thin REPL router < 5K tokens as unified entry point | Survives compaction by fitting within Claude Code re-attachment budget |
| 2026-04-15 | M001 | Gradual migration: forge-auto, forge-task, forge-new-milestone to skills/ with shims in commands/ | Avoids big-bang risk; existing /forge-auto users unaffected |
| 2026-04-15 | M001 | All forge-* skills use disable-model-invocation: true | Prevents bug #26251 where skill invocation blocks user in slash command context |

## S01 complete-slice decisions (2026-04-15)
- PostCompact handler is a no-op when auto-mode.json has active:false — does not interfere with non-auto sessions
- compact-signal.json is deleted immediately after recovery to prevent re-triggering
- COMPACTION RESILIENCE behavioral rule retained as fallback for older Claude Code versions
- All hook I/O errors are swallowed via try/catch — hooks must never crash Claude Code

## S03 plan-slice decisions (2026-04-15)
- Install scripts already have skills/ copy logic with broad globs — no new install code needed for T05, just verification
- Skill frontmatter includes allowed-tools per ROADMAP spec
- Shims must pass $ARGUMENTS through to skills for flags like --skip-brainstorm, --resume, -fast

## S04 plan-slice decisions (2026-04-15)
- forge-statusline.js version is NOT hardcoded — uses git describe --tags --always
- T03 creates annotated git tag v1.0.0 instead of editing JS file
- T03 must execute after T01/T02/T04 committed
- All S04 tasks are documentation/versioning only

## M002 discuss decisions (2026-04-16)
- Token counting uses Math.ceil(chars/4) heuristic only — no new dep (tiktoken/gpt-tokenizer deferred)
- Transient retry policy: max=3, exponential backoff 2s/4s/8s for rate_limit/network/server/stream classes
- Tier defaults fixed in shared/forge-tiers.md; users override tier→model via tier_models prefs, not unit_type→tier
- Manual per-task override via tier: heavy in T##-PLAN frontmatter
- Verify discovery: plan.verify → prefs → auto-detect → skip gracefully (docs-only repos never blocked)
- Context budget: mandatory sections error on overflow; optional sections truncate at H2 boundary
- Approach: Hybrid C — Node scripts for determinism/execution, inline markdown for pure logic
- Slice order: error-classifier → verification-gate → token-counter → complexity/model-router

## S01 plan-slice decisions (2026-04-16, M002)
- S01 tasks ordered strictly sequential: T01 (smoke gate) → T02 (classifier CLI) → T03 (dispatch handler section) → T04 (wire into forge-auto + forge-next) → T05 (prefs + demo + summary). No parallelism.
- Classifier CLI uses CommonJS (require/module.exports) to match existing scripts/forge-hook.js and forge-statusline.js — diverges from GSD-2's ESM source
- Retry Handler placed in shared/forge-dispatch.md as utility section separate from data-flow templates (per MEM011: templates are data-flow descriptors; retries are control-flow)
- Backoff policy: classifier provides per-class defaults (3s network, 15s stream/connection, 30s server, reset-in or 60s rate-limit); retry handler may override with exponential 2s/4s/8s per attempt number
- Transient error classes retained: rate_limit, network, server, stream, connection (5 total — runtime behaviour governs)

## S01 research-slice decisions (2026-04-16, M002)
- CommonJS required for scripts/forge-classify-error.js — reference (GSD-2) is ESM; conversion needed for parity with forge-hook.js, forge-statusline.js, merge-settings.js
- Retry Handler section appends at shared/forge-dispatch.md:279 (after research-slice template) — does not disturb existing 7 templates
- T04 REPLACES the Agent() CRITICAL hard-stop block in skills/forge-auto/SKILL.md lines 251-258; retry-first semantic, hard-stop only on permanent/unknown/exhausted classes
- Sleep primitive in Claude-in-the-loop orchestrator: bash `sleep` (or Windows `ping -n` fallback) — no setTimeout available
- Retry events in events.jsonl MUST include class/attempt/backoff_ms but NOT raw error body (low-risk secret leakage prevention)
- CODING-STANDARDS.md first version created for this repo: 20 asset-map entries, 8 pattern catalog entries, auto-promoted rules preserved

## T01 execute-task decisions (2026-04-16, M002/S01)
- GSD-2 regex suite is valid as-is for 3 major Anthropic SDK error shapes (503/429/ECONNRESET) — T02 can port with confidence
- `unknown` classification + opaque errorMessage → T02 must treat as `tooling_failure` blocker (stop loop, surface to user, NOT retryable) — added to T02 scope

## T02 execute-task decisions (2026-04-16, M002/S01)
- Output shape: {kind, retry, backoffMs} — changed from GSD-2 original {kind, retryAfterMs} to add explicit `retry` boolean and rename backoff field
- `unknown` kind always retry:false; opaque strings (success/error/ok) map to unknown (T03/T04 will treat as tooling_failure blocker per MEM041)
- 4/4 smoke tests pass: 500→server, 429 reset in 45s→rate-limit(45000), ECONNRESET→network(3000), 401 unauthorized→permanent

## T03 execute-task decisions (2026-04-16, M002/S01)
- Retry Handler section placed at shared/forge-dispatch.md:283, structurally separate from the 7 data-flow templates (per MEM011 control-flow vs data-flow distinction)
- Backoff policy: Math.min(classifier.backoffMs, 2000*2^(attempt-1)) — honors per-class defaults when they're lower, applies exponential 2s/4s/8s cap otherwise
- Event log schema: {ts, event:"retry", unit, class, attempt, backoff_ms, model} — errorMsg EXCLUDED (verified via grep)
- Kind table covers all 7 classifier outputs (5 transient + permanent + unknown)
- Drop-in compatibility design: `while(true)` retry block works in both forge-auto (linear) and forge-next (with selective memory injection block per MEM015)

## T05 execute-task decisions (2026-04-16, M002/S01)
- Retry prefs schema: retry.max_transient_retries=3, retry.base_backoff_ms=2000, retry.max_backoff_ms=60000
- Deviation noted in executor: plan had backoff_cap_ms=30000 but must-have said max_backoff_ms=60000 → used 60000 (must-have governs)
- S01-SUMMARY.md written as source for eventual CHANGELOG entry at M002 release time (per MEM027)

## M003 discuss-milestone decisions (2026-04-16)
- Evidence hook location: extend scripts/forge-hook.js PostToolUse branch (no separate script, no require'd module) — keeps hook surface unified
- Verification evidence format: YAML frontmatter block verification_evidence: [{command, exit_code, matched_line}] in T##-SUMMARY — machine-parseable, same parser as other frontmatter fields; no markdown table
- Must-haves enforcement: forge-planner emits structured must_haves: block unconditionally; forge-executor blocks with scope_exceeded/missing_must_haves_schema if absent — legacy M001/M002 plans get backward-compat skip
- File-audit scope: git diff --diff-filter=AM (additions + modifications only) vs expected_output union — deletions NOT audited; no expected_deletions: field
- Brainstorm-suggested slice order: S01 must-haves foundation → S02 evidence+file-audit → S03 verifier → S04 plan-checker (advisory); planner may adjust respecting: verifier depends on must_haves schema, evidence cross-ref depends on verification_evidence format

## M003 S01 plan-slice decisions (2026-04-16)
- Schema shape LOCKED for downstream S02/S03/S04: must_haves.{truths[], artifacts[{path, provides, min_lines, stub_patterns?}], key_links[{from, to, via}]} + expected_output[paths]
- Legacy-vs-structured detection centralized in scripts/forge-must-haves.js (CommonJS dual-mode, Node built-ins only) — single predicate reused by S03 verifier and S04 plan-checker
- Executor schema check runs BEFORE status:RUNNING in T##-PLAN frontmatter — blocked plans never leave dirty in-flight markers
- Legacy plans get graceful pass-through with legacy_schema:true warn in T##-SUMMARY (C13 backward-compat) — never blocks
- T05 smoke fixtures (legacy + structured-valid + structured-malformed) live under .gsd/milestones/M003/slices/S01/smoke/ and serve as canonical regression set for S03/S04
- Evidence prefs block (evidence.mode: lenient) scaffolded INERT in T04 — pure prose placeholder, S02 wires consumption

## M003 S01 T01 execute-task decisions (2026-04-16)
- YAML frontmatter regex in forge-must-haves.js uses [ \t]* instead of \s* for key matching — \s matches newlines and causes greedy cross-line capture
- Nested YAML maps parsed via extractSubBlock + dedent-2-spaces pattern (not a recursive generic YAML parser) — matches forge-verify.js precedent

## M003 S01 complete-slice forward intelligence (2026-04-16)
- S02 must read expected_output as TOP-LEVEL frontmatter key (sibling to must_haves, NOT nested inside)
- parseMustHaves throws on malformed — S02/S03/S04 consumers must wrap in try/catch
- Regex convention locked: use [ \t]* (not \s*) for single-line frontmatter key matching — cross-line greedy capture bug
- evidence.mode pref key exists in forge-agent-prefs.md but has zero consumers until S02 wires PostToolUse hook

## M003 S02 plan-slice decisions (2026-04-16)
- Execution order T01 → T02 → T05 → T04 → T03 (serialized completer edits: T03 and T04 both mutate forge-completer.md)
- PostToolUse hooks do NOT expose exit_code directly — use ok:boolean derived from success!==false && interrupted!==true; executor's self-reported exit_code in verification_evidence (T02) is authoritative
- Evidence line cross-ref (T03) compares command substring only, NOT exit codes
- T04 inline parses expected_output via regex rather than extending forge-must-haves.js CLI — rationale: avoid reopening S01 schema contract; if broader parse needed, S03 can extract forge-expected.js
- Perf budget C4 for hook (≤15ms p50 / ≤50ms p95) measured as ADDITIONAL cost relative to existing baseline hook — not absolute wall-clock (Node cold-start dominates on Windows)

## M003 S02 research-slice decisions (2026-04-16)
- PostToolUse hooks ALWAYS spawn as subprocess (no in-process option) — C4 perf budget must be reported as both in-script work time (hrtime.bigint) AND full wall-clock, averaged over ≥50 runs
- T04 file-audit must fallback master → main → origin/HEAD → working-tree chain (not assume master exists) — research surfaced this gap in T04-PLAN
- Evidence line truncation: suffix-ellipsis pattern (matches project convention, no new helper needed)
- auto_commit:false path uses `git diff --diff-filter=AM HEAD` UNION `git ls-files --others --exclude-standard` to capture staged+unstaged+untracked changes

## M003 S02 complete-slice forward intelligence (2026-04-16)
- forge-completer new features (step 1.5 Evidence cross-ref + step 1.6 File Audit) activate only after install.sh re-runs — completer agent runs from ~/.claude/agents/ not repo ./agents/
- S03 consumers: evidence-{T##}.jsonl path, verification_evidence frontmatter shape, expected_output inline regex — all locked and validated
- Hook additional cost (evidence write) measured: p50 and p95 reported in T01-SUMMARY
