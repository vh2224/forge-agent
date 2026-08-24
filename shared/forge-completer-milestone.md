# forge-completer — executable spec: complete-milestone

> **Loaded on demand by the forge-completer agent.** Extracted VERBATIM from
> `agents/forge-completer.md` on 2026-08-24 — same rationale as
> `shared/forge-completer-slice.md`. Read this file only when the dispatched
> unit is `complete-milestone`.

## Output budgets

- `M###-SUMMARY.md` ≤ **150 lines**; LEDGER entry ≤ 15 lines (existing rule).
- Compress by pointing at slice summaries — never restate them.

## For complete-milestone

### Git boundary — complete-milestone

**This unit NEVER integrates a branch — under ANY value of `auto_commit`.** No unit of the loop
does: integration is the OPERATOR's act, always. The milestone close-out delivers the run branch
`forge/{run}`, ready for the operator to push and open a PR. The loop never touches the default
branch, and does not push on its own: `auto_push` and `merge_strategy` document the operator's own
preferences and have no consumer in this unit.

The prohibited class is **integrating**, not one spelling of it — all forbidden here:
`git merge` (squash or not, `--ff`, `--no-ff`, `--squash`) · `git rebase` · `git cherry-pick` ·
`git pull` · any push of the default branch · `git checkout <branch>` · `git switch` ·
`git branch -d/-m` · `git reset` · `git worktree add/remove`

Permitted when `auto_commit: true`: `git add <specific-path>`, `git commit`, `git tag`, and
read-only inspection (`git status`, `git diff`, `git log`, `git rev-parse`). **You must return with the
same branch checked out as when you started.** When `auto_commit: false`: no git command at all.

> After tagging, bust the statusline version cache so the new state shows immediately:
> ```bash
> node -e "const fs=require('fs'),os=require('os'),p=os.tmpdir()+'/forge-update-check.json';try{fs.unlinkSync(p)}catch{}" 2>/dev/null || true
> ```

1. Write final `M###-SUMMARY.md` with all slices summarized
2. Mark milestone `[x]` in ROADMAP (if exists at milestone level)
3. Update `CLAUDE.md` — rewrite the `## Estado atual` section only:
   ```markdown
   ## Estado atual

   - **Milestone ativo:** — (M### concluído)
   - **Fase:** idle — M### encerrado com sucesso.
   - **Próxima ação:** Executar `/forge-new-milestone <descrição>` para iniciar o próximo milestone.
   ```
4. Emit milestone completion report: slices completed, total tasks, key decisions made

