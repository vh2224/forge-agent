# Bidirectional unit delivery

This contract takes precedence over the historical Codex-only Branch C/D for
**Claude sidecars**, and for artifact units on either engine. Native delivery
still uses the host's native agent tool. Neither model family nor a CLI's
presence grants delivery: `forge-dispatch-resolve` and the sidecar entrypoint
consult `forge-transport-capabilities.js` for the actual unit contract.

## Entry and delivery

1. Retain the unit selected by `forge-long-workflow-adapter`, its snapshot,
   workflow ID, begin transaction, owner and lease generation. Do not select
   again or acquire another lease. Run the normal risk, security, claim,
   verification and review gates. Sidecar support does not bypass these gates.
2. Resolve once using `forge-dispatch-resolve.js --unit-type ... --host-runtime
   <actual host> ... --json`. A false `dispatch_allowed` stops before launch.
   Preserve the entire route JSON, including model, tier, effort and chain.
3. Render the selected unit with `forge-prompt.js` using the existing context
   and pending-context bindings. Save the fully rendered prompt. For
   `execute-task`, retain its plan, security and context bundle bindings.
4. Allocate a result file **outside both CODE_DIR and WORKING_DIR**, in an
   operator-owned temporary directory. Keep it and its `.receipt.json` sibling
   until completion is acknowledged. Never reuse them for another attempt.
5. Write a UTF-8 JSON request file using the host's structured file tool or
   `JSON.stringify`, with these fields (values below describe the bindings):

   ```json
   {
     "route": "the full resolver object, not a string",
     "workflowId": "snapshot.workflow_id",
     "dispatchId": "the existing attempt dispatch ID",
     "unitType": "the selected unit type",
     "milestoneId": "the selected milestone",
     "sliceId": "the selected slice, omit when absent",
     "taskId": "the selected task, omit when absent",
     "cwd": "absolute CODE_DIR",
     "contextRoot": "absolute WORKING_DIR",
     "promptFile": "absolute rendered prompt path",
     "planFile": "absolute task plan, execution only",
     "securityFile": "security checklist, execution only",
     "contextFile": "context bundle, execution only",
     "resultFile": "absolute external result file",
     "constraints": { "auto_commit": false, "deploy": false }
   }
   ```

   Bind `constraints` from the operator's actual restrictions, including
   `auto_commit`; no sidecar may commit, push, deploy or release even if the
   parent is authorized to commit later. No account names, tokens, lease owner
   secrets or provider sessions belong in this request. For multi-repo execute,
   carry `writableRoots` from the existing CODE_DIR attribution contract.
6. Run `node "$FORGE_SCRIPTS_DIR/forge-unit-sidecar.js" --request "$REQUEST_FILE"`
   using the host's background process facility. Poll the result and retain the
   process handle. Use the existing orphan detector with the published real
   child PID, adapter PID, heartbeat interval and timestamp. Cancel the adapter
   on operator cancellation; SIGINT/SIGTERM terminate its owned provider tree.
   No visible helper window is needed on Windows.
   Keep the controller lease alive separately while polling via
   `forge-unit-lease.heartbeat(WORKING_DIR, unit.key, ownerToken, generation)`.
   Use the retained private generation from the begin transaction, never a
   public observation as authorization. A lease renewal refusal stops delivery
   and enters recovery; the provider heartbeat does not renew a workflow lease.

## Result and recovery

The adapter validates each unit's contract and persists the response before
publishing artifacts. Research has an artifact manifest, slice planning has
`slice_plan` + `task_plans` with structured `must_haves`, and execution has
`must_haves_status` plus VCS-derived changes. They are not interchangeable.
Read-only Claude turns expose only Read/Glob/Grep; no Bash, writing tools, MCP
servers, inherited hooks or skills. Codex uses the existing read-only app-server
profile. Artifact paths are derived by the parent, not accepted as arbitrary
worker destinations; links, traversal, duplicate paths and concurrent edits
are refused. STATE, leases, credentials and transaction records are never
worker artifacts. Completers return documents; the parent retains close-out,
verification, ledger, cleanup and authorized VCS operations.

On `done`, use the materialized artifacts and return the normal
`---GSD-WORKER-RESULT---` status/summary to post-unit housekeeping. On `partial`
or `blocked`, no artifact is published: collect `questions` through the native
interaction contract and preserve the existing pause/defer policy. Silence is
never an answer. Failure keeps the host and route intact and emits a named
`sidecar-unit` event; dispatch telemetry uses `forge-dispatch-event`.

