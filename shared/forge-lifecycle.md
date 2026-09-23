# Forge long-workflow lifecycle

`scripts/forge-loop-controller.js` is the provider-neutral loop boundary for
`auto` and `task`. It delegates selection, leases, durable boundaries and
resume/handoff to `forge-orchestrate`; it does not spawn or choose workers.

Both modes are milestone-scoped: `task` is the same controller with a one-unit
budget and a terminal resume, not a second selection domain. Selection lives in
`forge-orchestrate` → `forge-unit-controller.selectNextUnit`, whose every branch
reads a milestone's roadmap/slices, over state that `forge-state` reads only from
`.gsd/milestones/<id>/<id>-STATE.md`. A **standalone task** (`/forge-task`, whose
artifacts live in `.gsd/tasks/<id>/` with no STATE and no roadmap) is therefore
outside this boundary, and `next`/`pause` refuse it by name: `outcome: blocked`,
`reason_code: task-scope-unsupported`, `action: stop`, snapshot unchanged. That
refusal is the defined answer, not a malfunction — the caller proceeds under its
own authority. Supplying an unrelated milestone id to reach a dispatch is never
the workaround: it selects that milestone's next unit and commits a lease and a
transaction against it.

States are `idle → dispatch_required | paused | completed | blocked | failed`.
`next` returns a dispatch intent while the S02 lease remains authoritative.
`pause` creates a durable boundary through `forge-orchestrate`. Only `resume`
may explicitly change `host_runtime`, and only with that boundary. A repeated
command with the same snapshot/idempotency key is safe and does not acquire a
second lease or increment the step counter.

The adapter supplies only `host_runtime`, mode, normalized input and
presentation. It must not read provider homes, infer worker/model, spawn a CLI,
or fall back to another host. Dispatch remains the S06 boundary.

## Milestone selection authority

`forge-unit-controller.select` owns milestone phase selection. Do not reproduce
its dispatch table in a skill or advance STATE by hand to skip a phase.

In auto mode, consume the loop adapter's selected unit and keep its snapshot;
do not call the read-only selector again after a unit has been leased. Stop on
`pause`, `stop`, a pending human decision, or an error as the lifecycle requires.

In step mode without a leased unit, resolve the active milestone ID from the
run/per-milestone STATE (the workspace STATE is only a dashboard), then call:

```bash
SELECTION_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-unit-controller.js" --select "$MILESTONE_ID" --cwd "$WORKING_DIR")
SELECTION_EXIT=$?
```

No active milestone means stop and report no active milestone. A nonzero exit
means stop and show the diagnostic; never fall back to interpreting STATE prose.
For `ok: true`, use `unit.type`, `unit.id` and `slice` as `unit_type`, `unit_id`
and `SLICE_ID`. For `done: true`, emit the completion report and stop. Any other
result stops without dispatch. Selection is read-only: it does not acquire a
lease or write STATE, and is not permission to bypass dispatch or approval gates.

The selector applies canonical `skip_discuss`, `skip_research` and
`skip_slice_research` preferences. The two research preferences are independent.
The existing `forge-parallelism.js` picker remains responsible for task
dependencies and batches, after phase selection and before dispatch. A live
controller lease must never be retargeted to a different task or slice by a
second picker; stop on a mismatch and preserve the snapshot for recovery.

For the selected unit, set `agent_name` by family: `plan-*` uses `forge-planner`,
`discuss-*` uses `forge-discusser`, `research-*` uses `forge-researcher`,
`execute-task` uses `forge-executor`, and `complete-*` uses `forge-completer`.
Model/engine/effort still come from `forge-dispatch-resolve.js`; these agent names
do not select a host, delivery mode or model.
Standalone `/forge-task` remains outside milestone selection.

## Personal status payload (2.0.0)

The provider-neutral forge-orchestrate status operation keeps the operation
envelope protocol_version at 1.0.0; init, next, complete and handoff are unchanged.
Its details.status_schema_version is 2.0.0. Consumers must use this status-specific
version when interpreting state and details; the old workspace status payload
is not the personal queue contract.

Without an ID, status lists only explicitly bound personal work. Explicit ID
inspection reads that work without binding it. A single personal milestone can
provide state; multiple personal milestones have no implicit focus. Empty
bindings return no_work; a task-only personal view still returns completed.
Snapshot read errors return failed with warnings rather than a workspace fallback.

- details.scope identifies personal or inspection; details.works carries canonical
  workStatus, reliability, nextAction, checkpoint and terminalEvidence.
- state is a validated snapshot projection: milestone, phase, active_slice,
  active_task, auto_mode and next_action. It never causes another state-file read.
  Invalid/missing/unreadable/changed state or stale checkpoint evidence yields
  state=null and the work diagnostic remains visible. next_action, when present,
  comes from the snapshot action, including a current personal checkpoint.
- The former state.progress roadmap aggregate is absent. Status does not scan
  peer roadmaps to populate it.
- details.runs contains only bound work with activity=active, with id, kind and
  activity. Former phase/stale run fields are absent; process activity is separate
  from work completion and evidence reliability.
- details.autonomous_tasks contains only personal/explicitly inspected tasks.
  Its status is the workStatus enum: open, pending, unknown or completed, not the
  previous workspace task-plan status. Use details.works for diagnostic/action
  information.
- warnings includes per-work reliability diagnostics and snapshot errors.

No read operation creates bindings, rewrites checkpoints or synchronizes project
instruction files. Workspace census remains an explicitly separate API.
