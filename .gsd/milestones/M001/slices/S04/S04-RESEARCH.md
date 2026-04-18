# S04: Release v1.0.0 — Research

**Researched:** 2026-04-15
**Domain:** documentation / versioning / release
**Confidence:** HIGH

## Summary

This is a documentation-only slice with four independent tasks: CHANGELOG entry, README update, git tag, and CLAUDE.md architecture decisions. All functional work was completed in S01-S03. The research confirms exact file locations, current formats, and content needed for each task.

The critical ordering constraint is T03 (git tag): it must run AFTER T01, T02, and T04 are committed so the tag points to the final release commit. The task plans already document this correctly.

## CHANGELOG.md — Current State and v1.0.0 Entry

**Format:** `## vX.Y.Z (YYYY-MM-DD)` heading, followed by `### Section` sub-headings (Features, Bug Fixes, Performance, Other Changes), with `- item` entries. Most recent entry is at the top.

**Current top entry:** `## v0.7.3 (2026-04-10)` — line 1 of the file. Note: the file lacks a top-level `# Changelog` heading at the top (it appears at line 80, before v0.2.0 — this is a legacy formatting inconsistency).

**Latest tag:** `v0.25.0` with 3 commits after it (57824cc, 5bda3ef, d8c248e). The CHANGELOG has NOT been updated for any version after v0.7.3 — there is a gap from v0.7.3 to v0.25.0 in the changelog entries.

**v1.0.0 entry should contain** (per T01-PLAN and M001-SUMMARY):

- **Breaking Changes:** `/forge` replaces `/forge-auto` as primary entry point; `forge-auto`, `forge-task`, `forge-new-milestone` commands migrated to skills (commands remain as shims)
- **Features:** PostCompact hook recovery via compact-signal.json, lean orchestrator (workers read own artifacts, ~500 tokens/unit vs ~10-50K), `/forge` REPL shell (<5K tokens, compact-safe), skill migration with `disable-model-invocation: true`
- **Architecture:** compact-signal.json recovery flow, workers resolve artifacts via Read tool, /forge compact-safe token budget

## README.md — Sections to Update

**Current structure (117 lines):**
- Lines 1-17: Header with logo, title, subtitle, GSD-2 credit
- Lines 20-26: "O que voce ganha" (value props)
- Lines 30-48: "Quick start" — currently shows `/forge-init`, `/forge-new-milestone`, `/forge-auto`
- Lines 52-67: "Comandos principais" — table of 10 commands, NO `/forge` entry
- Lines 71-80: "Skills" — table of 5 skills, MISSING `forge-security`
- Lines 84-93: "Documentacao" — links to docs/
- Lines 97-104: "Atualizar"
- Lines 108-116: "Creditos" and "Licenca"

**Changes needed:**
1. **Quick start (line ~43):** Replace `/forge-auto` with `/forge` in the example
2. **Commands table (lines 54-65):** Add `/forge` as first row ("Shell interativo — entry point principal"); note `/forge-auto` as alias
3. **Skills table (lines 73-79):** Add `forge-security` row ("Analise de seguranca por task/slice")

## Git Tag State

**Existing tags:** 36 tags from v0.1.0 to v0.25.0 (no v1.0.0 yet)
**Latest tag:** v0.25.0
**Commits after latest tag:** 3 (57824cc, 5bda3ef, d8c248e)
**Current `git describe` would return:** `v0.25.0-3-g57824cc` (approx)

**Statusline version source:** `scripts/forge-statusline.js` line 162:
```js
const rawVersion = execSync(
  'git describe --tags --always 2>/dev/null || git log --oneline -1 2>/dev/null',
  { cwd: repo, encoding: 'utf8', timeout: 2000, shell: true }
).trim();
```
No code changes needed — creating `git tag -a v1.0.0 -m "..."` is sufficient.

**Ordering:** T03 must run last, after T01/T02/T04 commits, so the tag sits on the final release commit.

## CLAUDE.md — Architecture Decisions Section

**Current state:** The "Decisoes de arquitetura recentes" section has ~30 entries, each as `### Title` + paragraph. New entries append at the end.

**Five decisions to add** (per T04-PLAN):
1. PostCompact hook + compact-signal.json recovery
2. Lean orchestrator (workers read own artifacts)
3. /forge REPL shell as unified entry point
4. Skill migration with command shims
5. Compact-safe token budget

## M001 Deliverables Summary (for CHANGELOG/README content)

| Slice | Deliverable | Key Files |
|-------|-------------|-----------|
| S01 | PostCompact recovery — hook writes compact-signal.json, orchestrator auto-recovers | forge-hook.js, merge-settings.js, forge-auto.md |
| S02 | Lean orchestrator — 24 inlined artifacts replaced with Read directives, ~500 tokens/unit | shared/forge-dispatch.md, forge-auto.md, forge-next.md |
| S03 | /forge REPL shell + skill migration — 3 commands to skills, thin shims, compact-safe | commands/forge.md, skills/forge-auto/, skills/forge-task/, skills/forge-new-milestone/ |

## Common Pitfalls

### Pitfall 1: CHANGELOG gap
**What goes wrong:** CHANGELOG jumps from v0.7.3 to v1.0.0, skipping v0.8.0 through v0.25.0.
**Why it happens:** Changelog was not updated for intermediate releases.
**How to avoid:** Acceptable for v1.0.0 — the entry should focus only on M001 deliverables, not backfill missing versions.

### Pitfall 2: Git tag before final commit
**What goes wrong:** Tag created before T01/T02/T04 changes are committed; tag points to wrong commit.
**Why it happens:** T03 runs in parallel with other tasks.
**How to avoid:** T03-PLAN already specifies it must run last. Executor should verify all other S04 changes are committed before tagging.

### Pitfall 3: Annotated vs lightweight tag
**What goes wrong:** Lightweight tag may not propagate correctly with `git push --tags`.
**Why it happens:** Using `git tag v1.0.0` instead of `git tag -a v1.0.0 -m "..."`.
**How to avoid:** T03-PLAN specifies annotated tag. All existing tags in the repo appear to be annotated (consistent pattern).

## Sources
- File reads: `CHANGELOG.md` — format and current entries documented
- File reads: `README.md` — all 117 lines, sections mapped
- File reads: `scripts/forge-statusline.js:150-180` — confirmed git describe usage at line 162
- File reads: `M001-SUMMARY.md` — all four slice summaries with key files and decisions
- Bash: `git tag -l` — 36 tags, v0.1.0 to v0.25.0, no v1.0.0
- Bash: `git log v0.25.0..HEAD --oneline` — 3 commits since latest tag
