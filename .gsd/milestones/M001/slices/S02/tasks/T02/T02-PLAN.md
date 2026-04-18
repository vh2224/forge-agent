# T02: Strip artifact reads from forge-auto.md

status: DONE

**Slice:** S02  **Milestone:** M001

## Goal

Remove artifact file reads from the "Build worker prompt" step in `commands/forge-auto.md`, since templates now pass paths and workers read their own context.

## Must-Haves

### Truths
- Step 3 ("Build worker prompt") no longer instructs the orchestrator to Read artifact files
- Step 3 retains: placeholder substitutions (WORKING_DIR, M###, S##, T##, unit_effort, THINKING_OPUS, auto_commit), TOP_MEMORIES injection, CS_LINT injection
- The "Worker Prompt Templates" section at the bottom still references `~/.claude/forge-dispatch.md` as the template source
- The rest of forge-auto.md is unchanged (bootstrap, load context, dispatch loop steps 1/2/4/5/6/7, compaction resilience, isolation rule, etc.)

### Artifacts
- `commands/forge-auto.md` -- edited file, Step 3 section rewritten (~8 lines replacing current ~3 lines)

### Key Links
- `commands/forge-auto.md` reads templates from `shared/forge-dispatch.md` (installed as `~/.claude/forge-dispatch.md`)
- T01 must be completed first (templates must be lean before removing reads)

## Steps

1. Read `commands/forge-auto.md` (already known, ~410 lines)
2. Locate "#### 3. Build worker prompt" section (currently line 176, ~3 lines)
3. Replace the section content with:
   ```
   #### 3. Build worker prompt

   Use the template from `~/.claude/forge-dispatch.md` for the current `unit_type`.
   Substitute placeholders:
   - `{WORKING_DIR}` <- current working directory
   - `{M###}`, `{S##}`, `{T##}` <- from STATE
   - `{unit_effort}`, `{THINKING_OPUS}` <- resolved effort/thinking for this unit
   - `{TOP_MEMORIES}` <- RELEVANT_MEMORIES (already filtered in Step 4)
   - `{CS_LINT}` <- CS_LINT section (already extracted)
   - `{CS_STRUCTURE}` <- CS_STRUCTURE section (already extracted)
   - `{CS_RULES}` <- CS_RULES section (already extracted)
   - `{auto_commit}` <- PREFS.auto_commit
   - `{milestone_cleanup}` <- PREFS.milestone_cleanup
   - `{CODING_STANDARDS}` <- full CODING_STANDARDS content (for research templates)

   Do NOT read artifact files here -- templates now pass paths; workers read their own context.
   ```
4. Verify the "Worker Prompt Templates" section at the bottom still says to read `~/.claude/forge-dispatch.md`
5. Verify no other section references "Read artifacts" or "Inline their content" for worker prompts

## Standards
- **Target directory:** `commands/` (existing file, in-place edit)
- **Reuse:** N/A
- **Naming:** Keep existing `forge-auto.md` name
- **Lint command:** N/A (markdown file)
- **Pattern:** N/A

## Context
- Decision: "Lean orchestrator: workers read own artifacts via Read tool" (DECISIONS.md)
- The current Step 3 text is minimal ("Read ONLY the `.gsd/` artifact files the worker needs (templates below). Inline their content -- do not summarize or paraphrase.") but the instruction causes the orchestrator to read potentially dozens of KB of artifacts
- The "Selective memory injection" block is in Step 4 (forge-auto) or Step 3 (forge-next) -- this remains unchanged as TOP_MEMORIES is small and preprocessed
- Key file to read first: `commands/forge-auto.md`
