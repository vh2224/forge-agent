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

As preferências de apresentação estão **preservadas offline** pela evidência já concluída da T06, suíte node scripts/forge-presentation-prefs.test.js: homes temporários, bytes e mtime, renderers e instalador, diagnóstico somente leitura. O handoff T06 e sua entrega registram nove comandos aprovados, 49 testes do instalador e nenhum skip observado nessa rodada. T07 cita essa evidência anterior e não reexecuta a suíte inalterada. personality, model_verbosity, output style e seleções de barra explícitas não são alterados aqui. O antes e depois na instalação real continua como **runtime pendente**; o corpus não prova preservação em hosts instalados.

Na **rodada final**, uma pessoa ainda deve comparar os quatro cenários nos dois hosts, verificar compreensão de resultado/fase/executor/próximo passo/decisão e avaliar aparência, canais e preferências na instalação real. Esses aceites ficam pending-final-round até evidência própria. Resultados técnicos, revisão, integração e aceite humano continuam fatos separados.

Verificação planejada desta avaliação:

~~~text
node scripts/forge-communication-evaluation.test.js
node scripts/forge-doc-claims.test.js
~~~
