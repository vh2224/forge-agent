---
id: T04
slice: S04
milestone: M003
title: "Wire blocking-mode revision loop (inert default) in forge-auto + forge-next"
status: RUNNING
planned: 2026-04-18
must_haves:
  truths:
    - "`skills/forge-auto/SKILL.md` replaces the T03 placeholder `# TODO(T04): blocking revision loop goes here` with a working blocking-mode revision loop."
    - "Revision loop enforces: max 3 rounds (LOCKED constant in the skill body — `MAX_PLAN_CHECK_ROUNDS = 3`); each round must strictly decrease the `fail` count; on non-decreasing fail OR on exhausting rounds, the loop terminates and the user is surfaced with the current S##-PLAN-CHECK.md flags."
    - "Between rounds, the orchestrator dispatches `plan-slice` again (replan) OR waits for user to edit plans manually — decision LOCKED in this task: the loop dispatches `plan-slice` again with an injected ## Revision Request section naming the failing dimensions, and the new S##-PLAN-CHECK.md (written by re-running the gate after plan-slice) is compared to the prior one."
    - "On each revision round, the prior `S##-PLAN-CHECK.md` is renamed to `S##-PLAN-CHECK-round{N}.md` (backup) before the new one overwrites. Round 1 = original; Rounds 2/3 = revisions."
    - "`events.jsonl` gets one `{event: 'plan_check', round: N, outcome: 'revised'|'terminated-exhausted'|'terminated-non-decreasing'|'passed', ...}` line per round."
    - "`skills/forge-next/SKILL.md` gets the same revision-loop logic (MEM015 structural sync — existing lines 123-129 memory-injection block preserved untouched)."
    - "The user-surface message when terminating on non-decreasing or exhaustion is a structured block listing the still-failing dimensions and the round count — user is expected to edit plans manually and re-run `/forge-next` (which will re-invoke the gate idempotently if `S##-PLAN-CHECK.md` was deleted by the user) or `/forge-auto`."
    - "Default `plan_check.mode: advisory` → the revision loop branch is NEVER entered. This is the critical invariant: M003 ships the code path but does not activate it."
    - "`node --check scripts/forge-hook.js` passes (if touched — not expected in this task)."
  artifacts:
    - path: skills/forge-auto/SKILL.md
      provides: "Blocking-mode revision loop. Replaces T03 placeholder with full logic: max 3 rounds, monotonic fail-decrease enforcement, round-N backup of prior S##-PLAN-CHECK.md, re-dispatch of plan-slice with ## Revision Request section, events.jsonl per round, user-surface on termination. Inert when plan_check.mode is not 'blocking'."
      min_lines: 450
      stub_patterns: []
    - path: skills/forge-next/SKILL.md
      provides: "Same revision-loop logic mirrored per MEM015. Preserves existing memory-injection block (lines 123-129) unchanged."
      min_lines: 190
      stub_patterns: []
  key_links:
    - from: skills/forge-auto/SKILL.md
      to: forge-agent-prefs.md
      via: "regex read of plan_check.mode — loop activation gate"
    - from: skills/forge-auto/SKILL.md
      to: agents/forge-planner.md
      via: "Agent({ subagent_type: 'forge-planner', prompt }) with ## Revision Request section — re-dispatch of plan-slice for round 2/3"
    - from: skills/forge-auto/SKILL.md
      to: agents/forge-plan-checker.md
      via: "Agent re-dispatch after each revision — same as T03 dispatch, but with round number passed"
expected_output:
  - skills/forge-auto/SKILL.md
  - skills/forge-next/SKILL.md
---

# T04: Blocking-mode revision loop (inert default) in forge-auto + forge-next

**Slice:** S04  **Milestone:** M003

## Goal

Replace the T03 placeholder (`# TODO(T04): blocking revision loop goes here`) in `skills/forge-auto/SKILL.md` and mirror the logic into `skills/forge-next/SKILL.md`. The revision loop is **inert by default** — only activated when `plan_check.mode: blocking` is set in prefs. Logic: max 3 rounds, strict monotonic decrease in `fail` count per round, or terminate and surface flags to user. On each revision, re-dispatch `plan-slice` with an injected `## Revision Request` section naming the failing dimensions, back up the prior `S##-PLAN-CHECK.md` as `S##-PLAN-CHECK-round{N}.md`, re-run the plan-check gate, and compare counts.

