# Roteamento, capabilities e esforço — diagnóstico 2026-09-30

Base da fonte e do worktree isolado: `223e6fa6c3cc140f68dda98e5f54263be67fa0f3`.

**Escopo da evidência.** As fixtures deste PR não fazem inferência real: usam um `claude` e um
app-server Codex falsos, contas sintéticas e diretórios temporários (HOME/FORGE_HOME/CLAUDE_CONFIG_DIR
temporários na matriz vertical). A investigação e a implementação deste trabalho, por outro lado,
foram conduzidas com os provedores configurados do operador e leram as prefs existentes; nenhuma pref
global, conta, autenticação ou instalação (`~/.forge-agent`, `~/.claude`) foi alterada.

## Causas

1. **review-fix sem entrega sidecar.** O resolver conhecia `review-fix`, mas `UNIT_MODES`
   (`scripts/forge-transport-capabilities.js`) não o listava, `forge-unit-sidecar` não tinha fronteira
   nem ramo de entrega e as três skills recusavam com o literal `unsupported-sidecar-unit`.
2. **Clamp por família.** A regex `^claude-(haiku|sonnet)` limitava todo Sonnet/Haiku a `medium`,
   inclusive `claude-sonnet-5-5` e Sonnet 5, cuja documentação de effort lista a escala completa.
   Sonnet 4.6 documenta low/medium/high/max (sem `xhigh`).
3. **Esforço de review sem consumidor.** `forge-xllm` já aceitava `--effort` em
   challenge/defend/rebuttal, mas os chamadores canônicos nunca o passavam e o schema não tinha chave
   por estágio.

## Reproduções

- **Original (base `223e6fa`, fonte e instalação com hashes iguais — `forge-dispatch-resolve.js`
  `113ffe718a0d330a30b21377b99d403b317a8be70a05afba992cf011195f31fd`,
  `forge-transport-capabilities.js` `634ae12952baf2372ed84239f869f484c358894d15fb501b82a9445c1714db37`):**
  `node <fonte-ou-instalação>/scripts/forge-dispatch-resolve.js --unit-type review-fix --host-runtime claude --cwd C:/SVN/CMA/WDMA --json`
  → modelo `gpt-6.1-sol`, effort `medium` (`unit-type:review-fix`), host `claude`, engine `codex`,
  `worker_mode sidecar`, `dispatch_allowed:false`, `unsupported-sidecar-unit`, camada
  `transport-capability-before-spawn`, `providerCalled:false`. Trocar versões GPT não era a causa.
- **Depois da mudança (fixture):** a mesma rota (host claude → engine codex) é permitida pelo
  resolver e pelo guard e entrega via `forge-unit-sidecar` com app-server falso; a inversa (host codex
  → engine claude) entrega com CLI falso — `scripts/forge-bidirectional-sidecar.test.js`. A consulta read-only final em `C:/SVN/CMA/WDMA` confirmou a rota permitida na fonte
  corrigida e a recusa antes do spawn na instalação preservada. Essa resolução não é prova de
  execução de um provedor.

## Arquitetura

- `scripts/forge-model-policy.js` (`2026-09-30.1`): dono do clamp, do `thinking_header` e dos limites de
  transporte. Entradas `documented` com fontes e data de consulta: Sonnet 5.5, Sonnet 5 (escala
  completa) e Sonnet 4.6 (`xhigh` recusado por nome, nunca rebaixado). `legacy-preserved`: Haiku 4.5
  (teto `medium`), Opus 5 e Fable 5 (header adaptive). Id sem entrada: regra literal antiga +
  `model-policy-unknown`. Nada troca o modelo.
- `scripts/forge-review-fix.js` + `forge-xllm.runFix` (núcleo de escrita compartilhado com execute) +
  modo `fix` em `forge-unit-sidecar`: fronteiras `slice`, `task` e `milestone-triage`; claim gate com
  `decision: proceed` obrigatório e claim recalculado; realpath dos alvos do claim dentro de
  `CODE_DIR` (link/junção recusado); snapshot dos REVIEW.md e do estado de reset; receipt
  `started → ready/failed`; publicação e commit pelo pai (só git + `auto_commit:true`), com
  `Forge-Dispatch-Id`, reconciliação por trailer **e** por paths/hashes, hashes dos arquivos verificados
  e dos REVIEW.md conferidos **antes** de qualquer commit (`review-fix-concurrent-change`,
  `review-fix-review-conflict`).
- Correlação de triagem: a identidade de item é `review_file + R#`, conservada no prompt, schema, validação, notas e publicação. R# sozinho permanece compatível apenas quando não ambíguo.
- Aceitação nativa (`forge-review-fix.js --accept-native`): resultado por R#, `auto_commit`, SHA
  existente, descendente do `startSha`, ainda alcançável de HEAD e só com arquivos do claim; arquivo
  alterado não implica que todos os itens nele foram corrigidos. Snapshot prévio de hashes é obrigatório: o delta completo, inclusive escritas não commitadas, é conferido em ambas as políticas de commit; dirties anteriores inalterados são preservados.
