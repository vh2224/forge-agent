# Avaliação de comunicação nos dois hosts

Esta avaliação compara quatro cenários em Claude Code no terminal e Codex no VS Code. O resultado é uma evidência offline reproduzível de apresentação e proveniência. A rubrica e a utilidade são avaliação do autor; compreensão e aparência percebidas ainda não foram medidas.

O aceite humano tem status **pending-final-round**, com referência a AUTONOMY-AUTHORIZATION.md. Nenhuma entrada declara UAT visual ou de compreensão aprovado. A autorização mantém a validação humana concentrada numa rodada final.

## Método e fontes

O registro [samples.json](./samples.json) tem schema_version 1 e oito entradas: diagnóstico, execução com agente, falha recuperável e decisão humana para cada host. Cada entrada traz antes, depois, canal e nota de utilidade. Os cenários de execução e falha também trazem pares de apoio: entrega/timeline e parcial/recuperação. Isso mantém uma proveniência própria por trecho, sem misturar uma citação de skill com uma saída de renderer.

A revisão base é 3e25c611a54b2bdd23f11cb11eb474b3facc95e3, informada no handoff do owner. O registro fixa o SHA-256 dos bytes de [shared/forge-communication.md](../../shared/forge-communication.md) e do [arquivo histórico de modelos](./skill-templates-before.md). Mudanças nessas fontes exigem atualizar a avaliação; o validador rejeita divergências.

Proveniência da atualização do contrato (T-20261101004951-comunicacao-pessoal): o contrato ganhou a seção “Consulta simples” (interface resumida primeiro, conteúdo integral só em diagnóstico pedido e limite da proteção declarado). Somente `contract_sha256` foi atualizado para os bytes novos, de `d409a0cc91b426bd0e407931a6168185d745080a4d5d56e77839e628189781b3` para `ac32504157a07a2445cfd0ba3061ee397a82695334021099e191365aefe11bbc`. Entradas, limites e aceite humano (**pending-final-round**) ficam inalterados; as amostras não foram reavaliadas contra a nova seção.

Os rótulos formam um conjunto fechado:

- **observado**: exigiria um trace real sanitizado. Não é usado neste corpus porque não houve execução de host observada.
- **renderizado-offline**: saída completa dos renderers atuais, com entrada sintética e opções guardadas, reproduzida byte a byte.
- **modelo-da-skill**: citação literal do arquivo histórico anterior ou de uma skill atual, com fonte e SHA-256. Placeholders continuam placeholders.
- **redigido**: exemplo escrito pelo autor para ilustrar a organização de uma decisão; não é resposta observada de um modelo.

“Antes” significa a linha técnica de identidade, o modo de compatibilidade summary:false dos renderers atuais, ou o modelo histórico da skill. Não significa captura da instalação anterior. “Depois” usa a linha humana ou o resumo padrão atual; os exemplos redigidos continuam rotulados. As entradas são sintéticas e não contêm dados de operador, tokens ou IDs reais. O único prefixo absoluto permitido é C:/synthetic-forge-fixture/ (ou seu equivalente POSIX), nos dados sintéticos de reprodução e na saída completa renderizada. Sua ocorrência é contada, não escondida. Os segmentos . e .. e qualquer saída desse prefixo são recusados. Metadados source.file e source.reference usam somente arquivo relativo ao repositório e arquivo#âncora; mesmo um caminho sintético absoluto é recusado nesses campos. Cada string e chave aninhada de source é validada recursivamente, inclusive campos de input/options que o renderer ignora. A exceção de caminhos sintéticos vale somente para entradas/opções de reprodução e seu texto completo reproduzido; não dispensa a checagem de dados proibidos.

O [validador](../../scripts/forge-communication-evaluation.test.js) chama em memória formatIdentityLine, formatHumanIdentity, renderRecovery com e sem resumo e renderDeliveryMarkdown com e sem resumo. Ele confere citações, forma, proveniência, rubrica, métricas e hash do contrato, e rejeita alterações do texto completo, extração, métricas, ocultação de desconhecidos e omissão de conteúdo humano relevante. A verificação é somente leitura: nunca regenera JSON ou README para esconder drift.

## Rubrica

A ordem das cinco posições nas tabelas é **resultado / fase / executor / próximo passo / decisão pendente**. Os valores são:

- **presente**: o elemento está explícito no trecho.
- **ausente**: o trecho não comunica o elemento.
- **desconhecido**: a informação permanece desconhecida ou incompletamente observada; isso não é resultado negativo presumido.
- **nao-aplicavel**: o elemento não se aplica ao trecho. Valor admitido; não foi necessário nestas amostras.

Cada rubrica tem assessment:author. Não há escore de aprovação, inferência de ganho causal nem conversão dessa avaliação em aceite humano. Uma linha de identidade não descreve sozinha o resultado buscado; essa lacuna permanece na rubrica e o par timeline mostra a superfície complementar. O diagnóstico também preserva executor e fase não observados.

