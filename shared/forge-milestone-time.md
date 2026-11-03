# Contrato de tempo de milestone (v1)

Fonte canônica do comportamento de tempo de milestone para os dois hosts (Claude e
Codex). As skills `forge-auto`, `forge-next`, `forge-new-milestone` e `forge-status`
apontam para este arquivo (no repositório ou em `$FORGE_SHARED_DIR`, instalado em
`${FORGE_HOME:-~/.forge-agent}/shared`). Ele descreve o que o código faz; texto de
skill, de contrato ou JSON importado não concede autoridade, não aprova extensão e
não substitui a guarda executável.

Módulos: `scripts/forge-milestone-time.js` (armazenamento, atestação, journal),
`scripts/forge-milestone-time-clock.js` (relógio e previsão),
`scripts/forge-milestone-time-admission.js` (status, admissão, avisos de fronteira),
`scripts/forge-milestone-time-drain.js` (drain e checkpoint),
`scripts/forge-milestone-worker-observations.js` (esforço observado de workers) e as
costuras de `forge-orchestrate.js`, `forge-loop-controller.js`,
`forge-native-invocation.js`, `forge-unit-sidecar.js`, `forge-xllm.js` e
`forge-native-recovery-delivery.js`.

## Armazenamento e quem escreve

- Tudo fica em `.gsd/forge/time/<M>/` do owner físico (o `WORKING_DIR` onde vive o
  `.gsd`, nunca o `CODE_DIR` de um worktree): `contract.json`, `amendments/0002.json…`,
  `journal.jsonl`, `warnings/<id>.json`, `checkpoints/<versão>.json`,
  `observations/<id>.json` e `coverage/<id>.json`.
- Só o owner escreve, numa fronteira segura do controlador, sob o lock do owner
  (`withOwnerLock`) e por publicação imutável (hard link exclusivo). Workers e
  sidecars nunca escrevem aqui: `protectedSnapshot` cobre todo o `.gsd`, então uma
  escrita durante uma janela protegida seria divergência do snapshot.
- Leitores (`readContract`, `readJournal`, `listWarnings`, `readCheckpoints`,
  `readObservations`, `readCoverage`, `readClock`, `readForecast`, `readTimeStatus`)
  são limitados, recusam links e nunca carregam o lock. Importar os módulos é inerte.
- Só milestones; `time-work-kind-unsupported` para task avulsa. Milestone com
  roadmap já existente fica fora do fluxo de ativação (`time-contract-roadmap-exists`).

## Schema

- `contract.json` (schema 1): `milestone`, `clock_policy {id:"forge-milestone-time-clock",version:1}`,
  `option {id, options_sha256, label}`, `activated_at`, `preselection_started_at`,
  `ceiling_ms`, `endpoint {kind:"verified-integrated-delivery", items}` com
  `publication`, `installation`, `manual-uat` e `external-waits` em
  `included|pending|completed|deferred|not-applicable`, `allocation` (ou `null`),
  `linked_task:null`, `chain_forecast:null` e a `decision` atestada.
- Emendas encadeadas por `previous_sha256`, uma por versão, tipos `extension`,
  `allocation`, `scope-reduction` e `continue-to-cap`; cada uma carrega sua própria
  decisão. Mesma pergunta com outra resposta é `time-decision-conflict`.
- Journal: `presence {session_sha256, boundary}` com `session-start|next|complete|status|session-end`
  e `wait-start`/`wait-end {wait_id, class: human|pause|ci|external, source}`.
  A sessão bruta nunca é gravada: só o SHA-256.
- Dados públicos não aceitam caminho absoluto, credencial nem sessão bruta.

## Atestação viva e respostas canônicas

- Toda ativação ou emenda exige um handle vivo de `createDecisionAuthority(resolver)`
  emitido pelo host, com escopo `{milestone, kind, request_sha256, expires_at}` (até
  1 h), mais a pergunta persistida e respondida em `forge-pending-questions` com
  origem `owner` e `decision_set` `milestone-time-<kind>`.