- Adaptador nativo Claude: ID completo só quando as capabilities **ativas** listam o id
  (`model_ids`); sem essa observação, alias + `model_version_proof: alias-only` (Sonnet 5.5). A linha
  `thinking:` do frontmatter não é controle por subagente (herdado da sessão): vira apenas o
  diagnóstico `native-thinking-declaration-inert`; a intenção explícita (pref `thinking`) é recusada
  pelo resolver. `effort_requested` usa o valor pré-clamp da rota quando presente.
- `scripts/forge-review-effort.js`: esforço opt-in por leg (Codex app-server, Claude CLI, nativo
  Claude por binding observado, nativo Codex por `reasoning_effort` das capabilities observadas); só
  planeja. Os callers públicos xllm consomem as prefs por leg: override explícito > pref > ausência legada, sem aumento automático de custo. Valores inválidos, erros de prefs e thinking incompatível recusam antes do transporte. `effort_sent` é preenchido pelo chamador depois do lançamento.

- Callers públicos de review leem prefs do `contextRoot` quando fornecido, mantendo o código em
  `cwd`. Preflight incompatível emite `recusado`, camada nomeada e `provider_called:false`; o esforço
  enviado fica desconhecido até o lançamento efetivo. O CLI encaminha `--context-root` nos três legs.

## Contratos afetados

`review-fix` passa a ter modo `fix` (nunca alias de execute). Campos aditivos no resolver
(`effort_requested`, `policy_version`, `policy_entry`, `policy_diagnostics`, `thinking_requested`), nos
eventos `sidecar-unit`/receipts (`effort_requested/resolved/sent/applied`, `policy_*`) e no dispatch
event (só quando presentes na rota). `--shell-exports` e o envelope de execute não mudam. Novo tipo
`unit-sidecar` no source guard: o chamador `forge-unit-sidecar.js --request` é verificado pelo caminho
de dados (JSON do resolver salvo → `route` do request), não por flags de argv.

## Combinações não suportadas (recusas nomeadas antes do spawn)

| Combinação | Código |
|---|---|
| review-fix sidecar com engine agy ou desconhecida | `unsupported-sidecar-unit` (camada de transporte; o guard recusa agy já na postura: `runtime-posture-unmapped`) |
| claim divergente, decisão ≠ `proceed`, alvo por link/fora do `CODE_DIR` | `review-fix-claim-mismatch` |
| item com traversal, caminho absoluto ou `.gsd/**` | `review-fix-items-invalid` |
| item sem path | `pathless-conceded-item` |
| fronteira inválida | `review-fix-boundary-invalid` |
| `thinking.sonnet_phases: disabled`/`enabled` com Sonnet 5.5 (engine claude) | `thinking-disabled-incompatible` / `thinking-enabled-incompatible` |
| `between_tools` em qualquer transporte Claude (CLI ou nativo) | `thinking-transport-unsupported` |
| effort não documentado (ex.: Sonnet 4.6 + `xhigh`) | `effort-unsupported-by-model` |
| Claude CLI abaixo de 2.1.284 com Sonnet 5.5 | `claude-cli-version-unsupported` |
| esforço diferente do binding nativo | `native-effort-binding-mismatch` |
| esforço de review com agy / valor inválido | `effort-transport-unsupported` / `review-effort-invalid` |

## Limites honestos

- `effort_applied`/`model_observed` ficam `null`: nenhum transporte lê de volta o que o provedor aplicou.
  `effort_sent` só recebe o argumento que um adaptador realmente passou a um transporte lançado.
- O alias nativo não prova a versão executada; um ID completo é argumento do adaptador, não observação.
- O sandbox por raiz não é cerca por arquivo: a garantia de escopo do review-fix é a checagem pré-spawn
  (claim, realpath) + detecção pós-execução e reset cirúrgico; escritas transitórias durante o turno não
  são prevenidas. Sobreposição com arquivo previamente sujo não reseta nada (`operator-required`).
- A aceitação nativa exige hashes anteriores ao lançamento sob ambas as políticas de commit.
  Escritas novas fora do claim, inclusive sem commit, impedem publicar sucesso; bytes previamente
  sujos e inalterados não contam como correção. Alterações simultâneas de terceiros dentro do claim
  continuam uma limitação de atribuição de autoria, não uma garantia do sandbox.

## Testes (offline)

