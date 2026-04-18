# T03: forge-auto.md — compact-signal detection in dispatch loop

**Slice:** S01  **Milestone:** M001

## Goal

Add compact-signal.json detection at the start of each dispatch loop iteration in forge-auto.md, so the orchestrator re-initializes state from disk and continues autonomously after a compaction event.

## Must-Haves

### Truths
- The dispatch loop section of `forge-auto.md` contains a "Compact recovery check" step as the FIRST action in "Step 1. Derive next unit", before reading STATE.md
- The check reads `.gsd/forge/compact-signal.json` via Bash
- If the file exists: instructions specify re-reading all context files (STATE.md, 3 pref layers, AUTO-MEMORY.md, CODING-STANDARDS.md), re-initializing PREFS/EFFORT_MAP/THINKING_OPUS/session_units, deleting the signal file, emitting a recovery message, and continuing the loop
- If the file does not exist: the check is a no-op and the loop proceeds normally
- The recovery message format is: `"Recovery pos-compactacao — retomando de: {next_action do STATE.md}"`
- The signal file is deleted after recovery to prevent re-triggering on the next iteration

### Artifacts
- `commands/forge-auto.md` — modified (adds ~20 lines in the dispatch loop section)
  - New subsection "Compact recovery check" at the beginning of "Step 1. Derive next unit"

### Key Links
- `commands/forge-auto.md` reads `.gsd/forge/compact-signal.json` (produced by `forge-hook.js` PostCompact handler from T01)
- `commands/forge-auto.md` reads `.gsd/forge/auto-mode.json` (already used for auto-resume detection)
- Recovery re-reads the same files listed in the "Load context" section of forge-auto.md

## Steps

1. Read `commands/forge-auto.md` to confirm the exact location of "Step 1. Derive next unit" (already read — verify line numbers)
2. Insert a new subsection at the VERY BEGINNING of "#### 1. Derive next unit" (after the heading, before "From STATE, determine..."), with this content:

   ```markdown
   **Compact recovery check** — before anything else in each iteration:
   ```bash
   cat .gsd/forge/compact-signal.json 2>/dev/null
   ```
   If the file exists:
   1. Re-read all context files from disk:
      - `.gsd/STATE.md` → update `STATE`
      - `~/.claude/forge-agent-prefs.md`, `.gsd/claude-agent-prefs.md`, `.gsd/prefs.local.md` → re-merge `PREFS`
      - `.gsd/AUTO-MEMORY.md` → update `ALL_MEMORIES`
      - `.gsd/CODING-STANDARDS.md` → re-extract `CS_LINT`, `CS_STRUCTURE`, `CS_RULES`
   2. Re-derive `EFFORT_MAP` and `THINKING_OPUS` from merged PREFS
   3. Reset `session_units = 0`
   4. Delete the signal: `rm -f .gsd/forge/compact-signal.json`
   5. Emit: `↺ Recovery pós-compactação — retomando de: {next_action from STATE.md}`
   6. Continue the loop normally (proceed to derive next unit below)

   If the file does not exist, skip this block entirely.
   ```

3. Verify the new section integrates cleanly with the existing "COMPACTION RESILIENCE" rule in the "Orchestrate" section — they are complementary: the COMPACTION RESILIENCE rule handles in-memory variable loss detection; this check handles the disk-based signal from the hook
4. Ensure no duplicate logic — the "Auto-resume detection" in "Load context" handles session-level resume (after terminal close); the compact recovery check handles mid-session compaction (context compressed while loop is running)

## Standards
- **Target directory:** `commands/` (existing file modification)
- **Reuse:** Re-read pattern matches the "Load context" section structure (same files, same variable names)
- **Naming:** Signal file path `.gsd/forge/compact-signal.json` matches the path used in T01's handler
- **Lint command:** N/A (Markdown file — visual inspection of structure)
- **Pattern:** Follows the existing guard-check pattern in forge-auto.md (check condition via Bash, branch on result, emit status line)

## Context
- Decision: PostCompact hook writes compact-signal.json; forge-auto detects and recovers automatically (from DECISIONS.md)
- The existing "COMPACTION RESILIENCE" paragraph (line 87-92) is a behavioral instruction for the LLM; the compact-signal check is a concrete procedural step that runs in the loop. Both mechanisms work together:
  - If PostCompact hook fired: compact-signal.json exists, detected at loop start
  - If hook did not fire (older Claude Code version): the COMPACTION RESILIENCE behavioral rule catches undefined variables as fallback
- The `auto-mode.json` file is NOT modified during recovery — it stays `active: true` so the status line continues showing the AUTO indicator
- The recovery resets `session_units = 0` because post-compaction is effectively a fresh orchestrator session (context was compressed)
