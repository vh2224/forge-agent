---
name: forge-memories
description: "Gerencia memorias auto-aprendidas do projeto GSD."
disable-model-invocation: true
allowed-tools: Read, Write, Edit
---

Use the **forge** agent to manage auto-learned project memories.

## Input
$ARGUMENTS

## Operations

**No argument / "show":**
Read the canonical `forge-projection.js` memory projection from fragment sources. Display active memories grouped by category with canonical scores; do not invent a formula. Show top 20 in a table.

**"stats":**
Show canonical totals, categories and confidence. Distinguish legacy_ambiguous hits, exposures, reobservations, independent_confirmation_count and outcome-bound utility. A hit is not proof of usefulness; unavailable evidence remains unavailable.

**"clean":**
Use canonical projection regeneration for a clean human view; preserve fragment history and superseded evidence. Do not rewrite the monolith as an authoritative store.

**"export":**
Format ALL active memories (not superseded) as a markdown summary suitable for sharing or archiving. Group by category, include confidence and source.

**"inject":**
Show exactly what would be injected into the next worker prompt — i.e., top-ranked memories within the ~2000 token budget.

Ranking remains additive: matched_terms*100 + category_preference*10 + confidence*max(1,hits).
Exposure and utility never add ranking weight. Consult shared/forge-memory-evidence.md
for the canonical evidence semantics; legacy counters never prove independence.
