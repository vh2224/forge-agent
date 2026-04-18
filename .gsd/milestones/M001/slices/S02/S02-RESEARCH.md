# S02: Lean Orchestrator — Research

**Researched:** 2026-04-15
**Domain:** context engineering / orchestrator token optimization
**Confidence:** HIGH

## Summary

S02 is a straightforward, low-risk refactoring with clearly scoped changes across three files. The primary transformation replaces `{content of X}` placeholders in `shared/forge-dispatch.md` with `Read and follow:` / `Read if exists:` path directives so workers read their own artifacts in their isolated context instead of receiving inlined content from the orchestrator.

All six worker agents (executor, planner, researcher, completer, discusser, memory) already have `Read` in their tool lists -- no agent modifications are needed. The `WORKING_DIR` placeholder is already established in every template header and both command files reference it, so workers can construct absolute paths via `{WORKING_DIR}/.gsd/...` substitution.

The task plans (T01, T02, T03) are already detailed with per-template transformation tables. The research confirms the plans are accurate and complete. No pitfalls were found that aren't already addressed.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| N/A -- this slice is pure template editing, no logic to build | — | — | — |

## Common Pitfalls

### Pitfall 1: Conditional/complex placeholders need careful translation

**What goes wrong:** Some placeholders are not simple "content of X" -- they involve extraction logic like `{## Decisions section of S##-CONTEXT.md}` or `{first 35 lines of each T##-SUMMARY.md}`. A naive path directive could lose these constraints.

**Why it happens:** The original templates had the orchestrator do preprocessing (section extraction, line limits, multi-file aggregation) before inlining. With lean templates, workers must replicate this logic.

**How to avoid:** The T01-PLAN.md already handles this correctly with notes like `"extract ## Decisions section only"` and `"Read first 35 lines of each"`. Follow the transformation reference table in T01-PLAN.md exactly.

### Pitfall 2: Dependency slice summaries require iteration

**What goes wrong:** The plan-slice template has `{first 35 lines of S##-SUMMARY.md for each slice listed in depends:[]}`. This is a dynamic multi-file read -- the worker needs to know which slices are in `depends:[]` and iterate.

**Why it happens:** The orchestrator previously resolved the dependency list and read each file. Now the worker must do this.

**How to avoid:** The template should instruct the worker to read the ROADMAP or PLAN to find `depends:[]`, then read each dependency's summary. The T01-PLAN.md already specifies: `"Read if exists (first 35 lines each): .../{dep}/{dep}-SUMMARY.md -- for each slice in depends:[]"`.

### Pitfall 3: forge-auto Step 3 vs forge-next Step 3 structural difference

**What goes wrong:** forge-auto has "Selective memory injection" in Step 4 (inside Dispatch), while forge-next has it in Step 3 (inside "Build worker prompt"). T02 and T03 must preserve this structural difference.

**Why it happens:** The two commands evolved independently and placed the memory filtering logic in different steps.

**How to avoid:** T02 replaces only the single line at forge-auto.md:176. T03 replaces only the single line at forge-next.md:130, keeping the memory injection block (lines 123-128) untouched.

## Relevant Code

### Files to modify

| File | Current lines | What changes |
|------|--------------|--------------|
| `shared/forge-dispatch.md` | 247 lines, 7 template blocks | Replace all `{content of ...}` with path directives |
| `commands/forge-auto.md` | 410 lines | Line 176: one-line instruction to read artifacts -- replace with explicit placeholder list |
| `commands/forge-next.md` | 266 lines | Line 130: same one-line instruction -- replace, keep memory injection block above |

### Placeholder inventory (forge-dispatch.md)

**execute-task template (lines 8-46):**
| Placeholder | Type | Action |
|------------|------|--------|
| `{content of T##-PLAN.md}` | mandatory | `Read and follow:` path |
| `{content of S##-PLAN.md}` | mandatory | `Read:` path |
| `{content of M###-SUMMARY.md if exists, else last S##-SUMMARY.md if exists, else "(none yet)"}` | optional with fallback chain | `Read if exists:` with fallback note |
| `{content of T##-SECURITY.md if exists, else "..."}` | optional | `Read if exists:` |
| `{## Decisions section of S##-CONTEXT.md if exists, else "..."}` | optional, section extraction | `Read if exists:` with section note |
| `{TOP_MEMORIES}` | stays inlined | no change |
| `{CS_LINT}` | stays inlined | no change |

