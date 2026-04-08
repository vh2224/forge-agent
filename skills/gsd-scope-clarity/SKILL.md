---
name: gsd-scope-clarity
description: Scope definition skill for GSD milestones. Produces a crisp in/out scope list and validates that milestone success criteria are observable and testable. Use when milestone description is ambiguous or when discuss phase produces conflicting requirements.
---

<objective>
Convert an ambiguous milestone description into a precise scope contract: what is IN, what is OUT, what is DEFERRED, and how we'll know when done. Eliminates scope creep at the source.
</objective>

<essential_principles>
- Every "in scope" item must be observable. If you can't demo it, it's not done.
- Every "out of scope" item needs a reason. "Out of scope because: MVP doesn't need it" not just "out of scope."
- Deferred ≠ out of scope. Deferred means "yes, but later." Out of scope means "not this project."
- Definition of done must be verifiable by the executor without human interpretation.
</essential_principles>

<process>

## Step 1 — Extract commitments

From the milestone description and any context files, extract:
- Explicit commitments ("user can log in", "dashboard shows X")
- Implied commitments (things users will expect even if not stated)
- Anti-requirements (things explicitly excluded)

## Step 2 — Apply the scope razor

For each item, classify:
- **IN** — required for the milestone to be considered done
- **OUT** — explicitly not part of this milestone (with reason)
- **DEFERRED** — wanted, belongs to a future milestone (name which one)
- **UNCLEAR** — needs a human decision (becomes a discuss question)

## Step 3 — Write observable success criteria

Each "IN" item needs a success criterion that:
- Uses the word "can" (user can..., system can..., operator can...)
- Is verifiable by running a command, loading a URL, or reading a file
- Does NOT use words like "properly", "correctly", "well", "as expected"

Bad: "Authentication works correctly"
Good: "User can log in with Google OAuth and session persists across page refresh"

## Step 4 — Output

```markdown
# Scope Contract: M### — [Title]

**Defined:** YYYY-MM-DD

## In Scope
| Capability | Success Criterion | Verifiable by |
|------------|-------------------|---------------|

## Out of Scope
| Item | Reason |
|------|--------|

## Deferred
| Item | Target milestone |
|------|-----------------|

## Open questions (for discuss)
- [Question]
```

Save as `.gsd/milestones/M###/M###-SCOPE.md`.

</process>

<success_criteria>
- Every in-scope item has an observable success criterion
- No ambiguous items remain (all classified)
- Open questions are specific enough to be answered with a sentence
</success_criteria>