- Respostas canônicas: `option:<id>` ou `operator-ceiling:<ms>` (ativação),
  `extend:<ms>`, `allocation:<roadmap_sha256>`, `reduce-scope:<itens>` e
  `continue-to-cap`. Qualquer outra resposta é `time-decision-answer-mismatch`.
- `forge-milestone-time.js --extend` e `--decide` só funcionam quando o host embute
  `main(argv, io, liveAdapter)` com `liveAdapter.getDecisionHandle`. Rodados como CLI
  avulsa, recusam com `time-decision-attestation-required` (saída 3); essa recusa é
  o comportamento correto. JSON persistido, flag `approved` ou arquivo de pergunta
  nunca criam o consentimento.
- Silêncio ou timeout não é resposta: o contrato vigente continua valendo.

## Política de relógio v1

Cada instante entre a ativação e agora recebe uma classe, em ordem de prioridade:
`unit-work`, `owner-session`, `human-wait`, `pause`, `ci-wait`, `external-wait` e
`unknown`. Consomem o teto: `unit-work`, `owner-session` e `unknown`. Não consomem:
`human-wait`, `pause`, `ci-wait` e `external-wait`.

- `unit-work` vem dos intervalos `unit-began`…`unit-transition` do
  `<M>-events.jsonl` (união, sem soma dupla); unidade aberta conta até agora.
- `owner-session` vem de presença com sessão; troca de sessão vira `unknown`.
- Espera humana só deixa de consumir quando `wait-start` aponta uma pergunta
  `pending-question` ainda pendente desta milestone, ou quando fecha com `wait-end`;
  sem isso o intervalo fica `unknown` (`wait-end-missing`).
- Tempo sem fonte é `unknown` e consome: o desconhecido aparece como desconhecido
  (`unattributed-time`), nunca como zero.

### Esforço: proxy de unidade separado do esforço observado

- `effort.unit_interval_sum_ms` (base `controller-unit-intervals`) soma os intervalos
  de unidade do controlador, incluindo preparação e publicação do owner. É um proxy
  e nunca é rotulado como esforço de worker.
- `effort.worker` (T08) só vem de observações imutáveis publicadas pelo owner:
  duração observada de invocação (inclui startup e transporte; não é CPU, LLM ativo
  nem cobrança; invocações paralelas são somadas). Estados `complete`, `partial` e
  `unknown`, com cobertura por unidade.
- A cobertura só é registrada por `observeCompletion` com um leitor vivo criado no
  processo por `createObservationReader(read, {roots})` e passado ao loop como
  `workerObservationReader`. O CLI JSON do adaptador não fornece esse leitor: sem
  ele o resultado é `observation-reader-unavailable` e o esforço fica desconhecido.
- Disponibilidade condicional: o leitor de recibo de sidecar aceita até 1 MiB
  (`MAX_RECEIPT`); um recibo real maior fica `observation-source-oversized` e a
  cobertura daquela unidade permanece parcial ou desconhecida.
- Sucessor só de verificação não é worker novo; intervalo de controlador não é esforço.

## Previsão v1 e avisos

- `forge-milestone-time-forecast` v1 exige `allocation` com o SHA-256 atual do roadmap.
  Usa entregas históricas comprovadas (`proof_kind: historical-delivery`) para a taxa
  de consumo e classifica o restante em `fits`, `at-risk`, `exceeds` ou `unknown`.
- Progresso histórico não é aceite integrado atual:
  `current_integrated_acceptance: not-evaluated` em toda superfície.
- `observeBoundary` grava, só em fronteira de slice comprovada ou em bloqueio
  (`units-blocked`, `failure-deferred`, `pending-questions`), um aviso imutável
  quando a classificação muda. Aviso `at-risk` ou `exceeds` traz as alternativas
  `extend`, `reduce-scope` e `continue-to-cap`.