**plan-slice template (lines 48-85):**
| Placeholder | Type | Action |
|------------|------|--------|
| `{content of S##-RISK.md if exists, else "..."}` | optional | `Read if exists:` |
| `{relevant section of M###-ROADMAP.md for this slice}` | mandatory, scoped | `Read:` with scope note |
| `{content of M###-CONTEXT.md if exists, else "..."}` | optional | `Read if exists:` |
| `{content of S##-CONTEXT.md if exists, else "..."}` | optional | `Read if exists:` |
| `{first 35 lines of S##-SUMMARY.md for each slice listed in depends:[]}` | dynamic multi-file | `Read if exists (first 35 lines each):` with iteration note |
| `{TOP_MEMORIES}`, `{CS_STRUCTURE}`, `{CS_RULES}` | stays inlined | no change |

**plan-milestone template (lines 87-120):**
| Placeholder | Type | Action |
|------------|------|--------|
| `{content of .gsd/PROJECT.md}` | mandatory | `Read:` path |
| `{content of .gsd/REQUIREMENTS.md}` | mandatory | `Read:` path |
| `{content of M###-CONTEXT.md if exists, else "..."}` | optional | `Read if exists:` |
| `{content of M###-BRAINSTORM.md if exists, else "..."}` | optional | `Read if exists:` |
| `{content of M###-SCOPE.md if exists, else "..."}` | optional | `Read if exists:` |
| `{TOP_MEMORIES}`, `{CS_STRUCTURE}` | stays inlined | no change |

**complete-slice template (lines 122-153):**
| Placeholder | Type | Action |
|------------|------|--------|
| `{first 35 lines of each T##-SUMMARY.md in this slice}` | multi-file, truncated | `Read (first 35 lines each):` |
| `{content of S##-PLAN.md}` | mandatory | `Read:` path |
| `{content of M###-SUMMARY.md if exists, else "..."}` | optional | `Read if exists:` |
| `{CS_LINT}` | stays inlined | no change |

**complete-milestone template (lines 155-180):**
| Placeholder | Type | Action |
|------------|------|--------|
| `{first 35 lines of each S##-SUMMARY.md in this milestone}` | multi-file, truncated | `Read (first 35 lines each):` |
| `{content of M###-ROADMAP.md}` | mandatory | `Read:` path |
| `{content of M###-SUMMARY.md}` | mandatory | `Read if exists:` |

**discuss-milestone/discuss-slice template (lines 182-214):**
| Placeholder | Type | Action |
|------------|------|--------|
| `{content of .gsd/PROJECT.md}` | mandatory | `Read:` path |
| `{content of .gsd/REQUIREMENTS.md if exists}` | optional | `Read if exists:` |
| `{content of M###-BRAINSTORM.md if exists, else "..."}` | optional | `Read if exists:` |
| `{Prior Decisions...}` (conditional logic: slice vs milestone) | conditional | Two directives with conditional note |
| `{TOP_MEMORIES}` | stays inlined | no change |

**research-milestone/research-slice template (lines 216-247):**
| Placeholder | Type | Action |
|------------|------|--------|
| `{context from M###-CONTEXT.md or S##-CONTEXT.md}` | conditional | `Read if exists:` path |
| `{content of .gsd/PROJECT.md}` | mandatory | `Read:` path |
| `{CODING_STANDARDS or "(none)"}` | conditional | `Read if exists:` path |
| `{TOP_MEMORIES}` | stays inlined | no change |

### What stays inlined (small, preprocessed by orchestrator)