## Must-Haves

### Truths

- `skills/forge-auto/SKILL.md` placeholder replaced with working loop.
- LOCKED constant: `MAX_PLAN_CHECK_ROUNDS = 3`.
- Round termination conditions: exhausted rounds (reached 3 without `fail: 0`) OR non-decreasing fail count between rounds.
- Inter-round action: re-dispatch `plan-slice` with `## Revision Request` section listing failing dimensions; re-run plan-check gate; compare prior vs new fail counts.
- Backup convention: prior `S##-PLAN-CHECK.md` renamed to `S##-PLAN-CHECK-round{N}.md` before overwrite. Round 1 is the original.
- `events.jsonl` receives one `{event: 'plan_check', round, outcome, ...}` line per round.
- `skills/forge-next/SKILL.md` mirrors the logic; preserves lines 123–129 (MEM015).
- User-surface on termination: structured block listing failing dimensions + round count.
- Default `advisory` mode: revision-loop branch NEVER entered. Code ships live but inert.
- `node --check` passes on any modified scripts (n/a — only `.md` edits).

### Artifacts

- `skills/forge-auto/SKILL.md` — extended; final length ≥ 450 lines.
- `skills/forge-next/SKILL.md` — extended; final length ≥ 190 lines; lines 123–129 preserved.

### Key Links

- `skills/forge-auto/SKILL.md` → `forge-agent-prefs.md` via `plan_check.mode` regex read (loop activation gate).
- `skills/forge-auto/SKILL.md` → `agents/forge-planner.md` via `Agent({ subagent_type: 'forge-planner', prompt })` for replan rounds.
- `skills/forge-auto/SKILL.md` → `agents/forge-plan-checker.md` via `Agent({ subagent_type: 'forge-plan-checker', prompt })` for each round.

## Steps

1. **Read the T03 output first.** Confirm the placeholder `# TODO(T04): blocking revision loop goes here` exists in both `skills/forge-auto/SKILL.md` and `skills/forge-next/SKILL.md`. If T03 wired the block differently, note the exact line numbers in T04-SUMMARY.

2. **Read `agents/forge-planner.md`** — confirm the planner contract for `plan-slice` unit type. The replan round needs to pass a `## Revision Request` section; confirm the planner will honor an injected section in the prompt.

