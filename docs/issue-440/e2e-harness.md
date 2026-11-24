# Harness E2E determinístico sobre a gravação — issue #440 (S03/T03)

**Suíte:** `scripts/forge-issue-440-e2e.test.js` · **Gravação:** `scripts/fixtures/issue-440/e2e/` (rótulo `recorded`, origin `captured`, execution_mode `replay`) · **Rota:** host Claude Code → worker Codex (app-server), sidecar

Este harness reproduz no CI padrão, sem segredo, rede, conta ou provedor, a gravação
genuína e sanitizada da T02. Os bytes gravados passam pelo parser real do transporte
(`runUnitSidecar` → `runExecute` → `invokeCodexAppServer` → `startAppServerTurn`) e
pelas APIs públicas atuais da S01 e da S02: execution_contract v2, hook de evidência,
falha injetada, replay, abandono seguro e sucessor no mesmo controller begin.

## O que é real e o que é reproduzido

- **Real nesta execução:** `runUnitSidecar`, `recoverUnitSidecar`, `abandonAttempt` e o sucessor canônico; `runExecute`, `invokeCodexAppServer`, `startAppServerTurn` (parser JSON-RPC real) e o assembler; recibos e publicação; controller begin, lease e claim gate; atividade protegida do owner; custódia `forge-process-tree`; cerca `managed-surfaces-v1`; e o caminho real `forge-hook.js` → `appendHookEvidence`.
- **Reproduzido:** o processo do worker é um *replayer* local, escrito em tempo de teste no Temp próprio do harness e apontado por `FORGE_XLLM_CODEX_BIN`. Ele lê só o canal `worker` de `recording.jsonl` e responde às requisições do cliente na ordem gravada, por método. Os ids JSON-RPC do cliente são remapeados e os ids gravados como sha256 viram placeholders transparentes (`thread-<16 hex>`, `turn-<16 hex>`, `item-<16 hex>`). Texto livre que a gravação só guarda como hash é omitido; a resposta final, retida em claro e varrida, é repassada byte a byte.
- **Sem provedor:** `FORGE_XLLM_CLAUDE_BIN` aponta para um stub que conta e recusa qualquer chamada; `provider_calls` tem de ser 0. Variáveis de credencial são removidas durante a suíte e restauradas no fim.

## Separação no relatório

Cada caso imprime uma linha JSON com `case`, `label`, `platform`, `custody`, `route`, `versions`, `attempt`, `hashes`, `captured_bytes`, `synthetic_stimuli`, `harness_effects`, `provider_calls`, `transport_calls` e `outcome`.

Para preservar as nove observações quando o supervisor limita stdout a 10 KB,
`FORGE_ISSUE_440_E2E_REPORT` pode apontar para `cases.json` inexistente em um diretório
próprio sob o Temp inicial. A mesma execução grava com `wx` o hash estável do source,
as nove linhas completas e o resultado; o caller deve vincular esse arquivo à captura
real do comando. Isso não autoriza uma segunda execução para obter saída perdida.

- `captured_bytes`: as faixas de `seq` da gravação efetivamente consumidas ou emitidas pelo replayer, a sequência de métodos do cliente e o número de substituições de placeholder.
- `synthetic_stimuli`: o que o harness injeta. São o corte do stream antes da resposta final, o auxiliar descendente controlado, o hook concorrente do host, a edição manual de mesmo schema, as cópias relabeladas e o byte alterado.
- `harness_effects`: o que o próprio harness executa. O replay JSON-RPC não aplica a escrita histórica da ferramenta, então o replayer materializa explicitamente **só** o arquivo reclamado `same.txt` com `after` e LF, no momento do `item/completed` do `commandExecution` gravado. Esse efeito é declarado e nunca é um comando capturado executado.

A linha final traz `<passados>/<total>`, plataforma, custódia (`native` ou `unavailable`), transporte `recorded-replay`, `provider_calls 0` e `transport_calls`.

## Casos

