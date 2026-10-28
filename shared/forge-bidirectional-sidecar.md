# Bidirectional unit delivery

This contract takes precedence over the historical Codex-only Branch C/D for
**Claude sidecars**, artifact units, and memory extraction on either engine. Native delivery
still uses the host's native agent tool. Neither model family nor a CLI's
presence grants delivery: `forge-dispatch-resolve` and the sidecar entrypoint
consult `forge-transport-capabilities.js` for the actual unit contract.

## Identidade do sidecar exibida na conversa

A liveness é a autoridade primária de kill: o worker que fica sem sinal além do
limiar (60/120/240 s) é encerrado como falha de vida. Acima dela existe só um teto
de segurança por tentativa, resolvido por
`scripts/forge-worker-timeout.js resolveWorkerCeiling` com fonte rastreável
(`workers_timeout_source`): sem `workers.timeout`, vale o teto do tier da rota
(light/standard/heavy/max = 900/1800/3600/5400 s, fonte `tier-default`); um valor
explícito 1..86400 sobrescreve (`explicit`); o legado 300 é ignorado com aviso
(`legacy-300-ignored`) e vale o teto do tier. Heartbeat não renova o teto. Erro
explícito encerra a tentativa assim que observado. O teto alcançado com o stream
ainda ativo encerra com `reason_code: budget-exceeded-while-active` (classe
`active-budget`, não é falha do destino e não avança a cadeia); alcançado ainda em
partida, continua `claude-timeout`. Em qualquer caso, exponha o reason e o
resultado parcial, sem continuar narrando apenas "aguardando resposta". Timeout não prova recusa do
provedor. Não reinicie silenciosamente uma tentativa temporizada; qualquer
fallback permitido deve expor a falha e a nova tentativa antes de dispará-la.

A persistência de sessão do Claude é opt-in: só plan/execute, pelo dono da unidade via
`runUnitSidecar`, recebem `--session-id` (UUID gerado pelo Forge); as demais fases
mantêm `--no-session-persistence`. Com o teto `budget-exceeded-while-active`, a recovery
faz no máximo um `--resume` da mesma sessão, depois da inspeção e da reconciliação das
escritas (o worker é avisado de que o workspace voltou ao baseline); o receipt novo leva
`resumed_from` e só `session_sha256`. Sem sessão: `budget-exceeded-resume-unavailable`;
segundo teto: `budget-exceeded-resume-exhausted`. Ao concluir, o Forge remove a sessão
(`scripts/forge-claude-session.js`): alvos exatos sob `<home>/.claude`
(`projects/<key>/<id>.jsonl`, `projects/<key>/<id>/`, `session-env/<id>/`,
`file-history/<id>/`), sem seguir symlink; falha vira o evento
`claude-session-cleanup-failed`. Limitação: se o processo pai morrer, a sessão fica órfã
até a próxima recovery da unidade; a varredura periódica fica para a S09.

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

#### Claude CLI structured stream, identity and safe progress

For an explicitly authorized headless writer, the owner may set
`claudePermissions: 'verification'` in the request **before** fingerprinting and
dispatch. This opt-in is accepted only for Claude execute/review-fix with an
execution contract. The adapter resolves the canonical verification seal
(plan, preferences, supplements and legitimate discovery), then binds its exact
commands, provenance, timeout, physical root and request identity to the
invocation. Missing/invalid contracts or unsupported commands refuse before
inference; they are caller setup failures, not model unavailability.

The initial supported permission grammar is `node [--check] relative-file.js`
(also `.cjs` and `.mjs`), with portable unquoted paths and exactly one code root.
Quotes, spaces inside paths, backslashes, absolute paths, traversal, protected
paths, symlink ancestors, shell operators, wildcards, extra arguments and other
executables are refused. Each exact `Bash(command)` rule is a separate argv
entry; no wildcard/prefix permission is introduced. This permits execution of
the declared script, not a filesystem sandbox. Existing claims, protected
metadata, delta verification and reset remain mandatory.