## Saída completa e vista humana

Cada amostra guarda texto completo, volume e sinais de despejo técnico. A human_view guarda regra, texto e métricas independentes. Linhas incluem linhas vazias internas e desconsideram somente o separador final; caracteres contam pontos de código Unicode, inclusive quebras de linha.

O detector conta hash hexadecimal de 64 caracteres, identificador técnico de dispatch ou receipt, caminho absoluto (drive Windows, UNC e POSIX) e linha com pelo menos dois helpers forge-*.js. São quatro categorias de despejo. Os tokens exatos /forge-auto, /forge-next, /forge-task e /forge-status são comandos de skill, não caminhos; acrescentar um componente de caminho volta a ser detectado. A referência curta e sintética “registro técnico dispatch fixture-nav” é contada separadamente como navigation_references; não é lista de IDs e não é apagada. A identidade técnica dispatch=fixture-nav continua contada como despejo.

A política de tokens reconhece caminhos junto de delimitadores Markdown comuns: crases de código, colchetes, negrito com asteriscos, ênfase com sublinhado, sinais de menor/maior, chaves, aspas simples/duplas e parênteses, além de espaço, início de linha e atribuição. Fechamentos de formatação e pontuação final não fazem parte do caminho; sublinhados internos continuam caracteres de arquivo. A formatação preserva a exigência de prefixo sintético e a recusa de caminhos privados ou com travessia. Somente os quatro comandos exatos acima são dispensados, inclusive quando formatados; um comando com caminho filho continua contado e recusado. As matrizes exercitam os dez formatos em valores e chaves aninhados ignorados de input/options e nas referências estritas, com bytes de renderer idênticos, contagens esperadas independentes, positivos sintéticos e negativos de travessia. As referências sintéticas formatadas também são reproduzidas no registro completo, contadas ali e retiradas da vista humana pela mesma regra canônica.

Regras determinísticas:

- **complete-v1** conserva o trecho inteiro; é usada nas formas anteriores e em citações/exemplos redigidos.
- **identity-human-v1** conserva a linha [forge-agente] inteira, inclusive executor, modelo enviado sem aplicação confirmada, acompanhamento e eventual provedor desconhecido/próxima ação.
- **recovery-human-v1** remove as referências Fonte:/SHA-256:, o instante de captura e o aviso de localização do registro técnico. Quando a mesma linha Fonte: termina com conflitos, conserva a contagem junto do artefato; os exemplos incluem conflitos: 2 e conflitos: 0. Conserva todas as demais linhas: resumo, estados, textos completos das decisões, aceites, resultados, desconhecidos, famílias não cobertas e próxima ação. A repetição entre resumo e registro permanece visível; não se reivindica concisão ótima.
- **delivery-human-v1** conserva o resumo integral e cada descrição, situação, resultado de evidência (ok, falha, limite), motivo/limitação, ambiente e pendência dos critérios, além da situação de todos os fatos independentes. Remove a referência ao detalhe e somente as referências técnicas das evidências e dos fatos; a coluna Evidência continua com os resultados e motivos. Os exemplos incluem source_context_missing:environment e uma cobertura desconhecida, sem confundir falta de contexto com sucesso. A tabela completa fica intacta no registro. Negativos independentes exigem a preservação das contagens de conflito, de cada resultado e de cada motivo, mesmo quando as métricas da vista adulterada são recalculadas. Outros negativos mantêm os bytes renderizados idênticos e recusam caminhos privados drive Windows, UNC e POSIX em source.reference e nos campos aninhados ignorados de input/options.

A exigência de zero despejo depois vale para a **vista humana**. A saída completa preserva fontes e detalhes técnicos para reprodução e auditoria. O resumo pode aumentar o volume total; as tabelas mostram esse custo. As regras não escolhem uma substring vazia nem removem perguntas, desconhecidos ou próxima ação para obter zero.

## Comparação por host e cenário

Em “volume”, cada lado mostra **completo linhas/caracteres; humano linhas/caracteres**. Em “despejos”, cada lado mostra **completo/humano**, somando as quatro categorias; a referência curta de navegação é separada no JSON. Os números vêm das amostras, e o validador exige correspondência literal de todas as linhas desta tabela.