| Caso | Rótulo | Bytes capturados | Estímulos sintéticos | Efeitos do harness | Limite por plataforma |
|---|---|---|---|---|---|
| `contract-v2-recorded-success` | `recorded` | canal worker inteiro (seq 5–185) | hook concorrente do host na janela | `same.txt` = `after` + LF | win32 exige custódia nativa; custódia indisponível falha o caso |
| `replay-first-zero-transport` | `recorded` | nenhum novo (recibo `ready` do caso anterior) | nenhum | nenhum | igual nos três SOs; processo novo só faz replay |
| `injected-failure-abandon-successor` | `recorded` | worker seq 5–180 no original; worker inteiro no sucessor | corte antes da resposta final, saída não zero (código 7) do processo app-server real tipada como `appserver-exit-nonzero`, auxiliar descendente que escreve no claim e espera | `same.txt` = `after` + LF só no sucessor | win32: abandono com custódia nativa atual, backup, reset nos claims e sucessor; linux e darwin: `abandon-descendants-unproved`, sem reset e sem sucessor |
| `hook-evidence-window` | `recorded` | os do primeiro caso | hook `PostToolUse` real (`forge-hook.js`) durante a janela | nenhum | igual nos três SOs |
| `manual-edit-refused` | `recorded` | canal worker inteiro | append manual de mesmo schema em `.gsd/forge/events.jsonl` e hook na mesma janela | `same.txt` = `after` + LF | igual nos três SOs |
| `labels-recorded-never-real` | `recorded` | gravação verificada, sem replay | cópia relabelada para `real` | nenhum | igual nos três SOs |
| `mock-relabel-refused` | `mock` | nenhum (fixture sintética) | cópias da `e2e-mock` relabeladas | nenhum | igual nos três SOs |
| `recording-tamper-refused` | `recorded` | cópia da gravação | um byte alterado na cópia | nenhum | igual nos três SOs |
| `docs-tables-match` | `recorded` | nenhum | nenhum | nenhum | igual nos três SOs |

O caso `docs-tables-match` confere que esta tabela é igual, na ordem, aos casos executados
pela suíte e que a seção `## Códigos do verificador` de `windows-evidence.md` é igual a
`REASON_CODES` de `scripts/forge-e2e-evidence.js`.

## O que cada caso prova

- **`contract-v2-recorded-success`:** o manifesto verifica `recorded` antes do caso. A sequência de métodos do cliente atual (`initialize`, `initialized`, `thread/start`, `turn/start`) é igual à gravada. O recibo fica `ready`, e o resultado montado, o publicado e o do recibo têm o status e o conteúdo da resposta final gravada. Há exatamente uma chamada de transporte, e o `operator.txt` pré-existente fica intacto.
- **`replay-first-zero-transport`:** `recoverUnitSidecar` publica por replay duas vezes no mesmo processo e uma vez num processo Node novo, com zero chamadas ao replayer e sha256 estáveis de recibo, resultado, eventos e snapshot do owner.
- **`injected-failure-abandon-successor`:** o recibo fica `failed`, sem saída durável. A recusa operacional é `replay-refusal-transport-no-output`. No win32 a prova de descendentes vem da custódia nativa deste processo, com o handle vivo do processo do replayer obtido por observação transparente de `startAttemptTree`, nunca por evento gravado nem por PID. O backup é verificado e o reset fica só nos claims. O sucessor usa `recoveryDispatchId` no **mesmo** controller begin, com a mesma geração de lease, o mesmo claim, a autoridade e as perguntas preservadas e o teto integral do tier. Ele conclui com o stream gravado de sucesso. Não há segundo `controller.begin`.
- **`hook-evidence-window`:** com a janela do owner aberta e o recibo `started`, o hook real grava uma linha no journal externo de `hook-evidence`, fora do owner. O snapshot protegido não muda e a tentativa chega a `ready`, sem `execution-protected-metadata`. O nome do arquivo casa com o padrão declarado da superfície, cujo writer é `appendHookEvidence`.
- **`manual-edit-refused`:** o append manual de mesmo schema na superfície `owner-events` é recusado com `execution-protected-metadata`. O diagnóstico traz `managed-surface-unattributed`, sha256 antes e depois e um diff sanitizado (`append`, uma linha) sem o conteúdo manual. O hook da mesma janela não é a mudança recusada.
- **`labels-recorded-never-real`:** `verifyEvidence` e o CLI aceitam `recorded`. `--expect real` recusa com `e2e-expect-mismatch`, e a cópia relabelada para `real` recusa com `e2e-real-requires-live`.
- **`mock-relabel-refused`:** a `e2e-mock` continua `mock`. Relabelar só o manifesto recusa com `e2e-label-origin-mismatch`; relabelar também origin e execution_mode recusa com `e2e-synthetic-promotion`.
- **`recording-tamper-refused`:** um byte alterado numa cópia recusa com `e2e-file-hash-mismatch`, também pelo CLI, e a gravação original continua verificando.

## Diagnóstico e ajuste do estímulo

Histórico observado na execução de desenvolvimento local da T03, em 2026-11-22, no win32 com custódia nativa, e corrigido no fix-s03 (R3). Não é uma alegação de CI.

