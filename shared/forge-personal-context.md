# Personal session context

This contract applies to Claude and Codex, including natural-language “iniciar”,
boot, `/forge`, refresh, `/forge-status`, `/forge-auto` and `/forge-next`.
Resolve scripts from the Forge repository or `${FORGE_HOME:-~/.forge-agent}/scripts`.
The installed copy of this document is under the same Forge home's `shared/`.

## Read before discovery

For interrupted or partial work, after the personal summary, inspect the explicitly
chosen ID with `node "<scripts>/forge-doctor.js" --diagnose-recovery TASK-001 --cwd "<project>"`.
Use `--json` for the same observations in JSON. A milestone controller may be
observed only with its explicit `--controller-key "<key>"`; standalone tasks do
not gain controller coverage. The diagnostic does not discover or adopt work.
An existing binding retains checkpoint, acceptances and pending decisions; only a
valid `no-bindings` permits unbound inspection. Store errors never authorize fallback.

The report separates proven results, uncertainty, preserved artifacts, personal
continuity and the next safe inspection/decision. Missing, corrupt, unreadable and
stale are distinct. A durable release does not need a final event; an orphan bundle
does not prove release. SUMMARY alone, inactivity and committed controller
transactions do not prove global completion. Publications can precede phase updates.
Exit 0 means valid observations, not completion; 1 means partial/uncertain and 2
invalid arguments. This exclusive mode rejects other operations and mutation or
attestation flags. It never binds, checkpoints or changes claims, leases or journals.
Sweep, sidecar reset and other journals remain explicitly unknown/not covered.
Inspection does not authorize replay or grant attestations; existing authorities
must revalidate every future action. Preserve current acceptances and leave
unanswered required decisions pending.

For boot, resume, “onde paramos?” and simple status, run
`node "<scripts>/forge-personal-context.js" --summary --cwd "<current directory>"`.
It prints one compact JSON line built from the snapshot by allowlist; `--json` is
accepted and ignored. The full `--snapshot --cwd "<current directory>"` (or one work
with `--snapshot --id <ID>`) is reserved for an explicitly requested diagnostic or for
attention that needs an omitted mandatory decision; report only the fields needed.
Both read the OS profile's `.forge-personal/context.json`, independently of FORGE_HOME,
session ID, LLM account and provider. No separate login or automatic legacy adoption exists.
Only bound IDs may enter the personal operational context. A missing store means
`no-bindings`; corrupt, unreadable, unsupported schema and changed evidence are distinct.
Never recover those cases by reading global STATE, ledger, auto-mode markers or colleagues' runs.
Reading does not create directories, migrate, modify registry or remove continue.md.

Display from the summary each work's activity separately from workStatus and
reliability, with pending decisions/UAT, unresolved acceptances, lastResult and
nextAction, each with its relative source and validity (current, historical,
missing or uncertain). Hashes, capture times, full history and absolute paths stay
in the explicit `--snapshot` diagnostic. Historical/missing/uncertain observations
require reconciliation; do not repeat them as certainty or reopen an acceptance.

Summary limits: at most 5 works, 3 items per field, 240 code points per text
(ellipsis plus `truncated`) and 4096 bytes including the newline. Works are ordered
pending or needs-reconciliation first, then open, unknown and completed, ties by
ID; never by age or activity. Non-mandatory text and works are reduced first;
pending decisions and unresolved acceptances are never dropped silently: `totals`
count all of them and `attention` (`attention-required`, counts and the diagnostic
command) reports any omitted or truncated one. Omission is not approval, absence,
a resolved decision or permission to dispatch; omitted completed works do not
trigger an additional read. Errors keep their closed reason, never `no-bindings`.
The personal view takes precedence over old operational pointers in CLAUDE.md/KNOWLEDGE.md.
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

Recovery handoffs persist `authorization_reference` in their evidence source, not an
opaque process-local capability or a copied personal instruction. After restart the
trusted host revalidates that reference through `forge-recovery-authority` before
issuing a unit-scoped exception (see `shared/forge-interaction.md`). A checkpoint
is evidence and never consent. Keep functional question IDs, unanswered questions,
prior acceptances, receipt and recovery-state references in the source artifact.
`lastResult` and `nextAction` point to existing hashed evidence. An idle workflow,
an empty verification gate or a simulated provider does not complete delivery/UAT.

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
