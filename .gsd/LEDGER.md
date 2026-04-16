## M001 — Forge v1.0: Autonomous, Shell-first, Context-aware · 2026-04-15

forge-auto was silently dying after ~11 units because the orchestrator inlined full artifact file contents into every worker prompt (~10-50K tokens/unit), causing Claude Code to auto-compact and erase in-memory state with no recovery. M001 fixed this at three architectural levels: a PostCompact hook writes a disk signal so forge-auto can re-initialize and continue transparently after compaction; the orchestrator dispatch loop was stripped of all artifact inlining (workers read their own files via Read in their isolated contexts, cutting per-unit growth to ~500 tokens); and a new `/forge` REPL entry point (<5K tokens, compact-safe) replaced the scattered 20-command surface, with the three heaviest commands migrated to `skills/` for isolated execution.

**Slices:** S01 — PostCompact Recovery · S02 — Lean Orchestrator · S03 — /forge REPL Shell · S04 — Release v1.0.0  
**Key files:** scripts/forge-hook.js, scripts/merge-settings.js, commands/forge.md, shared/forge-dispatch.md, skills/forge-auto/SKILL.md, skills/forge-task/SKILL.md, skills/forge-new-milestone/SKILL.md, CHANGELOG.md  
**Key decisions:** PostCompact handler no-ops when forge-auto is inactive · Workers read own artifacts; orchestrator inlines scalars only · /forge REPL kept under 300 lines for compaction budget · Command→skill: body in skills/, 6-line shim in commands/

---

## M002 — Context Engineering Upgrades (GSD-2 Port) · 2026-04-16

Four context engineering layers ported from GSD-2 into Forge's shell-first architecture. The orchestrator gained automatic retry with exponential backoff on transient provider errors (rate limits, 5xx, connection resets), a zero-dependency verification gate that blocks `done` until typecheck/lint/test pass, coarse-grained token telemetry for every dispatch logged to `events.jsonl`, and a tier-based model router that routes light units (memory-extract, complete-*) to Haiku and heavy units (plan-milestone, plan-slice) to Opus — all tunable via a single `tier_models:` prefs block.

**Slices:** S01 — Error classifier + retry · S02 — Verification gate · S03 — Token counter + context budget · S04 — Tier-only model router  
**Key files:** scripts/forge-classify-error.js, scripts/forge-verify.js, scripts/forge-tokens.js, shared/forge-tiers.md, shared/forge-dispatch.md, agents/forge-executor.md, agents/forge-completer.md, forge-agent-prefs.md  
**Key decisions:** `unknown` errors are never retried (GSD-2 #3588 guard) · Slice-level verify failure → blocked, not retried (anti-recursion) · `Math.ceil(chars/4)` only — no tiktoken · Tier Resolution is pure Markdown (Hybrid C — no new script)

---