- Aviso dentro do teto e do escopo já autorizados é informativo: não é pergunta
  obrigatória nem bloqueia o loop. Estender, reduzir escopo ou seguir até o teto
  exigem decisão explícita do operador com ID estável.

## Admissão

`decideAdmission(cwd, {milestone, unit, kind})` decide antes de cada `begin`.

- Decisões: `admitted`, `no-contract` (milestone sem contrato segue o fluxo legado)
  e `boundary-continuation` (só a escrituração de uma pausa já comprometida).
- Recusas: `milestone-budget-exhausted`, `milestone-budget-draining`,
  `milestone-time-invalid` e `milestone-clock-unknown`. `time-option-pending` está
  reservado para a seleção de opção e não é recusa de transporte.
- Estados de status: `active`, `warning`, `exhausted`, `draining`, `checkpointed` e
  `extended`.

## Entrada de transporte

A guarda executável roda dentro do transporte, imediatamente antes do provider:

- Nativo: `forge-native-invocation` supervisionado chama
  `assertOwnerTransportEntry` dentro do callback da supervisão. A skill passa
  `milestoneTimeContext {cwd: owner físico, milestone, unit}` em toda chamada
  nativa de unidade de milestone (unidade única, lote, plan-check, review-fix,
  extração de memória e pernas nativas de revisão, inclusive fallback), com a
  ferramenta e as capacidades realmente expostas pelo host. Recusa não chama o
  provider e devolve `provider_called:false` com a testemunha local do processo.
- Sidecar de unidade: `forge-unit-sidecar --request` rechecha a requisição retida
  (escopo `milestone`) antes de cada lançamento e retry.
- Pernas externas de revisão (`--mode challenge|defend|rebuttal`): recebem
  `--budget-owner <owner> --budget-milestone <M> --budget-unit <tipo/id>`; a recusa sai
  com código 2 e `provider_called:false`, sem fallback para outro revisor.
- Precheck: `node scripts/forge-milestone-time-admission.js --admit-transport --cwd <owner>
  --milestone <M> --unit <tipo/id> --json` sai 0 quando admitido e 3 quando recusado.
  Na saída 3 a skill para sem chamar provider. O precheck antecipa a mensagem; ele
  não é a garantia: o relógio pode mudar até o lançamento e a guarda interna decide.
- Escopo avulso continua avulso: task standalone não recebe contexto de milestone.
- Limite: a guarda vale nos adaptadores e callbacks do Forge. Ela não intercepta
  chamada bruta arbitrária feita fora deles nem comportamento de interface do cliente.

## Drain e checkpoint

- No teto, writers em voo terminam pela própria vigilância: sem kill, sem roubo de
  lease, sem nova tentativa. `inspectDrain` classifica cada writer (`terminal`,
  `healthy`, `dead-requires-failure-consumption`, `saved-response-requires-publication`,
  `unknown`) e o claim (`absent`, `released`, `held`, `retained-reconciled`, `unknown`).
- `checkpointIfDrained` só grava com drain `drained`: registro imutável com
  `overshoot_ms`, `decision_pending:true`, `pending_decision {id:"time-cap-…-v<versão>"}`,
  `next_action` no STATE e o checkpoint pessoal. Drain incompleto não grava nada.
- Claim retido só vale como `retained-reconciled` com prova viva do owner
  (`reconcileRetainedClaim`, `inspectAttempt`, `processProbe`); claim sozinho nunca
  prova processo parado. Não se força commit nem release para chegar ao checkpoint.
- Limites observáveis: só as raízes físicas observadas; filhos de lote nativo não são
  observáveis; sonda desconhecida nunca drena; adaptadores vivos são obrigatórios.

## Retomada após extensão (`resume-budget`)

1. O loop bloqueado guarda `time_block {milestone, contract_version, contract_sha256}`
   no próprio snapshot.
