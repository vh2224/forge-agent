# Forge Dispatch — Shared Worker Prompt Templates

Single source of truth for all worker prompt templates used by `/forge-auto` and `/forge-next`.
**Changes here apply to both commands. Do not duplicate these templates in individual commands.**

---

### execute-task

```
Execute GSD task {T##} in slice {S##} of milestone {M###}.
WORKING_DIR: {WORKING_DIR}
auto_commit: {PREFS.auto_commit — true or false}
effort: {unit_effort}
thinking: disabled

## Task Plan
{content of T##-PLAN.md}

## Slice Plan (tasks section)
{content of S##-PLAN.md}

## Lint & Format Commands
{CS_LINT}

## Prior Context
{content of M###-SUMMARY.md if exists, else last S##-SUMMARY.md if exists, else "(none yet)"}

## Security Checklist
{content of T##-SECURITY.md if exists, else "(none — task has no security-sensitive scope)"}

## Slice Decisions
{## Decisions section of S##-CONTEXT.md if exists, else "(none — discuss-slice was skipped)"}

## Project Memory
{TOP_MEMORIES}

## Instructions
Execute all steps. The task plan's ## Standards section has the relevant coding rules — follow them.
If ## Security Checklist is present — treat each item as a must-have. Verify all checklist items before writing T##-SUMMARY.md.
Verify every must-have using the verification ladder — including lint/format check.
Write T##-SUMMARY.md.
If auto_commit is true: Commit with message feat(S##/T##): <one-liner>.
If auto_commit is false: Do NOT run any git commands.
Do NOT modify STATE.md. Return ---GSD-WORKER-RESULT---.
```

### plan-slice

```
Plan GSD slice {S##} of milestone {M###}.
WORKING_DIR: {WORKING_DIR}
effort: {unit_effort}
thinking: {THINKING_OPUS}

## Risk Assessment
{content of S##-RISK.md if exists, else "(none — slice is not high-risk)"}

## Roadmap Entry + Boundary Map
{relevant section of M###-ROADMAP.md for this slice}

## Milestone Context
{content of M###-CONTEXT.md if exists, else "(none)"}

## Slice Context
{content of S##-CONTEXT.md if exists, else "(none — discuss-slice was skipped)"}

## Directory Conventions & Asset Map
{CS_STRUCTURE}

## Code Rules
{CS_RULES}

## Dependency Slice Summaries
{first 35 lines of S##-SUMMARY.md for each slice listed in depends:[]}

## Project Memory
{TOP_MEMORIES}

## Instructions
Write S##-PLAN.md and individual T##-PLAN.md files (1-7 tasks).
Each T##-PLAN.md must include a ## Standards section with relevant rules from CODING-STANDARDS.md.
Iron rule: each task must fit in one context window.
Return ---GSD-WORKER-RESULT---.
```

### plan-milestone

```
Plan GSD milestone {M###}: {description}.
WORKING_DIR: {WORKING_DIR}
effort: {unit_effort}
thinking: {THINKING_OPUS}

## Project
{content of .gsd/PROJECT.md}

## Requirements
{content of .gsd/REQUIREMENTS.md}

## Directory Conventions & Asset Map
{CS_STRUCTURE}

## Context (discuss decisions)
{content of M###-CONTEXT.md if exists, else "(none)"}

## Brainstorm Output
{content of M###-BRAINSTORM.md if exists, else "(none)"}

## Scope Contract
{content of M###-SCOPE.md if exists, else "(none)"}

## Project Memory
{TOP_MEMORIES}

## Instructions
Write M###-ROADMAP.md with 4-10 slices, risk tags, depends, demo sentences, and a Boundary Map section.
Respect directory conventions and reusable assets from Coding Standards when placing new code.
Return ---GSD-WORKER-RESULT---.
```

### complete-slice

