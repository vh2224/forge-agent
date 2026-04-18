# M001: Forge v1.0 — UAT Script

**Milestone:** M001  
**Version:** v1.0.0  
**Written:** 2026-04-15

---

## Prerequisites

- Forge v1.0.0 installed: `install.sh` (macOS/Linux) or `install.ps1` (Windows) run successfully
- `~/.claude/commands/forge.md` present and < 300 lines
- `~/.claude/skills/forge-auto/SKILL.md` present
- `~/.claude/skills/forge-task/SKILL.md` present
- `~/.claude/skills/forge-new-milestone/SKILL.md` present
- `~/.claude/scripts/forge-hook.js` updated (contains `post-compact` handler)
- `~/.claude/scripts/merge-settings.js` updated (contains `PostCompact` in LIFECYCLE_HOOKS)
- A test project initialized with `/forge-init` (has `.gsd/STATE.md`)
- `git describe --tags --always` returns `v1.0.0` in the forge-agent repo

---

## Test Cases

### S01 — PostCompact Recovery

| # | Action | Expected | Pass? |
|---|--------|----------|-------|
| 1.1 | Open `~/.claude/scripts/forge-hook.js`. Search for `post-compact`. | A `post-compact` phase block exists. It reads `auto-mode.json`, writes `compact-signal.json` if `active === true`. | |
| 1.2 | Open `~/.claude/scripts/merge-settings.js`. Search for `PostCompact`. | `{ event: 'PostCompact', phase: 'post-compact' }` is present in the LIFECYCLE_HOOKS array. | |
| 1.3 | In a test project: start `/forge-auto`, immediately inspect `.gsd/forge/auto-mode.json`. | File exists with `"active": true`. | |
| 1.4 | Manually write `.gsd/forge/compact-signal.json` with `{"recovered_at":1000,"milestone":"M001","worker":"execute-task"}`. On the next `/forge-auto` loop iteration. | forge-auto emits `↺ Recovery pós-compactação — retomando de: ...`, re-reads STATE.md from disk, deletes `compact-signal.json`, and continues dispatching units. | |
| 1.5 | After recovery check in TC 1.4, inspect `.gsd/forge/compact-signal.json`. | File no longer exists. | |
| 1.6 | Run `merge-settings.js` a second time on the same project. | No duplicate `PostCompact` entry in `settings.json`. (Idempotent registration.) | |
| 1.7 | With forge-auto inactive (`auto-mode.json` absent or `active: false`), simulate a PostCompact event by running `node ~/.claude/scripts/forge-hook.js post-compact` with a dummy `cwd`. | `compact-signal.json` is NOT written. | |

---

### S02 — Lean Orchestrator

| # | Action | Expected | Pass? |
|---|--------|----------|-------|
| 2.1 | Open `~/.claude/forge-dispatch.md`. Search for `{content of`. | Zero matches. All former inline-content placeholders have been replaced. | |
| 2.2 | Open `~/.claude/forge-dispatch.md`. Search for `Read:` or `Read if exists:`. | Multiple path-directive lines found in each of the 7 template blocks (execute-task, plan-slice, plan-milestone, complete-slice, complete-milestone, research-*, discuss-*). | |
| 2.3 | Open `~/.claude/commands/forge-auto.md`. Find the `Build worker prompt` section (Step 3). | No `Read` calls for artifact files. Only placeholder substitution list: `{WORKING_DIR}`, `{M###}`, `{S##}`, `{T##}`, `{TOP_MEMORIES}`, `{CS_LINT}` etc. | |
| 2.4 | Open `~/.claude/commands/forge-next.md`. Find the equivalent Step 3. | Same result as TC 2.3. Selective memory injection block present but no artifact file reads. | |
| 2.5 | Run `/forge-auto` through at least 3 units on a real milestone. After 11 units, context token count should be noticeably lower than before (subjective — no hard measurement). No compaction-related failure. | forge-auto completes all units without dying or compacting during the run. | |

---

### S03 — /forge REPL Shell

