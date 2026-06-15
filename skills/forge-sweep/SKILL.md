---
name: forge-sweep
description: "Prune know-how files (AUTO-MEMORY, CHECKER-MEMORY, DECISIONS, milestones, sessions) per team policy. Default = dry-run preview; --apply executes after a single confirmation popup. Model-invocable at end of a milestone/task once the human has validated the work — see Invocation policy."
allowed-tools: Read, Write, Bash, Glob, AskUserQuestion
---

## O que fazer

$ARGUMENTS

---

Prune ephemeral GSD artifacts and tighten durable know-how files (AUTO-MEMORY, CHECKER-MEMORY, DECISIONS) at the end of a task or milestone. Goal: keep shared `.gsd/` files lean and long-lived; avoid SVN/Git merge conflicts.

Milestone and task directories are **trimmed in place** (preserving only the `*-SUMMARY.md` file) rather than removed entirely — the directory's continued presence in version control signals to the team that the milestone/task existed and was completed, avoiding the "where did M### go?" confusion when one teammate runs `/forge-sweep` and another pulls the result.

## Invocation policy

This skill is **model-invocable**: the orchestrator may run it directly via the `Skill` tool — the user does NOT have to type `/forge-sweep` for it to run. It is destructive, though, so it runs in exactly one situation:

> **At the end of a milestone or task, after the human has validated the delivered work.** You will normally have just told the user that the next step is the sweep; their positive feedback on the validation IS the go-ahead. There is no magic phrase — read the conversation.

**Recommended end-of-cycle flow — invoke with `--apply` directly:**

1. Call the skill with `--apply` (not bare). Step 3 always prints the preview first, so the user still sees exactly what will be pruned/trimmed before anything is written.
2. The `--apply` confirmation popup (Step 5, `AskUserQuestion`) fires as the single final reminder — one yes/no so a distracted dev isn't surprised. **This is the only gate.** Do NOT first run a bare dry-run and then ask the user to re-type `/forge-sweep --apply` — that re-type step is eliminated for the end-of-cycle flow.

**When to fall back to dry-run + explicit user authorization** (do NOT auto-apply if the preview surfaces a specific risk):

- any AUTO-MEMORY entry classified `review` (flagged), or
- a milestone/task dir that would be **skipped** for a missing `LEDGER.md` entry, or
- the project is **mid-milestone** (an active phase in `STATE.md` — sweeps run only after `complete-milestone` or between tickets), or
- the working tree is dirty in a way that makes the trim hard to review.

In those cases: present the dry-run, explain the risk in plain language, and ask the user to confirm before you pass `--apply`.

**Never** invoke this skill mid-task, during planning, or speculatively. A bare `/forge-sweep` (no args) remains a safe preview-on-demand that anyone can run at any time.

## Args

Parse `$ARGUMENTS`:
- (empty) → **dry-run** (preview only, no writes)
- `--apply` → execute the sweep (asks confirmation via AskUserQuestion before any destructive action)
- `--force` → combined with `--apply`, skips confirmation prompt
- `--scope task` → only drops sessions and prunes AUTO-MEMORY/DECISIONS; leaves milestone dirs fully intact (no trim)
- `--scope milestone` (default) → full sweep including trimming milestone dirs whose `LEDGER.md` entry exists (keeps only their SUMMARY)
- `--keep-low-confidence` → bypass the confidence/hits filter on AUTO-MEMORY (rare; use only when you know low-hit memories will graduate soon)

## Bootstrap guard

Run in parallel:
```bash
ls CLAUDE.md 2>/dev/null && echo "ok" || echo "missing"
ls .gsd/STATE.md 2>/dev/null && echo "ok" || echo "missing"
ls .gsd/LEDGER.md 2>/dev/null && echo "ok" || echo "missing"
```

If any missing → tell user "Project not initialized — run /forge-init first" and stop.

---

## Sweep Policy (single source of truth)

### AUTO-MEMORY fragments

AUTO-MEMORY is now stored as per-unit fragments in `.gsd/memory/*.md` (S04 fragment store). The monolithic `.gsd/AUTO-MEMORY.md` is **no longer rewritten by this sweep** — all pruning operates via event emission.

Prune criteria — emit a `{kind: prune}` event for any fragment entry where:
- `confidence < 0.90` OR `hits < 2`, OR
- description mentions specific line numbers (`line N`, `lines N-M`) — those are codified in code, re-discoverable via blame, OR
- description names a single file path as the only context — single-file gotchas have low reuse value

Otherwise → keep. Surface as **flag for human review** when confidence/hits pass but the description mentions a line number or single file (could still be valuable).

#### LEDGER guard — physical deletion rule

Emitting a `prune` event is a **logical prune** — the projection layer will exclude the entry from the active set.