| Host | Cenário | Proveniência antes → depois | Rubrica antes → depois | Volume antes → depois | Despejos antes → depois | Utilidade (avaliação do autor) |
|---|---|---|---|---|---|---|
| claude-code-terminal | diagnostico | renderizado-offline → renderizado-offline | presente/desconhecido/desconhecido/presente/presente → presente/desconhecido/desconhecido/presente/presente | 48/2101; 48/2101 → 56/2582; 50/1767 | 10/10 → 10/0 | O resumo antecipa situação e próxima ação; a vista humana conserva todas as linhas semânticas, inclusive a decisão e os desconhecidos. A saída completa cresce; a utilidade percebida ainda não foi medida. |
| claude-code-terminal | execucao-com-agente | renderizado-offline → renderizado-offline | ausente/presente/presente/ausente/ausente → ausente/presente/presente/presente/ausente | 1/244; 1/244 → 1/270; 1/270 | 1/1 → 0/0 | A identidade humana explica executor e onde acompanhar; a descrição do trabalho vem do modelo de timeline, e a entrega separa critérios de CI, instalação e aceite. Não se atribui melhora percebida. |
| claude-code-terminal | falha-recuperavel | renderizado-offline → renderizado-offline | ausente/presente/presente/ausente/ausente → ausente/presente/presente/presente/ausente | 1/266; 1/266 → 1/399; 1/399 | 1/1 → 0/0 | A falha mantém o provedor desconhecido e orienta inspeção antes de tentar de novo. O parcial explicita o que continua executável; a amostra não prova retomada real nem disponibilidade do destino. |
| claude-code-terminal | decisao-humana | redigido → redigido | presente/ausente/ausente/desconhecido/presente → presente/presente/desconhecido/presente/presente | 1/218; 1/218 → 5/537; 5/537 | 0/0 → 0/0 | A pergunta redigida fica separada do progresso e conserva ID, consequência e ausência de consentimento por silêncio. Não demonstra apresentação de cartão, resposta humana ou funcionamento da ferramenta. |
| codex-vscode | diagnostico | renderizado-offline → renderizado-offline | presente/desconhecido/desconhecido/presente/presente → presente/desconhecido/desconhecido/presente/presente | 48/2101; 48/2101 → 56/2582; 50/1767 | 10/10 → 10/0 | O resumo antecipa situação e próxima ação; a vista humana conserva todas as linhas semânticas, inclusive a decisão e os desconhecidos. A saída completa cresce; a utilidade percebida ainda não foi medida. |
| codex-vscode | execucao-com-agente | renderizado-offline → renderizado-offline | ausente/presente/presente/ausente/ausente → ausente/presente/presente/presente/ausente | 1/235; 1/235 → 1/261; 1/261 | 1/1 → 0/0 | A identidade humana explica executor e onde acompanhar; a descrição do trabalho vem do modelo de timeline, e a entrega separa critérios de CI, instalação e aceite. Não se atribui melhora percebida. |
| codex-vscode | falha-recuperavel | renderizado-offline → renderizado-offline | ausente/presente/presente/ausente/ausente → ausente/presente/presente/presente/ausente | 1/257; 1/257 → 1/390; 1/390 | 1/1 → 0/0 | A falha mantém o provedor desconhecido e orienta inspeção antes de tentar de novo. O parcial explicita o que continua executável; a amostra não prova retomada real nem disponibilidade do destino. |
| codex-vscode | decisao-humana | redigido → redigido | presente/ausente/ausente/desconhecido/presente → presente/presente/desconhecido/presente/presente | 1/218; 1/218 → 5/537; 5/537 | 0/0 → 0/0 | A pergunta redigida fica separada do progresso e conserva ID, consequência e ausência de consentimento por silêncio. Não demonstra apresentação de cartão, resposta humana ou funcionamento da ferramenta. |

## Pares complementares

A tabela abaixo mede também os trechos de entrega, timeline, parcial e recuperação, sem fundi-los com a identidade. As rubricas, rótulos e fontes individuais estão no JSON. Nenhum trecho modelo-da-skill é tratado como ferramenta acionada.

| Host | Par | Proveniência antes → depois | Volume completo antes → depois | Volume humano antes → depois | Despejos completo/humano antes → depois |
|---|---|---|---|---|---|
| claude-code-terminal | delivery | renderizado-offline → renderizado-offline | 21/1493 → 23/1853 | 21/1493 → 22/1508 | 5/5 → 5/0 |
| claude-code-terminal | timeline | modelo-da-skill → modelo-da-skill | 1/95 → 1/224 | 1/95 → 1/224 | 0/0 → 0/0 |
| claude-code-terminal | partial | modelo-da-skill → modelo-da-skill | 1/73 → 1/157 | 1/73 → 1/157 | 0/0 → 0/0 |
| claude-code-terminal | recovery | renderizado-offline → renderizado-offline | 48/2108 → 56/2596 | 48/2108 → 50/1781 | 10/10 → 10/0 |
| codex-vscode | delivery | renderizado-offline → renderizado-offline | 21/1493 → 23/1853 | 21/1493 → 22/1508 | 5/5 → 5/0 |
| codex-vscode | timeline | modelo-da-skill → modelo-da-skill | 1/95 → 1/224 | 1/95 → 1/224 | 0/0 → 0/0 |
| codex-vscode | partial | modelo-da-skill → modelo-da-skill | 1/73 → 1/157 | 1/73 → 1/157 | 0/0 → 0/0 |
| codex-vscode | recovery | renderizado-offline → renderizado-offline | 48/2108 → 56/2596 | 48/2108 → 50/1781 | 10/10 → 10/0 |

