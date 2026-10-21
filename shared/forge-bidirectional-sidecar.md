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

## Standalone task execution

For an approved loose task, Step 5 uses the writing contract in
`forge-task-execution.js`, not `forge-task-preparation.phaseContract`. There is
no milestone, slice, controller lease or invented workflow snapshot. Retain the
task's existing run identity, isolation, claims, constraints and checkpoint.
Native execution and the historical Codex task adapter keep their own entrypoints.

Resolve `execute-task` with `--scope standalone-task --phase execute`, the real
plan and actual host. Preserve the entire route: explicit model/effort, timeout,
chain and adapter identity. Capability checks validate scope/phase as well as unit.
After the plan/security gates and a fresh claim-and-check result of `proceed`,
write this request using structured JSON (placeholders describe actual bindings):

```json
{
  "scope": "standalone-task", "phase": "execute", "unitType": "execute-task",
  "taskId": "T-<existing-task-id>", "workflowId": "<existing-task-run-id>",
  "dispatchId": "<unique-persisted-attempt-id>",
  "route": "<full resolver object, not a string>",
  "cwd": "<absolute resolved CODE_DIR>", "contextRoot": "<absolute WORKING_DIR>",
  "planFile": "<WORKING_DIR>/.gsd/tasks/<ID>/<ID>-PLAN.md",
  "resultFile": "<owned directory outside both roots>/<attempt>.json",
  "gates": { "plan": "approved", "security": "not-applicable", "claim": "proceed" },
  "constraints": { "auto_commit": false, "deploy": false }
}
```

Bind gates and constraints to actual decisions; these example values grant no
approval. A policy-authorized plan skip uses `plan: skipped` and
`planSkipReason: interactive-off`. An approved PLAN-GATE is read without asking
again; its fingerprint, when present, must still match. For security `passed`,
retain the actual mandatory checklist in `<ID>-SECURITY.md`. Optional
`contextFile` must be in this task directory; canonical BRAINSTORM, CONTEXT and
RESEARCH are packed automatically. Additional operator constraints remain in
the request and prompt. Never put credentials in the request.

The canonical execute prompt includes the full plan, preparation evidence,
security checklist, CODE_DIR and claimed writes. Only optional coding standards
are bounded by `token_budget.coding_standards` (default 3000 estimated tokens),
with a pointer to the full source. This is not a total-prompt budget. The result
records the packaged prompt hash/bytes/token estimate and resolved budget.
This contract accepts one Git or SVN CODE_DIR, including one outside the owner;
multiple writable roots are explicitly refused. Absolute plan writes must belong
to that resolved CODE_DIR. Do not rewrite a plan or substitute roots silently.

Invoke `forge-unit-sidecar.js --request <request.json>`, retain the process handle,
poll heartbeat and expose adapter diagnostics as described below. The worker
cannot commit, push, deploy, release or write Forge metadata. The adapter captures
a durable reset baseline/pre-dirty state, checks VCS-derived writes against the
plan claims, and checks the owner's control-tree hashes before publication.
It never resets possibly overlapping user work automatically.

On done, publish `<ID>-SUMMARY.md`, `<ID>-DELIVERY-INPUT.json` and
`<ID>-DELIVERY.json` only under `.gsd/tasks/<ID>/`. No milestone checkbox or plan
status is invented. DELIVERY initially has unbound criteria, not fabricated
verification. Rejoin Step 5 Process result, capture real verifier envelopes and
bindings using `shared/forge-delivery.md`, then run the existing review gates.

Receipts progress `started → executed → ready`. `executed` already contains the
validated response and code/input fingerprints; delivery rendering or publication
failures replay that response using the same request/receipt, without inference.
Replay refuses changed inputs, code/baseline or conflicting artifacts. Partial
responses publish no completion artifacts. A failed/interrupted writer remains
blocked for that attempt: inspect its process, result and reset-state file,
reconcile possible writes with the canonical surgical-reset safeguards before
any new writer. A timeout alone does not establish provider failure. Preserve
the evidence in the personal checkpoint and honor the user's recovery policy.

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