If interrupted after a validated response was saved, rerun the **identical**
request: publication resumes without another provider invocation, accepting
only the original file content or the exact already-published content. An
interrupted attempt without a saved response refuses with
`sidecar-attempt-interrupted`: inspect its heartbeat/PIDs and use the existing
orphan/recovery and surgical-reset policy before a new attempt ID. Never
relaunch merely because the foreground tool timed out. Do not discard receipts
at compaction. The receipt is local workflow data, never a commit artifact.

### Claude result diagnostics and bounded recovery

`claude-invalid-result` remains the public rejection code. The result file,
failed receipt and `sidecar-unit` failure event additionally carry a versioned
`diagnostic`: a closed `stage`/`reason` vocabulary and, when a child ran,
`stdout_bytes`, `stderr_bytes`, `duration_ms` and `marker_count` when available.
These fields contain no output excerpts, parser exception text, artifact paths,
account names or environment values. See `scripts/forge-sidecar-diagnostic.js`
for the vocabulary. Do not log `classifyReturn().tail` or raw provider streams.
No raw-output capture is implemented, even on failure; introducing one requires
an explicit opt-in and private storage/retention contract, not a debug default.

The JSON envelope requires standalone start/end markers, an explicit status,
and one complete `result_json` object. Compact and multiline JSON are accepted;
newlines within JSON strings must still be escaped. Literal markers inside
artifact strings are data. The last framed block wins; a malformed final block
never falls back to an earlier success. Missing end markers, partial JSON and
status mismatches are rejected. Every recovered complete payload still passes
the full unit validator and output barrier before publication.

Artifact delivery allows at most 32 artifacts and 512 KiB UTF-8 per content.
Claude delivery additionally allows 900 KiB for the compact serialized result
JSON; this transport-specific cap is not imposed on Codex. The Claude stream separately
has a 1 MiB cap (including envelope/prose/pretty-print whitespace), for each of
stdout and stderr. These are independent limits; `artifact-limit`,
`payload-limit` and `output-limit` distinguish them. The prompt states the
budgets. When rendering without `promptFile`, supply `description` for research
and milestone planning; the renderer uses the resolved route's effort.

Recovery never spends another provider turn automatically:

- A receipt in `failed` records the sanitized failure. Repeating the identical
  request returns the recorded rejection, without another invocation or lease.
  `recovery: operator-required` means inspect the reason and fix the contract or
  external failure before an explicitly controlled new attempt of the same unit
  and route. Do not retry just because output was invalid or change engines.
- A receipt in `ready` retains the validated response, including after a
  publication error. `recovery: replay-publication` permits the identical request
  to finish publishing it. Existing target conflicts still require resolution;
  replay never overwrites an unrelated edit or duplicates a provider turn.
- A receipt in `started` has no durable response. It remains
  `sidecar-attempt-interrupted`; inspect the existing process/heartbeat and use
  the established recovery policy, never manufacture success from files.

`partial`/`blocked` are actual worker outcomes, not parser failures. Preserve
their questions and existing decision policy. Authentication, process exit,
timeout and output limits retain their distinct public codes. A detected token
in successful process output is rejected with `secret-output`; the token itself
is never included in diagnostics. A parser rejection is not evidence of an
authentication failure, truncation, or permission to fall back.

After post-unit housekeeping succeeds, call the loop adapter with
`--command complete`, the same snapshot/host/workflow/milestone/owner, and
`result: {status: "done", summary: ...}`. This commits completion through the
original begin transaction and releases its lease. Preserve the returned
snapshot; `action: continue` then permits `--command next`. Replaying the old
snapshot's completion uses the same transaction key. Do not reset the snapshot
to fabricate an idle workflow.

Fallback remains a parent decision under the canonical retry policy: recover
the failed attempt, resolve the next explicitly permitted chain member and emit
`worker-engine-fallback` before dispatch. This adapter never falls back. Missing
CLI/account, invalid authentication, invalid output and unsupported contracts
do not authorize a host or preference change.

## Supported contracts

Both Claude and Codex sidecars support research-milestone, research-slice,
discuss-milestone, discuss-slice, plan-milestone, plan-slice, execute-task,
complete-slice, complete-milestone and plan-check. Discussion remains
noninteractive: required questions return partial to the parent. Research uses
local file inspection; arbitrary research shell commands are unavailable in
the Claude read-only profile.

Review challenger, advocate and rebuttal use `forge-xllm.js --mode
challenge|defend|rebuttal --engine <resolved engine> --host-runtime <actual host>
--sidecar-declared`, retaining their distinct review schemas and pairing.
Cross-host `review-fix` and `memory-extract` have no unit delivery contract yet;
the guard returns `unsupported-sidecar-unit` for these specific auxiliary
operations. Follow the existing nonblocking review/memory failure policy;
never impersonate the missing worker or switch engines silently.

Install/synchronize the updated Forge sources on **both** hosts. Updating only
the guard or copying one adapter leaves stale skills and incomplete delivery.