| Placeholder | Approx size | Why inlined |
|------------|-------------|-------------|
| `{TOP_MEMORIES}` / `{RELEVANT_MEMORIES}` | ~500 tokens | Already filtered/ranked by orchestrator |
| `{CS_LINT}` | ~100 tokens | Small section extract |
| `{CS_STRUCTURE}` | ~300 tokens | Small section extract |
| `{CS_RULES}` | ~200 tokens | Small section extract |
| `{WORKING_DIR}` | ~30 chars | Simple path substitution |
| `{M###}`, `{S##}`, `{T##}` | ~4 chars each | IDs |
| `{unit_effort}`, `{THINKING_OPUS}` | ~10 chars each | Config values |
| `{auto_commit}`, `{milestone_cleanup}` | ~5 chars each | Config values |
| `{CODING_STANDARDS}` (research only) | varies | Full file for research template |

### Worker agent tool confirmations

| Agent | Has `Read` | Confirmed |
|-------|-----------|-----------|
| forge-executor | Yes | tools: `Read, Write, Edit, Bash, Glob, Grep` |
| forge-planner | Yes | tools: `Read, Write, Glob, Grep, WebSearch, WebFetch` |
| forge-researcher | Yes | tools: `Read, Bash, Glob, Grep, Write, WebSearch, WebFetch` |
| forge-completer | Yes | tools: `Read, Write, Edit, Bash` |
| forge-discusser | Yes | tools: `Read, Write, Glob, Agent, AskUserQuestion, EnterPlanMode, ExitPlanMode` |
| forge-memory | Yes | tools: `Read, Write, Edit, Bash` |

All agents can read files. No agent modifications needed.

### WORKING_DIR resolution

- `forge-auto.md` sets WORKING_DIR from `pwd` during bootstrap (line 9: `pwd`)
- `forge-next.md` sets WORKING_DIR from `pwd` during bootstrap (line 19: `pwd`)
- Both inject `WORKING_DIR: {WORKING_DIR}` in every template header
- Templates use `{WORKING_DIR}/.gsd/...` paths, which resolve to absolute after substitution
- Workers receive absolute paths -- no ambiguity

### forge-auto.md Step 3 (current, to be replaced by T02)

```
Line 174: #### 3. Build worker prompt
Line 175: (blank)
Line 176: Read ONLY the `.gsd/` artifact files the worker needs (templates below). Inline their content — do not summarize or paraphrase.
Line 177: (blank)
```

This is a 1-line instruction. The orchestrator interprets this as "read every file referenced in the template and paste content into the prompt". T02 replaces this with an explicit placeholder substitution list and a "Do NOT read artifact files" directive.

### forge-next.md Step 3 (current, to be replaced by T03)

```
Line 121: ### 3. Build worker prompt
Line 122: (blank)
Line 123-128: **Selective memory injection** block (KEEP THIS)
Line 129: (blank)
Line 130: Read ONLY the `.gsd/` artifact files the worker needs (templates below). Inline their content — do not summarize or paraphrase.
Line 131: (blank)
```

Only line 130 gets replaced. Lines 123-128 (memory injection) stay.

## Coding Conventions Detected

- **File naming:** kebab-case with `forge-` prefix for all agents, commands, skills
- **Template structure:** frontmatter YAML + markdown body with numbered/named sections
- **Placeholder style:** `{content of X}` for inlined content, `{VARIABLE}` for simple substitutions
- **Directory structure:** `agents/`, `commands/`, `shared/`, `skills/`, `scripts/`
- **Import style:** N/A (markdown files, no imports)

## Pattern Catalog -- Recurring Structures

| Pattern | When to Use | Files to Create | Key Steps |
|---------|-------------|-----------------|-----------|
| Worker prompt template | Adding new unit type | Template block in `shared/forge-dispatch.md` | 1. Add template with header (WORKING_DIR, effort, thinking) 2. Add mandatory `Read:` paths 3. Add optional `Read if exists:` paths 4. Keep small preprocessed vars inlined 5. End with `## Instructions` + `Return ---GSD-WORKER-RESULT---` |

## Sources

- File reads: `shared/forge-dispatch.md` -- all 7 template blocks with 24 total `{content of ...}` placeholders catalogued
- File reads: `commands/forge-auto.md` -- Step 3 is a single instruction line at line 176
- File reads: `commands/forge-next.md` -- Step 3 has memory injection (lines 123-128) + artifact read instruction (line 130)
- File reads: All 6 agent `.md` files -- confirmed all have `Read` in tools list
- File reads: T01/T02/T03 task plans -- verified accuracy against current file state
