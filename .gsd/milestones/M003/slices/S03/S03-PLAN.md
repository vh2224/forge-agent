---
id: S03
milestone: M003
title: "Goal-backward verifier (3-level)"
risk: high
depends: [S01, S02]
status: planned
planned: 2026-04-16
---

# S03: Goal-backward verifier (3-level) — Plan

Ship `scripts/forge-verifier.js` — a CommonJS dual-mode script that reads the structured `must_haves:` schema (produced by S01) from every `T##-PLAN.md` in a slice and audits each declared artifact at three levels: **Exists** (file present, ≥1 line), **Substantive** (line count ≥ `min_lines`, no stub patterns match), and **Wired** (≥1 import/call reference from another JS/TS file within the slice, depth-2 walker). The verifier writes a per-slice `S##-VERIFICATION.md` with pass/fail rows; `forge-completer` invokes it as a new advisory sub-step (1.8, after File Audit 1.6) and summarises the verdict inline.

The verifier ships advisory-only, heuristic-only, zero-deps, CommonJS, Windows-safe. It never blocks a slice closure; flags surface in `S##-VERIFICATION.md` for human triage.

## Acceptance Criteria (for complete-slice gate)

1. `scripts/forge-verifier.js` exists, parses with `node --check`, and exports `verifyArtifact(mustHaves, sliceFiles) → {exists, substantive, wired, flags[]}`.
2. CLI `node scripts/forge-verifier.js --slice S## --milestone M### --cwd <dir>` prints JSON to stdout and writes `.gsd/milestones/M###/slices/S##/S##-VERIFICATION.md`.
3. Running against the S03 smoke fixtures produces: legit file passes Exists + Substantive + Wired; stub file (`() => null`) fails Substantive with the matching regex name recorded; legacy plan (no `must_haves:`) emits `skipped: legacy_schema` rows without crashing.
4. 10-artifact slice completes in ≤ 2s wall-clock on Windows (hot cache — measured and recorded in SUMMARY).
5. Non-JS/TS plan (zero `.js|.ts|.tsx|.jsx|.mjs|.cjs` paths in `artifacts[]`) emits `wired: skipped, reason: non_js_ts_repo` per artifact — not a failure.
6. `forge-completer` sub-step 1.8 invokes the verifier after sub-step 1.6 (File Audit), reads `S##-VERIFICATION.md`, and writes a one-paragraph `## Verification Summary` section into `S##-SUMMARY.md`.
7. `S03-SUMMARY.md` documents known heuristic limits: stub-detection is regex-based (not semantic analysis), Wired walker is depth-2 (misses deeper chains), perf budget assumes hot cache.

## Task Breakdown (6 tasks)

| T## | Title | Tier | Depends | Outputs |
|-----|-------|------|---------|---------|
| T01 | `scripts/forge-verifier.js` core module — 3-level API, stub regex library, short-circuit eval | standard | — | `scripts/forge-verifier.js` (≥ 220 lines) |
| T02 | CLI dual-mode + `S##-VERIFICATION.md` writer | standard | T01 | extends `scripts/forge-verifier.js`; template for VERIFICATION.md |
| T03 | Import-chain walker (Wired level) — depth-2 JS/TS scan | standard | T01 | extends `scripts/forge-verifier.js` with `walkImports(file, slice, depth=2)` |
| T04 | Wire `forge-completer` sub-step 1.8 — invoke verifier + summarise | light | T02 | `agents/forge-completer.md` edit (insert sub-step 1.8) |
| T05 | Smoke fixtures — legit/stub/legacy/non-JS cases + RESULTS.md | light | T02 | `.gsd/milestones/M003/slices/S03/smoke/` + RESULTS.md |
| T06 | Perf smoke — cold/warm/hot measurements on Windows, record in SUMMARY | light | T02, T03 | appendix in `S03-SUMMARY.md` + perf harness script (optional) |

### Dependency graph
```
T01 ──┬─► T02 ──┬─► T04 ──► complete-slice
      │        │
      ├─► T03 ─┤
      │        │
      │        ├─► T05 (smoke)
      │        └─► T06 (perf)
```

