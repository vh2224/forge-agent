# Personal session context

This contract applies to Claude and Codex, including natural-language “iniciar”,
boot, `/forge`, refresh, `/forge-status`, `/forge-auto` and `/forge-next`.
Resolve scripts from the Forge repository or `${FORGE_HOME:-~/.forge-agent}/scripts`.
The installed copy of this document is under the same Forge home's `shared/`.

## Read before discovery

Run `node "<scripts>/forge-personal-context.js" --snapshot --cwd "<current directory>" --json`.
This reads the OS profile's `.forge-personal/context.json`, independently of FORGE_HOME,
session ID, LLM account and provider. No separate login or automatic legacy adoption exists.
Only bound IDs may enter the personal operational context. A missing store means
`no-bindings`; corrupt, unreadable, unsupported schema and changed evidence are distinct.
Never recover those cases by reading global STATE, ledger, auto-mode markers or colleagues' runs.
Reading the snapshot does not create directories, migrate, modify registry or remove continue.md.

Display each work's activity separately from workStatus and reliability, including
pending decisions/UAT, recorded acceptances, lastResult, nextAction, sources, hashes
and capture times. `stale`/`missing` observations remain historical evidence and
require reconciliation; do not repeat them as certainty or reopen an acceptance.
The snapshot takes precedence over old operational pointers in CLAUDE.md/KNOWLEDGE.md.
Unverified prose is historical; this is not a semantic parser of every old document.
Shared technical knowledge stays available through canonical memory/decision projections.
The global ledger and dashboard are not a personal queue.

## Explicit producers

After a task directory/run or milestone state is created, invoke:
`node "<scripts>/forge-personal-context.js" --bind --project "<WORKING_DIR>" --id "<ID>" --intent create --json`.
After an explicitly chosen resume, use the same call with `--intent explicit-resume`
before loading its handoff. Bind again after isolation registration to retain validated
worktree aliases. Main/nested checkout and a registered worktree then resolve together;
different SVN working copies remain separate even with the same remote URL.
Bind is idempotent and keeps checkpoints. Inspection by ID must never call bind.
Registry creation and binding are two writes: a failed second write is a **partial**
result naming the ID and the explicit-resume recovery command. Stop that execution;
do not erase the run or claim that personal resume was persisted.

## Durable handoff — every exit

After writing authoritative continue/state/review/UAT evidence, prepare a JSON file
inside that work's artifact directory using the host's file-writing tool (no shell
interpolation of user text), then invoke:
`node "<scripts>/forge-personal-context.js" --checkpoint --project "<WORKING_DIR>" --id "<ID>" --intent checkpoint --file "<checkpoint.json>" --json`.
Example payload (all sources must exist within the project or a validated worktree):

```json
{
  "nextAction": [{"text":"Validate UAT when the environment is ready","source":".gsd/tasks/TASK-001/continue.md"}],
  "pending": [{"text":"UAT waiting for environment","source":".gsd/tasks/TASK-001/continue.md"}],
  "acceptances": [{"text":"Plan approved","source":".gsd/tasks/TASK-001/TASK-001-PLAN-GATE.md","resolved":true}],
  "lastResult": [{"text":"Implementation verified; UAT pending","source":".gsd/tasks/TASK-001/TASK-001-SUMMARY.md"}]
}
```

The API captures source SHA256 and time itself. Omitted fields preserve existing
captures; acceptance history is retained. Apply this at pause, blocked/partial,
review deferral, account handoff, compact, next-unit and successful completion exits.
Boundary hooks only checkpoint already-bound work; they never adopt a session marker.
Deactivation/idle preserves bindings and handoffs. Before declaring terminal success,
explicitly reconcile pending items and next actions (resolved:true or an empty list
after checking the evidence), and capture a terminal `lastResult` with `resolved:true`
from the final SUMMARY/state. SUMMARY/ledger existence alone is not completion.
Reconcile stale handoff and acceptance observations too; an explicit recapture of
the same acceptance preserves its history and supersedes the previous confidence.
Do not mark terminal while acceptance/UAT remains outstanding. Failed checkpoint is
reported as partial continuity; preserve the authoritative artifacts for explicit repair.

## Selection and compatibility

Auto/next without an ID call `--select` or `forge-cli-helpers.js --resolve-args`.
`selected` is the sole unambiguous, open work with current evidence. `selection-required`
requires an explicit ID. `attention-required` displays pending/unknown/stale work but
does not authorize dispatch. Zero bindings never discovers the team. A selected task
routes to `/forge-task --resume ID`; milestone routes to its per-milestone state.
Explicit inspection is read-only: `forge-status ID`. Explicit resume binds first and
reconciles invalid evidence/pending decisions before execution, preserving prior consent.
Low-level runs, locks, reaper and census remain global for workspace coordination.
`forge-status --scope workspace` explicitly requests the old global diagnostic view;
it neither establishes ownership nor supplies implicit personal candidates.
This isolates operational context, not filesystem access or simultaneous editing rights.
