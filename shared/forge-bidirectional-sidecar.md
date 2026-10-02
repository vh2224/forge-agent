# Bidirectional unit delivery

This contract takes precedence over the historical Codex-only Branch C/D for
**Claude sidecars**, artifact units, and memory extraction on either engine. Native delivery
still uses the host's native agent tool. Neither model family nor a CLI's
presence grants delivery: `forge-dispatch-resolve` and the sidecar entrypoint
consult `forge-transport-capabilities.js` for the actual unit contract.

## Identidade do sidecar exibida na conversa

O timeout padrão é de 300 segundos (5min) por tentativa, vindo de
`scripts/forge-worker-timeout.js` e `workers.timeout`. Um valor explicitamente
configurado continua prevalecendo. O prazo é absoluto: heartbeat mostra que o
processo está vivo e nunca renova o timer. Erro explícito encerra a tentativa assim
que observado; ao vencer o prazo, exponha o reason de timeout e o resultado parcial,
sem continuar narrando apenas "aguardando resposta". Timeout não prova recusa do
provedor. Não reinicie silenciosamente uma tentativa temporizada; qualquer
fallback permitido deve expor a falha e a nova tentativa antes de dispará-la.

Antes de disparar um sidecar, anuncie fase/unidade, engine, modelo enviado, esforço e host da rota resolvida com o rótulo **solicitação do orquestrador — aguardando confirmação do adaptador**. Essa frase descreve a intenção do despacho.

Depois, leia o stderr completo do processo, inclusive em `run_in_background` pela ferramenta de saída do host. Reproduza literalmente, na conversa, cada linha que começa com `[forge-sidecar]`, incluindo `recusado`, `falhou` e `reaproveitado`. Se nenhuma linha aparecer, diga que falta prova do adaptador. Preserve `observado=nao-confirmado` e diga **modelo enviado**; não afirme que o provedor aplicou o modelo.

As linhas `[forge-sidecar]` registram identidade e estágio. A causa continua na linha `forge-xllm:` ou `forge-unit-sidecar:` e no result-file. Preserve ambos os canais. Nunca redirecione o stderr do comando de despacho para `/dev/null`. Se o stdout for capturado com `$(...)`, ainda leia e exponha as linhas de identidade do stderr.

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
   For `memory-extract`, use `sourceUnitId` for the real completed unit (a loose
   `T-...` task stays a task), include the source material and current owner-read
   memory snapshot, and set `publicationSafe:true` only with a
   `publicationBoundary` carrying `ownerJoined:true`, `checkedAt`, and every
   overlapping protected snapshot in `state:"ended"`. The worker never supplies
   identity, boundary evidence, or paths.
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

Memory uses the same versioned facts/events envelope for native and sidecar
workers. The receipt persists the validated response before the owner calls
`publishExtraction`; replay therefore republishes without another provider turn.
When `publicationSafe` is absent or false, the ready response stays durable and
publication reports `deferred`. Empty `done` reports `noop`; partial, blocked,
invalid and transport failures publish nothing. `quarantined` is a refusal, not
saved canonical memory. Provider success alone is not publication evidence.

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
`stdout_bytes`, `stderr_bytes`, `duration_ms`, `marker_count` and `model_count`
when available.
These fields contain no output excerpts, parser exception text, artifact paths,
account names or environment values. See `scripts/forge-sidecar-diagnostic.js`
for the vocabulary. Do not log `classifyReturn().tail` or raw provider streams.
No raw-output capture is implemented, even on failure; introducing one requires
an explicit opt-in and private storage/retention contract, not a debug default.

#### Claude CLI JSON transport and model identity

The Claude sidecar runs `claude -p --output-format json` with inline invocation
settings `{"disableAllHooks":true,"switchModelsOnFlag":false}` and
`--setting-sources ''`, which excludes the user, project and local settings
files. Managed policy settings are not one of those sources: they may still
apply and are not bypassed. No settings file is changed.
Account, environment allowlist, `shell:false`, tools, permissions, timeout,
heartbeats, cleanup and the 1 MiB per-stream cap are unchanged. A Claude
dispatch without `--model` is refused as `claude-model-required` before any
version probe, prompt file or spawn: without a requested id nothing can be
proved.

Stdout must be exactly one CLI result object: `type: "result"`,
`subtype: "success"`, `is_error: false`, a string `result` and a plain
`modelUsage` object. Text around it, concatenated, duplicated or truncated JSON
and duplicate member names are `json-invalid`; a run error (`is_error: true` or
an error `subtype`) is `result-error`; any other shape is
`result-envelope-invalid`. All are `claude-invalid-result` and never fall back
to an earlier object. With JSON stdout, authentication is decided only by
`api_error_status` 401/403 (`claude-auth-failed`); token counters are data. The
text heuristic still applies to stderr and to non-JSON stdout.

Order of checks: authentication, non-zero exit, raw credential in
stdout/stderr, empty output, envelope, credential in any decoded string or
property name of the object (Unicode escapes included), model identity, the
worker-result block (unchanged framed parser and unit validator), credential in
the decoded candidate. The decoded walk is iterative and bounded; exceeding the
bound is refused (`payload-limit`).