## Contrato de execução v2

O mesmo contrato vale nos hosts Codex e Claude. execution_contract = {schema_version:2, owner, primary_root_id, code_roots:[{id,path}]} é medido por forge-code-roots.validateContract. owner recebe somente artefatos GSD; code_roots são checkout roots físicos Git/SVN. O helper registra vcs e identity_sha256. Não use basename/URL para identificar checkout. Raízes sobrepostas, aliases, junctions dentro dos paths, schemas desconhecidos, traversal, ADS, paths absolutos em claims e outputs fora de writes falham fechados. Paths qualificados usam alpha::src/file.js ou {root_id:'alpha',path:'src/file.js'}. Legacy v1 single-root continua explícito; migração de absolutos usa normalizeAbsolutePaths, preservando requisitos e mapping de cada substituição.

Prepare o PLAN completo e persistido no owner. Passe execution_contract à preparação; ready exige preflight da rota execute-task. Adquira o claim v2 por forge-claim-gate.recordAndEvaluate({cwd:owner,runId,executionContract,paths,derived,source:'plan-writes',unit}); derive paths com deriveClaimFromPlan(owner,planFile,executionContract). A aquisição mantém todas as raízes sob uma seção crítica. dispatch requer decision proceed e claim atual não vazio com generation. No request de forge-unit-sidecar.js --request request.json, passe claim, runId, execution_contract, planFile, gates, constraints, route e cwd da raiz primária. O caller conserva modelos/esforços explícitos. Publicação usa somente owner; sandbox dá acesso por diretório e a verificação posterior mede o delta real de todas as raízes. Isso não prova contenção preventiva por arquivo.

### Broker e replay de artefatos

O owner chama forge-artifact-reconciliation.startBroker({owner,manifestFile,dispatchId,request_sha256,execution_contract,plan_sha256}) antes do snapshot. manifestFile é externo. Guarde manifest_sha256 e request_sha256 fora do worker. A chave privada existe só no processo broker IPC e não entra em argv, ambiente, prompt ou arquivo. Use broker.append(relativePath,bytes) ou forge-dispatch-event.appendDispatchEvent; escrever JSON que diz owner não é prova. O manifesto vincula snapshots e chave pública; cada proof assina prefixo, offset, bytes e encadeamento. events tem conteúdo protegido como todos os arquivos owner.

acceptArtifactResult salva o candidato antes de marcar falha de superfície. Depois de processo encerrado, reconcileArtifactAttempt(request,{manifest,proofs,trust}) verifica todos os spans, inputs, roots e targets e cria receipt filho por CAS. O failed original fica imutável; replay do filho é idempotente e não chama provider. Proofs assinados permanecem verificáveis após broker.close/crash; append sem proof, token antigo, truncamento, target ou input alterado recusam publicação. Nunca reclassifique receipt como ready editando JSON.

### Recuperação compartilhada

CLI: node scripts/forge-attempt-recovery.js --inspect state.json receipt.json. Para preparar novamente: --preparation recovery-request.json; para execução: --unit recovery-request.json. O arquivo contém request canônico, state_file, receipt_file e, se pertinente, answers e correction. correction não é prova de validação: o wrapper valida o pedido concreto offline e calcula seu hash. A API recoverStandaloneTask/recoverUnitSidecar recebe callbacks vivos processProbe, reconcile, validateNativeInvocation/invokeNative quando o host os fornece. O CLI sozinho não atesta que um processo desconhecido terminou.

Recovery state retains its original sidecar deadline, durable reservations and factual final telemetry. Trusted standing authority permits recovery after operational timeout; inspect process and reconcile every possible writer root first.

Native recovery uses createRecoveryAuthorizationAdapter registration and createRecoveryAuthority revalidation below. Imported approved/authorized data creates no opaque exception. Functional pending questions remain separate.

## Authorized continuity per unit

