# Guia operacional: prazos de milestone, endpoint e task ligada

Guia de uso da feature implementada na milestone
M-20261101111759-opcoes-prazo-milestones. O contrato canônico, distribuído aos dois
hosts (Claude e Codex), é `shared/forge-milestone-time.md`; este guia explica o
fluxo de operação e não substitui o contrato. Texto de guia, de skill ou de JSON
importado não concede autoridade, não aprova extensão e não substitui a guarda
executável. A proposta original fica em `docs/milestone-time-options.md`.

## Adesão e opções de prazo

- Só milestone nova entra no fluxo: `forge-new-milestone` e o bootstrap de milestone
  nova de `forge-auto` e `forge-next` gravam a adesão com
  `forge-milestone-time-selection.js --enroll` antes da primeira seleção.
- Sem adesão nada muda. Milestone sem adesão, milestone com ROADMAP já existente
  (`time-options-roadmap-exists`) e task avulsa seguem a seleção, as transações e
  os prompts de antes.
- Sem roadmap, o controlador seleciona `estimate-milestone/<M>` (somente leitura). O
  worker devolve `<M>-OPTIONS.json` com três posições (`curta`, `media`, `longa`),
  com DAG preliminar, verificações, revisão e eventual task ligada.
- O owner materializa o registro imutável das opções na fronteira segura do `next`
  e renderiza `<M>-OPTIONS.md`. Faixa, teto proposto e caminho crítico vêm do
  histórico de milestones fechadas; sem base suficiente a posição fica
  `evidence-insufficient`, e `infeasible` traz motivo, sem número inventado.

## Decisão e alocação

- Uma decisão por rodada, recomendação primeiro e nada pré-selecionado:
  `--round` abre a rodada e `--answer --round <ID> --response <texto> --source user-text|tool-answer`
  grava só a resposta explícita do operador. Silêncio, timeout, resposta vazia,
  parcial ou estrangeira não avançam.
- Enquanto não há decisão, `next` bloqueia com `time-option-pending` e o snapshot
  guarda `time_option_block`.
- `--decide` só decide quando o host embute `main(argv, io, liveAdapter)` com
  `liveAdapter.getDecisionHandle`. Rodado como CLI avulsa, recusa com
  `time-decision-attestation-required` (saída 3) sem escrever nada; essa recusa é o
  comportamento correto e a decisão continua pendente.
- A decisão confere as respostas persistidas, grava a seleção e ativa o contrato.
  Com uma posição de task ligada e autorização de criação, o mesmo `--decide`
  embutido cria a task ligada (seção “Task ligada”).
- Depois da decisão, `forge-long-workflow-adapter.js --command resume-time-option`
  com o mesmo snapshot segue para `plan-milestone`. O prompt traz o bloco
  `{TIME_SELECTION}` e o ROADMAP declara uma seção `## Alocação de tempo`.
- Roadmap conforme vira emenda `allocation` delegada, sem pergunta redundante.
  Roadmap fora do aceito bloqueia com `time-roadmap-nonconformant`,
  `time-allocation-pending` ou `time-scope-unallocated` até decisão explícita.

## Relógios e avisos

- Política de relógio v1: cada instante entre a ativação e agora recebe uma classe.
  Consomem o teto `unit-work`, `owner-session` e `unknown`; não consomem
  `human-wait`, `pause`, `ci-wait` e `external-wait`.
- Tempo sem fonte é `unknown`, consome e aparece como desconhecido, nunca como zero.
- O proxy de intervalos do controlador fica separado do esforço observado de
  workers; nenhum dos dois é CPU, uso de LLM ou cobrança.
- Avisos só nascem em fronteira de slice comprovada ou em bloqueio, quando a
  classificação da previsão muda. Cada aviso tem ID estável (SHA-256) e não se
  repete. Aviso `at-risk` ou `exceeds` traz as alternativas `extend`,
  `reduce-scope` e `continue-to-cap`; dentro do teto e do escopo autorizados é
  informativo e não bloqueia o loop.

## Teto, drain, checkpoint e extensão

- No teto, trabalho novo é recusado antes do `begin` com `milestone-budget-draining`
  (writer em voo) ou `milestone-budget-exhausted`. A unidade em voo termina pelo
  próprio `complete`: sem kill, sem roubo de lease e sem nova tentativa.
- O drain classifica writers e claims com adaptadores vivos do host. Só drain
  completo grava o checkpoint imutável, com `overshoot_ms` e decisão pendente;
  drain incompleto ou sonda desconhecida não grava nada.
- Extensão: só por emenda atestada com resposta explícita `extend:<ms>` e handle
  vivo. Depois dela, `forge-long-workflow-adapter.js --command resume-budget` com o
  mesmo snapshot devolve `budget-resume-ready` e retoma a unidade selecionada pelo
  controlador. Sem extensão: `budget-extension-required`; com pergunta funcional
  pendente: `pending-questions`.