## Canais e limites

No Claude Code terminal, TaskCreate e TaskUpdate são apenas os canais previstos quando expostos e permitidos. No Codex no VS Code, o canal básico é texto; ferramenta de plano ou de tarefas depende da exposição real. As citações TaskCreate guardadas para esse host são modelos de origem Claude, não sintaxe executável prometida para Codex. Nenhuma linha declara um sidecar como thread nativa nem inventa um link de navegação.

Para decisão humana, o exemplo separa a pergunta do progresso, conserva o ID escolha-sintetica, sua consequência e a próxima ação. Uma ferramenta só pode ser usada se realmente exposta e permitida para finalidade e modo; sem ela, a pergunta segue em texto separado e aguarda resposta explícita. Silêncio, timeout, fechamento e resposta vazia não resolvem a decisão. Esta avaliação não chama ferramenta de pergunta, não emite consentimento e não testa a retomada de um gate.

Os exemplos são produzidos **sem chamada a provider** e **sem host real renderizando**. Não demonstram cartões, abas, montagem do painel, resposta real de LLM, recuperação operacional, melhoria percebida, CI, merge, release ou instalação. A interpretação da rubrica é autoral e limitada ao trecho.

## Re-pin das fontes modelo-da-skill (S03/T07)

Na correção R1 da revisão S03, somente as duas referências de forge-next em
`entries[2]` e `entries[6]` foram atualizadas novamente: de
`f60cbc7b52c4546d35ce3b6c876b67890885c5b2e8fbd69d48618d458f9f4bf8` para
`31cbaaecd02b708261b97c2141d9b0b673ab720c96977095a00571d2e0dc194c`.
Isso acompanha os bytes da skill com `unit_type`/`unit_id` e o guard fechado;
citações, rótulos, rubricas, contrato, privacidade e aceite humano permanecem iguais.

A S03/T07 editou `skills/forge-task/SKILL.md` e `skills/forge-next/SKILL.md` para a identidade nativa por tentativa, o nome humano, o registro do ID devolvido pelo host fora das janelas protegidas e o guard somente leitura no Codex. Como o validador fixa o SHA-256 dos bytes de cada fonte citada, só o `source.sha256` das quatro citações modelo-da-skill dessas duas skills mudou; o texto citado (o TaskCreate de execução e o template parcial) continua literalmente presente nas skills, e nada mais no registro mudou: base_revision, contract_sha256, rótulos, as oito entradas, rubricas, métricas, limites, privacidade e human_acceptance pending-final-round.

| Amostra (campo) | Fonte | SHA-256 anterior | SHA-256 novo |
|---|---|---|---|
| entries[1].supporting.timeline.after.source.sha256 | skills/forge-task/SKILL.md#modelo-literal | 9bdba39c187aa590cc034d056cad9601c0a3e606edaee299fc5e4594a33cef71 | d81556180d9bb16d45a8f81ba6b5faa12ece7f6601a510963f29eb50fe10679b |
| entries[5].supporting.timeline.after.source.sha256 | skills/forge-task/SKILL.md#modelo-literal | 9bdba39c187aa590cc034d056cad9601c0a3e606edaee299fc5e4594a33cef71 | d81556180d9bb16d45a8f81ba6b5faa12ece7f6601a510963f29eb50fe10679b |
| entries[2].supporting.partial.after.source.sha256 | skills/forge-next/SKILL.md#parcial | 375a6b5c3fa2ed371174ad0d94b36a8755cb6cc3896509f4fcf7db187cd545e9 | f60cbc7b52c4546d35ce3b6c876b67890885c5b2e8fbd69d48618d458f9f4bf8 |
| entries[6].supporting.partial.after.source.sha256 | skills/forge-next/SKILL.md#parcial | 375a6b5c3fa2ed371174ad0d94b36a8755cb6cc3896509f4fcf7db187cd545e9 | f60cbc7b52c4546d35ce3b6c876b67890885c5b2e8fbd69d48618d458f9f4bf8 |

Os valores anteriores são os bytes da revisão 06f7d5a; os novos são os bytes finais das skills nesta task. O re-pin registra proveniência, não melhora de comunicação nem comportamento real dos hosts.

## Re-pin das citações de forge-next (tempo de milestone, S01/T07)

A task S01/T07 de M-20261101111759-opcoes-prazo-milestones acrescentou a
`skills/forge-next/SKILL.md` a seção “Tempo da milestone” (ponteiro para
`shared/forge-milestone-time.md`, presença, admissão nativa, decisões atestadas e
modelos de aviso, teto, drain e checkpoint) e ponteiros junto às chamadas nativas.
O template parcial citado não mudou e continua literal na skill. Só os dois
`source.sha256` das citações modelo-da-skill de forge-next mudaram, medidos como
SHA-256 dos bytes do arquivo, a mesma regra do validador:

| Amostra (campo) | Fonte | SHA-256 anterior | SHA-256 novo |
|---|---|---|---|
| entries[2].supporting.partial.after.source.sha256 | skills/forge-next/SKILL.md#parcial | 31cbaaecd02b708261b97c2141d9b0b673ab720c96977095a00571d2e0dc194c | 22bddaebd4367ce2cc8729cfdc7f14131de2c155be62226c3d24c45f626ed2c5 |
| entries[6].supporting.partial.after.source.sha256 | skills/forge-next/SKILL.md#parcial | 31cbaaecd02b708261b97c2141d9b0b673ab720c96977095a00571d2e0dc194c | 22bddaebd4367ce2cc8729cfdc7f14131de2c155be62226c3d24c45f626ed2c5 |

O valor anterior é o da revisão 6fc732e. Contrato, rótulos, rubricas, métricas, as
citações de forge-task e o aceite humano pending-final-round ficam iguais.

As preferências de apresentação estão **preservadas offline** pela evidência já concluída da T06, suíte node scripts/forge-presentation-prefs.test.js: homes temporários, bytes e mtime, renderers e instalador, diagnóstico somente leitura. O handoff T06 e sua entrega registram nove comandos aprovados, 49 testes do instalador e nenhum skip observado nessa rodada. T07 cita essa evidência anterior e não reexecuta a suíte inalterada. personality, model_verbosity, output style e seleções de barra explícitas não são alterados aqui. O antes e depois na instalação real continua como **runtime pendente**; o corpus não prova preservação em hosts instalados.

Na **rodada final**, uma pessoa ainda deve comparar os quatro cenários nos dois hosts, verificar compreensão de resultado/fase/executor/próximo passo/decisão e avaliar aparência, canais e preferências na instalação real. Esses aceites ficam pending-final-round até evidência própria. Resultados técnicos, revisão, integração e aceite humano continuam fatos separados.

Verificação planejada desta avaliação:

~~~text
node scripts/forge-communication-evaluation.test.js
node scripts/forge-doc-claims.test.js
~~~

## Milestone time options (S02/T07, 2026-11-03)

Only the two modelo-da-skill source.sha256 fields citing skills/forge-next/SKILL.md
were re-pinned. Quoted text and all other sample bytes remain unchanged.
Owner pre-T07 source revision: `0ee8dfdd9ffa0a4ca6dfafe928991a9125f6d573`; baseline
`scripts/fixtures/milestone-options/distribution-before.json`.

- Before: `22bddaebd4367ce2cc8729cfdc7f14131de2c155be62226c3d24c45f626ed2c5`.
- After (SHA-256 of actual source bytes): `637e73b1e2cdae1c97dd75f67f4f0b42028be6684235e6215c9516a1d1e37d1b`.

The source instruction changes enroll new milestones, present explicit choices
and resume the same snapshot. This corpus remains source/distribution evidence,
not a client observation or human acceptance.

## S02 integrated review R61/R63 correction

From verified 7e91b8f, the two literal forge-next citation source hashes change
from `637e73b1e2cdae1c97dd75f67f4f0b42028be6684235e6215c9516a1d1e37d1b` to `e8d04241493f4fa7c5a1db28e075487759fea1dd87dfafdbb750aa06aa723d0f` after the crash-safe bootstrap ordering edit.
Quoted text and every other sample byte remain unchanged; the immutable
distribution-before fixture is preserved. Runtime restart assertions are
separate evidence from these source citations, with no human UAT claim.

## Task ligada (S03/T07 de M-20261101111759-opcoes-prazo-milestones)

A T06 acrescentou blocos `forge:linked-task` a `skills/forge-task/SKILL.md` e
`skills/forge-next/SKILL.md`. Os textos citados continuam literais nas duas skills;
só os quatro `source.sha256` das citações modelo-da-skill mudaram, para o SHA-256
dos bytes reais de cada arquivo (a regra do validador). Os valores anteriores são
os da captura do owner antes da T06 (revisão
`f0b5fb17b4c57348e18fbb96bf38e8fb6ef8ee2b`, `scripts/fixtures/linked-task/distribution-before.json`)
e conferem com os preimages imutáveis dessa revisão.

| Amostra (campo) | Fonte | SHA-256 anterior | SHA-256 novo |
|---|---|---|---|
| entries[1].supporting.timeline.after.source.sha256 | skills/forge-task/SKILL.md#modelo-literal | d81556180d9bb16d45a8f81ba6b5faa12ece7f6601a510963f29eb50fe10679b | af9cf1d0b0b9f68ba751394f935e2c324050b226409f7bea9095700d13ea62ae |
| entries[5].supporting.timeline.after.source.sha256 | skills/forge-task/SKILL.md#modelo-literal | d81556180d9bb16d45a8f81ba6b5faa12ece7f6601a510963f29eb50fe10679b | af9cf1d0b0b9f68ba751394f935e2c324050b226409f7bea9095700d13ea62ae |
| entries[2].supporting.partial.after.source.sha256 | skills/forge-next/SKILL.md#parcial | e8d04241493f4fa7c5a1db28e075487759fea1dd87dfafdbb750aa06aa723d0f | d824741df528de5b38f35aec9e00e9df80349ae8ed4687e0bf6fdb1cb69dc59a |
| entries[6].supporting.partial.after.source.sha256 | skills/forge-next/SKILL.md#parcial | e8d04241493f4fa7c5a1db28e075487759fea1dd87dfafdbb750aa06aa723d0f | d824741df528de5b38f35aec9e00e9df80349ae8ed4687e0bf6fdb1cb69dc59a |