2. A extensão entra só por emenda atestada (seção de atestação).
3. `forge-long-workflow-adapter.js --command resume-budget` com o mesmo snapshot.
   O owner exige checkpoint drenado da versão bloqueada, emenda `extension` posterior
   e saldo positivo; rechecha a prova retida com adaptadores novos e recusa com
   `budget-resume-invalid`, `budget-checkpoint-required`, `budget-extension-required`,
   `budget-retained-claim-changed`, `pending-questions`, `lease-active`,
   `transaction-pending` ou `milestone-budget-draining`.
4. Pronto: `budget-resume-ready` e o loop segue com a mesma unidade selecionada pelo
   controlador. Falha já consumida por este workflow devolve `linked-reentry-required`
   e só continua por entrada vinculada explícita (`reenter`), readmitida pelo
   controlador antes de qualquer lease.

Nunca se edita o snapshot, não se inventa falha e não se reseleciona unidade.

## Primeira invocação nativa recusada antes do provider

Quando a guarda recusa a primeira invocação nativa de uma unidade já iniciada, o owner
fecha pela API real: `refuseNotInvoked(outcome)` da sessão de
`forge-native-recovery-delivery.prepare` exige a testemunha local do processo
(`notInvokedWitness`), o manifesto imutável gravado por `start()`, claim e código
inalterados, e grava o recibo `not-invoked`. Em seguida o loop roda
`consume-failure` (consumo canônico) e, depois de extensão, `reenter`. Clone de JSON
não carrega testemunha; nunca se fabrica resultado de worker.

## Superfícies

- `forge-status.js` (escopos pessoal, inspeção e workspace) acrescenta `time` só a
  milestone com contrato, lido por `readTimeStatus` e `summarizeTimeStatus`, sem
  escrita; `renderTree` mostra horizonte, consumido, desconhecido, saldo, previsão,
  estado, proxy de unidade separado do esforço observado e o comando de diagnóstico.
  Sem contrato, modelo e render ficam iguais aos anteriores.
- `forge-orchestrate status` expõe o mesmo bloco em `details.works[].time`.
- `forge-personal-summary` inclui o bloco fechado de `summarizeTimeStatus` dentro de
  4096 bytes; esgotado, em drain, em checkpoint e aviso aberto são trabalho protegido.
- Mensagens de aviso, teto, drain e checkpoint estão nas skills `forge-auto` e
  `forge-next`; `forge-status` repassa o bloco verbatim e não infere decisão.

## CLIs

- `node scripts/forge-milestone-time.js --show|--presence <fronteira>|--wait-start <id>|--wait-end <id>|--extend|--decide <continue-to-cap|reduce-scope> --cwd <owner> --milestone <M> [--session <s>] [--class <c>] [--source-kind <k>] [--source-ref <r>] [--ceiling-ms <n>] [--question-identity <sha>] [--question-id <id>] [--items <a,b>] [--reason <texto>] [--json]`
  (saída 2 uso, 3 recusa).
- `node scripts/forge-milestone-time-clock.js --cwd <owner> --milestone <M> --json`
  (relógio e previsão).
- `node scripts/forge-milestone-time-admission.js --status --milestone <M> --json` e
  `--admit-transport --cwd <owner> --milestone <M> --unit <tipo/id> --json`.
- `node scripts/forge-milestone-time-drain.js --inspect|--checkpoint --cwd <owner> --milestone <M> --json`
  (saída 2 quando o drain não está completo).

## Opções de prazo antes do roadmap (S02)

Módulos: `scripts/forge-milestone-time-selection.js` (adesão, fronteira do owner,
rodadas, decisão, bloco de prompt, regra do roadmap, projeção de vínculo e retomada),
`scripts/forge-milestone-options.js` (validador, estimador, render e rodadas),
`scripts/forge-milestone-roadmap-time.js` (conformidade pura) e o schema
`shared/schemas/forge-milestone-options.schema.json`.

### Adesão

