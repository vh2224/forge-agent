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

Read and follow: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/tasks/{T##}/{T##}-PLAN.md

## Slice Plan

Read: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN.md

## Lint & Format Commands
{CS_LINT}

## Prior Context

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-SUMMARY.md

## Security Checklist

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/tasks/{T##}/{T##}-SECURITY.md

## Slice Decisions

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-CONTEXT.md — extract ## Decisions section only

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

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-RISK.md

## Roadmap Entry + Boundary Map

Read: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-ROADMAP.md — focus on {S##} entry and Boundary Map

## Milestone Context

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-CONTEXT.md

## Slice Context

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-CONTEXT.md

## Milestone Research

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-RESEARCH.md

## Directory Conventions & Asset Map
{CS_STRUCTURE}

## Code Rules
{CS_RULES}

## Dependency Slice Summaries

Read if exists (first 35 lines each): {WORKING_DIR}/.gsd/milestones/{M###}/slices/{dep}/{dep}-SUMMARY.md — for each slice listed in depends:[] in the Roadmap entry

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

Read: {WORKING_DIR}/.gsd/PROJECT.md

## Requirements

Read: {WORKING_DIR}/.gsd/REQUIREMENTS.md

## Directory Conventions & Asset Map
{CS_STRUCTURE}

## Context (discuss decisions)

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-CONTEXT.md

## Brainstorm Output

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-BRAINSTORM.md

## Scope Contract

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-SCOPE.md

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

Read (first 35 lines each): {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/tasks/T*/T*-SUMMARY.md

## Slice Plan

Read: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN.md

## Lint & Format Commands
{CS_LINT}

## Current Milestone Summary

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-SUMMARY.md

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

Read (first 35 lines each): {WORKING_DIR}/.gsd/milestones/{M###}/slices/S*/S*-SUMMARY.md

## Milestone Roadmap

Read: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-ROADMAP.md

## Milestone Summary

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-SUMMARY.md

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

Read: {WORKING_DIR}/.gsd/PROJECT.md

## Requirements

Read if exists: {WORKING_DIR}/.gsd/REQUIREMENTS.md

## Brainstorm Output (if available)

Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-BRAINSTORM.md

## Prior Decisions (do not re-debate)

For discuss-slice: Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-CONTEXT.md — extract ## Decisions section (locked milestone decisions, do not re-open)
For discuss-milestone: Read last 30 lines: {WORKING_DIR}/.gsd/DECISIONS.md — decisions from prior milestones only
Either way: these are closed — do not re-open or re-debate.

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

For research-milestone: Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-CONTEXT.md
For research-slice: Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-CONTEXT.md

## Project

Read: {WORKING_DIR}/.gsd/PROJECT.md

## Current Coding Standards

Read if exists: {WORKING_DIR}/.gsd/CODING-STANDARDS.md

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
