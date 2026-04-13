---
name: forge-brainstorm
description: Structured brainstorming for GSD milestones and slices. Generates alternative approaches, surfaces hidden risks, clarifies scope boundaries, and produces a decision brief ready for the discuss phase. Use before planning any significant milestone.
---

<objective>
Transform a rough milestone description into a structured decision brief by exploring the problem space before committing to a plan. The output feeds directly into the GSD discuss phase — giving the discuss agent concrete alternatives to reason about instead of starting from scratch.
</objective>

<essential_principles>
- Generate options, not prescriptions. The user decides; you explore.
- Diverge first, converge last. Do not filter ideas during generation.
- Invert the problem. "What would make this fail?" surfaces risks faster than "what could go wrong?"
- Be concrete. Vague risks and vague ideas are useless. Name the file, the library, the team, the edge case.
- Respect what's already decided. Read DECISIONS.md before generating alternatives — do not re-open closed questions.
</essential_principles>

<process>

## Step 1 — Read existing context

Before generating anything, read:
- `.gsd/DECISIONS.md` — what's already locked (do not brainstorm around these)
- `.gsd/PROJECT.md` — what kind of project this is
- `.gsd/KNOWLEDGE.md` — lessons already learned
- `.gsd/AUTO-MEMORY.md` — patterns and gotchas discovered so far
- If an active milestone exists: its `M###-CONTEXT.md` and `M###-SUMMARY.md`

## Step 2 — Web research (optional, targeted)

If Step 1 reveals specific libraries, frameworks, or external services involved in this milestone, run 2–4 targeted searches **before** generating alternatives. Focus on what changes the decision:

- `"{library} {version} known issues"` or `"{library} pitfalls production"`
- `"{approach A} vs {approach B} {year}"` for competing approaches
- `"{library} breaking changes {current_version}"` if a pinned version was found in the project

Guidelines:
- Only search if the milestone involves specific named tech — skip for purely architectural decisions
- Max 4 searches total — stop when you have enough signal to inform tradeoffs
- If a search result is thin, use WebFetch on the official changelog/docs URL
- Record a 1-line takeaway per search; discard results that don't change any alternative

If no specific tech is identified from context, skip this step entirely.

## Step 3 — Five-lens exploration

For the milestone/topic, generate ideas through each lens:

### Lens 1: User outcomes
What does the user actually need to be able to *do* when this is done?
- List 3-5 concrete user outcomes (not features — outcomes)
- For each: what's the simplest implementation? What's the riskiest assumption?

### Lens 2: Alternative approaches
What are 3 fundamentally different ways to achieve the same outcome?
- Approach A: the obvious way
- Approach B: the simpler/cheaper way (what can we cut or defer?)
- Approach C: the riskier-but-more-powerful way
For each: one-sentence tradeoff summary.

### Lens 3: Inversion — what kills this
Complete the sentence: "This milestone will fail if..."
- List 5-7 specific failure modes (technical, scope, dependency, assumption)
- For each: is it detectable early? What's the mitigation?

### Lens 4: Scope razor
What is explicitly OUT of scope for this milestone?
- List things that sound related but should be deferred
- List assumptions that need to be validated before planning
- List dependencies on other teams/systems that could block

### Lens 5: Slice candidates
If this milestone were broken into 3-5 demoable slices, what would they be?
- Each slice: one sentence describing what the user can demo when done
- Flag which slice has the highest risk (validate it first)

## Step 4 — Decision brief

Produce a structured brief:

```markdown
# Brainstorm: [Milestone Title]

**Date:** YYYY-MM-DD
**Prepared for:** discuss phase

## Recommended approach
[One paragraph — the approach that best balances speed, risk, and value]

## Key alternatives considered
| Approach | Tradeoff |
|----------|----------|

## Top risks (ranked)
1. [Risk] — [Early signal / mitigation]
2. ...

## Explicit non-goals
- [What is out of scope]

## Open questions for discuss
- [Question the user needs to answer before planning]
- ...

## Slice draft (for planner context)
- S01: [what user can demo] — risk: high/medium/low
- S02: ...
```

## Step 5 — Hand off to discuss

After producing the brief:
- Save it as `.gsd/milestones/M###/M###-BRAINSTORM.md` (create milestone dir if needed)
- Tell the agent: "Brainstorm complete. Feeding into discuss phase."
- The discuss agent should read this file before asking questions — many questions will already be answered.

</process>

<fast_mode>
When invoked with `-fast` flag: skip brainstorm entirely. Acknowledge with one line:
> Brainstorm skipped (fast mode). Proceeding to discuss.
Then return immediately.
</fast_mode>

<success_criteria>
- Brief is concrete enough that a planner could start without the discuss phase
- At least 3 alternative approaches explored
- At least 5 failure modes named
- Scope boundaries are explicit
- Open questions are specific (not "what tech should we use?" but "should we use Prisma or raw SQL given the existing codebase uses knex?")
</success_criteria>