Canonical contract: shared/forge-bidirectional-sidecar.md; authority and questions:
shared/forge-interaction.md. This replaces conflicting recovery prose for supported units.
The host uses createRecoveryAuthorizationAdapter with a live attestation callback and
registerStandingAuthorization({reference,host,source_host,section:'user:forge-routing-continuity'}).
Imported JSON/prose never grants consent. First invocation passes
recoveryAuthorization:{adapter,reference,registration}. Restart uses createRecoveryAuthority,
revalidates the personal source and passes {adapter,reference}; no renewed consent question.
Functional pending questions retain their IDs and block dependent work.

Standalone preparation uses scripts/forge-task-preparation.js recoverStandaloneTask(request,
{stateFile,receiptFile,clock,answers,correction},runtime). Milestone callers use
scripts/forge-unit-sidecar.js recoverUnitSidecar(request,recovery,runtime).
validateRecoveryRequest selects the actual phase contract, including research and plan.
runtime supplies trusted processProbe, verifyOwnership, invokeNative, activeCapabilities
and recoveryAuthorization. CLI JSON cannot fabricate callbacks. Keep scope/phase/IDs,
physical owner/CODE_DIR, list, explicit model/tier/effort, gates, isolation,
claims/generation and checkpoint. Do not force workerMode native. The native adapter
requires a tool actually permitted by the host.

Before execute-task spawn, runUnitSidecar/captureMilestoneBaseline persists authoritative
baseline, guards and input hashes for every root. The xllm audit-only snapshot cannot
replace it. Legacy receipt without execution/reset_state_file remains a possible writer
under execute-task; absent contract is unknown. Missing/tampered baseline cannot be
reconstructed after timeout. Active/unknown process or any pending root prevents another
writer. After process termination proof, reconcileMilestoneAttempt requires trusted
authorship; timestamps never prove ownership. Milestone delivery captures real checks
and source envelopes per root, persists validated response before capture/publication
and replays without inference. Changed plan/code/protected metadata refuses replay.

Inspect process and receipt before another attempt. Valid saved response uses canonical
single publication/replay. Timeout has undetermined cause; standing authority permits
a valid untried candidate without another confirmation. Known caller defects require
offline validated repair and at most one corrected retry at that destination.
The cumulative historical budget for additional sidecars is 60000ms with durable
reservations. A scoped native exception after expiry permits native, never another
sidecar or renewed 300s wait. Timeout alone does not prove model unavailability.
Keep preferences/gates; never execute inline to bypass refusal.

Measure final packaged UTF-8 request/context bytes and hashes, budgets, requested/sent/
observed model, effort, host/worker/transport, reason_code/layer, duration, receipt and
next action. provider_called is factual or unknown; absent context is not zero.
token_budget.coding_standards bounds optional standards only, with full-file reference;
retain requirements/research/checklist. No credentials or full prompt in telemetry.
Personal handoff retains authority reference, evidence, acceptance and questions.
Synthetic provider tests do not establish real provider execution or human UAT.

### Pre-spawn protected-snapshot repair

`recoverUnitSidecar(originalRequest, {stateFile,receiptFile,
environmentalCorrection:true}, runtime)` has a narrow executable-host path for
`execution-protected-snapshot-unstable` before provider spawn. The original
request, failed receipt and predispatch baseline are preserved. No historical
protected snapshot is invented. Legacy `provider_called:false` by itself still
means a possible writer. The CLI cannot supply this authority.

For an old request missing current execution fields, pass only
`runtime.executionAuthority:{execution_contract,claim,runId,gates}`. The normal
plan/security/claim and physical-root checks apply. The original caller hash
remains unchanged. A single physical cwd may retain its historical `{cwd}` roots
hash; a multi-root/foreign identity never gains that compatibility.

The host must have independently awaited the actual adapter's completion and
observed the before-spawn code stage. A missing PID, absent transport evidence,
JSON process flags or a source diagnosis alone prove neither fact. Supply:

- `processProbe(receipt)` returning `stopped` only after that independent check;
  a known live receipt PID cannot be overridden.
