---
slice: S01
milestone: M003
risk: medium
depends: []
status: planned
planned: 2026-04-16
---

# S01: Structured must-haves schema + executor validation

## Slice Goal

Establish the `must_haves:` + `expected_output:` YAML frontmatter schema in T##-PLAN files as the **single, machine-parseable contract** between planner and executor. The planner emits the block unconditionally for every net-new task; the executor validates it at task start and returns `blocked/scope_exceeded/missing_must_haves_schema` when absent or malformed. Legacy M001/M002 plans (free-text must-haves) pass through with a warn note via a shared detection predicate that S03 (verifier) and S04 (plan-checker) will reuse.

## Schema Shape (LOCKED — D3)

```yaml
---
id: T##
slice: S##
milestone: M###
must_haves:
  truths:
    - "Observable outcome 1"
    - "Observable outcome 2"
  artifacts:
    - path: "path/to/file.ts"
      provides: "one-line description of what this file exports/does"
      min_lines: 20
      stub_patterns: ["return null", "return <div/>"]   # optional
  key_links:
    - from: "path/a.ts"
      to: "path/b.ts"
      via: "import of functionX"
expected_output:
  - path/to/file.ts
  - path/to/other.ts
---
```

**Contract:**
- `must_haves` is a **map** with exactly three keys: `truths` (string array), `artifacts` (array of objects), `key_links` (array of objects).
- `artifacts[].path` and `artifacts[].min_lines` are REQUIRED per entry; `provides` is REQUIRED (human-readable); `stub_patterns` is OPTIONAL (array of regex strings, JS syntax).
- `key_links[]` has REQUIRED `from`, `to`, `via` fields.
- `expected_output` is a **top-level** key (sibling to `must_haves`), a flat array of path strings (file-audit input for S02).

## Task Decomposition

| ID | Title | Depends on | Files touched |
|----|-------|-----------|---------------|
| T01 | Schema detection predicate helper (shared, S03/S04 reuse) | — | `scripts/forge-must-haves.js` (new) |
| T02 | Planner emits `must_haves:` unconditionally in every T##-PLAN | T01 | `agents/forge-planner.md` |
| T03 | Executor reads/validates schema at Step 1; legacy skip | T01, T02 | `agents/forge-executor.md` |
| T04 | Add `evidence.mode: lenient` pref default (inert until S02) | — | `forge-agent-prefs.md` |
| T05 | Smoke demos — 3 plan samples × expected outcomes | T01, T02, T03 | `.gsd/milestones/M003/slices/S01/smoke/` |

## Acceptance Criteria (slice-level)

- [ ] Opening any T##-PLAN.md produced by the updated `forge-planner` shows a non-empty `must_haves:` block and an `expected_output:` array in the frontmatter.
- [ ] Deleting the `must_haves:` block from a net-new T##-PLAN and dispatching `execute-task` returns `---GSD-WORKER-RESULT---` with `status: blocked`, `blocker_class: scope_exceeded`, reason `missing_must_haves_schema`.
- [ ] A legacy-style plan (free-text "## Must-Haves" markdown section, no YAML `must_haves:` key) dispatched to the executor passes the schema check with a one-line warn note in `T##-SUMMARY.md` `## What Happened` and reaches the Execute step normally.
- [ ] `scripts/forge-must-haves.js --check <plan.md>` from CLI prints structured JSON and exits 0 for legacy, 0 for valid structured, 2 for malformed structured.
- [ ] `forge-agent-prefs.md` has a documented `evidence:` block with `mode: lenient` default (grep confirms). Block is inert — no code references it yet.
- [ ] `node --check scripts/forge-must-haves.js` passes.
- [ ] Three smoke demo plans (legacy / structured-valid / structured-missing-keys) live under `.gsd/milestones/M003/slices/S01/smoke/` and each has an expected-outcome line documented in `S01-SUMMARY.md` (produced at complete-slice, not now).

## Dependencies Consumed

- **YAML frontmatter extract idiom** — `scripts/forge-verify.js` lines 420-466 (Asset Map). T01 follows the same regex shape: `/^---\n([\s\S]*?)\n---/` for the block + per-key patterns; 1 MB size cap before regex.
- **Node CLI + module dual-mode** — Pattern Catalog. T01's `scripts/forge-must-haves.js` exports `hasStructuredMustHaves(planContent)` and `parseMustHaves(planContent)`; CLI mode via `require.main === module` guard.
- **Worker return contract** — CODING-STANDARDS Error Patterns. T03 surfaces blockers as `---GSD-WORKER-RESULT---` with `blocker_class: scope_exceeded`.
- **Agent frontmatter conventions** — Frontmatter Conventions table. T02/T03 edits preserve `name`, `description`, `model`, `tools`, `thinking`, `effort`.

## Dependencies Produced (for S02/S03/S04)

- `scripts/forge-must-haves.js` exports (S03 verifier + S04 plan-checker both consume `parseMustHaves` and `hasStructuredMustHaves`).
- Canonical `must_haves` schema shape (S03 reads `artifacts[].min_lines`, `artifacts[].stub_patterns`, `artifacts[].path`; S04 scores dimensions against it).
- `expected_output` field (S02 file-audit consumes this).
- `evidence.mode: lenient` pref key (S02 wires semantics).

## Risk Notes

- **Medium risk** per ROADMAP. Primary risks:
  1. Planner emission divergence between S02/S03/S04 consumers — mitigated by locking the schema shape HERE (above) and centralizing the parser in T01.
  2. Legacy detection false-positive (structured plan misclassified as legacy) — T01's predicate uses a narrow "must have `must_haves:` key at YAML root" test and T05's smoke demos explicitly cover this.
  3. Planner instructions drift vs executor validation — T02 and T03 reference the same schema shape inline from this S01-PLAN.
- No research slice required (shape already spelled out in CONTEXT D3 + SCOPE C1/C2).

## Ordering Notes

- T01 ships first — it's pure code with no agent/file dependencies and the other tasks import from it.
- T02 and T03 can be planned in parallel but T03 imports the T01 predicate via a shell-out from the executor's Step 1 (`node scripts/forge-must-haves.js --check <plan>`). Same tier, same session.
- T04 is independent (prefs file edit) — can run any time.
- T05 is last — it validates T01+T02+T03 together with seeded plan samples.

## Standards Reminder

- CommonJS + Node built-ins only (MEM017, M002 zero-deps rule)
- Files: `forge-<name>` prefix
- Top-level try/catch in scripts; hooks swallow, **non-hook scripts propagate** (error classifier pattern — exit 0 on logical outcomes, exit 2 on parse errors)
- Agent frontmatter edits: preserve existing `thinking:`/`effort:`/`tools:` fields
- Cross-platform path handling via `path.join`; never use backslashes in JS string literals