T03 can run in parallel with T02 (both extend T01's module); orchestrator will serialise them per one-task-at-a-time policy.

## Boundary Map — what this slice produces and consumes

### Produces

- `scripts/forge-verifier.js` — new CommonJS dual-mode script, zero deps, exports `verifyArtifact(mustHaves, sliceFiles)`, CLI `--slice/--milestone/--cwd`.
- `S##-VERIFICATION.md` template — per-artifact table with columns: `artifact | exists | substantive | wired | flags`.
- Stub regex defaults (JS/TS): `return null` (function body), `onClick={() => {}}` (JSX no-op), `return <div />` (placeholder JSX), empty function bodies `function foo() {}` / `() => {}` / `async () => {}`.
- Regex precedence order documented in module header (MEM038 precedent).
- Depth-2 import-chain walker supporting ESM `import from`, CJS `require`, re-exports `export ... from`, barrel `export * from`.
- `forge-completer.md` sub-step 1.8 — invokes verifier, reads VERIFICATION.md, writes `## Verification Summary` to `S##-SUMMARY.md`.

### Consumes

- `must_haves:` schema from S01 — `artifacts[{path, provides, min_lines, stub_patterns?}]`, `key_links[{from, to, via}]`, top-level `expected_output[]`. **Schema is LOCKED** per MEM044/050.
- `hasStructuredMustHaves` + `parseMustHaves` from `scripts/forge-must-haves.js` (S01) — required deps for legacy skip and parse.
- `[ \t]*` regex idiom (MEM047) — any new top-level key matching in verifier must use `[ \t]*` not `\s*`.
- Cross-platform shell dispatch pattern from Asset Map (`scripts/forge-verify.js` lines 321–330) if shelling out.
- Optionally: `.gsd/forge/evidence-{T##}.jsonl` from S02 — **DEFERRED** per RISK card; Wired level uses only static import-chain scan in v1.
- `forge-completer` sub-step letter-suffix convention (MEM from S02) — use `1.8` to insert after 1.6 without cascading renumbers.

## Risk Callouts (from S03-RISK.md — must be honoured)

1. **Schema was frozen in S01 ([x] in ROADMAP)** — verifier reads `artifacts[{path, min_lines, stub_patterns?}]` and `key_links[{from, to, via}]` exactly. No schema changes allowed in this slice.
2. **Wired level defers evidence log** — ROADMAP line 94 says "optional; primary signal is static import-chain scan". This plan takes that literally: v1 does NOT read `evidence-{T##}.jsonl`. Documented in T03 Non-Goals and SUMMARY.
3. **Stub-detection false positives** — each match emits `{regex_name, line_number, matched_text}` so a human can triage. Per-artifact override `stub_patterns: []` turns detection off for that artifact.
4. **Perf budget 2s on Windows hot cache** — T06 measures cold/warm/hot; budget assumed hot. Implementation uses single-invocation file-read cache + short-circuit Exists→Substantive→Wired.
5. **Non-JS/TS repos** — detect extensions in `artifacts[].path`; if zero JS/TS, emit `wired: skipped, reason: non_js_ts_repo`. Not failure.
6. **Legacy plans** — `hasStructuredMustHaves` returns false → emit `skipped: legacy_schema` per artifact. Never crash (C13).
7. **Regex precedence order** (MEM038) — documented in module header + unit-like smoke fixture flips verdict if reordered.
8. **Barrel depth limit** — depth-2 walker emits `wired: approximate, reason: depth_limit` when cap hit with no resolution. Not failure, not success — signal for human review.
9. **Export detection in TS/ESM is non-trivial** — documented limitations in T03 Non-Goals: re-exports through multi-hop barrels, dynamic imports, `module.exports = require(...)` chains.
10. **Research-slice skipped** — AUTO-MEMORY noted tension: RISK card advises research-first, dispatch table plans first. **Resolution:** this PLAN is self-contained (stub regex list uses M002 precedent + risk-card contraexamples). If research-slice later lands, T05 smoke fixtures serve as the calibration baseline.

## Context

### From M003-CONTEXT
- **D3 (must_haves enforcement):** schema emitted unconditionally by planner; executor blocks if missing. Verifier consumes the LOCKED shape.
- **D4 (file-audit AM-only):** no deletions tracked. Verifier is additive/modification-focused too; doesn't audit removed files.
- **Agent's Discretion:** stub regex patterns tunable during implementation. Performance budget is one-time benchmark, no runtime telemetry.

### From S01-SUMMARY (Forward Intelligence)
- `parseMustHaves` **throws** on malformed structured plans — wrap in try/catch; on throw, treat as legacy-equivalent for robustness.
- `hasStructuredMustHaves` is the cheap pre-check; always call it first.
- `expected_output` is a **top-level YAML key**, sibling to `must_haves:` — not nested.
- `extractTopLevelValue` uses `[ \t]*` not `\s*` — preserve this in any new regex.
- Smoke fixtures at `.gsd/milestones/M003/slices/S01/smoke/` are valid regression inputs (legacy / structured-valid / structured-malformed).

### From S02-SUMMARY (Forward Intelligence)
- Evidence JSONL path is `.gsd/forge/evidence-{unitId}.jsonl` where `unitId` = right-half of `worker` in `auto-mode.json`. Falls back to `evidence-adhoc.jsonl`.
- Line shape LOCKED: `{ts, tool, cmd, file, ok, interrupted}`.
- `disabled` mode produces zero files — walker must tolerate missing log (treat as "no corroborating evidence", not error).
- `verification_evidence:` shape in T##-SUMMARY: `[{command, exit_code, matched_line}]`; `matched_line: 0` = grep miss.
- Deletions not tracked anywhere (D4); verifier inherits this boundary.

### From CODING-STANDARDS
- CommonJS + Node built-ins only (MEM017).
- `scripts/forge-<verb>.js` naming, `#!/usr/bin/env node` shebang, dual-mode CLI pattern.
- `path.join` everywhere — no hardcoded separators.
- `spawnSync` explicit shell binary on win32 (`cmd /c`) vs unix (`sh -c`) for shell-outs; `shell: false`. Avoids DEP0190.
- Telemetry appends (events.jsonl) propagate errors — verifier CLI is telemetry-adjacent but writes its own artifact (VERIFICATION.md), not events.jsonl. Still propagate I/O errors; silent-fail only applies to hooks.
- Pattern Catalog: "Node CLI + module dual-mode" — matches T01/T02 precisely. `require.main === module` guard.

### From AUTO-MEMORY
- MEM044/050: schema LOCKED — `artifacts[{path, min_lines, stub_patterns?}]` + `key_links[{from, to, via}]`.
- MEM038: regex precedence order matters — document explicit order canonically in module header.
- MEM047: `[ \t]*` not `\s*` for YAML key matching.
- MEM052: evidence log Wired corroboration OPTIONAL — defer per RISK.
- MEM058: git diff covers tracked files only — use `ls-files --others --exclude-standard` for untracked. Relevant if verifier ever shells git (v1 does not; reads files via fs directly).
- MEM068: agent edits need `install.sh` re-run to be live — applies to T04 (forge-completer edit); document that `S##-VERIFICATION.md` generation only activates after install.

## Non-Goals

- **Semantic analysis.** Verifier is regex-based and import-chain-scan heuristic. Does not track data flow, call graphs, or type-level reachability.
- **Python/Go/Rust Wired support.** JS/TS only. Non-JS artifacts emit `wired: skipped, reason: non_js_ts_repo`.
- **Evidence log integration.** v1 does not read `evidence-*.jsonl`. Future slices may add as corroborating Wired signal.
- **Deletion auditing.** Mirrors D4 (file-audit AM-only). Removed files are not verified.
- **Runtime blocking.** Verifier is advisory — never returns blocker from completer sub-step 1.8.
- **100% coverage promise.** SUMMARY explicitly documents heuristic limits.
- **Dynamic imports / `module.exports = require(...)` chains** — documented limitation, not a bug.

## UAT Outline (for S##-UAT.md at completion)

| # | Action | Expected |
|---|--------|----------|
| 1 | Run `node scripts/forge-verifier.js --slice S03 --milestone M003` against S01 structured-valid fixture | JSON to stdout + VERIFICATION.md with one artifact row, `exists: pass / substantive: pass / wired: <n/a on fixture>` |
| 2 | Modify a fixture file to `() => null` (3 lines) | Stub regex name `return_null_function` appears in flags; `substantive: fail` |
| 3 | Run against S01 legacy fixture | `skipped: legacy_schema` for all artifact rows; exit 0; no crash |
| 4 | Create a fixture with Python-only paths in `artifacts[].path` | `wired: skipped, reason: non_js_ts_repo` per row |
| 5 | Invoke `forge-completer` on a fake slice with mixed valid/stub artifacts | `S##-SUMMARY.md` gains `## Verification Summary` paragraph; VERIFICATION.md exists in slice dir |
| 6 | Time 10-artifact run with perf harness (T06) | Hot: ≤ 2s; Cold/Warm recorded for transparency |

## Forward Intelligence (for S04 — plan-checker)

When S04 lands, it will score `must_haves-wellformed` and `expected-output-realistic` dimensions. Both can call into `scripts/forge-must-haves.js` (S01) for validation. S03 does NOT share scoring logic with S04 — they're orthogonal: S03 audits what was built, S04 audits what is planned. Shared data: the LOCKED `must_haves:` schema.
