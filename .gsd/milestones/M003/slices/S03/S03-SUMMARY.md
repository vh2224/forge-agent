---
id: S03
milestone: M003
title: "Goal-backward verifier (3-level)"
status: complete
completed_at: "2026-04-18"
provides:
  - "scripts/forge-verifier.js — CommonJS dual-mode module + CLI (975 lines)"
  - "verifyArtifact(mustHaves, sliceFiles) → {exists, substantive, wired, flags[]}"
  - "DEFAULT_STUB_REGEXES — 4-pattern ordered stub library (canonical precedence order)"
  - "Depth-2 BFS import-chain walker (walkImports) supporting ESM/CJS/re-exports/barrels"
  - "S##-VERIFICATION.md writer — per-artifact table with pass/fail per level + stub names"
  - "forge-completer sub-step 1.8 — verifier invocation + Verification Summary paragraph"
  - "Smoke fixtures (4 cases) + RESULTS.md regression record"
  - "Perf harness run-perf.js — cold/warm/hot benchmarks; hot mean ~3.5ms / 10 artifacts"
key_files:
  - scripts/forge-verifier.js
  - agents/forge-completer.md
  - .gsd/milestones/M003/slices/S03/smoke/RESULTS.md
  - .gsd/milestones/M003/slices/S03/perf/PERF-RESULTS.md
  - .gsd/milestones/M003/slices/S03/S03-VERIFICATION.md
  - .gsd/milestones/M003/slices/S03/perf/run-perf.js
key_decisions:
  - "return_null_function regex flags ALL bare return null; as heuristic — human triages per-artifact; stub_patterns:[] override disables per artifact"
  - "Wired check is per-artifact JS/TS detection (not per-repo) — each artifact independently assessed"
  - "sliceFiles converted to absolute paths at verifyArtifact boundary; deduped with Set"
  - "Sub-step 1.8 in forge-completer (skipping 1.7) preserves room for future insertions; always writes Verification Summary even on 0-artifact result"
  - "Wired v1 uses static import-chain scan only — evidence-{T##}.jsonl deferred to future slice per RISK card"
patterns_established:
  - "BFS walker with hop-tracking and depth_limit sentinel — scripts/forge-verifier.js walkImports()"
  - "Decimal-suffix sub-step insertion (1.5 → 1.6 → 1.8) in forge-completer without renumbering"
  - "Per-artifact isNonJsTs check (not per-repo) for graceful non-JS repo handling"
drill_down_paths:
  - .gsd/milestones/M003/slices/S03/tasks/T01/T01-SUMMARY.md
  - .gsd/milestones/M003/slices/S03/tasks/T02/T02-SUMMARY.md
  - .gsd/milestones/M003/slices/S03/tasks/T03/T03-SUMMARY.md
  - .gsd/milestones/M003/slices/S03/tasks/T04/T04-SUMMARY.md
  - .gsd/milestones/M003/slices/S03/tasks/T05/T05-SUMMARY.md
  - .gsd/milestones/M003/slices/S03/tasks/T06/T06-SUMMARY.md
---

# S03: Goal-backward verifier (3-level) — Summary

`scripts/forge-verifier.js` ships a zero-dep CommonJS 3-level artifact verifier (Exists / Substantive / Wired) that reads the locked `must_haves:` schema from `T##-PLAN.md` files and audits each declared artifact, writing a per-slice `S##-VERIFICATION.md`; `forge-completer` sub-step 1.8 invokes it automatically and embeds a paragraph summary in `S##-SUMMARY.md`.

## What Was Built

T01 created the core module: `verifyArtifact(mustHaves, sliceFiles, opts)` with 4 stub regexes in locked precedence order (`empty_function_body` → `return_null_function` → `jsx_placeholder_onclick` → `jsx_placeholder_return_div`), short-circuit evaluation across levels, per-invocation file cache, and per-artifact `stub_patterns: []` override. Wired level returned a placeholder at this stage.

T02 added the full CLI dual-mode: argv parsing (`--slice`, `--milestone`, `--cwd`, `--help`), `discoverTaskPlans` scanner, `aggregateMustHaves` classifier (structured / legacy / malformed / error), `runSliceVerification` pipeline, and `formatVerificationMd` + `writeVerificationMd` writer. Running the CLI against S03 itself produced the first live `S03-VERIFICATION.md`.

