---
description: "Mostra, limpa ou exporta as memórias auto-aprendidas do projeto GSD. Use: /gsd-memories | /gsd-memories clean | /gsd-memories export"
allowed-tools: Read, Write, Edit
---

Use the **gsd** agent to manage auto-learned project memories.

## Input
$ARGUMENTS

## Operations

**No argument / "show":**
Read `.gsd/AUTO-MEMORY.md` and display memories grouped by category, sorted by score (`confidence × (1 + hits × 0.1)`). Show top 20. Format as readable table.

**"stats":**
Show: total memories, count per category, average confidence, most-reinforced entries (hits > 2), entries pending decay (hits=0, old).

**"clean":**
Read `.gsd/AUTO-MEMORY.md`. Remove all `[SUPERSEDED]` entries. Re-rank and rewrite the file cleanly.

**"export":**
Format ALL active memories (not superseded) as a markdown summary suitable for sharing or archiving. Group by category, include confidence and source.

**"inject":**
Show exactly what would be injected into the next worker prompt — i.e., top-ranked memories within the ~2000 token budget.
