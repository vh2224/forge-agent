# M003: Anti-Hallucination Layer — Context

**Gathered:** 2026-04-16
**Status:** Ready for planning
**Source:** brainstorm + scope-clarity + interactive discuss

## Implementation Decisions

### D1. Evidence hook location — extend forge-hook.js
The PostToolUse branch in `scripts/forge-hook.js` is extended to append evidence lines to `.gsd/forge/evidence-{unitId}.jsonl`. No separate script or require'd module.

**Why:** Keeps the hook surface area unified. Every Claude Code hook event already lives in one file; adding a second hook command in settings.json doubles registration complexity and risks divergence between Pre and Post branches. The file grows, but that's manageable — hook logic is small per branch.

**How to apply during planning:** S## for evidence capture extends the existing `subagent-*` / `pre` / `post` branch pattern. `merge-settings.js` does NOT need a new hook entry — the existing PostToolUse registration covers both dispatch tracking and evidence capture.

### D2. Verification evidence format — YAML frontmatter
`T##-SUMMARY.md` gains a machine-parseable `verification_evidence:` block in its YAML frontmatter. Shape:

```yaml
verification_evidence:
  - command: "npm test"
    exit_code: 0
    matched_line: 42          # line number in evidence-{T##}.jsonl
  - command: "npm run typecheck"
    exit_code: 0
    matched_line: 43
```

**Why:** The completer cross-references claims against the evidence log. Markdown table parsing is fragile and varies by renderer. Frontmatter is already parsed by our YAML loaders for other fields (`id`, `parent`, `provides`, etc.). One more field, same parser. GSD-2 does it this way.

**How to apply during planning:** Executor writes this field as part of its existing summary-writing step. Completer reads it via the same YAML parser used for other frontmatter. No `## Verification Evidence` markdown section needed — the existing `## Verification` section already covers human-readable output.

### D3. Must-haves enforcement — planner emits always, executor blocks if missing
forge-planner writes the structured `must_haves:` block in T##-PLAN frontmatter unconditionally for every net-new task. forge-executor reads it at task start; if missing or malformed, returns `---GSD-WORKER-RESULT---` with `status: blocked` and `blocker_class: scope_exceeded`, reason `missing_must_haves_schema`.

**Why:** Without enforcement from day one, the schema is decorative. The whole verifier (C7) consumes this block — if it's absent, verifier skips to `legacy_schema` mode and the anti-hallucination gain evaporates. Legacy M001/M002 plans get grace via the backward-compat skip (C13 in SCOPE); new plans are strictly enforced.

**How to apply during planning:** T## that modifies forge-planner must add the `must_haves:` emission. T## that modifies forge-executor must add the schema check at step 1 of the Process (before `status: RUNNING`). Plan-checker (C9) audits *content* only — it does NOT replace the executor check.

### D4. File-audit scope — additions and modifications only, no deletions
`## File Audit` section in S##-SUMMARY compares `git diff --name-only --diff-filter=AM` (additions + modifications) against the union of `expected_output` from all tasks. Deletions are NOT audited.

**Why:** Deletions are rare and almost always intentional (removing dead code, replacing a file). The hallucination class M003 targets is "agent claimed to build X but didn't" — a spurious delete doesn't fit that pattern. Adding deletion tracking doubles schema surface (`expected_deletions:` field) for a marginal case.

**How to apply during planning:** `scripts/forge-hook.js` or whichever module does the diff uses `--diff-filter=AM`. No `expected_deletions:` field in T##-PLAN. If a task deletes a file, the planner writes a `## Notes` line explaining; otherwise no annotation needed.

## Agent's Discretion

- **Stub-detection regex patterns in verifier.** Concrete patterns for JS/TS (`return <div/>`, `onClick={() => {}}`, `return null`, empty function bodies) — tune based on false-positive rate during implementation. JS-only per SCOPE.
- **Plan-checker dimension list.** Target ~10 dimensions from the GSD v1 list; final cut during S04 planning based on which are meaningfully derivable from PLAN text.
- **Evidence log line format specifics.** Keys within the JSONL line (timestamp, tool_name, command, exit_code, file_path) — design during S02 implementation.
- **Performance budget enforcement.** C4/C8 set budgets; not deciding now whether to add runtime telemetry or just one-time benchmarks.

## Deferred Ideas

- `/forge-verify` user-facing command for on-demand re-verification (deferred per SCOPE)
- Pluggable language matchers for verifier Wired level (Python/Go/Rust) — JS/TS only v1
- Blocking mode for plan-checker (pref exists as inert flag; activation is M004+)
- Retroactive verification of archived M001/M002 slices
- Evidence-log-based auto-recovery in executor (advisory signal only in M003)

## Slice Proposal (from brainstorm, for planner to adjust)

Brainstorm suggested this order:
- S01 — structured must-haves schema + executor enforcement (foundation)
- S02 — evidence capture (PostToolUse hook) + file-audit
- S03 — goal-backward verifier (consumes must_haves)
- S04 — plan-checker agent (advisory)

Planner may reorder or merge as needed, but must respect these dependency facts:
- Verifier (S03) depends on must_haves schema (S01)
- Evidence cross-ref (S02 completer logic) depends on verification_evidence format (D2, ships in S01)
- Plan-checker (S04) depends on nothing new — can ship last or in parallel