**Physical fragment deletion** (`rm .gsd/memory/<unit-id>.md`) is performed ONLY when:
1. Every memory inside the fragment has a corresponding `prune` event, AND
2. The owning unit appears in `.gsd/LEDGER.md` (matched by unit ID in a heading line, e.g. `^## M-<ts>-<slug>` or `^## TASK-###`).

Until both conditions are met, pruning is **event-only** — the fragment file stays on disk. This guarantees that an open or partially-evaluated unit never loses facts prematurely.

### DECISIONS (no-op — fragments pending S05)

<!-- DECISIONS are now fragments (S03 fragment store at .gsd/decisions/).
     The legacy row-pruning policy that previously lived here is OBSOLETE —
     kept as a no-op until S05 defines a fragment-level pruning policy.
     This sweep step performs zero file mutations on DECISIONS. -->

The DECISIONS sweep step is intentionally a no-op. No rows are dropped, no file is rewritten. During the preview and apply phases below, the DECISIONS section will always report `Keep: all rows (no-op — S05 pending)`.

### CHECKER-MEMORY fragments

CHECKER-MEMORY stores per-dimension check events in `.gsd/checker-memory/*.md` (one fragment per slice). The sweep applies a staleness-based prune policy in parallel to AUTO-MEMORY.

Prune criteria — emit a `{kind: prune}` event for any checker-memory fragment entry where:
- The entry is older than 3 completed milestones (projection-derived from `ts` + LEDGER order), AND
- The `count` field for that dimension in that slice is `>= 5` (the legacy decay rule, now projection-derived from fragment events)

Rationale: high-count old dimensions are either fixed (safe to drop) or systemic (will re-appear via new events — no value in the historical record).

#### LEDGER guard (same rule as AUTO-MEMORY)

Physical deletion of `.gsd/checker-memory/<slice-id>.md` only when:
1. Every dimension record inside the fragment has a `prune` event, AND
2. The owning slice's parent milestone appears in `.gsd/LEDGER.md`.

Until both conditions hold, pruning is event-only.

### Milestone directories (`.gsd/milestones/M*/`)

**Trim in place** (do NOT remove the directory) when:
- `M###-SUMMARY.md` exists inside it (milestone is closed)
- AND a corresponding entry exists in `.gsd/LEDGER.md` (matched by milestone ID in heading)

Trim = delete every file inside the directory EXCEPT `M###-SUMMARY.md`. Slice plans, task plans, research notes, CONTEXT, plan-checks, `continue.md`, and any other intermediate artifacts are removed. The directory itself and the SUMMARY remain so the team still sees the milestone existed.

Skip + warn if either condition is missing — don't lose history without a LEDGER trail.

### Task directories (`.gsd/tasks/TASK-###/`)

**Trim in place** (do NOT remove the directory) when:
- `TASK-###-SUMMARY.md` exists inside it (task is done)
- AND a corresponding entry exists in `.gsd/LEDGER.md` (matched by `## TASK-###` heading)

Trim = delete every file inside the directory EXCEPT `TASK-###-SUMMARY.md`. The directory itself and the SUMMARY remain for the same team-visibility reason as milestones.

Skip + warn if either condition is missing — don't lose history without a LEDGER trail.

### Session files (`.gsd/sessions/ask-*.md`)

Drop when frontmatter has `status: closed`. Keep `status: open` sessions untouched. Surface as flag if status is missing or unparseable.

### Files NOT touched by this sweep

`PROJECT.md`, `REQUIREMENTS.md`, `KNOWLEDGE.md`, `CODING-STANDARDS.md`, `CLAUDE.md`, `LEDGER.md`, `STATE.md`, `claude-agent-prefs.md`, `prefs.local.md`, `.claude/settings.json`, `.gsd/forge/` (telemetry).

---

## Steps

### 1. Inventory

In parallel:
- `node scripts/forge-memory.js --list` (enumerate AUTO-MEMORY fragments)
- `node scripts/forge-checker-memory.js --list` (enumerate CHECKER-MEMORY fragments)
- `ls -d .gsd/milestones/M*/ 2>/dev/null`
- `ls -d .gsd/tasks/TASK-*/ 2>/dev/null`
- `ls .gsd/sessions/ 2>/dev/null`
- Read `.gsd/LEDGER.md`

For each AUTO-MEMORY fragment returned by `forge-memory.js --list` (format: `[{unitId, path}]`):
- Read the fragment file.
- Parse all `mem_id`, `confidence`, `hits`, and description text.
- Apply the prune criteria (see Sweep Policy above).