- Só milestone nova criada pelas entradas modernas entra no fluxo: `forge-new-milestone`,
  e o bootstrap de milestone nova de `forge-auto` e `forge-next` gravam
  `.gsd/forge/time/<M>/enrollment.json` (imutável) com
  `forge-milestone-time-selection.js --enroll --source forge-new-milestone|forge-auto|forge-next --cwd <owner> --milestone <M>`
  antes da primeira seleção. Recusa (saída 3) para a criação com diagnóstico.
- Sem adesão nada muda: milestones atuais, milestones com roadmap e tasks avulsas
  seguem a seleção, as transações, os eventos, os prompts e os aceites de antes. A
  adesão é recusada quando o ROADMAP já existe (`time-options-roadmap-exists`).

### Proposta, registro e política do estimador

- Sem roadmap, o controlador seleciona `estimate-milestone/<M>` (somente leitura,
  `forge-planner`, tier `max` travado como `plan-milestone`, effort `medium`). O
  worker devolve só `<M>-OPTIONS.json` pelo schema v1: três posições (`curta`,
  `media`, `longa`) com DAG preliminar, verificações, revisão, adiamentos com
  consentimento e eventual task ligada, sem durações (só contagens de fase e
  julgamento rotulado). Texto do worker é dado: `isPublicData` e envelope DATA.
- O owner materializa, na fronteira segura do `next`, o registro imutável
  `options/<options_sha256>.json` e renderiza `<M>-OPTIONS.md`. A identidade do
  produtor (documentos, raiz física do código e arquivos investigados) é congelada
  antes do begin; mudança de fonte antes da escolha pede nova estimativa com chave
  nova; depois da escolha o registro é histórico.
- Estimador v1, determinístico e sem constante de duração: p50/p90 por fase de
  sucesso e razão de sobrecarga de milestones fechadas, execução serializada sem
  crédito de paralelismo, faixa, teto proposto (topo da faixa defensável) e caminho
  crítico. Histórico escasso com bounds atribuíveis completos dá faixa de confiança
  baixa; sem base completa a posição fica `evidence-insufficient`, e `infeasible`
  traz motivo; nenhuma das duas recebe número. Esperas não classificadas continuam
  desconhecidas, nunca descontadas.

### Rodadas e respostas canônicas

- Uma decisão por rodada, duas ou três opções, recomendação primeiro e nada
  pré-selecionado: `forge-milestone-time-selection.js --round` abre a rodada canônica
  em `forge-pending-questions`; o host a apresenta por `forge-question-channel.js
  --select` e `--present` e espera de forma econômica.
- Respostas canônicas: `mode:position`, `mode:operator-ceiling`, `option:<id>`,
  `operator-ceiling:<ms>` (texto livre de 1 minuto a 365 dias), `no-contract`,
  `re-estimate`, `linked-task:create-and-start-after-proven-completion|create-without-auto-start|none`
  e `reduce-scope:<itens>`. `--answer --round <ID> --response <texto> --source user-text|tool-answer`
  grava somente a resposta explícita do operador; vazia, estrangeira, parcial ou
  conflitante não avança.
- `re-estimate` não ativa contrato nem cria task: a retomada segue para a estimativa
  da base atual.

### Decisão e modelo de integração do adaptador vivo

- `--decide` só decide quando o host embute `main(argv, io, liveAdapter)`: o
  `liveAdapter.getDecisionHandle(request)` do host pede ao resolvedor de
  `createDecisionAuthority` um handle opaco e escopado para aquela pergunta. O
  resolvedor vivo devolve somente a resposta que o host observou ao vivo, naquela
  conversa, para aquela referência; nunca lê arquivo, JSON, flag ou prompt, e o
  handle nunca é persistido.
- A CLI avulsa recusa com `time-decision-attestation-required` sem escrita; a decisão
  continua pendente e não se repete a chamada com outros argumentos.
- A decisão confere cada resposta persistida, grava `selection.json` e ativa o
  contrato pela API da S01. Queda entre os dois passos é `activation-pending` e retoma
  de forma idempotente com autoridade viva nova.