| # | Action | Expected | Pass? |
|---|--------|----------|-------|
| 3.1 | Run `/forge` in Claude Code (in a project with `.gsd/STATE.md`). | A single status line appears: `Forge v1.0 │ {project} │ {active milestone or "sem milestone"} │ ...` followed by an `AskUserQuestion` menu with options: auto, task, new-milestone, status, help, sair. | |
| 3.2 | Check `~/.claude/commands/forge.md` line count. | File is ≤ 300 lines. | |
| 3.3 | From the `/forge` menu, select `status`. | Skill `forge-status` executes and its output is shown. The REPL menu reappears after. | |
| 3.4 | From the `/forge` menu, select `sair`. | The loop exits cleanly. If auto-mode was active, it is deactivated. | |
| 3.5 | Run `/forge-auto` (the old command). | It behaves identically to selecting `auto` from `/forge` — same skill is invoked. | |
| 3.6 | Run `/forge-task Atualizar o README`. | Task skill is invoked with the argument. Execution begins. | |
| 3.7 | Run `/forge-new-milestone Adicionar suporte a PostgreSQL`. | New-milestone skill is invoked with the description. Brainstorm/discuss flow begins. | |
| 3.8 | Open `~/.claude/skills/forge-auto/SKILL.md`. Verify frontmatter. | Contains `disable-model-invocation: true` and `allowed-tools:` list including Agent. | |
| 3.9 | Open `~/.claude/skills/forge-task/SKILL.md`. Verify frontmatter. | Contains `disable-model-invocation: true`. | |
| 3.10 | Open `~/.claude/skills/forge-new-milestone/SKILL.md`. Verify frontmatter. | Contains `disable-model-invocation: true`. | |
| 3.11 | With `auto-mode.json` present and `active: true` (within 60 min), run `/forge`. | REPL immediately delegates to `Skill("forge-auto")` without presenting the menu — auto-resume is transparent. | |
| 3.12 | Manually write `compact-signal.json`, then enter `/forge` menu and wait one iteration. | REPL detects the signal, re-reads STATE.md, deletes the signal, and continues to the menu without halting. | |

---

### S04 — Release v1.0.0

| # | Action | Expected | Pass? |
|---|--------|----------|-------|
| 4.1 | Open `CHANGELOG.md`. Find the `v1.0.0` entry. | Entry exists at the top with Breaking Changes, Features, and Architecture sub-sections. | |
| 4.2 | Check CHANGELOG Breaking Changes section. | Mentions `/forge` as new primary entry point and lean orchestrator removing artifact inlining. | |
| 4.3 | Open `README.md`. Find Quick Start section. | `/forge` (not `/forge-auto`) is listed as the primary command. | |
| 4.4 | Open `README.md`. Find commands table. | `/forge` is listed as first row. `/forge-auto` and `/forge-new-milestone` are annotated as aliases or secondary. | |
| 4.5 | In the forge-agent repo, run `git tag -l`. | `v1.0.0` is present. | |
| 4.6 | Run `git show v1.0.0 --stat`. | Annotated tag with a release message. Includes 13+ files, ~1375 insertions. | |
| 4.7 | In `scripts/forge-statusline.js`, verify version mechanism. | Version is read via `git describe --tags --always` — not hardcoded. | |
| 4.8 | Open `CLAUDE.md`. Search for `PostCompact hook`. | At least one new architecture decision block mentioning PostCompact hook + compact-signal.json is present under "Decisões de arquitetura recentes". | |
| 4.9 | Open `CLAUDE.md`. Search for `Lean orchestrator`. | Decision block present describing workers reading their own artifacts. | |
| 4.10 | Open `CLAUDE.md`. Search for `/forge REPL`. | Decision block present describing the unified REPL shell. | |

---

## Notes

- TC 2.5 (token growth reduction) is observational — no hard metric tooling. The absence of compaction failure during an 11+ unit run is the acceptance signal.
- TC 3.11 (auto-resume in REPL) requires a live auto-mode session or manual state manipulation of `auto-mode.json` + `auto-mode-started.txt`.
- TC 1.7 requires running the hook script directly from the CLI; the `cwd` must point to a project without `auto-mode.json` or with `active: false`.
- The annotated tag `v1.0.0` was created locally and must be pushed manually (`git push origin v1.0.0`) before remote tooling reflects it.