For each CHECKER-MEMORY fragment returned by `forge-checker-memory.js --list`:
- Read the fragment file.
- Parse each dimension entry: `dimension`, `slice`, `ts`, `count`.
- Determine milestone age by cross-referencing `LEDGER.md` — compute how many completed milestones are newer than `ts`.
- Apply the staleness-based prune criteria.

For each milestone dir, check `M###-SUMMARY.md` and `LEDGER.md` heading.
For each task dir, check `TASK-###-SUMMARY.md` and `LEDGER.md` heading.
For each session file, parse frontmatter `status`.

### 2. Classify

**AUTO-MEMORY classification** — for each fragment entry:
- `prune` — below-threshold (confidence/hits) or single-file-ref
- `keep` — passes all criteria
- `review` — passes confidence/hits but mentions line numbers or single file path

**CHECKER-MEMORY classification** — for each dimension record:
- `prune` — older than 3 milestones AND count >= 5
- `keep` — anything else

**DECISIONS classification** — always `keep (no-op)`. No decisions are classified for pruning.

When in doubt on AUTO-MEMORY: classify as **flag for review** rather than auto-drop.

### 3. Print preview

Always print the preview, regardless of mode:

```
## /forge-sweep preview {dry-run | apply}

### AUTO-MEMORY (fragment store — event-based prune)
  Keep:    N entries  (across M fragments)
  Prune:   N entries  (each listed with [MEMxxx] one-liner + reason: below-threshold | single-file-ref)
  Review:  N entries  (each listed with WHY flagged: "mentions line 1115" / "single file scope")
  Physical delete eligible: N fragments  (all entries pruned + LEDGER confirmed)

### DECISIONS (no-op — S05 pending)
  Keep: all rows (no-op — fragment-level pruning policy TBD in S05+)

### CHECKER-MEMORY (fragment store — event-based prune)
  Keep:    N dimension records  (across M fragments)
  Prune:   N dimension records  (each listed with dimension + slice + reason: stale)
  Physical delete eligible: N fragments  (all entries pruned + LEDGER confirmed)

### Milestone dirs
  Trim:    M001, M002, ...   (keep only M###-SUMMARY.md; drop intermediates)
  Keep:    M00X (active — untouched)
  Skip:    M00Y (no SUMMARY) | M00Z (missing LEDGER entry)

### Task dirs
  Trim:    TASK-001, TASK-002, ...   (keep only TASK-###-SUMMARY.md; drop intermediates)
  Keep:    TASK-NNN (no SUMMARY yet — untouched)
  Skip:    TASK-NNN (missing LEDGER entry)

### Session files
  Drop:    ask-YYYY-MM-DD-HHMM.md (status: closed)
  Keep:    ask-YYYY-MM-DD-HHMM.md (status: open)
  Skip:    ask-... (status missing)
```

### 4. If dry-run → stop here

This is the terminal state ONLY for (a) an explicit bare `/forge-sweep` preview-on-demand, or (b) an end-of-cycle run where the preview surfaced a risk (see **Invocation policy**) that needs explicit user authorization before `--apply`.

Print: "Dry-run complete. To apply: /forge-sweep --apply"

In an end-of-cycle wrap-up with the work already validated and no risk flagged, do NOT dead-end here — you should have invoked with `--apply` from the start, so the user gets the preview + the single confirmation popup without re-typing the command.

### 5. If --apply (and not --force) → confirm

Use AskUserQuestion with a single yes/no:
- Question: "Apply the sweep above? Emits N prune events (AUTO-MEMORY) + N prune events (CHECKER-MEMORY); physically deletes N eligible fragments; drops N sessions; trims N milestone dirs + N task dirs (keeping only their SUMMARY). Cannot be undone except via version control."
- Options: ["Apply now", "Cancel"]

If user picks Cancel → stop, no writes.

### 6. Execute (when --force OR confirmed)

Order matters — do these in sequence:

**a) AUTO-MEMORY prune events**

For each entry classified as `prune`:
```bash
echo '{"kind":"prune","mem_id":"<mem_id>","ts":"<ISO8601>","reason":"<below-threshold|single-file-ref>"}' \
  | node scripts/forge-memory.js --write --cwd .
```

Do NOT rewrite `.gsd/AUTO-MEMORY.md`. Do NOT delete fragment files here (see physical deletion step below).

**b) DECISIONS sweep — no-op**

<!-- This step performs zero file mutations. DECISIONS are fragments (S03).
     No rows are dropped. No file is rewritten. Prune policy TBD in S05+. -->
Skip entirely. Log: "DECISIONS sweep skipped (no-op — S05 pending)".

**c) CHECKER-MEMORY prune events**

For each dimension record classified as `prune`:
```bash
echo '{"kind":"prune","dimension":"<dimension>","slice":"<slice>","ts":"<ISO8601>","reason":"stale"}' \
  | node scripts/forge-checker-memory.js --write --cwd .
```

