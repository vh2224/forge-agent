# Claude/Codex delegation

## Cause and before/after

The 4.33.0 runtime posture map refused every Codex → Claude dispatch with
`codex-claude-unroutable`. This initially protected a real gap: skills only
entered Codex Branch C/D, and the later account-backed Claude adapter only
parsed execute-task results. Its existence did not supply research, planning,
review, or completion contracts. Non-executor/planner phases also filtered GPT
members out of tier chains because their delivery was assumed to be native
Claude. The loop had no completion acknowledgement to leave dispatch_required
after a delivered unit while retaining its snapshot.

Repository and installed guard/resolver/xllm/Claude-adapter sources matched at
investigation time. The installed long-workflow adapter differed at the byte
level but had the same behavior. No installed user files were modified.

Now the guard and transport share a per-unit capability table. Research and
other document-producing units return allowlisted artifacts from a read-only
turn; slice planning keeps its distinct plan/must_haves schema; execution
retains VCS baselines, changed-file derivation and the protected-state fence.
Claude review uses its existing challenge/defense/rebuttal schemas. The
resolver keeps configured cross-engine tier chains for supported artifact
units. A resolver failure refuses dispatch instead of opening a default-engine
path. No worker, preference, host, or fallback is substituted by delivery.

Validated responses are persisted before materialization. An identical request
replays publication after interruption without another provider call. Modified
targets conflict instead of being overwritten. An unfinished attempt with no
validated response requires explicit recovery. Loop completion commits through
the original controller transaction/lease and returns a snapshot ready for the
next unit; replay is idempotent. The adapter never acquires another lease.

## Matrix and limits

| Contract | Claude → Codex | Codex → Claude |
| --- | --- | --- |
| research-milestone, research-slice | Artifact transport | Artifact transport |
| discuss-milestone, discuss-slice | Artifacts or pending questions | Artifacts or pending questions |
| plan-milestone | Roadmap artifact | Roadmap artifact |
| plan-slice | Existing plan contract | Same validated plan contract |
| execute-task | Existing execution contract | Same execution safety tail |
| complete-slice, complete-milestone, plan-check | Artifact transport | Artifact transport |
| review challenger, advocate, rebuttal | xllm review contracts | xllm review contracts |
| review-fix, memory-extract | Named unsupported auxiliary unit | Named unsupported auxiliary unit |

Claude → Claude and Codex → Codex retain native delivery. A declared same-host
sidecar uses the same capability table. Interactive decisions stay with the
parent: a read-only sidecar returns partial/questions, never assumed consent.
Auxiliary failures retain their existing nonblocking policy, with no fabricated
review or memory extraction. Research on the restricted Claude profile uses
file inspection, not arbitrary shell commands. Completers return documents;
parent verification, ledger, cleanup and authorized VCS operations still run.

Claude uses the Forge default account through `resolveLaunch`; the credential
is child-only environment data. No provider text is echoed on failure. Missing
account/CLI, authentication failure, output limit, timeout, cancellation and
invalid result have named outcomes. Read-only Claude children disable inherited
hooks, MCPs, skills and persistent sessions and expose only Read/Glob/Grep.
Execution retains acceptEdits and the shared post-run guards; these guards
detect violations and are not an OS sandbox for arbitrary malicious programs.
No live provider/OS-sandbox conformance claim is made by fixture tests.

## Validation

`forge-bidirectional-sidecar.test.js` covers all four host/engine combinations,
both artifact engines, distinct planning/execution/review contracts, pending
questions, protected/traversal paths, replay, concurrent edits, account-backed
Claude fixture processes, missing CLI, authentication failure, invalid output,
nonzero exit, timeout and cancellation. Its workflow test uses the real
controller/resolver/guard, a fake external Claude CLI, durable artifacts and
completion transactions: Codex research-milestone advances to plan-slice
without changing host or repeating research.

Existing suites cover missing accounts, token confinement, protected state,
app-server protocol/permissions, multi-repo attribution, heartbeat, lifecycle,
leases, rendering and dispatch events. Installation dry-run verifies that both
hosts receive the new scripts, shared contract and schema. All provider tests
use isolated fixtures/mocks; no real account authentication, paid model call,
deployment or release was exercised. Install/synchronize the complete version,
not just the relaxed guard, before retrying a previously blocked workflow.

See [the executable host instructions](../shared/forge-bidirectional-sidecar.md)
for request bindings, lease heartbeat, polling, acknowledgement and recovery.
