# Direct actions and UAT corrections

This is the canonical boundary between ordinary host work and a Forge unit.
Apply it before creating a run, selecting a worker, or invoking a task lifecycle.
It applies to Claude and Codex, including feedback during task or milestone UAT.
Explicit `/forge-*` commands keep their chosen lifecycle and flags.

## Choose the path before dispatch

Perform an already-authorized action directly in the current session when all
of the following are established from the request and current technical evidence:

- The result and affected paths are clear; no important human decision is pending.
- The correction is localized, low risk, and has a clear, proportionate verification.
- The current context explains the cause and the intended change. Recheck the
  relevant source bytes before editing, especially after resume or compaction.
- It does not expand product scope, introduce an architectural decision, or affect
  security, permissions, data integrity, a migration, or another high-risk boundary.
- Existing isolation and coordination requirements can be honored in the same
  code directory, without overlapping another writer or adopting another person's work.

Examples include a known label correction and removal of explicitly identified
temporary directories created by the session. For deletion, verify the absolute
targets, their ownership and contents; protect against traversal and symlink escape.
File count alone, a confidence score, imported consent, and an unanswered question
never establish eligibility. Uncertainty about any required criterion keeps the
normal Forge path with a brief reason.

Explain the classification in one short sentence, act, verify, and report the
result. Do not ask "direct or task?" for every clear request or reconfirm consent
already present in the conversation. Ask only for a missing important decision.
A direct action creates no run, task, milestone, assessment, or worker dispatch.
It does not require brainstorm, research, a new plan gate, or dialectic review.

This is an entry decision, never a fallback after a routed unit fails. A refusal
or failed sidecar retains its selected model, effort, route and pending unit;
investigate the failure through the canonical dispatch diagnostic contract.

## Feedback during UAT

Passing or failing UAT may reveal a correction eligible for the same direct path.
Rich context alone is insufficient: establish the criteria above from current
sources. Identify the task or milestone from the explicit current conversation
and its personal binding; ambiguous ownership requires an explicit selection.
Never choose a work item by age, shared activity, or another person's queue.

Apply an eligible correction in its existing CODE_DIR, branch/worktree and scope.
Keep existing accepted decisions. Do not create another task, restart preparation,
replay the milestone loop, or call `/forge-task --resume` merely to make the edit.
An expanded scope, unknown cause, or high-risk correction follows normal preparation;
only affected decisions and verification are reconsidered, with a visible reason.

Before returning, append a dated correction record to the existing work's UAT
artifact and SUMMARY or handoff. For a standalone task without a UAT file, create
`{TASK_ID}-UAT.md` in that task's artifact directory. Record the user's observation,
the reason direct work was appropriate, files changed, verification commands and
results, affected acceptance criteria, and what needs retesting. If a criterion
changes, record the explicit decision instead of silently rewriting its history.

Update the existing authoritative pending/next-action evidence and personal
checkpoint with `--intent checkpoint`, per `shared/forge-personal-context.md`.
Recapture changed source references; preserve acceptance history. Mark the affected
UAT checks pending until the user accepts the corrected result. Earlier approval
of the preceding implementation does not accept newly changed behavior. Never
declare the task/milestone complete from a successful automated check alone.
If record or checkpoint publication fails, report partial continuity with the
successful code change and the missing record; do not claim the correction was saved.

## Verification boundary

Use the smallest check that demonstrates the requested result, expanding when
failures or affected behavior justify it. Prompt/projection tests establish this
contract's distribution, not that a host will classify arbitrary prose correctly.
Validate actual host behavior with a trivial request, a known UAT correction,
an ambiguous work item, and a small high-risk request before claiming end-to-end
coverage.