### Continuação `resume-time-option`

- Enquanto não há decisão, `next` bloqueia com `time-option-pending`; o snapshot guarda
  `time_option_block {milestone, options_sha256}`. Depois da decisão atestada,
  `forge-long-workflow-adapter.js --command resume-time-option` com o mesmo snapshot
  devolve `time-option-ready` (segue para `plan-milestone`) ou
  `time-option-reestimate-ready`; `time-option-resume-invalid` e os demais códigos
  param. Nada edita o snapshot nem fabrica checkpoint.

### Seção de alocação, conformidade e alocação delegada

- Com contrato ativo, o prompt de `plan-milestone` traz `{TIME_SELECTION}` (bloco do
  owner em DATA) e o ROADMAP declara exatamente uma `## Alocação de tempo` com um
  bloco `json`: opção, posição, hash das opções, hash do contrato BASE, alocação por
  slice, integração, revisão e correções (positiva, até o teto, sem piso obrigatório),
  dependências, adiados e a divisão com a task ligada inalterada, sem adiamento novo.
- A conformidade é validada no aceite (sidecar, nativo e reconciliação), na seleção do
  controlador e na fronteira do owner: `time-roadmap-nonconformant`,
  `time-allocation-pending` e `time-scope-unallocated` bloqueiam.
- A alocação conforme vira emenda `allocation` com `delegation` ligada à decisão de
  ativação, sem pergunta humana redundante; realocações técnicas dentro da delegação
  são append-only. A identidade estrutural do roadmap ignora caixas marcadas; mudança
  estrutural posterior fica `scope-unallocated` até decisão explícita.

### Vínculo das tasks à alocação vigente

- O prompt de `plan-slice` traz `{TASK_NODE_BINDING}`: a projeção atual
  `taskBindingContext` da slice (identificadores alocados, partes de refinamento,
  arestas, dependências de slice e hashes), relida do owner físico, completa e sem
  corte, e ao lado dela o mesmo `{TIME_SELECTION}`. Vazio para milestone sem adesão,
  sem contrato ou só com contrato da S01; estado pendente, estrangeiro ou
  ilegível recusa o render antes de qualquer provider.
- Cada task publica `time_options_sha256`, `time_position_id` e `time_node`; com o
  vínculo não há meta de 1 a 7 tasks. `depends` continua local; barreiras entre
  slices vêm do DAG validado do roadmap e da prova histórica canônica.

### Códigos e limites da S02

- Códigos: `time-option-pending`, `time-options-invalid`, `time-roadmap-nonconformant`,
  `time-allocation-pending`, `time-scope-unallocated`, `time-option-ready`,
  `time-option-resume-invalid` e os bloqueios do DAG de tasks do controlador.
- Sem crédito de paralelismo; histórico só de milestones fechadas, com leitor limitado
  (até 64 fontes, 2 MiB por fonte) e sem truncamento silencioso.
- Milestones sem adesão ou com roadmap existente ficam fora do fluxo; painel, dashboard,
  statusline e app não ganham campos de tempo.

## Limites

- Sem kill, sem roubo de lease, sem nova tentativa por causa do teto.
- Pernas de revisão são guardadas no driver com contexto real; consumidor que não
  fornece contexto real não tem a garantia e isso é declarado, não suposto.
- Painel VS Code, dashboard e statusline não mostram campos de tempo.
- Milestone com roadmap existente não entra na ativação.

## Disponibilidade

Implementado e testado offline: armazenamento, atestação, relógio, previsão,
admissão, guardas de transporte, drain, checkpoint, retomada, observações e estas
superfícies. Distribuído: este contrato e as skills, pelos renderers Claude e Codex.
Condicional: esforço observado depende do leitor vivo do host e do tamanho do recibo.
Desconhecido até aceite humano: comportamento do host instalado e da interface.
Testes técnicos, revisão, CI, publicação, instalação e UAT são etapas separadas;
distribuição não prova interceptação nem obediência do modelo.
