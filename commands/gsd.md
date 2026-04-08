---
description: "GSD step mode — avança uma unidade de trabalho e para. Use /gsd auto para modo autônomo."
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Agent
---

Use the **gsd** agent in **step mode**.

Read `.gsd/STATE.md` to find the next pending unit. Execute exactly one unit (one task, or one phase like plan/research/discuss/complete-slice). After the unit is done:
1. Write the appropriate artifact (summary, plan, research, etc.)
2. Update `.gsd/STATE.md` with the new position and next action
3. Report what was done in one concise paragraph
4. **Stop** — do not proceed to the next unit

If there is a `continue.md` in the active slice directory, resume from it instead (read it, delete it, execute from "Next Action").

$ARGUMENTS