Identity is admitted only when `modelUsage` has exactly one well-formed key
byte-identical to `--model`. Then `model_observed` is that id and
`model_observed_source` is `claude-json-modelUsage`; `effort_applied` stays
`null` because nothing reads it back. Otherwise the unit validator is never
called:

- `claude-model-substituted`: one valid key naming a clearly different model
  while a full id was requested. The diagnostic (`stage: identity`) carries
  `model_count` and that validated `model_observed`.
- `claude-model-unverified`: absent, empty, malformed or several keys
  (including an auxiliary Haiku), another date, a `[1m]` suffix, a requested
  alias, or a neighbouring version of the same family. No equivalence is
  inferred and no unproven id is persisted.

`switchModelsOnFlag:false` only disables the classifier-driven model switch. A
fallback for availability is not prevented by any setting; it is detected
after the turn through `modelUsage`. Detection is therefore post-turn: a
refused identity never reaches acceptance, a ready receipt, a commit or
publication, but the worker may already have edited files. Nothing is reset or
retried automatically and no other model or engine is tried. In review-fix the
tree, including new files, is preserved with `recovery: operator-required`, the
items are deferred and `error_class` is `terminal`; other units end in a
`failed` receipt without artifacts. A write worker with Bash may also use an
auxiliary model internally; that reports a second `modelUsage` key and is
refused by design as unverified. This is not a universal pre-turn guarantee.

The observation reaches the execute, fix and plan result-files, the
challenge/defense/rebuttal JSON (engine `claude` only; codex and agy output is
unchanged) and the ready receipts of artifacts, memory and fix, and survives
their replay without a new provider turn.

The worker-result block inside `result` requires standalone start/end markers,
an explicit status, and one complete `result_json` object. Compact and multiline JSON are accepted;
newlines within JSON strings must still be escaped. Literal markers inside
artifact strings are data. The last framed block wins; a malformed final block
never falls back to an earlier success. Missing end markers, partial JSON and
status mismatches are rejected. Every recovered complete payload still passes
the full unit validator and output barrier before publication.

Artifact delivery allows at most 32 artifacts and 512 KiB UTF-8 per content.
Claude delivery additionally allows 900 KiB for the compact serialized result
JSON; this transport-specific cap is not imposed on Codex. The Claude stream separately
has a 1 MiB cap (including the CLI JSON object, its string escaping,
prose and pretty-print whitespace), for each of stdout and stderr; a stream that
escaping pushes over it fails as `output-limit`, never truncated. These are independent limits; `artifact-limit`,
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
timeout, output limits and the three `claude-model-*` identity codes retain
their distinct public codes. A detected token
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
complete-slice, complete-milestone, plan-check and memory-extract. Discussion remains
noninteractive: required questions return partial to the parent. Research uses
local file inspection; arbitrary research shell commands are unavailable in
the Claude read-only profile.

Review challenger, advocate and rebuttal use `forge-xllm.js --mode
challenge|defend|rebuttal --engine <resolved engine> --host-runtime <actual host>
--sidecar-declared`, retaining their distinct review schemas and pairing.
Sidecar `review-fix` is supported for engines claude and codex through the
scoped `fix` contract (`UNIT_MODES['review-fix'] = 'fix'`, never an alias of
execute): no plan, SUMMARY or checkbox exists. The request carries
`reviewFix: {boundary: slice|task|milestone-triage, decision: "proceed", items,
claimPaths}`, `cwd` (CODE_DIR), `contextRoot`, `writableRoots` (multi-repo
attribution), a `resultFile` outside both roots and the operator's
`constraints.auto_commit`. The adapter re-derives the claim and refuses a
divergent one (`review-fix-claim-mismatch`), refuses claim targets that resolve
through links or outside CODE_DIR, snapshots the REVIEW.md files and the
surgical-reset state, then writes the `started` receipt and runs
`forge-xllm.runFix` (the execute safety core). A failure after the snapshot is
reset surgically (pre-dirty overlap → nothing reset, `operator-required`) and
the items are deferred. Success writes a `ready` receipt (`kind: review-fix`,
identity, verified-file hashes) **before** any commit or REVIEW.md write; the
parent then commits only in git with `auto_commit:true` (exactly the verified
paths, `Forge-Dispatch-Id` trailer, reconciliation checked against paths and
hashes) and publishes per-R# lines idempotently. Replay of `ready` never calls a
provider; a concurrent change of the verified files or of the REVIEW.md refuses
publication (`review-fix-concurrent-change` / `review-fix-review-conflict`).
**Limits:** the per-root sandbox is not a per-file fence — scope is guaranteed
by pre-spawn checks plus post-run detection and surgical reset, not by
preventing transient writes. agy (and any unknown engine) keeps
`unsupported-sidecar-unit` before spawn. Memory extraction is read-only inference followed
by owner publication through the canonical fragment transaction. Missing auth,
unsupported native model/effort, invalid output and publication failures remain
nonblocking for the completed source unit and never switch engines silently.

Install/synchronize the updated Forge sources on **both** hosts. Updating only
the guard or copying one adapter leaves stale skills and incomplete delivery.