Absent opt-in preserves the previous invocation without granting Bash. Read-only
workers retain only Read/Glob/Grep. Writers retain `acceptEdits`, invocation-only
settings and managed deny/ask precedence; no global preferences or bypass mode
are changed. CLI version and policy digest are recorded, while managed-policy
visibility remains unknown. Argv fixture tests do not prove real CLI permission
acceptance or override a managed denial.

Persisted sessions bind a separate semantic permission digest containing the
seal scope (policy version, root identity, plan, commands/origins and timeout),
excluding only the attempt identity. A successor must supply a newly bound
request with the same scope. Changed permission scope, removing the opt-in, or
adding it to a legacy session without a digest is refused before inference.
Review-fix retains its existing no-session contract.

Permission syntax/precedence source:
https://code.claude.com/docs/en/permissions . Locally inspected CLI: 2.1.310.

Claude uses `-p --output-format stream-json --verbose --include-partial-messages`
and `--json-schema` from `forge-worker-result-contract.js`. The same per-unit
contract renders the instruction and validates the candidate locally: only
`done`, `partial` and `blocked` are valid, with no extra properties. Claude takes
its candidate exclusively from the unique successful terminal `structured_output`.
A JSON string in `result`, framed text, partial envelopes and a `complete` alias
cannot supply a candidate. Native transports retain explicit framed delivery and
local validation; their instructions do not claim provider schema enforcement.

Invocation retains the explicit model/effort, account/environment allowlist,
`shell:false`, readonly/writer permissions, absolute deadline and owned cleanup.
Inline settings disable hooks and flag-based model switching, with empty setting
sources; managed policy can still apply. No settings file is modified. Missing
model is refused before any probe or spawn. Identity requires exactly one valid
`modelUsage` key byte-identical to the requested model. Aliases, several keys,
context suffixes and nearby versions are not inferred equivalent. Substitution
is detected after the turn and cannot publish; possible writes still require
canonical reconciliation. `effort_applied` remains unknown without readback.

`forge-claude-stream.js` incrementally consumes fatal UTF-8 NDJSON, including
fragmented code points, LF/CRLF and an EOF without newline. It refuses malformed
or duplicate decoded keys, duplicate terminals, any event after terminal, and
structured fatal errors immediately. Acceptance still requires process close,
exit zero, exact model identity and unit validation. Stderr words such as
"timeout" are not fatal structured evidence. Limits are 1 MiB per line/terminal,
16 MiB stdout, 1 MiB stderr, 100000 events, depth 128, 100000 decoded nodes per
event, 32 active blocks and 1 MiB retained reconstruction. Over-limit chunks are
refused before concatenation. Raw and decoded credential checks cover unknown
events, property names, Unicode escapes, fragmented text and tool-input JSON.
Raw streams, prompts, tool/session identifiers and environment values are never
persisted. Artifact limits remain independent (32 artifacts, 512 KiB per content,
900 KiB compact Claude payload).

Progress is a closed sanitized snapshot: local start, validated remote activity,
terminal candidate, process close and verification remain distinct. Spawn, PID,
bytes, init/ping and local tool timing do not prove remote activity. Only owned
assistant message starts and deltas update remote timing. Tool spans suspend gap
measurement until remote output resumes. Unknown usage is `null`, observed zero
is `0`; token counts are nonnegative safe integers. `remote_source` identifies
CLI protocol evidence, `usage_source` identifies CLI usage, and `cost_source`
marks the nonnegative CLI estimate in USD. Denials have fixed read/write/shell/other counters. Progress
is emitted immediately, on milestones and every 15 seconds through an optional
observer (CLI: one bounded JSON line on stderr). Observer exceptions are ignored.
The same projection survives success, failure, receipts and replay. Requesting
termination or receiving a kill-promise rejection is never process-exit evidence.

#### Prova local de vida e detector de loop

Enquanto uma tool está em execução (`gap_suspended`), o watchdog do sidecar
Claude decide com uma prova local fechada em dois eixos, sem texto do provedor:
`capability` (`available` | `unavailable`: a plataforma conseguiu medir?) e
`proof` (`positive` | `negative` | `none`). A forma booleana da S01
(`available`/`proven`) continua aceita e é mapeada para `capability` e
`positive`/`none`. Forma inválida vira `unavailable`/`none`, nunca exceção no tick.