Do NOT delete fragment files here (see physical deletion step below).

**d) Physical fragment deletion (LEDGER-gated)**

For AUTO-MEMORY fragments:
- A fragment at `.gsd/memory/<unit-id>.md` is eligible for physical deletion ONLY when:
  1. Every `mem_id` in the fragment has a `prune` event (read fragment stats to confirm), AND
  2. The `<unit-id>` matches a heading in `.gsd/LEDGER.md`.
- If eligible: `rm .gsd/memory/<unit-id>.md`
- If not eligible: skip silently (the prune events already applied — projection will exclude them).

For CHECKER-MEMORY fragments:
- A fragment at `.gsd/checker-memory/<slice-id>.md` is eligible for physical deletion ONLY when:
  1. Every dimension record in the fragment has a `prune` event, AND
  2. The owning milestone (derived from slice-id) matches a heading in `.gsd/LEDGER.md`.
- If eligible: `rm .gsd/checker-memory/<slice-id>.md`
- If not eligible: skip silently.

**e) Milestone dirs**

For each dir in the "Trim" list:
- Double-check LEDGER has a matching heading (defensive).
- Remove every file inside `.gsd/milestones/M###/` EXCEPT `M###-SUMMARY.md`. Portable command (works on Linux/macOS/Git Bash):
  `find .gsd/milestones/M###/ -mindepth 1 -not -name 'M###-SUMMARY.md' -delete`
  PowerShell equivalent:
  `Get-ChildItem '.gsd/milestones/M###/' -Recurse -Force | Where-Object { $_.Name -ne 'M###-SUMMARY.md' } | Sort-Object FullName -Descending | Remove-Item -Force -Recurse`
- Do NOT remove the directory itself, and do NOT remove `M###-SUMMARY.md`.

**f) Task dirs**

For each dir in the "Trim" list:
- Double-check LEDGER has a matching heading (defensive).
- Remove every file inside `.gsd/tasks/TASK-###/` EXCEPT `TASK-###-SUMMARY.md`. Use the same find/PowerShell pattern as above with the task-specific paths and filename.
- Do NOT remove the directory itself, and do NOT remove `TASK-###-SUMMARY.md`.

**g) Session files**

For each file in the "Drop" list:
- `rm -f .gsd/sessions/<file>`

**h) Telemetry log**

Append to `.gsd/forge/events.jsonl`:
```json
{"ts":"<ISO8601>","event":"sweep","scope":"<scope>","emitted":{"memory_prune_events":N,"checker_prune_events":N},"deleted":{"memory_fragments":N,"checker_fragments":N,"sessions":N},"trimmed":{"milestones":N,"tasks":N},"flagged":{"memories":N},"decisions_step":"no-op"}
```

### 7. Final report

```
✓ Sweep applied

  AUTO-MEMORY:      N prune events emitted  (P fragments physically deleted, K fragments retained pending LEDGER)
  DECISIONS:        no-op (S05 pending)
  CHECKER-MEMORY:   N prune events emitted  (P fragments physically deleted, K fragments retained pending LEDGER)
  Milestone dirs:   M trimmed (only SUMMARY kept), K untouched (active)
  Task dirs:        M trimmed (only SUMMARY kept), K untouched (no SUMMARY yet)
  Sessions:         M dropped, K kept (open)

Files now lean. Commit to version control when ready.

Flagged entries (re-evaluate before next sweep):
  - [MEMxxx] reason
```

---

## Notes for the team

- **Run after `complete-milestone`** — that's when LEDGER gets the milestone entry, making the milestone dir safe to trim down to its SUMMARY and memory fragments eligible for physical deletion.
- **Prune events are logical, not physical** — the projection layer (S05+) reads prune events to exclude entries from the active set. Physical deletion follows only after LEDGER confirmation.
- **DECISIONS are intentionally untouched** — the legacy row-pruning approach is obsolete now that decisions live as fragments in `.gsd/decisions/`. Fragment-level pruning policy will be defined in S05.
- **For ad-hoc tasks (`/forge-task`)** — task dirs are trimmed automatically when SUMMARY + LEDGER entry exist, same rules as milestones.
- **Why trim instead of delete** — the empty-ish milestone/task directory (with just the SUMMARY inside) stays visible in version control so teammates pulling the sweep see the milestone existed. This avoids the confusion of "where did M### go?" when one dev sweeps and another pulls.
- **Flagged AUTO-MEMORY entries don't auto-drop** — re-evaluate them in the next sweep. If they still don't earn promotion (hits stay low, scope still narrow), emit prune events manually next time.
- **Never edit `STATE.md`** — this command does not touch state.
- **Never run during an active milestone phase** — only after `complete-milestone` or between tickets.
