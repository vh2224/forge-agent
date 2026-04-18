# T03: Strip artifact reads from forge-next.md

status: DONE

**Slice:** S02  **Milestone:** M001

## Goal

Apply the same "Build worker prompt" simplification from T02 to `commands/forge-next.md`, removing artifact file reads since workers now read their own context.

## Must-Haves

### Truths
- Step 3 ("Build worker prompt") no longer instructs the orchestrator to Read artifact files
- Step 3 retains: placeholder substitutions and selective memory injection (already present in forge-next Step 3)
- The "Worker Prompt Templates" section at the bottom still references `~/.claude/forge-dispatch.md`
- The rest of forge-next.md is unchanged (parse arguments, bootstrap, load context, steps 1/2/4/5/6, continue-here protocol)

### Artifacts
- `commands/forge-next.md` -- edited file, Step 3 section rewritten (~15 lines replacing current ~10 lines)

### Key Links
- `commands/forge-next.md` reads templates from `shared/forge-dispatch.md` (installed as `~/.claude/forge-dispatch.md`)
- T01 must be completed first (templates must be lean before removing reads)

## Steps

1. Read `commands/forge-next.md` (already known, ~266 lines)
2. Locate "### 3. Build worker prompt" section (currently line 122, ~8 lines)
3. Note: forge-next has the "Selective memory injection" block inside Step 3 (lines 123-129), while forge-auto has it in Step 4. Keep the memory injection block in Step 3 -- it stays.
4. Replace the artifact-reading instruction (line 130-131: "Read ONLY the `.gsd/` artifact files...") with:
   ```
   Use the template from `~/.claude/forge-dispatch.md` for the current `unit_type`.
   Substitute placeholders:
   - `{WORKING_DIR}` <- current working directory
   - `{M###}`, `{S##}`, `{T##}` <- from STATE
   - `{unit_effort}`, `{THINKING_OPUS}` <- resolved effort/thinking for this unit
   - `{TOP_MEMORIES}` <- RELEVANT_MEMORIES (filtered above)
   - `{CS_LINT}` <- CS_LINT section (already extracted)
   - `{CS_STRUCTURE}` <- CS_STRUCTURE section (already extracted)
   - `{CS_RULES}` <- CS_RULES section (already extracted)
   - `{auto_commit}` <- PREFS.auto_commit
   - `{milestone_cleanup}` <- PREFS.milestone_cleanup
   - `{CODING_STANDARDS}` <- full CODING_STANDARDS content (for research templates)

   Do NOT read artifact files here -- templates now pass paths; workers read their own context.
   ```
5. Verify the "Worker Prompt Templates" section at the bottom still says to read `~/.claude/forge-dispatch.md`
6. Verify no other section references "Inline their content" for worker prompts

## Standards
- **Target directory:** `commands/` (existing file, in-place edit)
- **Reuse:** N/A
- **Naming:** Keep existing `forge-next.md` name
- **Lint command:** N/A (markdown file)
- **Pattern:** N/A

## Context
- Decision: "Lean orchestrator: workers read own artifacts via Read tool" (DECISIONS.md)
- forge-next.md Step 3 currently has two responsibilities: (1) selective memory injection and (2) reading artifact files. Only (2) is removed.
- The current text to remove is: "Read ONLY the `.gsd/` artifact files the worker needs (templates below). Inline their content -- do not summarize or paraphrase."
- Key file to read first: `commands/forge-next.md`