## Endpoint e congelamento

- Endpoint é a conclusão canônica de `complete-milestone` mais a entrega
  reconstruída com o histórico dos filhos, slices revisadas, nenhuma pergunta
  funcional pendente e verificação NOVA do código integrado.
- Ordem: ACK real de `complete-milestone` → `forge-milestone-endpoint.js --verify`
  (envelopes novos com os comandos `verify:` declarados, por raiz) → `--record`
  (registro imutável `endpoint.json`). Sem comando ou sem contrato de raízes:
  `endpoint-verification-unavailable`.
- SUMMARY, DELIVERY, checkbox, run inativo, claim liberado ou checkpoint por teto
  isolados nunca são endpoint.
- Com endpoint válido o consumo da milestone congela: estado `endpoint-proven`,
  saldo pelo consumo congelado. O tempo corrido continua passando sem consumir.
  Begin, reentrada e transporte novos da milestone recusam com
  `milestone-endpoint-closed`.

## Task ligada

- Criação: `create-and-start-after-proven-completion` ou `create-without-auto-start`
  criam a task no `--decide` embutido (link, índice, BRIEF, run inativo, vínculo
  pessoal e checkpoint pendente). `none`, `no-contract` e opção sem task ligada
  não criam nada. A CLI avulsa `forge-linked-task.js --create` recusa com
  `linked-task-authorization-required`.
- Bloqueio: a task aparece como pendência pessoal e nunca é selecionada antes da
  prova da predecessora (`endpoint-unproven`, `milestone-budget-exhausted`,
  `milestone-budget-draining`, `milestone-budget-checkpointed`, `creation-pending`).
- Handoff: o owner o produz no fechamento (`forge-linked-task-start.js --handoff`),
  limitado, saneado e ligado ao endpoint, SUMMARY, entrega e roadmap. Fonte
  alterada depois dele recusa o início com `linked-task-handoff-stale`.
- Início encadeado: a decisão original é reatestada ao vivo, sem pergunta nova.
  Início explícito (`create-without-auto-start`): só com a resposta persistida
  `linked-task:start`. Os dois só pelo host que embute `main` com adaptador vivo.
- Base comprovada antes de consumir: `milestone-branch` (worktree emprestada do run
  da milestone, HEAD igual à revisão do endpoint) ou `integrated`. Deriva
  (`linked-task-base-drift`) ou base não comprovada (`linked-task-base-unproven`)
  recusam sem apagar histórico.
- O início acrescenta ao BRIEF exatamente um bloco de handoff, e a preparação da
  task entrega esse bloco uma vez no prompt das fases brainstorm, discuss, research
  e plan. Segundo início recusa com `linked-task-already-started`.
- Depois do início, sem PLAN, o trabalho pessoal fica desconhecido (fonte ausente),
  não aberto nem selecionável.
- Horizonte: teto da milestone governa operações da milestone; teto da task
  (horizonte do vínculo mais extensões atestadas) governa operações da task; o teto
  da cadeia é soma derivada que não governa nenhuma operação.
- No teto da task, toda entrada real de provider recusa antes do provider com
  `linked-task-budget-exhausted` e `provider_called:false`. Drain, checkpoint e
  extensão da task seguem as regras da milestone; a extensão exige a resposta
  `linked-task:extend:<ms>` e handle vivo.
- Encerramento da task (`--close`): só depois da entrega canônica verificada da
  task; SUMMARY sozinho recusa com `linked-task-delivery-unproven`. Encerramento da
  cadeia (`--close-chain`): só com a resposta `linked-task:close-chain` e handle
  vivo; revoga início e continuação.

## Comandos

- `node scripts/forge-milestone-time-selection.js --enroll|--status|--round|--answer|--decide|--prompt-block|--conformance --cwd <owner> --milestone <M> [--json]`
- `node scripts/forge-long-workflow-adapter.js --command resume-time-option|resume-budget` (mesmo snapshot)
- `node scripts/forge-milestone-time.js --show|--presence|--wait-start|--wait-end|--extend|--decide --cwd <owner> --milestone <M> [--json]`
- `node scripts/forge-milestone-time-admission.js --status --milestone <M> --json` e `--admit-transport --cwd <owner> --milestone <M> --unit <tipo/id> --json`
- `node scripts/forge-milestone-time-drain.js --inspect|--checkpoint --cwd <owner> --milestone <M> --json`
- `node scripts/forge-milestone-endpoint.js --verify|--prove|--record|--show --cwd <owner> --milestone <M> --json`
- `node scripts/forge-linked-task.js --status|--create --cwd <owner> [--milestone <M>|--task <T>] --json`
- `node scripts/forge-linked-task-start.js --status|--handoff|--close` (owner) e `--start|--continue|--close-chain` (só embutidos)
- `node scripts/forge-linked-task-horizon.js --status|--admit|--inspect-drain|--checkpoint` e `--extend` (só embutido)