5. **Persist write-coverage series + write ledger fragment + run merger** (M001/S02+):

   **5a. Measure write coverage while unit refs are still alive.** This runs
   before cleanup because merged/deleted `forge/*` refs make the attribution
   axis irreproducible. The adapter appends one compact, mutex-protected JSONL
   snapshot and deduplicates an identical retry by `measurement_id`:
   ```bash
   FORGE_SCRIPTS_DIR=$([ -f scripts/forge-write-coverage-ledger.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
   node "$FORGE_SCRIPTS_DIR/forge-write-coverage-ledger.js" --milestone "{M###}" --cwd "{WORKING_DIR}"
   ```
   `inconclusive` is a durable measurement outcome, not a success and not a
   reason to block close-out. On any tool error, emit a warning and continue;
   never fabricate a GO row. The append-only series lives at
   `.gsd/forge/write-coverage.jsonl` and survives every cleanup mode.

   **5b. Write LEDGER fragment** to `.gsd/ledger/<milestone-id>.md` via `forge-ledger.js`. The fragment is the source of truth — no global `LEDGER.md` write path in this step. Build a JSON payload and pipe it to the script:
   ```bash
   FORGE_SCRIPTS_DIR=$([ -f scripts/forge-ledger.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
   node "$FORGE_SCRIPTS_DIR/forge-ledger.js" --write --cwd "{WORKING_DIR}" <<'EOF'
   {
     "id": "{M###}",
     "title": "{milestone title}",
     "completed_at": "$(date -u +%FT%TZ)",
     "slices": ["S01 — title", "S02 — title"],
     "key_files": ["path/to/file"],
     "key_decisions": ["one-liner"],
     "body": "{2-3 sentence description of what was built and delivered. Keep under 10 lines. Focus on WHAT was built, not HOW.}"
   }
   EOF
   ```
   On failure: log a warning and continue — the LEDGER fragment is non-critical relative to the merger. Do not return `status: blocked`.

   **D4 — the NEW entry stays under 15 rendered lines.** The cap is on the **rendered block** (what `renderLedger` emits into `LEDGER.md`), not on `body` alone: `slices[]` + `key_files[]` + `key_decisions[]` are what make an entry fat, so trimming only the prose changes nothing. `--write` measures the block after writing and reports the additive fields `rendered_lines`, `cap` and `over_cap` inside its exit-0 JSON (plus one warning line on stderr when over). It never trims and never refuses.

   When the envelope says `"over_cap": true`, **rewrite your own new entry leaner and re-run `--write`** (fewer `key_files`, fewer `key_decisions`) before moving on. Shortening `body` is **not** a lever for the entries this step writes: `renderLedgerBlock` suppresses `body` entirely whenever any of `slices`/`key_files`/`key_decisions` is present, and the template above always emits all three. A shorter `body` only reduces `rendered_lines` for entries that carry none of those three fields. Re-writing is idempotent — the same id is overwritten in place.

   **Entries that already exist are never rewritten.** D4 applies from here forward only; the accumulated size of older entries is handled elsewhere, not by this step.

   **5c. Invoke the merger** to promote all per-milestone files to workspace globals under lockfile. Note: the merger no longer touches LEDGER (handled by the fragment write in 5b); DECISIONS/AUTO-MEMORY/CHECKER/events still merge normally.
   ```bash
   FORGE_SCRIPTS_DIR=$([ -f scripts/forge-merger.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
   node "$FORGE_SCRIPTS_DIR/forge-merger.js" --milestone {M###} --cwd "{WORKING_DIR}" --holder "completer:{M###}"
   ```
   The merger reads:
   - `M###-DECISIONS.md` → append rows (dedup by ID) to global `DECISIONS.md` under `.gsd/.locks/DECISIONS.md/`
   - `M###-AUTO-MEMORY.md` → promote entries (dedup by ID or description match), apply cap-50 with decay ordering, write `AUTO-MEMORY.md` under `.gsd/.locks/AUTO-MEMORY.md/`
   - `M###-CHECKER-MEMORY.md` → _(deprecated S04)_ CHECKER events now live in the fragment store (`.gsd/checker-memory/`); this merge path is a no-op when fragments exist
   - `M###-events.jsonl` → append all lines to global `.gsd/forge/events.jsonl`

   Parse the JSON output. On non-empty `errors` array: emit warning but proceed (cleanup in step 6 is still safe — per-milestone files remain on disk). On success: log merge counts in the completion report.

   The fragment store (`.gsd/ledger/`), `.gsd/forge/write-coverage.jsonl`, `.gsd/items/`, `AUTO-MEMORY.md`, `DECISIONS.md`, `CHECKER-MEMORY.md`, `CODING-STANDARDS.md` and `STATE.md` (dashboard) are durable across `milestone_cleanup` — never touched by archive/delete.

6. **Cleanup milestone artifacts** — based on `milestone_cleanup` from injected config:
   - `keep` (default): do nothing — all files remain
   - `archive`: move the milestone directory to archive:
     ```bash
     mkdir -p {WORKING_DIR}/.gsd/archive
     mv {WORKING_DIR}/.gsd/milestones/{M###} {WORKING_DIR}/.gsd/archive/{M###}
     ```
   - `delete`: remove the milestone directory entirely:
     ```bash
     rm -rf {WORKING_DIR}/.gsd/milestones/{M###}
     ```
   In all cases `.gsd/LEDGER.md`, `.gsd/items/`, `AUTO-MEMORY.md`, `DECISIONS.md`, `CODING-STANDARDS.md`
   and `STATE.md` are never touched — they are the durable record.

7. **Deactivate run in registry** (M005+ — multi-run aware). After cleanup, mark the run as `active:false` in `runs/{id}.json` and regenerate the dashboard. Idempotent: safe to skip if `runs/{id}.json` does not exist (legacy single-run workspace):

   ```bash
   FORGE_SCRIPTS_DIR=$([ -f scripts/forge-runs.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
   if [ -f "{WORKING_DIR}/.gsd/forge/runs/{M###}.json" ]; then
     node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "{M###}" --json '{"active":false,"deactivated_reason":"complete-milestone"}' --cwd "{WORKING_DIR}" > /dev/null
     node "$FORGE_SCRIPTS_DIR/forge-dashboard.js" --cwd "{WORKING_DIR}" > /dev/null || true
   fi
   ```

   Without this step, the run stays as `active:true` in the registry indefinitely — dashboard would keep listing M### as active even after merger ran. Operator confusion + stale runs count toward `multi_run.refused_when_active_count`.

Then return the `---GSD-WORKER-RESULT---` block.