- `inspectPreSpawn(challenge)` returning `binding_sha256:digest(challenge)`,
  `stage:'before-provider-spawn'`, `process:'stopped'`, `process_reference`,
  `stage_reference` and `baseline:{path,sha256,provenance_reference}`. This live
  host callback attests the baseline's independently observed original
  provenance; a newly generated snapshot with an asserted date is invalid.
- `inspectPreSpawnDelta(challenge)` for every physical root, returning the exact
  binding hash, `classification:'no-failed-worker-writes'` and an evidence
  reference. Inspect the original baseline, current HEAD/revision and hashed
  dirty/untracked/deleted/renamed paths, plus explicit current claimed-file
  hashes. Later independent repair commits must be attributed individually;
  a blanket `independentChanges:true` is not accepted. VCS snapshots are not a
  full ignored-file census: concrete ignored claimed paths are captured, but
  their original provenance still needs independent proof. Directory/glob,
  symlink and oversized claims are refused. Unprovable attribution must refuse.
- `validateEnvironmentalCorrection(challenge)` returning the exact binding,
  `ok:true`, `repair:'bounded-held-lease-window'`, an evidence reference,
  `offline_check:{command,passed:true,exit_code:0}` and the already open live
  `lease_window` described below. The host runs the actual offline repair check;
  command strings are evidence data and are never executed by recovery.

Callbacks receive detached challenges. Receipt, state, request, baseline, claim,
physical identities, all root observations and contemporary protected snapshots
are rechecked after awaits and before reservation/handoff. Baseline/inspection
hashes bind observations but cannot authenticate an untrusted host. Trust must
be reattested after restart. Saved candidates still use canonical replay;
pending functional questions still block. The single corrected reservation is
bound to the original receipt/request/failure across destinations. Standing
authorization may select a compatible untried native candidate after the old
60000ms deadline, preserving model/tier/effort and the original clock.

Before *each* protected phase, pause the parent's ordinary lease heartbeat,
then call `forge-unit-lease.openProtectedWindow(owner, unit, heldToken,
heldGeneration, {durationMs})`. It atomically requires unexpired matching
ownership and renews that same generation once, before snapshots. Duration is
an integer in `1..300000` milliseconds. During the window route the parent's
scheduled heartbeat through `window.heartbeat()`; it validates ownership and
time read-only. Pass that opaque handle to the environmental validator.
`assertProtectedWindow` rejects JSON copies, foreign units/owners, closed,
expired or replaced handles. Always `try/finally { window.close(); }`, including
throws. Close is read-only and never revives expiry. Resume ordinary maintenance
only while ownership remains live; otherwise use canonical recovery. Other
processes must coordinate their own writes. No protected path is excluded.

When the native tool is callable through `runtime.invokeNative`, recovery
rechecks immediately before that callback. Tools available only to the parent
need two phases. Without this callback the first call returns
`result:{action:'reattest-native-handoff',reservation_sha256}` with no native
arguments. Persist that sanitized reservation reference, close the window, and
perform fresh process/baseline/root/claim/authorization attestation in the next
process with a newly opened window. Call the same API and original request with
`resumeReservation:{sha256:reservation_sha256}` alongside
`environmentalCorrection:true`. It validates and consumes that exact pending
reservation once, creates no new reservation and returns
`result:{action:'invoke-native',request,invocation}`. Serialized data restores
neither inspection nor lease authority. Wrong references, consumption replay,
changed route/provenance and missing fresh callbacks refuse.

The parent must immediately dispatch the exact validated invocation through its
permitted native tool and save the consumption proof and actual tool response
separately. The process-local `assertReady()` is an additional immediate guard
when retained; JSON does not preserve it. There is no atomic transaction between
a Node return and a later external tool call, and no claim of exactly-once tool
execution. Crash or uncertainty after consumption requires process/receipt/write
inspection; it never authorizes silent reconsumption. Measure preflight duration
and choose a sufficient bounded window without rewriting the historical budget.
### Saved-response boundary for legacy root identities