Saída 0 sucesso, 2 uso e 3 recusa. A recusa da CLI avulsa numa ação viva é o
comportamento correto: não se repete a chamada com outros argumentos.

## Códigos

- Opções: `time-option-pending`, `time-options-invalid`, `time-roadmap-nonconformant`,
  `time-allocation-pending`, `time-scope-unallocated`, `time-option-ready`,
  `time-option-resume-invalid`, `time-decision-attestation-required`.
- Milestone: `milestone-budget-exhausted`, `milestone-budget-draining`,
  `milestone-time-invalid`, `milestone-clock-unknown`, `milestone-endpoint-closed`.
- Retomada: `budget-resume-ready`, `budget-extension-required`,
  `budget-checkpoint-required`, `pending-questions`.
- Task ligada: `predecessor-incomplete`, `linked-task-not-started`,
  `linked-task-budget-exhausted`, `linked-task-budget-draining`,
  `linked-task-time-invalid`, `linked-task-clock-unknown`,
  `linked-task-chain-closed`, `linked-task-closed`,
  `linked-task-authorization-required`, `linked-task-already-started`,
  `linked-task-handoff-stale`.

## Limites

- Adaptador vivo embutido obrigatório: sem ele, decisão, criação, início,
  continuação, encerramento da cadeia e extensão ficam pendentes, nunca fabricados.
- Guarda de transporte: confere os registros imutáveis antes do provider nos
  adaptadores e callbacks do Forge. Não reatesta autoridade ao vivo e não intercepta
  chamada bruta feita fora deles nem comportamento da interface do cliente.
- Contexto das pernas de revisão: perna externa sem contexto real de milestone ou de
  task ligada não tem a garantia do horizonte; isso é declarado, não suposto.
- `milestone_cleanup` `archive` ou `delete` antes do endpoint move ou apaga as
  fontes da milestone e impede a prova (`endpoint-sources-missing`); a preferência
  não é alterada pelo Forge.
- Filhos de lote nativo não são observáveis pelo drain e ficam desconhecidos.
- Painel VS Code, dashboard e statusline não mostram campos de tempo.

## Disponibilidade

- Implementado: seleção, contrato, relógio, previsão, avisos, teto, drain,
  checkpoint, extensão, endpoint, congelamento, task ligada, horizonte, guardas e
  superfícies de status, testados offline com transportes simulados.
- Distribuído: o contrato `shared/forge-milestone-time.md` e as skills
  `forge-auto`, `forge-next`, `forge-new-milestone`, `forge-task` e `forge-status`,
  pelos renderers Claude e Codex.
- Condicional: decisões e início dependem do adaptador vivo embutido pelo host; o
  esforço observado depende do leitor vivo; o drain depende das sondas vivas.
- Desconhecido: execução e compreensão pelo cliente instalado. Distribuição e
  projeção não demonstram execução no cliente.

## Fatos separados da entrega

Implementação, verificação local, CI, revisão, merge, release, instalação e UAT são
fatos separados; um não prova o outro. O UAT humano desta entrega foi dispensado e
não foi realizado.

### Inventário de verificação da T07

Verificação local do worker (14 comandos, executados pelo owner na árvore final):

1. `node scripts/forge-milestone-time-chain.test.js`
2. `node scripts/forge-milestone-time.test.js`
3. `node scripts/forge-claude-renderer.test.js`
4. `node scripts/forge-codex-renderer.test.js`
5. `node scripts/forge-dispatch-source-guard.test.js`
6. `node scripts/forge-communication-evaluation.test.js`
7. `node scripts/forge-source-manifest.test.js`
8. `node scripts/forge-procedure-context.test.js`
9. `node scripts/forge-installer.test.js`
10. `node scripts/forge-instructions.test.js`
11. `node scripts/forge-delivery.test.js`
12. `node scripts/forge-release-version.test.js`
13. `node scripts/forge-release-impact.test.js`
14. `node scripts/forge-update.test.js`

Operações do owner, pendentes até evidência própria (não fazem parte dos 14):

- consolidação da slice;
- regressão completa `node scripts/run-tests.js`, comparada rótulo a rótulo com o
  baseline do `master` no mesmo ambiente;
- `node scripts/forge-smoke.js`;
- security gate final;
- revisão independente final;
- relatório de entrega por critério;
- auditoria da distribuição (distribuído, demonstrado, condicional e desconhecido);
- PR, checks, merge, release e instalação.

UAT humano (S03-UAT): dispensado, não realizado.