`forge-sidecar-local-proof.js` compõe a prova a partir do PID do filho, da CPU
da árvore de processos e de uma impressão de metadados do sistema de arquivos.
PID morto produz `available`/`negative`. PID vivo com delta de CPU de pelo menos
50 ms, ou com mudança de arquivo, produz `positive`. Sem CPU mensurável
(win32 hoje, ou sem provedor), a capability é `unavailable`. A amostragem roda a
cada 15 s num timer próprio, com uma amostra inicial. O tick do watchdog só lê o
cache. Uma prova `positive` vale 30 s (duas cadências) e depois degrada para
`none`. `negative` não expira.

As raízes medidas são o `cwd` e as `writableRoots` (nenhuma em `readOnly`).
Ficam fora da impressão `.git/`, `.gsd/forge/` de cada raiz e os prefixos de
`localProofIgnore`. O owner (`forge-unit-sidecar.js`) passa o result file e o
receipt da unidade, o que cobre também `.reset-state.json`. A escrita do próprio
canal de resultado nunca conta como progresso.

Regras de silêncio de tool (base `deadMs` 240000, extensão 420000):

- Prova `positive`: a tool continua viva até 660000 ms de silêncio. Depois disso
  morre com `tool-extension-exhausted`.
- Prova indisponível (`unavailable`/`none`: win32 sem CPU, ou sem provedor):
  **não mata aos 240000**. Fica `slow-suspect`/`proof-unavailable` e morre aos
  660000 com `tool-proof-unavailable-expired` (`dead-silence`), não no teto do
  tier. São as decisões do operador de 2026-10-23.
- PID morto (`negative`): morre aos 240000 com `tool-proof-negative`.
- Linux/macOS com medição disponível e sem prova (`available`/`none`): morrem aos
  240000 com `tool-unproven`, salvo extensão conquistada na mesma janela.
