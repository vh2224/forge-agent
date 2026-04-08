---
name: gsd-risk-radar
description: Risk assessment for GSD slices before execution. Identifies technical risks, dependency risks, and scope creep signals in a slice plan before the executor starts work. Use during plan-slice or when a slice has high risk tag.
---

<objective>
Analyze a slice plan and surface risks that would cause the executor to get stuck, produce wrong output, or need to replan mid-execution. Output a risk card that the executor reads before starting.
</objective>

<essential_principles>
- Focus on risks that affect THIS slice, not the whole project.
- A risk without a mitigation is noise. Always pair risk + response.
- Distinguish: known unknowns (we know we don't know) vs unknown unknowns (find them).
- The executor has a fixed context window. Any risk that requires reading >5 large files is a planning risk.
</essential_principles>

<process>

## Input
Read the slice's `S##-PLAN.md`, `S##-CONTEXT.md` (if exists), and the parent `M###-ROADMAP.md` boundary map section for this slice.

## Risk categories to check

### Technical risks
- Are there libraries/APIs used that have known breaking changes or poor docs?
- Does any task assume a pattern that contradicts `.gsd/AUTO-MEMORY.md` gotchas?
- Is the verification strategy clear? (If must-haves say "tests pass" but no test file exists, that's a risk)

### Context window risks
- Do any tasks require reading >3 large files simultaneously?
- Is the task decomposition fine enough? (a task titled "implement entire auth system" is a red flag)
- Are there tasks with vague steps like "implement as needed"?

### Dependency risks
- Does this slice consume outputs from prior slices? Are those outputs actually there?
- Check the boundary map: does the "consumes from" match what was actually built?

### Scope creep signals
- Are there tasks that say "also fix X" or "while we're at it"?
- Are there must-haves that belong to a different slice?

## Output — Risk card

```markdown
# Risk Radar: S## — [Slice Title]

**Assessed:** YYYY-MM-DD
**Overall risk:** HIGH / MEDIUM / LOW

## Blockers (fix before executing)
- [Risk] → [Required action]

## Warnings (monitor during execution)
- [Risk] → [Mitigation]

## Executor notes
- [Specific guidance for the executor agent]
```

Save as `.gsd/milestones/M###/slices/S##/S##-RISK.md`.

</process>

<success_criteria>
- Every identified risk has a concrete response
- Blockers require the planner to revise before execution starts
- Warnings are actionable by the executor without replanning
</success_criteria>
