# Issue 440 — consumidores do resultado de execute (mapa wire × montado)

**Slice:** S02 · **Task:** T05 · **Critério:** S02-A6 · **Suíte que confere este mapa:** `node scripts/forge-issue-440-result.test.js`

Este mapa registra cada leitura de resultado de `execute-task` encontrada em `scripts/` e diz, para cada uma, se ela lê o
resultado **na fronteira de wire** (a resposta do worker, antes da montagem) ou **montado a jusante** (o resultado do PR441,
produzido por `assembleExecuteResult` ou, na rota nativa, o resultado cru validado com metadados confiáveis). A suíte abre
este arquivo, confere que cada call site existe na fonte atual, que cada caso diferencial citado foi executado na mesma
rodada e que todo script de produção que casa com os termos do censo tem pelo menos uma linha aqui.

## Método do censo

1. Busca textual em `scripts/*.js` (excluídos `*.test.js` e `scripts/fixtures/**`, que são suítes e dados de teste) pelos
   termos `validateExecuteResult`, `validateAssembledExecuteResult`, `must_haves_status` e `files_changed_declared`.
2. Para cada ocorrência, leitura do símbolo que a envolve, para separar leitura real de resultado de execute de comentário,
   texto de prompt, esquema ou outro perfil de resultado.
