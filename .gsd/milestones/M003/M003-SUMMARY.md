---
id: M003
title: Anti-Hallucination Layer
status: in-progress
slices_completed: [S01, S02]
slices_pending: [S03, S04]
last_updated: 2026-04-16
---

# M003: Anti-Hallucination Layer — Milestone Summary

## Vision

Replace self-reported "done" with evidence-backed verification. Every net-new task plan carries a machine-parseable `must_haves` schema; every tool call leaves an auditable evidence line; every slice closure re-derives what was built against what was claimed.

## Slices

### S01 — Structured must-haves schema + executor validation (COMPLETE)

Established the `must_haves:` + `expected_output:` YAML frontmatter schema as the single machine-parseable contract between planner and executor. Five tasks shipped:

- `scripts/forge-must-haves.js` — hand-rolled CommonJS parser (no external deps). Exports `hasStructuredMustHaves()` + `parseMustHaves()`. CLI `--check` exits 0/0/2 for legacy/valid/malformed.
- `agents/forge-planner.md` — added `## Must-Haves Schema` section with locked schema shape and unconditional emit contract.
- `agents/forge-executor.md` — step 1a validation: malformed structured plans block (`status: blocked / scope_exceeded / missing_must_haves_schema`); legacy plans pass with warn note.
- `forge-agent-prefs.md` — `evidence: {mode: lenient}` pref scaffolded (inert until S02).
- Three smoke fixtures validate end-to-end parser round-trip (legacy / structured-valid / structured-malformed).

**Key decisions:** `[ \t]*` not `\s*` in regex (prevents cross-line capture); `extractSubBlock + dedent` for nested YAML; step 1a naming avoids cascading renumbers.

**Produces for S02/S03/S04:** `scripts/forge-must-haves.js` module, locked schema shape, `expected_output[]` field, `evidence.mode` pref key.

### S02 — Evidence log + file-audit (COMPLETE)

Evidence capture + file-audit infrastructure landed across 5 tasks:

- `scripts/forge-hook.js` — extended PostToolUse branch with 3 private helpers (`resolveUnitId`, `readEvidenceMode`, `truncate`) and evidence-line writer. Appends one ≤512-byte JSONL line per Bash/Write/Edit call to `.gsd/forge/evidence-{unitId}.jsonl`. `disabled` mode skips writes. Silent-fail per MEM008.
- `agents/forge-executor.md` — step 12a added: executor emits `verification_evidence: [{command, exit_code, matched_line}]` in T##-SUMMARY.md frontmatter after verification. Sentinel values documented.
- `agents/forge-completer.md` — sub-step 1.5 (Evidence Flags cross-ref) and sub-step 1.6 (File Audit) inserted. Both advisory: write sections to S##-SUMMARY.md only when non-empty, never block closure.
- `forge-agent-prefs.md` — `## File Audit Settings` section added with `file_audit.ignore_list` default (7 patterns).

**Key decisions:** evidence block placed before `if (toolName !== 'Agent') return` (additive); D4 LOCKED — `--diff-filter=AM` only (deletions not tracked); `strict` mode reserved for M004+; sub-step letter-suffix pattern avoids cascading renumbers.

**Produces for S03:** `.gsd/forge/evidence-{unitId}.jsonl` as optional Wired-level corroborating input. Shape LOCKED (additive contract). `disabled` mode produces no files — verifier must tolerate absence gracefully.

### S03 — Goal-backward verifier (PENDING)

### S03 — Goal-backward verifier (PENDING)

### S04 — Plan-checker agent + CLAUDE.md doc (PENDING)