T03 replaced the Wired stub with a real depth-2 BFS import-chain walker. `extractImports` handles ESM `import from`, CJS `require`, re-exports `export ... from`, and barrel `export * from`. `resolveSpec` normalises Windows path separators via `path.normalize`. `walkImports` tracks `anyHopAtMaxDepth` to distinguish `depth_limit` (approximate) from `no_references_found`. Module grew from 682 to 975 lines.

T04 wired `forge-completer` sub-step 1.8: invoke the verifier CLI, parse JSON, read VERIFICATION.md, write `## Verification Summary` to `S##-SUMMARY.md` (always — even 0-artifact result is meaningful). Graceful fallback writes `## Verification Summary (unavailable)` when the script is missing or fails.

T05 created four smoke fixtures under `.gsd/milestones/M003/slices/S03/smoke/`: `legit-source.js` (passes all levels), `stub-source.js` (fails Substantive on `return_null_function`), `legacy-plan.md` (emits `skipped: legacy_schema`), `non-js-plan.md` (documents Exists short-circuit before Wired non-JS detection). RESULTS.md documents expected vs actual per fixture.

T06 created `perf/run-perf.js` harness and ran it 14 times. Hot-cache mean ~3.5ms per 10-artifact workload (budget: 2000ms). Cold-cache range 4.8–18.3ms (Windows Defender adds ~5–10ms on first-run file access).

### Known Heuristic Limits (per acceptance criterion 7)

- Stub detection is regex-based, not semantic analysis. `return null;` flags legitimate guards; human triage via `{regex_name, line_number, matched_text}` in VERIFICATION.md.
- Wired walker is depth-2 BFS. Artifacts behind 3-hop barrel chains get `wired: approximate, reason: depth_limit` — not failure, not pass.
- Perf budget 2s assumes hot cache (repeated invocations within the OS page-cache window). Cold (post-reboot) is dominated by Windows Defender per-file scan time, still well within budget in practice.
- Dynamic imports and `module.exports = require(...)` chains are not supported.
- Non-JS/TS artifacts emit `wired: skipped, reason: non_js_ts_repo` — not a failure.

## Verification Gate

- **Result:** skipped (no-stack)
- **Discovery source:** none
- **Command:** `node scripts/forge-verify.js --cwd . --unit complete-slice/S03`
- **Exit code:** 0
- **Timestamp:** 2026-04-18T19:45:28Z
- **Explanation:** No test stack configured for this repo. All acceptance criteria verified manually via task-level smoke runs and CLI invocations.

## Forward Intelligence

**What the next slice should know:** `scripts/forge-verifier.js` exports `verifyArtifact(mustHaves, sliceFiles, opts)` and all internals (`checkExists`, `checkSubstantive`, `checkWired`, `walkImports`, `resolveSpec`, `extractImports`, `DEFAULT_STUB_REGEXES`) — S04 plan-checker can import and reuse them if needed without re-implementing. The `parseMustHaves` function from `scripts/forge-must-haves.js` is the shared parser both S03 and S04 depend on; it **throws** on malformed structured plans — always wrap in try/catch.

**What's fragile:** The non-JS fixture smoke test documents a behavior divergence: files that don't exist hit Exists-fail short-circuit before the per-artifact non-JS check runs, so `wired: skipped, reason: non_js_ts_repo` only appears for files that actually exist with non-JS extensions. The `forge-completer` sub-step 1.8 only fires in the installed agent (`~/.claude/agents/forge-completer.md`) — requires `install.sh` / `install.ps1` re-run to activate.

**Authoritative diagnostics:** Run `node scripts/forge-verifier.js --slice S03 --milestone M003 --cwd .` to verify the verifier is functional. Run `node --check scripts/forge-verifier.js` to confirm syntax. Smoke fixture regression: `node -e "const {verifyArtifact}=require('./scripts/forge-verifier'); ..."` patterns documented in T03-SUMMARY.

**What assumptions changed:** The plan comment in T03 said "forge-verifier.js shows `wired: true` (it requires forge-must-haves.js)" — this was inverted. Wired checks whether OTHER files import THIS artifact, not what the artifact imports. forge-verifier.js correctly shows `wired: false` (nothing imports it in the candidate set); forge-must-haves.js correctly shows `wired: true` (forge-verifier.js requires it at line 61).