3. Leitura de `result.status` restrita aos caminhos de execute alcançados pelos símbolos do passo 2 e aos seus chamadores
   diretos (`finishExecute`, `verifyResult`, o reparo do #439 e o resíduo de membro de lote). `result.status` de outras
   unidades (plan, review, memory, artifacts) não é resultado de execute e fica fora do mapa.
4. Classificação de cada linha por classe, tipo de consumidor, validador, transportes e veredito, e ligação a um caso
   nomeado da suíte.

Limite declarado: o censo é textual e por símbolo. Leitura dinâmica por nome calculado não seria encontrada; nenhuma foi
observada nos símbolos lidos. Processos que não são `execute` não são lacuna deste mapa.

## Legenda

- **Classe:** `wire` (fronteira, resposta do worker antes da montagem), `montado` (resultado aceito, do receipt ou publicado)
  ou `n/a` (não lê resultado de execute).
- **Consumidor:** `accept`, `replay`, `recovery`, `reparo`, `entrega`, `diagnóstico` ou `status`.
- **Transportes:** `app-server` (host Claude → worker Codex, rota primária), `claude-cli` (host Codex → worker Claude) e
  `nativo` (host Codex, ferramenta nativa). Na suíte os três são simulados e rotulados `mock`.
- **Veredito:** `correct-wire`, `correct-assembled`, `gap-demonstrated` ou `not-applicable`.

## Mapa

| ID | Call site | Classe | Consumidor | Validador | Transportes | Veredito | Caso diferencial |
|---|---|---|---|---|---|---|---|
| C01 | `scripts/forge-xllm.js#validateExecuteResult` | wire | accept | validateExecuteResult | app-server, claude-cli, nativo | correct-wire | `wire-boundary` |
| C02 | `scripts/forge-xllm.js#executeContract` | wire | accept | validateExecuteResult + chaves do executeSchema | app-server, claude-cli | correct-wire | `transport-app-server-from-claude` |
| C03 | `scripts/forge-xllm.js#acceptClaudeOutput` | wire | accept | contract.validate (executeContract) | claude-cli | correct-wire | `transport-claude-cli-from-codex` |
| C04 | `scripts/forge-xllm.js#runWriteContractCore` | wire | accept | contract.validate sobre finalText ou extractLastJsonBlock | app-server | correct-wire | `keysets-frozen` |
| C05 | `scripts/forge-xllm.js#assembleExecuteResult` | montado | accept | pin de toString (produtor) | app-server, claude-cli | correct-assembled | `pins-immutable` |
| C06 | `scripts/forge-xllm.js#validateAssembledExecuteResult` | montado | status | validateAssembledExecuteResult | app-server, claude-cli, nativo | correct-assembled | `assembled-validator-per-transport` |
| C07 | `scripts/forge-claude-sidecar.js#checkedTerminalOutput` | wire | accept | contrato execute de forge-worker-result-contract + validateCandidate | claude-cli | correct-wire | `transport-claude-cli-from-codex` |
| C08 | `scripts/forge-claude-sidecar.js#parseExecuteCandidate` | wire | accept | parseJsonEnvelope + isValidMustHave | envelope enquadrado | correct-wire | `framed-envelope-parser` |
| C09 | `scripts/forge-worker-result-contract.js#contract` | wire | accept | esquema fechado execute | claude-cli | correct-wire | `wire-boundary` |
| C10 | `scripts/forge-worker-result.js#parseJsonEnvelope` | wire | accept | marcadores e status do envelope | envelope enquadrado | correct-wire | `framed-envelope-parser` |
| C11 | `scripts/forge-unit-sidecar.js#validNativeExecutionResult` | wire | accept | validateExecuteResult + chaves fechadas | nativo | correct-wire | `transport-native-codex` |
| C12 | `scripts/forge-unit-sidecar.js#runNativeExecutionTransport` | wire | accept | validNativeExecutionResult + assertUntrustedOutputBarrier | nativo | correct-wire | `transport-native-codex` |
| C13 | `scripts/forge-unit-sidecar.js#runUnitSidecarCore` | wire | replay | validNativeExecutionResult sobre o candidato sem metadados | nativo | correct-wire | `replay-same-process` |
| C14 | `scripts/forge-unit-sidecar.js#finishExecute` | montado | status | status e files_changed do resultado aceito | app-server, claude-cli | correct-assembled | `content-status-differential` |
| C15 | `scripts/forge-unit-sidecar.js#executeDeliveryArtifacts` | montado | entrega | campos summary e must_haves_status do resultado aceito | app-server, claude-cli, nativo | correct-assembled | `delivery-summary-differential` |
| C16 | `scripts/forge-unit-sidecar.js#replayArtifactAttempt` | montado | replay | publishReadyRecord | app-server, claude-cli, nativo | correct-assembled | `replay-artifact-attempt` |
| C17 | `scripts/forge-unit-sidecar.js#publishReadyRecord` | montado | replay | assertReplay + materialize | app-server, claude-cli, nativo | correct-assembled | `replay-fresh-process` |
| C18 | `scripts/forge-unit-sidecar.js#preserveReturnedResponse` | montado | reparo | custódia; validação no reparo #439 | app-server, claude-cli | correct-assembled | `repair-439-predicate` |
| C19 | `scripts/forge-unit-sidecar.js#runUnitSidecarCore` | montado | status | resíduo de membro de lote (partial/blocked) | membro de lote | not-applicable | `content-status-differential` |
| C20 | `scripts/forge-sidecar-verification-repair.js#create` | montado | reparo | validateAssembledExecuteResult + status done | app-server, claude-cli | correct-assembled | `repair-439-predicate` |
| C21 | `scripts/forge-task-execution.js#verifyResult` | montado | accept | claims e snapshots sobre files_changed derivado | app-server, claude-cli | correct-assembled | `content-status-differential` |
| C22 | `scripts/forge-env-promote.js#checkEnvPromotion` | montado | diagnóstico | status + must_haves_status | app-server, claude-cli, nativo | correct-assembled | `env-promote-differential` |
| C23 | `scripts/forge-reverify.js#needsReverification` | montado | diagnóstico | must_haves_status | app-server, claude-cli, nativo | correct-assembled | `reverify-differential` |
| C24 | `scripts/forge-reverify.js#hasDivergentCommandNotes` | montado | diagnóstico | notas de must_haves_status | app-server, claude-cli, nativo | correct-assembled | `reverify-differential` |
| C25 | `scripts/forge-repair.js#reinjectDiff` | n/a | diagnóstico | lista dropped do plano de reparo | nenhum | not-applicable | `not-applicable-profiles` |
| C26 | `scripts/forge-native-artifact-advisory.js#create` | n/a | recovery | perfil milestone-recovery (kind/index) | nativo em recuperação | not-applicable | `not-applicable-profiles` |
| C27 | `scripts/forge-native-recovery-delivery.js#resultContract` | n/a | recovery | contrato milestone-recovery | nativo em recuperação | not-applicable | `not-applicable-profiles` |
| C28 | `scripts/forge-native-recovery-delivery.js#evidenceRequests` | n/a | recovery | evidence das linhas milestone-recovery | nativo em recuperação | not-applicable | `not-applicable-profiles` |
| C29 | `scripts/forge-native-recovery-delivery.js#createDocumentaryContinuation` | n/a | recovery | kind/index das linhas milestone-recovery | nativo em recuperação | not-applicable | `not-applicable-profiles` |
| C30 | `scripts/forge-native-recovery-delivery.js#criterionBindings` | n/a | recovery | kind/index das linhas milestone-recovery | nativo em recuperação | not-applicable | `not-applicable-profiles` |
| C31 | `scripts/forge-native-recovery-delivery.js#prepare` | n/a | recovery | kind/index das linhas milestone-recovery | nativo em recuperação | not-applicable | `not-applicable-profiles` |
| C32 | `scripts/forge-smoke.js#validateExecuteResult` | n/a | diagnóstico | autoteste do adaptador instalado | nenhum | not-applicable | `wire-boundary` |

## Notas por linha

- **C01–C04 (fronteira de wire do adaptador).** `validateExecuteResult` só recebe a resposta do worker. No app-server, o
  `finalText` é validado primeiro e `extractLastJsonBlock` é só degradação nomeada; no Claude CLI, `acceptClaudeOutput`
  repete o gate do contrato sobre o candidato já validado pelo adaptador. O caso `keysets-frozen` confere que o stream mock
  segue o caminho `output-schema`, sem `degradation`.
- **C05–C06 (montagem do PR441).** `assembleExecuteResult` produz `files_changed` derivado do VCS e `files_changed_declared`
  com a lista do worker. `validateAssembledExecuteResult` valida a parte do worker com o mesmo gate de campo e aceita o
  resultado cru histórico. Os dois e `validateExecuteResult` estão pinados por `toString` (`pins-immutable`), assim como os
  bytes inteiros de `forge-xllm.js` e `forge-sidecar-verification-repair.js`.
- **C07–C10 (Claude e envelope enquadrado).** O caminho vivo do Claude CLI usa `structured_output` em `checkedTerminalOutput`.
  `parseExecuteCandidate` não tem chamador de execute em produção: `forge-task-preparation.js` o usa para artefatos de
  preparação nativa. Mesmo assim ele lê o mesmo bloco com o mesmo conteúdo (`framed-envelope-parser`).
- **C11–C13 (nativo).** A rota nativa guarda de propósito o resultado cru validado com metadados confiáveis (`native`,
  `dispatch_id`, `workflow_id`, `host_runtime`, `worker_engine`), sem `files_changed_declared`. Por isso
  `validateExecuteResult` aceita o resultado nativo e `validateAssembledExecuteResult` o trata como forma histórica. A
  diferença é de forma, não de conteúdo: `content-status-differential` projeta a lista declarada pela mesma regra do
  validador montado e obtém o mesmo conteúdo nos três transportes.
- **C14–C18 e C21 (jusante do sidecar).** `finishExecute`, `verifyResult`, a entrega (`SUMMARY`), o replay e a custódia
  de `.returned.json` leem só o resultado aceito. O replay é provado no mesmo processo, por `replayArtifactAttempt` e num
  processo Node novo, com zero chamadas ao transporte simulado e hashes estáveis de artefatos, eventos, receipt e result.
- **C19.** O resíduo de membro de lote só existe com `partial`/`blocked` dentro de uma coorte; o diferencial usa `done` em
  tentativa única, então o ramo não é tomado. A coorte continua coberta pelas suítes de lote existentes (CI da S03).
- **C20 (#439).** O reparo admite o resultado retido exatamente por `validateAssembledExecuteResult(result) && status ===
  'done'`; `repair-439-predicate` confere o predicado nos três transportes. O fluxo ponta a ponta do reparo é de
  `forge-issue-439.test.js`, regressão obrigatória do CI final da S03, não declarada aqui.
- **C22–C24 (diagnóstico).** `checkEnvPromotion`, `needsReverification` e `hasDivergentCommandNotes` dão o mesmo veredito
  para os três resultados.
- **C25–C31 (outros perfis).** `reinjectDiff` lê a lista `dropped` do plano de reparo. O advisory de artefato e a entrega de
  recuperação nativa leem linhas do perfil `milestone-recovery` (com `kind`, `index`, `root_id` e `evidence`), com contrato
  próprio. Linhas de execute não têm esses campos e o contrato fechado de execute as recusa (`not-applicable-profiles`).
- **C32.** `forge-smoke.js` é autoteste do adaptador instalado, não consumidor de resultado de unidade.

## Chaves congeladas por transporte

As chaves de topo do resultado foram medidas na suíte pelos pontos de entrada reais e ficam congeladas em `KEYSETS`
(receipt e publicado). Diferenças declaradas, todas preexistentes:

- `app-server` publica `transport_telemetry` (commit de calibração do registro aceito), ausente do resultado do receipt, e
  carrega `runtime_evidence`;
- `claude-cli` carrega `transport_telemetry` no receipt e no publicado;
- `nativo` mantém a forma crua com os cinco metadados confiáveis.

## Conclusão do diferencial

Nenhuma divergência de conteúdo ou de status foi demonstrada entre transportes ou consumidores. Nenhuma linha recebeu
`gap-demonstrated` e nenhuma correção de consumidor foi feita: `assembleExecuteResult`, os validadores, o reparo do #439 e
as chaves por transporte ficaram como estavam. Se uma divergência aparecer, ela vira caso nomeado que falha nesta suíte e
só é corrigida em `scripts/forge-unit-sidecar.js`; em qualquer outro arquivo, vira bloqueio `scope-writer-outside-plan`.

## Fora deste mapa

Provider real, gravação genuína host Claude → worker Codex, matriz completa e as seis regressões amplas (unit-sidecar, #439,
app-server, evidence, surfaces e bidirectional) são da S03 e do CI final. Nada aqui as declara aprovadas.