```
Complete GSD slice {S##} of milestone {M###}.
WORKING_DIR: {WORKING_DIR}
auto_commit: {PREFS.auto_commit — true or false}

## Task Summaries
{first 35 lines of each T##-SUMMARY.md in this slice}

## Slice Plan
{content of S##-PLAN.md}

## Lint & Format Commands
{CS_LINT}

## Current Milestone Summary
{content of M###-SUMMARY.md if exists, else "(none)"}

## Instructions
1. Write S##-SUMMARY.md (compress all task summaries)
2. Write S##-UAT.md (non-blocking human test script)
3. Security scan — search changed files for risky patterns (eval, innerHTML, dangerouslySetInnerHTML, raw SQL concatenation, console.log near secrets, hardcoded credentials). If found, add ## ⚠ Security Flags to S##-SUMMARY.md. Not a blocker — document and continue.
4. Run lint gate — if lint commands exist, run on changed files. Fix violations.
If auto_commit is true:
5. Squash-merge branch gsd/M###/S## to main
If auto_commit is false:
5. Skip — do NOT run any git commands (no merge, no branch operations).
6. Update M###-SUMMARY.md with this slice's contribution
7. Mark slice [x] in M###-ROADMAP.md
Return ---GSD-WORKER-RESULT---.
```

### complete-milestone

```
Complete GSD milestone {M###}.
WORKING_DIR: {WORKING_DIR}
auto_commit: {PREFS.auto_commit — true or false}
milestone_cleanup: {PREFS.milestone_cleanup — keep, archive, or delete}

## Slice Summaries
{first 35 lines of each S##-SUMMARY.md in this milestone}

## Milestone Roadmap
{content of M###-ROADMAP.md}

## Milestone Summary
{content of M###-SUMMARY.md}

## Instructions
1. Write final M###-SUMMARY.md
2. Mark milestone as complete in STATE.md (do modify STATE.md for this)
If auto_commit is true:
3. Write final git tag or note
If auto_commit is false:
3. Skip — do NOT run any git commands.
Return ---GSD-WORKER-RESULT---.
```

### discuss-milestone / discuss-slice

```
Discuss {milestone M### | slice S##} architecture decisions.
WORKING_DIR: {WORKING_DIR}
effort: {unit_effort}
thinking: {THINKING_OPUS}

## Project
{content of .gsd/PROJECT.md}

## Requirements
{content of .gsd/REQUIREMENTS.md if exists}

## Brainstorm Output (if available)
{content of M###-BRAINSTORM.md if exists, else "(none)"}

## Prior Decisions (do not re-debate)
{For discuss-slice: extract ## Decisions section from M###-CONTEXT.md (milestone-level locked decisions).
 For discuss-milestone: use last 30 rows of .gsd/DECISIONS.md (decisions from prior milestones).
 Either way: these are closed — do not re-open or re-debate.}

## Project Memory
{TOP_MEMORIES}

## Instructions
Identify 3-5 gray areas not yet resolved. Ask them ONE AT A TIME using AskUserQuestion — do NOT dump all questions in a single text block.
For each question, provide 2-4 concrete options derived from the project context. AskUserQuestion adds "Other" automatically — do not add it manually.
Wait for each answer before asking the next question.
Record all answers in M###-CONTEXT.md (or S##-CONTEXT.md for slice discuss).
Append significant decisions to .gsd/DECISIONS.md.
Return ---GSD-WORKER-RESULT---.
```

### research-milestone / research-slice

```
Research codebase for GSD {milestone M### | slice S##}: {description}.
WORKING_DIR: {WORKING_DIR}
effort: {unit_effort}
thinking: {THINKING_OPUS}

## What we're building
{context from M###-CONTEXT.md or S##-CONTEXT.md}

## Project
{content of .gsd/PROJECT.md}

## Current Coding Standards
{CODING_STANDARDS or "(none — no .gsd/CODING-STANDARDS.md found)"}

## Project Memory (known gotchas)
{TOP_MEMORIES}

## Instructions
Explore the codebase. Produce M###-RESEARCH.md (or S##-RESEARCH.md) with:
- Summary
- Don't Hand-Roll table (what libraries/patterns exist already)
- Common Pitfalls found
- Relevant Code sections
- Asset Map — Reusable Code (functions, hooks, services to reuse)
- Coding Conventions Detected (naming, structure, imports, error patterns)
After writing RESEARCH.md, update .gsd/CODING-STANDARDS.md with new findings (Asset Map, conventions).
Return ---GSD-WORKER-RESULT---.
```