- `scripts/forge-bidirectional-sidecar.test.js` — matriz vertical: Claude→Codex e Codex→Claude via
  `runUnitSidecar` nas três fronteiras (argv/params reais dos provedores falsos, commit único do pai,
  bytes publicados nos REVIEW.md, receipts, eventos e replay com zero turnos); Claude→Claude e
  Codex→Codex via `buildNativeInvocation` + aceitação nativa nas três fronteiras; falhas (saída não
  zero, saída inválida, R# ausente/estranho, fora do claim com reset verificado, `.gsd`, commit do
  worker, parcial, conflito de REVIEW antes do commit, mudança concorrente antes do commit, queda entre
  commit e receipt); árvore suja preservada e sobreposição `operator-required`; recusas pré-spawn sem
  receipt; esforço de review nos params do app-server e no argv do CLI, com e sem as chaves.
- `scripts/forge-model-policy.test.js`, `scripts/forge-review-fix.test.js`,
  `scripts/forge-review-effort.test.js` (inclui invariância de `forge-cost-policy`),
  `scripts/forge-native-invocation.test.js`, `scripts/forge-dispatch-source-guard.test.js`, além das
  suítes de resolver, claude-sidecar, dispatch-event, review-emit, prefs e instalação.
- Gate offline ambos os hosts/win32: 11/11 passaram. No head `4e361df`, o CI concluiu
  14/14 checks verdes e as 266 suítes passaram em Linux, macOS e Windows. Esse resultado
  precede as correções adicionais da revisão independente descritas abaixo.
- Smoke local bruto: 2878 assertions passaram, 2 falharam, 10 foram puladas por limites de Windows/
  ausência de bash. As duas falhas foram reproduzidas nas mesmas seções da fonte base `223e6fa`:
  `(k)` depende do tier global do operador (gpt-6.1-sol, enquanto a fixture espera Claude); o check do
  schema instalado detecta drift no Codex CLI `0.159.2` (MCP UI, disabledPluginIds, descrições/enum de
  erros e conteúdo de imagem). Não são provas de rejeição de modelo nem de inferência real. A fonte
  de pin e as preferências globais permaneceram intactas; esta PR não corrige essas duas pendências
  preexistentes. Os testes determinísticos de schema/transportes permanecem no runner canônico.

## Correções adicionais da revisão independente (R1–R5)

A revisão do head `4e361df` encontrou cinco cenários que escapavam às fixtures anteriores:

- **R1 — replay de commit:** o recibo comparava hashes dos bytes da working tree com blobs Git.
  `core.autocrlf` e filtros clean podem produzir bytes diferentes para a mesma correção. A identidade
  Git normalizada deve ser capturada antes do commit e persistida separadamente do hash da working
  tree, que continua protegendo contra mudanças concorrentes. O trailer sozinho não comprova entrega.
  Recibos antigos sem `verified_git_blobs` não autorizam commit/publicação sob `auto_commit:true`
  em Git: `review-fix-git-identity-missing` mantém a recusa sem reconstruir evidência após o commit.
- **R2 — contrato nativo:** o prompt pedia status/SHA, mas a aceitação exigia resultados por item.
  O prompt deve entregar explicitamente `items` com uma entrada por par `review_file`/R#, incluindo
  itens não corrigidos; a ausência dessa evidência continua sendo uma recusa do pai.
- **R3 — retorno não terminal:** `partial`/`blocked` podiam publicar “aplicada” na aceitação nativa
  sem commit. Somente `done` pode fornecer evidência de sucesso, sob ambas as políticas de commit.
- **R4 — thinking na revisão nativa:** o helper de esforço montava uma rota sintética sem validar
  `thinking.sonnet_phases`. A preferência explícita deve ser validada mesmo quando esforço está
  ausente; a declaração inerte do frontmatter não substitui a preferência nem controla a sessão.
- **R5 — API direta Claude:** o guard do adaptador só recusava `between_tools`. Todas as combinações
  incompatíveis da política devem ser recusadas antes do probe de versão e do spawn de inferência.
  Execute/fix canônicos e os consumidores externos de revisão já tinham proteção no resolvedor;
  a correção fecha a defesa do boundary direto sem atribuir falha a esses callers protegidos.

Os testes adicionais usam contas/processos falsos e repositórios Git temporários, incluindo
normalização real de CRLF/filtros e publicação/replay. Nenhuma preferência, autenticação,
instalação ou política de isolamento do operador é alterada para fazer esses cenários passarem.

Validação desta rodada: 13 suítes focadas/de integração passaram, além das 11 suítes do gate offline
para ambos os hosts/win32. A matriz bidirecional levou 60 s; os checks de integração, 18,70 s;
o gate offline, 44,02 s. Não houve timeout. Uma execução direta da matriz herdou preferências
globais e falhou antes dos novos casos; o runner canônico com HOME isolado passou, sem alterar
as preferências para ocultar a falha. O revisor independente reconferiu R1–R5 com zero novos achados,
incluindo a identidade CRLF/Git real, quatro combinações de retorno não terminal e recusas de thinking
sem probe/spawn. A matriz completa e o smoke dos sistemas suportados são executados pelo CI do PR.