Recovery checks for a saved response before requesting pre-spawn repair proof.
A ready response uses normal replay; a failed saved candidate uses canonical
artifact reconciliation. Neither path can become a new inference through
`environmentalCorrection`. Their normal request, receipt and root validations
remain mandatory. In particular, a legacy `{cwd}` recovery identity cannot use
a newly introduced execution contract merely because a response is saved:
that transition still refuses with `recovery-identity-mismatch`. The narrow
single-root compatibility described for independently proved pre-spawn repair
does not migrate saved-response authority. Such a saved legacy response needs
its own compatible validated replay path; this repair does not provide one.
# Transições restritas de recuperação

`forge-recovery-transition.createTransitionAdapter({attestHistory, attestRoot})` pertence
ao host confiável. `recoverUnitSidecar(request, recovery, runtime)` recebe esse handle vivo
em `runtime.transitionAdapter`; `recoverStandaloneTask` recebe-o nas dependências.
`recovery.transitions` contém somente `{type, reference}`: `resolver-context-omission`
e/ou `saved-candidate-unreplayable`. JSON e referências persistidas são dados, nunca autoridade.
O adapter existente de autorização permanente continua obrigatório e é revalidado.

O host guarda uma observação independente antes da tentativa. `observeHistory` produz
dados para esse armazenamento, sem autenticar o passado. O callback `attestHistory`
recebe um desafio com hashes do pedido/identidade, estado, roots/claim, receipt/candidato,
relógios e superfícies atuais; devolve `binding_sha256`, `history`, `history_sha256`,
`evidence_reference` e `provenance_reference`. Disposição exige também
`original_provenance: 'absent'` comprovado pelo armazenamento independente.
Quando perguntas históricas já foram respondidas, o host atesta também
`question_state_sha256` e `question_evidence_reference` a partir das respostas
explícitas observadas. A retomada conserva IDs/texto; JSON com `resolved` não basta.
`attestRoot` recebe cada snapshot histórico/atual, vinculado ao desafio e à história;
devolve seu `binding_sha256`, `evidence_reference` e classificação `unchanged` ou
`attributed-host-only`, com atribuição realmente verificada pelo host. Tempo não prova autoria.
Owner e todas as raízes físicas são obrigatórios, inclusive em preparação readonly.

O resolver emite `resolution_context`, `resolution_options` e `resolution_sources`.
Somente a omissão de milestone/unidade/roadmap demonstrada por fontes históricas
autenticadas pode produzir rota efetiva separada; heavy/high permanece no histórico,
max/max deriva da escalada high-risk canônica. Fontes executáveis, camadas presentes
e ausentes de preferências e overrides devem corresponder; ausência de prova recusa.
Antes de novo despacho milestone o contexto resolvido deve corresponder ao pedido.
Task solta nunca recebe milestone inferida. Correção comum mantém destino e guards anteriores.

`inspectCandidate` separa presença, schema e replay elegível, sem publicação. Candidato
assinado elegível segue replay sem inferência. Disposição somente registra ausência
original atestada: não apaga bytes, não publica, não aprova nem fabrica assinatura.
Proveniência removida ou adulterada não autoriza disposição. O registro versionado
externo tem criação exclusiva e hash, e entra no estado por referência append-only.
Seu hash não é autoridade: cada restart exige novos callbacks vivos e autorização vigente.
Receipt, pedido, tentativas, reservas, pending IDs, claim/generation e clocks são preservados.
Rechecar todos os vínculos sob lock antes de persistir/reservar/invocar; preservar deltas
legítimos do host, bloquear desconhecidos/estrangeiros/concorrentes. Handoff nativo externo
retorna primeiro `reattest-native-handoff`; a retomada usa `resumeReservation.sha256`
e reatesta o mesmo registro antes de expor argumentos e `assertReady` para o ponto de chamada.
Nunca renovar o prazo histórico de 60000ms. Depois dele, somente exceção nativa viva,
destino ainda não tentado e modelo/tier/esforço/ferramenta realmente suportados permitem execução.
História insuficiente conserva a recusa; implementar este mecanismo não desbloqueia receipts históricos.