- Extensão conquistada (#205): uma prova `available`/`positive` medida dentro da
  janela suspensa atual conquista a extensão para esse episódio. O tracker do
  spawn (`createTracker`) é o dono desse estado. A primeira amostra vista na
  janela é só linha de base, e a primeira amostra nova ainda mede um intervalo
  que atravessa a abertura. Por isso só uma `positive` a partir da segunda
  amostra nova conquista. Amostras ociosas (`available`/`none`) do mesmo
  episódio conservam a extensão até 660000 ms de silêncio. Depois disso a tool
  morre com `tool-extension-exhausted`. Acima de 240000 o estado é
  `slow-suspect`/`tool-extended`. A prova publicada continua sendo a amostra
  real (`none`), nunca `local-proof`. O episódio é o `suspension_epoch` do
  reducer mais a âncora `last_remote_ms`. A extensão zera quando a janela fecha,
  quando o epoch ou a âncora mudam, ou quando ficam ausentes ou inválidos, e
  também em todo spawn novo. Assim, outra janela, tool paralela fora da janela,
  sessão, replay ou retry nunca herdam a extensão. Uma `negative` prevalece e
  revoga a extensão até o fim do episódio, sem antecipar o prazo de 240000. O teto
  do tier também prevalece. O backstop de tempo real classifica pelo mesmo
  tracker (`assess`, sem commit), então watchdog e backstop concordam. Uma tool
  `available`/`none` que nunca teve `positive` medida na janela continua morrendo
  após 240000. Os números são os defaults: com política resolvida diferente, os
  limites são `deadMs` e `deadMs + toolExtensionMs`. A regra é de política,
  verificada com relógio e leitores injetados. Não há medição de campo sobre
  quantas tools ela salva.

O detector de loop conta impressões SHA-256 de chamadas de tool. Cinco chamadas
idênticas sem escrita entre elas produzem a transição `slow-suspect` com reason
`no-progress`, e uma escrita observada zera a contagem. O loop **não mata**:
silêncio e teto continuam sendo os únicos motivos de kill. A transição carrega só
`progress: {repeats, fingerprint_sha256}`, com 16 hex.

O owner registra essa transição em `.gsd/forge/events.jsonl` pelo próprio canal
(`appendOwnedEvent`: broker, `recoveryReady` ou owner protegido). O worker nunca
escreve esse arquivo. A linha tem campos fechados:
`{ts, event: "sidecar-no-progress", workflow_id, dispatch_id, unit,
worker_engine, model, repeats, fingerprint_sha256}`. `repeats` é inteiro, e
`fingerprint_sha256` só aparece quando casa `^[0-9a-f]{16}$`. Nenhum nome de tool,
argumento, prompt ou caminho entra no evento. O diagnóstico de um loop usa só a
contagem e o hash: não registre argumentos de tool para investigar. O registro
ocorre uma vez por episódio. `no-progress` repetido sem saída intermediária não
duplica a linha. Uma transição que sai de `slow-suspect`/`no-progress` reabre o
episódio. Os appends são serializados, relêem o receipt dentro da fila e são
aguardados antes do evento terminal da unidade. Falha no append é best-effort e
não altera o status da unidade. Os review legs Claude recebem o mesmo
`onLiveness`, mas ainda não têm evento de owner.

#### Liveness heartbeat on the progress channel

O host (codex ou claude) lê o estado de liveness do worker Claude pelo canal de
progresso existente: o callback `onProgress` em processo e a linha
`[forge-sidecar-progress] {json}` no stderr do CLI. O dado vem no bloco aditivo
`liveness` de `observation()` (`forge-sidecar-diagnostic.js`):

`"liveness": {"version": 1, "state": "slow-suspect", "since_ms": 120025, "reason": "silence"}`

- `version`: fixo em `1`. Outra versão faz o consumidor ignorar o bloco.
- `state`: vocabulário fechado `starting | working | slow-suspect | dead`
  (`liveness.STATES`). Valor fora do conjunto omite o bloco inteiro.
- `since_ms`: `elapsed_ms` da transição que levou ao estado atual
  (`transition.at_ms`); vale `0` na partida.
- `reason`: `null` ou um item de `liveness.REASONS` (`silence`, `local-proof`,
  `tool-extended`, `tool-unproven`, `tool-proof-negative`, `proof-unavailable`,
  `tool-extension-exhausted`, `tool-proof-unavailable-expired`, `no-progress`).
  Razão desconhecida vira `null`, nunca texto livre.
- `termination`: opcional e **só no snapshot final** de uma tentativa encerrada
  pelo watchdog (`dead-start`, `dead-silence`, `budget-exceeded-while-active`).
  Kill por liveness termina em `state: "dead"`. Kill pelo teto com stream vivo
  mantém o estado (`working`/`slow-suspect`) e usa
  `budget-exceeded-while-active`: teto ativo não é morte.

O bloco não carrega impressão digital, argumentos de tool, prompt, caminho nem ID
de sessão; o `fingerprint_sha256` continua exclusivo do evento
`sidecar-no-progress`.

Cadência: emissão periódica a cada 30000 ms (`DEFAULT_PROGRESS_INTERVAL_MS`, seam
interno `progressIntervalMs`, recusado antes do spawn quando inválido) e emissão
imediata em cada transição do tracker, depois de `onLiveness`. A transição
`null -> starting` não gera emissão extra. O `heartbeat_interval_ms` de 15000 do
result-file (orphan detection) permanece inalterado e é outro canal.

Leitura pelo host: `readProgressLine(line)` aceita uma linha
`[forge-sidecar-progress] {json}` e devolve `observation(parsed)`, ou `null` para
linha sem prefixo ou JSON inválido; nunca lança. O owner normaliza o snapshot com
`observation()` e o propaga a `receipt.telemetry.observation`, a
`runtime.onProgress` e ao stderr. A ausência do bloco significa payload antigo:
os consumidores estritos aceitam os dois formatos e a saída sem bloco é
byte-idêntica à anterior.

Limitação conhecida: os review legs (`challenge/defend/rebuttal` com engine
claude) publicam o bloco no stderr, mas o evento durável `sidecar-no-progress`
nesse caminho não é gravado, porque o CLI de review não tem canal de owner. É um
achado para a triagem final da S09.

#### App-server liveness adapter

O transporte Codex app-server (`startAppServerTurn` em `scripts/forge-appserver-client.js`)
usa a mesma liveness neutra da S01 como autoridade primária do kill. O módulo puro
`scripts/forge-appserver-liveness.js` reduz as notificações JSON-RPC a um snapshot no
contrato de entrada de `liveness.evaluate`; o cliente só acrescenta o watchdog. O
bloco `liveness` exposto ao host é o mesmo da S06 (`observation()`, `progressLine`,
`readProgressLine`), com a mesma cadência de 30000 ms e emissão na transição.

O review agy usa o mesmo tracker e DEFAULTS quando o binário anuncia
`--output-format stream-json` no `--help`, consultado a cada invocação, sem cache.
Sem anúncio ou com probe falho de término confirmado, mantém o caminho legado
limitado e rotulado `unsupported-legacy`, sem supervisão semântica. O stream não
tem prova local: a janela de ferramenta permanece limitada a 660000 ms nos
defaults e ao timeout efetivo. O formato dos eventos e o vocabulário de
tipos/estados são uma suposição documentada, ainda não verificada contra o
provider. O host executou apenas `--version`/`--help` do binário oficial 1.4.8
isoladamente; nenhuma inferência real foi executada. Saída de processo não
confirmada bloqueia fallback e conserva o prompt até reconciliação.

- **Evento remoto (suposição conservadora, sem probe ao vivo):** conta como remoto
  qualquer notificação do servidor depois do envio de `turn/start`, exceto o conjunto
  fechado `LOCAL_LIFECYCLE` (`thread/started`, `turn/started` e `item/started`/
  `item/completed` de item `userMessage`). Respostas JSON-RPC (`initialize`,
  `thread/start`, `turn/start`) não contam. O pin do app-server não lista métodos de
  notificação, então a forma é frágil: um falso "remoto" só adia `dead-start` para
  `dead-silence` (240 s) e nunca mata um turno vivo.
- **Tool aberta:** `item/started` sem o `item/completed` de mesmo `item.id`, apenas
  para `TOOL_ITEM_TYPES` (`commandExecution`, `fileChange`, `mcpToolCall`,
  `dynamicToolCall`, `collabAgentToolCall`, `webSearch`, `imageView`, `sleep`,
  `imageGeneration`). `agentMessage`, `reasoning`, `plan` e tipos desconhecidos não
  suspendem a contagem de silêncio. A extensão e o detector de loop seguem a S02; o
  detector só reporta.
- **Fingerprint:** `toolFingerprint('appserver:' + item.type, campos fechados por tipo)`
  de `forge-claude-stream.js`, com dedupe por `item.id`. Só o hash sai do módulo.
- **Prova local por plataforma:** `createLocalProof` da S02 com `pid` do filho
  app-server e `roots = [cwd, ...writableRoots]`. Em linux/darwin vale CPU da árvore
  mais delta de fs. Em win32 não há CPU: só delta de fs pode dar `positive`; sem delta
  a prova fica `unavailable`, o turno vira `slow-suspect/proof-unavailable` aos 120 s e
  morre em 660000 ms (`tool-proof-unavailable-expired`). Sem pid ou com provider
  falho a regra é a mesma. Limite: a CPU do app-server ocioso pode ficar abaixo de
  `MIN_CPU_DELTA_MS` e dar `negative` durante uma tool remota (`webSearch`,
  `mcpToolCall`), que então morre aos 240 s.
- **Kill:** sempre pelo caminho existente, `turn/interrupt` seguido do grace e só então
  a morte do processo.
- **Códigos (`APPSERVER_LIVENESS_CODES`):** kill por liveness (`dead-start`/
  `dead-silence`) usa `code: 'appserver-anomalous-silence'` e mensagem
  `anomalous silence (<termination>) after Ns`, sem `terminated`/`timeout`/`network`
  para não ser lida como transitória. O teto com stream vivo usa
  `budget-exceeded-while-active`. O teto ainda em `starting` não tem código e preserva
  a mensagem load-bearing `timeout after Ns`. Os erros levam `interrupt`, `turnId`,
  `liveness` e `diagnostic`.
- **Recovery:** `appserver-anomalous-silence` com `observation.silence.cause ===
  'indeterminate'` é classe `silence`, como `claude-anomalous-silence`;
  `budget-exceeded-while-active` é `active-budget`. O codex não tem resume de sessão
  (o resume da S05 é só Claude), então `next()` para com
  `budget-exceeded-resume-unavailable`. É limite declarado, não lacuna.
- **Contexto sob censo protegido:** com `opts.executionContext` presente,
  `invokeCodexAppServer` calcula o health de contexto em memória (`persist: false`; o
  thread é `ephemeral` e o estado nunca é relido), sem gravar
  `.gsd/forge/context/codex/` no owner, o que antes derrubava a publicação com
  `execution-protected-metadata`. `context_health`/`context_boundary` não mudam. Sem
  `executionContext` a persistência atual é mantida.
- **Follow-ups (fora desta correção):** a escrita do hook PreCompact em
  `auto-mode.json` e a renovação do lease em `.gsd/forge/leases` pertencem ao
  controlador/host, não ao transporte codex, e seguem como follow-up nomeado.

#### Personal calibration and anomalous silence

`forge-sidecar-calibration.js` resolves the user home independently of account
registry overrides. Its private store keys exact transport/protocol/model/effort/
canonical phase/policy identity; no account, project, path, prompt or session
identity is stored. Initial and eligible-gap dimensions collect five independent
accepted healthy samples each, then freeze at
`max(120000, 4 * max(samples) + 15000)` milliseconds. A cold dimension never aborts
adaptively. No request or wait is added for learning. Once both dimensions are
frozen, subsequent commits do not rewrite `calibration.json`.

Only trusted adapter telemetry creates a proposal. The executed/ready receipt
persists its attempt identity before acceptance/publication; canonical acceptance
binds the proposal to the receipt and fingerprint. Replaying the same proposal
cannot learn twice. Worker JSON cannot choose a home or manufacture a proposal.
Accepted review candidates commit only after schema and semantic output checks.
A short owner/generation lock rereads and merges before an exclusive private
temporary write and atomic rename. Symlinks, malformed/oversized stores and
more than 256 keys refuse learning; calibrated records are never evicted.

An eligible calibrated window exceeding its frozen threshold is
`claude-anomalous-silence`, with measured window, threshold, policy/source and
`cause: indeterminate`. A one-second local watchdog never extends the hard
invocation deadline. Timeout/silence does not prove provider unavailability.
Recovery first inspects process and receipt, replays a saved valid response and
reconciles every possible writer root. A live canonical recovery capability may
reserve at most one unchanged same-destination silence retry. Reservation is
persisted with compare-and-swap under a short lock before invocation; pending
reservation blocks every other writer across restart. Callbacks run outside the
lock and the adapter rereads state before reserving. The single retry receives
the tier safety ceiling from ceilingFromRoute, like any recovery sidecar; there is
no cumulative recovery clock and no remainder. The durable reservation, not a
deadline, prevents a second silence retry across restart or clock regression.
After that one retry, ordinary authorized untried routing applies. No provider
probe, preference rewrite or second learning call is introduced.

##### Calibration v2 (`claude-silence-v2`)

The v1 policy above stays a readable legacy: its store is untouched and nothing
from it is promoted. Policy `claude-silence-v2` lives in a separate store,
`calibration-v2.json`, beside `calibration.json` (same directory, same lock,
same `safePath`, 1 MiB and 256-key limits). It is a separate file because the
v1 reader validates every record against the fixed v1 identity; a v2 record in
that file would make the v1 reader refuse the whole store.

v2 only tightens the locked defaults. It calibrates `startMs` (dimension
`initial`) and `deadMs` (dimension `gap`); the final threshold is always inside
[floor, default]: `startMs` 30000..60000 and `deadMs` 120000..240000
(`CALIBRATION_FLOORS` and `DEFAULTS` in the liveness module). Formula, with clamp:
`raw = 4 * max(samples) + 15000`, `lower = censored.max_ms + 15000` (0 without
censored data), `threshold_ms = min(default, max(floor, raw, lower))`.

A dimension is calibrated with 5 uncensored samples from distinct evidence; the
uncensored samples freeze at 5. Censored samples (an open gap from a cut
stream) count only as a lower bound: they never calibrate alone and never raise
the threshold above the default. Their origins are `dead-start`, `dead-silence`
and an active ceiling hit, always without a suspended gap (a tool kill is a
proven extension, not silence). Up to 32 evidence entries are kept; replay of the
same attempt is not counted twice, and a full list is a no-op. Censored
samples may still be added after the freeze and can only raise the threshold up
to the default.

When the exact model/effort/phase dimension is not calibrated, a model fallback
aggregates v2 records of the same transport/protocol/model across efforts and
phases, requiring at least 10 deduplicated samples from at least 2 distinct
phases; the source is `model-fallback`. Precedence per dimension, never mixing
values: exact v2, then v2 model fallback, then the v1 gap rule, then the locked
default. The v1 `initial` stays ignored.

`observation().silence` accepts `policy: claude-silence-v2` with source
`persisted-calibration` or `model-fallback`, `cause: indeterminate`, a threshold
inside [floor, default] and a window greater than the threshold; any other v2
snapshot is dropped, and v1 and liveness-v1 projections are unchanged.

A failed receipt preserves the sanitized cause; a ready receipt replays canonical
publication with no inference and without overwriting unrelated edits. An
interrupted started receipt requires process evidence and reconciliation.
`partial`/`blocked` remain worker outcomes and unanswered questions remain pending.
Fixture tests, independent review and the separately authorized bounded readonly
pilot are distinct evidence. Local fixtures cannot establish real authentication
or explain a historical timeout.

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
Each additional recovery sidecar receives the full tier safety ceiling from
ceilingFromRoute (scripts/forge-worker-timeout.js), never an inherited remainder.
Recovery state v2 has no cumulative clock; a v1 state is migrated explicitly.
Termination comes from the finite candidate list, destination exclusions, durable
reservations, one silence retry and canonical exception expiry; a native candidate
still needs a live scoped exception. Timeout alone does not prove model unavailability.
Keep preferences/gates; never silently replace a refused route. Separately authorized
Forge maintenance follows `shared/forge-direct-actions.md`, preserving the original
reservation, reconciled roots, claims and independent review. Record the actual executor.

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
authorization may select a compatible untried candidate (native or a sidecar
with the tier safety ceiling), preserving model/tier/effort and started_at.

Before *each* protected phase, pause the parent's ordinary lease heartbeat,
then call `forge-unit-lease.openProtectedWindow(owner, unit, heldToken,
heldGeneration, {durationMs})`. It atomically requires unexpired matching
ownership and renews that same generation once, before snapshots. Duration is
an integer in `1..MAX_PROTECTED_WINDOW_MS` (5460000, the largest tier ceiling
plus 60s, from `scripts/forge-worker-timeout.js`). Size it with
`protectedWindowMs(ceilingMs)`; when it returns `covers: false` (an explicit
ceiling above 5400s) do not open a single window — refuse it or split the phase
into windows; the duration is never silently truncated. During the window route the parent's
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
and choose a sufficient bounded window without a cumulative recovery clock; each sidecar keeps its full tier safety ceiling.
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
Não há relógio cumulativo: cada sidecar de recuperação recebe o tier safety ceiling (ceilingFromRoute).
Só destino ainda não tentado, autoridade viva e modelo/tier/esforço/ferramenta realmente suportados permitem execução.
História insuficiente conserva a recusa; implementar este mecanismo não desbloqueia receipts históricos.


## Standalone native execution and durable writer results

An ordinary `uninvoked-native-reservation` continuation supports standalone
execution with the same live history, held claim, gates and strict delivery checks.
When `nativePromptFile` is requested, the final invocation binds a short file
instruction and SHA-256; the complete UTF-8 prompt is retained beside the derived
result path. File bytes, physical identity and ancestor links are rechecked at
invocation boundaries. Telemetry measures the full context and actual tool arguments
separately. The native tool must receive those arguments unchanged.

`uninvoked-native-repackage` is an exclusive recovery transition for a consumed
callback that the trusted host proves never called its executor tool. It requires
`nativeRepackage.invocationFile` and `journalFile`, a fresh native lifecycle journal,
the normal live history/root/uninvoked attestations and `attestRepackage(challenge)`.
The latter binds the exact challenge with `actual_native_calls: 0`,
`wrapper_stopped: true`, `status: 'uninvoked'` and an evidence reference. Process
absence or these fields in imported JSON do not constitute proof. An observed
acknowledgement, remote event, provider contact, result or receipt refuses this path.
The original invocation, manifest, journal and full prompt must match the consumed
binding; only transport changes. One replacement is allowed per reservation.
Original attempts/reservations stay intact and the previous continuation is retained
in `continuation_history`. A prepared replacement can resume through the ordinary
transition with fresh live attestations and all retained evidence revalidated;
returned results retain canonical replay priority without another inference.

`runUnitSidecar(request, runtime)` accepts standalone `execute-task` with an
explicit native route, nonempty held v2 claim and `request.nativeInvocation`.
The latter is a declaration: the adapter rebuilds it from
`runtime.activeCapabilities` and the resolved model/effort. Runtime callbacks
cannot be imported through request JSON. The same started/executed/ready,
independent delta, inputs, protected metadata, delivery and publication lifecycle
applies. Recovery with a callable native tool enters this full lifecycle too.
`assertMilestoneContext`, recovery transitions and authenticated owner-event
appends retain their existing checks.

The optional `request.nativePromptFile` is outside owner and every code root.
It stores the complete canonical prompt with exclusive creation and full hash;
the native message carries its path and SHA-256. Links, path substitution and
byte changes are refused. Full context and transport hashes are separate.
`onPackagedContext` and `announce` are awaited before the final authority check;
the check repeats immediately before the host callback, after invocation and
after readback. Capabilities, exact arguments, request, held claim, gates,
inputs, original baseline and protected metadata must still match. This is a
process-local boundary, not an atomic guarantee about a remote provider. An async
mandatory guard is awaited and followed by synchronous binding checks; recovery
rechecks live process/receipt, reservation and authorization at these boundaries.

Native execution seals verification before its first writer. Host supplements
belong in `runtime.verification`, with only `preferenceCommands`,
`commandsByRoot` and positive integer `commandTimeoutMs`. Unknown roots/keys,
invalid commands and replacement/removal/reordering of explicit command lists
refuse. Plan commands retain priority, followed by root preferences, general
preferences and discovery; valid supplements append. A root without commands
refuses. The versioned receipt seal contains root commands and origins, timeout
and origin, plan hash, execution identity and digest. Delivery envelopes bind
the seal digest. Executed/ready replay reuses it and rejects changed supplied
policy. A legacy native receipt needs a complete saved capture; absent provenance
is not synthesized. Existing sidecar execution without declared verification
retains its historical discovery path.

`runtime.savedNativeResult` describes only `{resultFile, sha256, dispatchId,
fingerprint}` for a failed or started attempt. It grants no authority, including
when an old descriptor also contains `processStopped`. Parsing may strip a BOM;
hashing always covers the original physical bytes. The original baseline,
strict result schema, inputs, delta, held claims and protected metadata must
validate before recovery can reconcile or choose another writer.

The trusted host creates a live handle with
`forge-recovery-transition.createWriterObservationAdapter(attestWriter)` and
passes it as `runtime.writerObservationAdapter`, plus `runtime.processProbe`.
The asynchronous callback must independently observe the same writer and return
`status: 'stopped'`, a nonempty `writer_identity`, `evidence_reference`,
`binding_sha256` of the complete challenge and its exact `dispatch_id`,
`fingerprint`, `receipt_sha256`, `execution_identity_sha256` and `roots_sha256`.
The adapter checks before and after awaits. `inspectReceipt` running/unknown
observations veto acceptance. PID, boolean, serialized handle and callback that
simply echoes caller assertions are not evidence of a stopped writer. Restart
requires a new host adapter and fresh independent attestation. Valid saved
responses replay without inference/reset and preserve the historical failure,
final evidence, fingerprint, baseline, identity and recovery deadline.

The portable matrix in `forge-native-execution.test.js` uses public execution,
recovery, invocation and CLI entrypoints. Its shared factory lives in
`fixtures/forge-native-execution.js`; it does not read personal report paths or
patch production module loading. Inference/host observation are synthetic;
controlled child Node process, filesystem/VCS and link checks are local evidence.
A passing fixture is neither a real provider execution nor human UAT.