3. **Replace the `skills/forge-auto/SKILL.md` placeholder** with the following logic (exact block — language-agnostic pseudo-code that the orchestrator executes):

   ```markdown
   **Blocking-mode revision loop (activated when PLAN_CHECK_MODE == "blocking"):**

   Constants:
   - `MAX_PLAN_CHECK_ROUNDS = 3` (LOCKED — changing requires a new milestone decision).

   State for the loop:
   - `round = 1` (initial plan-check already ran via T03 gate; this is round 1)
   - `prev_fail_count = plan_check_counts.fail` (from the T03 dispatch result)

   While `prev_fail_count > 0` AND `round < MAX_PLAN_CHECK_ROUNDS`:
     a. **Back up the prior PLAN-CHECK.md:**
        ```bash
        mv {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-CHECK.md \
           {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-CHECK-round{round}.md
        ```

     b. **Collect failing dimensions** from the prior PLAN-CHECK.md (parse the table — rows where Verdict == "fail"). Include their justifications.

     c. **Increment round:** `round += 1`.

     d. **Re-dispatch plan-slice** with an injected `## Revision Request` section:
        ```
        Agent({
          subagent_type: 'forge-planner',
          prompt: <plan-slice template>
            + "\n\n## Revision Request (round {round})\n"
            + "The prior plan scored `fail` on these dimensions:\n"
            + "- <dimension 1>: <justification>\n"
            + "- <dimension 2>: <justification>\n"
            + "...\n"
            + "Revise the slice plan to resolve these failures. Preserve all already-passing dimensions. Do NOT reduce scope to hide failures — fix the root cause."
        })
        ```

     e. **Re-run the T03 plan-check gate** (from the `advisory` path — same logic, round number passed in `MODE: blocking, round: {round}`). This produces a NEW `S##-PLAN-CHECK.md`.

     f. **Parse new counts** → `new_fail_count`.

     g. **Append events.jsonl line:**
        ```json
        {"ts":"<ISO-8601>","event":"plan_check","milestone":"{M###}","slice":"{S##}","mode":"blocking","round":{round},"counts":{"pass":N,"warn":N,"fail":new_fail_count},"prev_fail":prev_fail_count,"outcome":"revised"}
        ```

     h. **Monotonic-decrease check:** if `new_fail_count >= prev_fail_count`, TERMINATE:
        - Append events.jsonl line with `outcome: "terminated-non-decreasing"`.
        - Surface to user (see step 4 below).
        - Break out of the loop. Do NOT dispatch first `execute-task`.

     i. `prev_fail_count = new_fail_count`.

   After the while loop exits:
     - If `prev_fail_count == 0`: success — append events.jsonl `outcome: "passed"`, proceed to first `execute-task`.
     - Else (round reached MAX): TERMINATE — append events.jsonl `outcome: "terminated-exhausted"`, surface to user.
   ```

4. **Write the user-surface block** (step h / termination):
   ```markdown
   **Surface to user (pt-BR):**

   Emit:
   ```
   ⚠  Plan-check blocking mode: terminando loop de revisão.
      Motivo: {non-decreasing | exhausted rounds}
      Rodada atual: {round}/3
      Dimensões ainda falhando:
        - {dim1}: {justification}
        - {dim2}: {justification}

   Ação: edite os T##-PLAN.md para resolver as dimensões listadas, depois:
     - delete {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-CHECK.md
     - rode `/forge-next` para reexecutar o gate (ou `/forge-auto` para continuar autônomo).
   ```

   After emitting, set `auto-mode.json` inactive (standard stop pattern — matches Agent() failure block) and return. Do NOT dispatch first `execute-task` for this slice.
   ```

5. **Mirror the logic into `skills/forge-next/SKILL.md`.** Preserve the existing selective memory injection block at lines 123–129 (MEM015). The revision-loop block goes where the T03 placeholder was inserted.

6. **Verify the default advisory path is unchanged.** Test by reading prefs:
   - If `plan_check.mode: advisory` (default) → the T03 gate dispatches plan-checker once, writes events.jsonl, proceeds to first `execute-task`. The while-loop above is NEVER entered.
   - If `plan_check.mode: blocking` → the T03 gate dispatches plan-checker once, then enters the while-loop if `fail > 0`.
   - If `plan_check.mode: disabled` → the T03 gate is skipped entirely. Revision loop is unreachable.

7. **Confirm LOCKED constant.** `MAX_PLAN_CHECK_ROUNDS = 3` must appear as a literal constant in the skill body (no env var, no pref key). Future M004+ can bump this with a new milestone decision; for M003 the cap is hard-coded to match SCOPE C10.

8. **Add a `## Plan-Check Revision Loop` subsection to `skills/forge-auto/SKILL.md`** documenting the loop for future readers. This subsection goes immediately after the step with the blocking-branch code. Explain: activation, round semantics, backup filenames, termination conditions, user-surface contract.

9. **Verify activation timing.** MEM068 applies: edits to `skills/forge-auto/SKILL.md` and `skills/forge-next/SKILL.md` need `install.sh` / `install.ps1` re-run to activate in `~/.claude/skills/`. Document this in T04-SUMMARY.

10. **Smoke verification (manual, documented in SUMMARY):**
    - Read-through: confirm the while-loop cannot be entered when `PLAN_CHECK_MODE != "blocking"`.
    - Backup filename logic: round 1 backup → `S##-PLAN-CHECK-round1.md`. If round 2 also fails and triggers round 3, round 2 backup → `S##-PLAN-CHECK-round2.md`. Final state: original (round 3) at `S##-PLAN-CHECK.md` + round1/round2 backups.
    - Termination: on non-decreasing fail OR round == MAX, the first execute-task is NEVER dispatched. The user must intervene.

## Standards

- **Target directories:** `skills/forge-auto/`, `skills/forge-next/`.
- **Reuse:**
  - MEM011 — dispatch templates use placeholder substitution; the replan step re-uses the existing `plan-slice` template with an appended `## Revision Request` section.
  - events.jsonl append convention from Asset Map — propagate I/O errors.
  - Agent() failure block pattern (`skills/forge-auto/SKILL.md` lines 251–258 per Asset Map) — the user-surface termination uses the same `auto-mode.json {active: false}` stop pattern.
- **Naming:**
  - `MAX_PLAN_CHECK_ROUNDS` — UPPER_SNAKE constant name.
  - Backup filename: `S##-PLAN-CHECK-round{N}.md` — LOCKED.
  - events.jsonl outcome values: `"revised"`, `"terminated-exhausted"`, `"terminated-non-decreasing"`, `"passed"` — LOCKED.
- **Lint command:** none for `.md`. Manual MD review.
- **Pattern:** `follows: Dispatch control-flow section` from Pattern Catalog (this is a new cross-cutting control-flow that wraps the plan-check dispatch).
- **Language:** user-surface messages in pt-BR (matches existing patterns). Code / constant names in English.
- **Idempotency:** the loop itself is not idempotent (each round creates state); but an interrupted loop (user kills the session mid-round) leaves the backup files as-is. User can manually resume by deleting `S##-PLAN-CHECK.md` and re-running — the T03 gate's idempotency check will re-dispatch round 1 fresh.

## Context

- **Read first:**
  - `skills/forge-auto/SKILL.md` after T03 lands — locate the placeholder.
  - `skills/forge-next/SKILL.md` after T03 lands — same.
  - `agents/forge-planner.md` — confirm plan-slice prompt accepts an appended `## Revision Request` section (the planner reads the full prompt; a new section is visible to the agent).
  - `shared/forge-dispatch.md § Retry Handler` (lines 289–446) — the structural template for dispatch control-flow sections. Our revision loop is similar in shape.
  - `scripts/forge-verify.js` lines 479–493 — events.jsonl append convention.
  - `skills/forge-auto/SKILL.md` lines 251–258 per Asset Map — Agent() failure block (our termination uses same stop pattern).

- **Prior decisions to respect:**
  - SCOPE C10 — max 3 rounds, monotonic decrease rule. LOCKED.
  - M003 default: `plan_check.mode: advisory`. Revision loop is INERT by default.
  - MEM068 — skill edits need install.sh re-run.
  - MEM015 — preserve forge-next's unique memory-injection block (lines 123–129).
  - events.jsonl is telemetry — propagate I/O errors (no try/catch around appendFileSync).
  - User-surface messages in pt-BR.

- **What NOT to do:**
  - Do NOT parameterize `MAX_PLAN_CHECK_ROUNDS` — it's a LOCKED constant in M003. A new pref key would add surface area; use the existing `plan_check.mode: disabled` for users who want to opt out entirely.
  - Do NOT modify `agents/forge-plan-checker.md` — the agent signature is LOCKED in T01.
  - Do NOT modify `agents/forge-planner.md` — the planner already accepts appended prompt sections (Markdown is additive; the `## Revision Request` section is visible without changing the agent definition).
  - Do NOT write a new script. All logic lives in the skill `.md` files (orchestrator executes them inline).
  - Do NOT edit `CLAUDE.md` (T05 handles docs).
  - Do NOT change the default to `blocking` — that's explicitly M004+ per DEFERRED.

- **Smoke-demo scenarios to document in T04-SUMMARY:**
  1. `plan_check.mode: advisory` (default) → revision loop never enters. Single round, proceed to first execute-task.
  2. `plan_check.mode: blocking` + plan with structural fail → round 1 fails, plan-slice redispatched with revision request, round 2 passes → proceed.
  3. `plan_check.mode: blocking` + plan with chronic fail that doesn't improve → round 2 fail == round 1 fail → terminate with `non-decreasing` outcome.
  4. `plan_check.mode: blocking` + plan with slowly improving fail (5 → 4 → 3) → reaches round 3 still fails → terminate with `exhausted` outcome.