Repondo esses quatro valores, os bytes do arquivo voltam ao SHA-256 da captura
(`3f4640b4c1383652e4890827d9e8456ae75c54f2493a9bdafa48931542fed10e`). Textos,
rótulos, referências, rubricas e o aceite humano pending-final-round ficam iguais.
É proveniência de fonte, não observação de cliente nem aceite humano.

## Review-fix com limites executáveis (#341, S01/T05 de M-20261106040502-review-fix-limites)

A T05 espelhou a política `review-fix-policy-v1` nas skills `forge-task` (Step 5.5) e
`forge-next` (gate de revisão e triagem). Os textos citados continuam literais nas duas
skills; só os mesmos quatro `source.sha256` mudam, de novo para o SHA-256 dos bytes reais de
cada arquivo. O valor anterior é o versionado na base `563ac2752722ac7c29848f62520c8446185bc15c`
(o valor novo da tabela da T07 acima); o novo foi medido sobre os bytes finais da T05. O delta
completo, com proveniência, fica em `scripts/fixtures/review-policy/distribution-delta.json`.

| Amostra (campo) | Fonte | SHA-256 anterior (#341) | SHA-256 novo (#341) |
|---|---|---|---|
| entries[1].supporting.timeline.after.source.sha256 | skills/forge-task/SKILL.md#modelo-literal | af9cf1d0b0b9f68ba751394f935e2c324050b226409f7bea9095700d13ea62ae | 2f3a10c2e2d906b77778077af83d00bb6578f124d92cee4b40b638e787593754 |
| entries[5].supporting.timeline.after.source.sha256 | skills/forge-task/SKILL.md#modelo-literal | af9cf1d0b0b9f68ba751394f935e2c324050b226409f7bea9095700d13ea62ae | 2f3a10c2e2d906b77778077af83d00bb6578f124d92cee4b40b638e787593754 |
| entries[2].supporting.partial.after.source.sha256 | skills/forge-next/SKILL.md#parcial | d824741df528de5b38f35aec9e00e9df80349ae8ed4687e0bf6fdb1cb69dc59a | 61d13a04a7cfd6c3f8543fadf6de12ac8d27e856e23a7946028a965bd34755a1 |
| entries[6].supporting.partial.after.source.sha256 | skills/forge-next/SKILL.md#parcial | d824741df528de5b38f35aec9e00e9df80349ae8ed4687e0bf6fdb1cb69dc59a | 61d13a04a7cfd6c3f8543fadf6de12ac8d27e856e23a7946028a965bd34755a1 |

Sem os blocos `forge:linked-task` da T06 (medição atribuída que as camadas históricas
conferem), `skills/forge-task/SKILL.md` passa de `d81556180d9bb16d45a8f81ba6b5faa12ece7f6601a510963f29eb50fe10679b`
a `f85dce7a8bed7c53fd1253183c520f6017e52902b0e2d083ae0a587224269329`, e
`skills/forge-next/SKILL.md` de `e8d04241493f4fa7c5a1db28e075487759fea1dd87dfafdbb750aa06aa723d0f`
a `fad7ae40c8495226402cce4fbf0c849e1823450172e130195503af6e072cadee`.

Repondo esses quatro valores pelos anteriores da #341, o arquivo volta aos bytes da base; e,
repondo os da tabela da T07, à captura acima. Textos, rótulos, referências, rubricas e o
aceite humano pending-final-round ficam iguais. É proveniência de fonte, não observação de
cliente, CI nem aceite humano.

## Identity and lifecycle citation update

Artifact base: `20ae504cbd4e546aaa49f9643955ded1062e67ce`. Only the two forge-task timeline-after
`source.sha256` literals change from `2f3a10c2e2d906b77778077af83d00bb6578f124d92cee4b40b638e787593754`
to `109262eb2c60a498b7775527988b1b1b5a3b57b4a6ce3d890b83282f333dc854`. Quotes, labels, metadata, layout and
forge-next citations stay byte-identical. Full samples.json SHA-256:
`c0a3cdd57bc64ea98691f216712665013a52ee570fdf233ffe6c8c13b1e449ff` to `0a0d5ccb39fc880642d6a338153ed0e91bc72f39f978bda94ddcddb9ce242f3c`.
The retained attribution-state proof removes only the historical linked blocks;
that task source measures `f85dce7a8bed7c53fd1253183c520f6017e52902b0e2d083ae0a587224269329`
before and `e6114c0603df23f99697e6264d13d496427ef139f86f99c033209173b8bcedb5` after this update.
The checked-in citations use the raw after hash above.
The bounded update is recorded in `scripts/fixtures/identity-lifecycle/distribution-delta.json`;
it proves source attribution and distribution, not client execution or acceptance.


## Identity citation after maintenance correction 090bd42f9eb4

Only the existing two forge-task timeline-after source.sha256 literal spans are eligible for this remeasurement. Quotes, labels, metadata, layout and forge-next nodes retain the immutable sample restoration proof.

Raw task after: `109262eb2c60a498b7775527988b1b1b5a3b57b4a6ce3d890b83282f333dc854`; attributed task after: `e6114c0603df23f99697e6264d13d496427ef139f86f99c033209173b8bcedb5`.
Full samples before: `c0a3cdd57bc64ea98691f216712665013a52ee570fdf233ffe6c8c13b1e449ff`; after: `0a0d5ccb39fc880642d6a338153ed0e91bc72f39f978bda94ddcddb9ce242f3c`.
This records source attribution following maintenance corrections; review, client behavior and acceptance remain separate facts.


## #368 — bounded forge-next citation update

Base52a69e79e92c58914da7fcb69f112219a4fd508b. Only the two existing forge-next source.sha256 literals change from `61d13a04a7cfd6c3f8543fadf6de12ac8d27e856e23a7946028a965bd34755a1` to `3ffd7bef2befcbfdf49e865435b538da9b3305d5207036d488507c741fdb1e6e`; quotations, metadata and all other bytes are preserved. Full samples `0a0d5ccb39fc880642d6a338153ed0e91bc72f39f978bda94ddcddb9ce242f3c` → `40d879d0b390068d8133de40e2d2c70ae9afab012d0d3770050af0d65def65bc`. Measured layer: scripts/fixtures/unit-entry/distribution-delta.json; distribution only, no client/UAT proof.

The attributed forge-next source, with only its existing linked-task blocks removed, changes from `fad7ae40c8495226402cce4fbf0c849e1823450172e130195503af6e072cadee` to `0d9fed221f4fa52227184fc1d68a6aadac6f7ba917ce294b9dc837d04fb27eb4`. Both attributed and raw sample states remain documented and checked.


## #367 — bounded continuation citation update

Base8856ddb3bdbed8e6c0a19802e9764fe950f67172. Only the two existing forge-next source.sha256 literals change from `3ffd7bef2befcbfdf49e865435b538da9b3305d5207036d488507c741fdb1e6e` to `26cd95c5cbb829eae5dbefad7e115e77c496d10af41b5a033fd336a6e2d553f1`; quotations, metadata and all other sample bytes remain unchanged. Full samples `40d879d0b390068d8133de40e2d2c70ae9afab012d0d3770050af0d65def65bc` → `38bb2dea9d9c6ea56ff672eae2452a0a6f6a2bfbe5697830724a49a43039e405`. Raw skills `019035d20f0f70239fe0e035478af988ec6fdd5efea8b7f78e8eff6c8a64e052` → `4b1446cf4fcfc99184596bf84aeb936d497f79aab1dcde46c2fb1f72a2a23fd8`; attributed skills `bc8e2f9ebbb1a189a435417c9b3ef258531cb8db67046ccf5b26cc48f99ca5bd` → `01041828db52aa6e6c477ad222fa46ab09b8e95b53c51f65f60087ef2dbea6d8`. Measured layer: scripts/fixtures/incomplete-resume/distribution-delta.json; distribution only, not client/UAT proof.

The forge-next SOURCE attributed bytes also change from `0d9fed221f4fa52227184fc1d68a6aadac6f7ba917ce294b9dc837d04fb27eb4` to `e7bd4bd148db233e2896c4dd7c553abce729a4a52e266e2c148de2d920f42fde`; both raw and attributed citation states remain explicitly documented.


## Measured381/346 native effort terminal

Prior revision: a36033d41fd779cf4b1262d3e01455c54016786d
Previous layer: scripts/fixtures/superseded-owner/distribution-delta.json
Only the four existing task/next source.sha256 citation literals change. All other sample bytes are retained.
/entries/1/supporting/timeline/after/source/sha256 before 109262eb2c60a498b7775527988b1b1b5a3b57b4a6ce3d890b83282f333dc854 after 850589544a3e7698971bee85931c1fe99b8ba110a8f1ec94ecd5f42419fc9168
/entries/5/supporting/timeline/after/source/sha256 before 109262eb2c60a498b7775527988b1b1b5a3b57b4a6ce3d890b83282f333dc854 after 850589544a3e7698971bee85931c1fe99b8ba110a8f1ec94ecd5f42419fc9168
/entries/2/supporting/partial/after/source/sha256 before 26cd95c5cbb829eae5dbefad7e115e77c496d10af41b5a033fd336a6e2d553f1 after 1d3fc660ccfd9bb411f4f6911660b03ce53afc3b118915715081ba5e33947d71
/entries/6/supporting/partial/after/source/sha256 before 26cd95c5cbb829eae5dbefad7e115e77c496d10af41b5a033fd336a6e2d553f1 after 1d3fc660ccfd9bb411f4f6911660b03ce53afc3b118915715081ba5e33947d71
skills/forge-task/SKILL.md attributed before e6114c0603df23f99697e6264d13d496427ef139f86f99c033209173b8bcedb5 attributed after 9b092ac794b0139a2b29158808229bdd4374fc596d9a258c9cdd28d2400975d3
skills/forge-next/SKILL.md attributed before e7bd4bd148db233e2896c4dd7c553abce729a4a52e266e2c148de2d920f42fde attributed after c74b137205734a1cf266a1befcc8d14decfef6b07b335807e3ab1aa3b1321417
samples before 38bb2dea9d9c6ea56ff672eae2452a0a6f6a2bfbe5697830724a49a43039e405
samples after de86e803156d05f2b1e9bbb016801026529360db9e5fb0030377c4ddac578cec


## Measured owner-recovery terminal

Actual public predecessor b0e3dd9a5970d07014f63a0a2240764cf22df211
Previous layer scripts/fixtures/native-effort/distribution-delta.json
Only the 2 existing changed source.sha256 literals move; every other sample byte is retained.
/entries/1/supporting/timeline/after/source/sha256 before 850589544a3e7698971bee85931c1fe99b8ba110a8f1ec94ecd5f42419fc9168 after d657fe3b191a675c2d2a62012ca00c71360d44b65cd65787fa4e75a81016b957
/entries/5/supporting/timeline/after/source/sha256 before 850589544a3e7698971bee85931c1fe99b8ba110a8f1ec94ecd5f42419fc9168 after d657fe3b191a675c2d2a62012ca00c71360d44b65cd65787fa4e75a81016b957
skills/forge-task/SKILL.md attributed before 9b092ac794b0139a2b29158808229bdd4374fc596d9a258c9cdd28d2400975d3 attributed after 4e778c46a1db66ec35d49314129fb30aad6ce7c075cae72aa0e43f3d3d03e952
samples before de86e803156d05f2b1e9bbb016801026529360db9e5fb0030377c4ddac578cec
samples after f7c143e50413e1eb00391e6857bbd9cd995a233078409ab2957153f676844cdf


## Measured request-retention terminal (#382)

Actual public predecessor 421a8ec3af341fa8ec3a71fd0feee7f985e5d1eb
Previous layer scripts/fixtures/owner-recovery/distribution-delta.json
Only 0 existing changed after/source.sha256 citation literals move; all other sample bytes remain exact.
samples before f7c143e50413e1eb00391e6857bbd9cd995a233078409ab2957153f676844cdf
samples after f7c143e50413e1eb00391e6857bbd9cd995a233078409ab2957153f676844cdf


## Measured FULL guard / legacy-alias terminal (#385+#387)

Actual public predecessor 61da5cf036fcab26f4cb63a01084b09cae7e4781
Previous layer scripts/fixtures/request-retention/distribution-delta.json
Only 0 existing changed after/source.sha256 citation literals move; all other sample bytes remain exact.
samples before f7c143e50413e1eb00391e6857bbd9cd995a233078409ab2957153f676844cdf
samples after f7c143e50413e1eb00391e6857bbd9cd995a233078409ab2957153f676844cdf

## Historical parallelism branch measurement (pending integration regeneration)

Prior revision: bccfb723bee755f830e452d0b3e3dbcc6fb66025
Previous layer: scripts/fixtures/interrupted-owner/distribution-delta.json
Only the two existing forge-next citation source.sha256 literals change; all other sample bytes are retained.
forge-next before 26cd95c5cbb829eae5dbefad7e115e77c496d10af41b5a033fd336a6e2d553f1
forge-next after ca226959ba87cbe75acffd91e0d9af673677f876aa3f39ec12b238e9b9ded711
forge-next attributed before e7bd4bd148db233e2896c4dd7c553abce729a4a52e266e2c148de2d920f42fde
forge-next attributed after 41d75d9cba96f8c0953626c7951bb2bd762db8abecd716feabe2bbcdca8245ed
samples before 38bb2dea9d9c6ea56ff672eae2452a0a6f6a2bfbe5697830724a49a43039e405
samples after 29f9dcf18ccd04e9759f52a0ec428a576f70ec608697419b1db7edd39cd290bf

This preserved branch measurement predates the native-effort, owner-recovery and request-retention layers above. It is not a measurement of this merged tree. The parallelism fixture and current citation samples require a new measured terminal after the final dependency integration; historical fixture pins are unchanged here.
