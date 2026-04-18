# T05: Verify install.sh + install.ps1 handle new skills

status: DONE

**Slice:** S03  **Milestone:** M001

## Goal

Verify that both install scripts already copy the three new skill directories (forge-auto, forge-task, forge-new-milestone) via their existing glob patterns, and fix if needed.

## Must-Haves

### Truths
- `install.sh` copies `skills/forge-auto/`, `skills/forge-task/`, `skills/forge-new-milestone/` to both `~/.agents/skills/` and `~/.claude/skills/` (via existing glob `"${REPO_DIR}/skills"/*/`)
- `install.ps1` copies the same three directories to both targets (via existing glob `Get-ChildItem "$RepoDir\skills" -Directory`)
- Running `install.sh --dry-run` shows the three new skill names in output
- Running `install.ps1 -DryRun` shows the three new skill names in output
- `install.ps1` does NOT contain `\f` as a literal string anywhere (form feed bug)
- The `commands/forge.md` file (new in T01) is also picked up by the existing command copy glob (`forge*.md`)

### Artifacts
- `install.sh` — potentially unchanged (existing glob already covers new skills)
- `install.ps1` — potentially unchanged (existing glob already covers new skills)

### Key Links
- `install.sh` copies from `skills/*/` → `~/.claude/skills/` and `~/.agents/skills/`
- `install.ps1` copies from `skills\*` → same two targets

## Steps

1. Read `install.sh` — locate the skills install block (around line 149-161)
2. Verify the glob `"${REPO_DIR}/skills"/*/` will match the three new directories
3. Verify `commands/forge.md` matches the glob `"${REPO_DIR}/commands"/forge*.md`
4. Read `install.ps1` — locate the skills install block (around line 117-133)
5. Verify `Get-ChildItem "$RepoDir\skills" -Directory` matches the new directories
6. Verify `Get-ChildItem "$RepoDir\commands\forge*.md"` matches `forge.md`
7. Run `bash install.sh --dry-run` and confirm the three new skills appear in output
8. Run `powershell -File install.ps1 -DryRun` and confirm same
9. Grep `install.ps1` for any literal `\f` sequences — there should be zero matches
10. If any glob does NOT match, edit the script to include the new paths (unlikely — existing globs are broad)

## Standards
- **Target directory:** root (install scripts live at repo root)
- **Reuse:** Existing glob patterns should already work — avoid adding special-case logic
- **Naming:** No changes expected
- **Lint command:** `bash install.sh --dry-run` for verification

## Context
- Decision: install.ps1 must never contain `\f` literal (interpreted as form feed 0x0C)
- The install scripts already have skills/ copy logic (added in a previous version) — this task is primarily verification, not creation
- The existing skills glob `skills/*/` is broad enough to pick up any new skill directory automatically
- Read both install scripts first to confirm the glob patterns
- `commands/forge.md` (no hyphen after forge) must match the glob `forge*.md` — it does because `forge.md` starts with `forge`