- **Defeito observado (`e2e-transport-defect`).** No caso `injected-failure-abandon-successor`, o cliente real do app-server encerrava a falha de saída não zero com a mensagem "app-server exited with code N", sem código tipado. O recibo registrava `reason_code` `sidecar-unit-failed` (`error_class` `terminal`), e o censo fechado de `replay-refusal-v1` (`SOURCES` de `scripts/forge-replay-refusal.js`) não tinha fonte de saída não zero do app-server. A classificação resultava em `replay-refusal-unknown-code`, bloqueante, e o abandono e o sucessor nunca eram alcançados na rota principal host Claude → worker Codex. Naquela execução o estímulo foi trocado por silêncio anômalo (watchdog real), que provava só o caminho do silêncio.
- **Correção.** O handler `close` de `startAppServerTurn` (`scripts/forge-appserver-client.js`) passa a emitir o código tipado estreito `appserver-exit-nonzero` (`APPSERVER_EXIT_CODES.NONZERO_EXIT`) somente quando o filho fecha sem sinal e com código inteiro diferente de zero, com o turno ainda não liquidado. A mensagem e o stderr emendado ficam como antes, então a classificação transitória não muda, e a corrida do turno concluído (`matchedCompletion() && pending.size === 0`) e o resultado de sucesso são preservados. Saída por sinal, saída zero, timeout, cancelamento e os demais códigos mantêm seus caminhos.
- **Censo.** `scripts/forge-replay-refusal.js` ganha uma linha em `replay-refusal-transport-no-output` (`appserver-exit-nonzero`, fase `failed`, sem timeout, símbolo `APPSERVER_EXIT_CODES`). O fallback genérico `sidecar-unit-failed` do unit sidecar cobre erros arbitrários do chamador e **não** entra no censo: continua bloqueante (`replay-refusal-unknown-code`). O código sozinho nunca concede elegibilidade, e identidade, claim, perguntas, autoridade, ausência de saída retida e execução completa continuam bloqueando antes da tabela. `scripts/forge-replay-refusal.test.js` fixa a linha, os negativos de portas independentes e o bloqueio do código genérico.
- **Estímulo atual do caso.** O replayer, que é o processo filho real do app-server, escreve o claim pelo helper controlado e sai com código 7 no meio do turno (modo `exit-nonzero`, estímulo sintético `exit-nonzero-app-server`). Rodam o parser, o cliente, a árvore de processos e o produtor de erro reais, sem seam de relógio, e nada é simulado. O caso afirma o código tipado em `failure.code` e no recibo (não `sidecar-unit-failed`), a recusa `replay-refusal-transport-no-output`, o abandono com a custódia nativa viva, o backup e o reset só nos claims e o sucessor no mesmo begin, com o stream gravado de sucesso. O silêncio anômalo continua coberto pela suíte da S02 e pelo censo, não neste caso.
- Se o caso encontrar de novo uma recusa bloqueante, ele ainda prova a recusa sem mutação (uma única chamada de transporte, nenhum sucessor, nenhuma prova, backup ou reset, recibo falho imutável, mesmo begin, geração, claim e transações, recusa registrada uma vez) e falha com o achado nomeado, nunca com sucesso fabricado. A execução original falha permanece no histórico.

## Como rodar

```
node --check scripts/forge-issue-440-e2e.test.js
node scripts/forge-issue-440-e2e.test.js
```

A suíte cria primeiro o isolamento: HOME, USERPROFILE e CODEX_HOME vão para um diretório
descartável, e o harness existente (`createFixtureHarness`) isola TEMP, TMP e FORGE_HOME e
troca a conta. Só depois os adapters são carregados. As raízes Git são descartáveis e
próprias da fixture. Tudo é removido no `finally`, e as variáveis são restauradas. Não rode
git enquanto a suíte estiver em execução.

## O que a gravação histórica não prova

- Que as APIs novas (contrato v2, hook, recusa, abandono, sucessor) rodaram na captura original. A captura é de uma tentativa de sucesso; tudo o que vai além disso é exercitado aqui pelas APIs atuais sobre bytes reproduzidos.
- Que o writer atual parou. O evento gravado de custódia (`process-tree-custody-v1`, `stopped`) é histórico; a prova de writer e descendentes parados vem só da custódia viva deste processo.
- Que um provedor respondeu agora. O replay é `recorded` e nunca `real`; o `provider_called` que o recibo registra reflete a visão do transporte sobre o replayer, não uma inferência nova.

## Limites

- **Plataforma.** Custódia nativa só existe no win32. Lá, custódia indisponível falha o caso e nunca vira skip. Em linux e darwin o abandono recusa com `abandon-descendants-unproved`, sem reset e sem sucessor. A execução nos três SOs e nos shards Windows do CI final é gate pendente (GF2, GF5).
- **Gravação sanitizada.** Deltas de mensagem e textos de comentário só existem como hash e não são reconstituídos. A sequência e o conteúdo da resposta final são os gravados.
- **Achados.** Gravação insuficiente para o parser vira o achado nomeado `e2e-recording-insufficient`; defeito de transporte vira `e2e-transport-defect`. Os dois vão para o fix-s03 e nunca são corrigidos editando produção ou a gravação nesta task.
- **Fora daqui.** Nada aqui prova CI final, revisão, merge, release, instalação ou UAT.
