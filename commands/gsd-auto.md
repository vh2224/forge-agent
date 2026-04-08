---
description: "GSD auto mode — executa o milestone inteiro de forma autônoma. Equivalente ao /gsd auto do gsd-pi."
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent
---

Use the **gsd** agent in **AUTO MODE**.

Read `.gsd/STATE.md` to determine the active milestone and next pending unit. Then run the full orchestration loop:

1. Derive next unit from STATE.md using the dispatch table
2. Build a focused prompt with inlined file content for that unit
3. Dispatch to the `gsd-worker` sub-agent (fresh context per unit)
4. Parse the worker result, advance state, loop
5. Repeat until: milestone complete OR blocker requires human input OR 3 consecutive failures

**Stop conditions:**
- All slices in the active milestone are marked `[x]` in the ROADMAP → report milestone complete
- Worker returns `status: blocked` → surface the blocker and stop
- 3 consecutive failures on the same unit → escalate to user with diagnosis

**Do not ask for confirmation between units.** Run autonomously. Emit one progress line per unit as you go.

$ARGUMENTS
