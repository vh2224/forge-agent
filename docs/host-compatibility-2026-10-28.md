# Compatibilidade e experiência do Forge no Codex e no Claude

Análise de 28/10/2026. Há manutenção concreta de compatibilidade e espaço para melhorar a comunicação e o acompanhamento dos agentes. Atualizar os CLIs, sozinho, não resolve a experiência: o Forge precisa apresentar melhor o andamento e distinguir agentes nativos de processos sidecar. Um painel próprio também se tornou uma alternativa documentada por extensões de plugins.

Este é um registro de investigação, autorizado pelo pedido de análise e persistência. Não inicia task ou milestone, não muda modelos, preferências, instalações, gates ou roteamento. Recomendações abaixo ainda não foram implementadas.

## Versões e cobertura

| Camada | Observação nesta análise | Alcance da conclusão |
| --- | --- | --- |
| Forge fonte | `6fee802526c5b80fa53f63a34688308929f2ea5d`, release 4.46.8 | Checkout inicialmente limpo; código e testes relacionados examinados |
| Forge instalado | Core 4.46.8; pin 0.163.0 | Hashes do pin, renderer Codex, helper de perguntas e cliente app-server comparados com a fonte |
| Codex CLI | **0.165.0** instalado; última versão estável encontrada no changelog oficial em 28/10 | Schema gerado localmente; flags inspecionadas; nenhuma inferência real executada |
| Claude Code | **2.1.312** instalado pelo executável nativo; release oficial de 27/10 | Versão e documentação verificadas; nenhum worker Claude real executado |
| Codex app / ChatGPT desktop | Documentação atual consultada em 28/10; **build gráfico local não identificado** | Sem UAT visual; versão do CLI ou do daemon não identifica a versão da interface |
| Claude Desktop / extensão IDE | Não inventariados | A análise de versão cobre Claude Code, não todos os produtos Claude |

O histórico do schema inclui notas de 0.155.0 e 0.159.3. O pin efetivo já avançou para **0.163.0**, com `projected_at: 2026-10-20T04:24:12.966Z`. O último marco local do contrato headless Claude menciona **2.1.310**, em `shared/forge-bidirectional-sidecar.md`. Isso não equivale a uma auditoria anterior de toda a experiência.

O novo intervalo de notas de release examinado é **(0.163.0, 0.165.0]** para Codex e **(2.1.310, 2.1.312]** para Claude Code. A documentação funcional atual complementa esses deltas; não se afirma revisão exaustiva de todos os releases anteriores. A [baseline legível por ferramentas](host-compatibility-baseline.json) separa revisão documental, provas locais e pendências.

## Compatibilidade que precisa de atenção

### Pin do Codex

`node scripts/forge-schema-pin.js --check --json` retorna `drift`, exit 1, contra o CLI 0.165.0. Uma comparação recursiva independente, sem o limite de vinte caminhos do helper, confirmou **18 diferenças**:

- Sete mudanças na variante existente `imageGeneration`, incluindo a alternativa de resultado e `inputImages`.
- Dez diferenças posicionais no enum de erros, decorrentes da inserção de `modelNotFound`; os erros anteriores permanecem.
- Um tipo referenciado novo: `ImageGenerationInputImage`.

Continuam cinco roots e dezenove variantes de ThreadItem. O schema novo tem 54 tipos referenciados, contra 53 do pin. Geração de imagem continua sem admissibilidade como evidência de execução; `commandExecution` e `fileChange` conservam sua política. `ThreadStartParams`, fora dos cinco roots, foi inspecionado separadamente: não tem campos obrigatórios e ainda expõe os parâmetros usados pelo Forge.

O guard está detectando uma mudança real. A falha demonstra manutenção pendente do contrato e afeta a asserção live do smoke; não demonstra falha de execução ou rejeição de provedor. Revisar shapes, classificação dos erros e evidência antes de regenerar o pin. Registro: [issue 279](https://github.com/vh2224/forge-agent/issues/279).

### Relatórios e permissões

O relatório instalado `adapters/codex/capabilities.json` declara 4.8.0, enquanto o core declara 4.46.8. O catálogo e `docs/runtime-compatibility.md` ainda descrevem projeções Codex como futuras, embora o renderer distribua agentes, skills, comandos e templates. Essas inconsistências dificultam saber o que realmente está disponível. A causa histórica da desatualização não foi determinada. Registro: [issue 280](https://github.com/vh2224/forge-agent/issues/280).

O renderer coloca `sandbox_mode = "workspace-write"` nos TOMLs de agentes. A documentação atual diz que permissões e sandbox são herdados do pai e não são sobrescritos por esse campo em um custom agent. Essa linha, portanto, não pode ser apresentada como prova de isolamento. Auditar o contrato real de raízes, claims e permissões herdadas antes de modificar o renderer. Não foi demonstrado escape de sandbox. A mesma documentação descreve a precedência de modelo/esforço; qualquer adaptação deve conservar os valores resolvidos por unidade. [Subagentes Codex](https://learn.chatgpt.com/docs/agent-configuration/subagents).

Os mínimos genéricos do catálogo, Codex 0.1.0 e Claude 2.0.0, também não comprovam os recursos modernos. O caminho útil é testar capabilities específicas e registrar versões observadas, sem impor uma versão exata a todos os fluxos.

## Respostas e clareza do andamento

A percepção de respostas piores foi relatada pelo usuário. Não houve comparação controlada entre modelos que permita atribuir a causa ao Codex, ao prompt ou ao cliente. Há, porém, uma melhoria aplicável no Forge: um contrato comum de comunicação, projetado pelos dois renderers, adaptado aos canais reais de cada host.

A proposta é:

1. Na abertura, explicar o resultado buscado e a primeira verificação em uma frase.
2. Durante o trabalho, comunicar achados, impacto e próximo passo; atualizar em mudanças de fase ou espera relevante, sem narrar cada comando.
3. Ao delegar, informar uma descrição humana da tarefa, o agente e onde acompanhar quando a interface realmente oferecer esse recurso.
4. Em falhas, separar o que falhou, o que continua executável e o efeito para a entrega. IDs e logs completos ficam acessíveis no registro técnico.
5. Na entrega, mostrar resultado, validação e pendência concreta. Implementação, teste, integração e aceite humano continuam distintos.

Exemplo de atualização: “A correção passou nos testes. O revisor está verificando o comportamento ao retomar a sessão; depois compararei a instalação com o código aprovado.” Evitar sequências de mensagens que apenas enumeram helpers, hashes e receipts sem explicar a consequência.

Uma alteração de estilo deve ser avaliada com os mesmos cenários nos dois hosts: diagnóstico, execução com agente, falha recuperável e decisão humana. Medir compreensão da fase, executor e pendência, além de volume e utilidade das mensagens. Testes que só procuram frases no prompt não provam a melhora percebida.

Há uma configuração local `personality = "pragmatic"`. A documentação atual classifica `friendly` e `pragmatic` como opções de compatibilidade sem seleção de estilo. `model_verbosity` pode controlar detalhe quando suportado, mas não fornece navegação, estado ou perguntas. Não recomendo simplesmente aumentar verbosidade. [Referência de configuração](https://learn.chatgpt.com/docs/config-file/config-reference).

Claude oferece output styles, incluindo Explanatory e estilos próprios. Isso ajuda a separar apresentação das regras operacionais e serve de referência para a projeção do Forge; não garante cumprimento de comportamento. Não usar um estilo como substituto dos gates. [Output styles](https://code.claude.com/docs/en/output-styles).

## Acompanhamento dos agentes

O Codex atual documenta threads de subagentes no aplicativo e `/subagents` no CLI. A extensão IDE pode exibir um painel, quando disponível. Esses recursos dependem de agentes criados no runtime nativo e da superfície efetivamente usada. [Subagentes Codex](https://learn.chatgpt.com/docs/agent-configuration/subagents).

No Forge, a diferença de transporte é decisiva: `forge-xllm.js` inicia threads sidecar com `ephemeral: true`, e o cliente faz sua própria inicialização do app-server. Isso não comprova associação à árvore de agentes da conversa principal. Não prometer que um sidecar será aberto como um agente nativo nem trocar a rota para obter essa aparência.

Para agentes nativos, registrar o identificador real, dar uma descrição útil e orientar a abertura pela UI disponível. Para sidecars, apresentar um resumo de progresso baseado em eventos observados: fase, executor, tempo, atividade recente e resultado. Heartbeat local não equivale a progresso remoto; falta de eventos continua desconhecida até a classificação canônica.

Claude oferece navegação e retomada de subagentes; seu painel também aceita `subagentStatusLine`, com dados por agente. Essa é uma oportunidade de enriquecer o acompanhamento no host Claude. O statusline principal do Forge já usa rate limits: o trabalho novo seria o resumo por agente, não refazer esse suporte. [Subagentes Claude](https://code.claude.com/docs/en/sub-agents), [status lines](https://code.claude.com/docs/en/statusline).

## Sidebar e barra de status

São três superfícies diferentes:

| Superfície | Oportunidade |
| --- | --- |
| Sidebar de projetos e conversas do cliente | Usar títulos e organização compreensíveis; não confundir posição na lista com estado ou conclusão do trabalho. A documentação descreve pin, busca e arquivamento. [Projetos](https://learn.chatgpt.com/docs/projects) |
| Barra inferior do Codex CLI | O Forge já sugere indicadores de modelo, contexto, tokens, limites e progresso. Uma seleção existente é preservada. A configuração local selecionada não inclui os dois indicadores de limites sugeridos pelo default atual; rever a seleção pode ajudar no terminal. Isso não altera o aplicativo gráfico |
| Painel próprio do Forge | Plugin Extensions documentam sidebar apps, painéis de conversa, deep links e formulários. É uma possibilidade concreta de integração, condicionada ao suporte do cliente e a um plugin próprio; não surge apenas por editar AGENTS.md. [Plugin Extensions](https://developers.openai.com/plugins/build/extensions) |

Um painel Forge deve começar somente leitura, usando a visão pessoal canônica e dados do trabalho autorizado: fase, agentes reais, pendências e links de evidência. Não usar filas compartilhadas como fila pessoal nem expor contexto de terceiros. A Forge.app em Swift é outra aplicação, voltada a macOS; seus testes de sidebar não demonstram suporte no cliente Windows desta análise.

## Perguntas e continuidade

O Forge já distribui regras para adaptar `AskUserQuestion` às ferramentas Codex realmente expostas. No CLI local, `default_mode_request_user_input` aparece como `under development`, habilitado; o probe atual o reconhece. Isso não prova disponibilidade, finalidade ou comportamento visual em toda sessão.

A melhoria proposta é uma decisão por vez, pergunta curta, opções com consequência, IDs estáveis e retomada fiel das respostas. Worker sem interação deve devolver a decisão pendente ao orquestrador. A aceitação da apresentação de uma pergunta assíncrona não é resposta. Preservar a preferência pessoal de encerrar a rodada quando mantê-la aberta exigiria consumo adicional sem garantia comprovada.

O app-server documenta requests de entrada do usuário; o cliente Forge atual recusa todos os requests entrantes com `-32601`. Portanto, perguntas nativas da sessão principal e perguntas dentro do sidecar são contratos diferentes. Integrar um broker de perguntas exigiria identidade, persistência, resposta, cancelamento e retomada próprios. Nenhum timeout ou fechamento pode aprovar automaticamente uma decisão obrigatória, mesmo quando o protocolo oferece resolução automática. [App-server](https://learn.chatgpt.com/docs/app-server).

Formulários de plugins podem melhorar decisões com mais campos. Eles ainda precisam preservar os mesmos gates e não substituem a autorização exigida pelo host.

## Mudanças recentes relevantes

Codex 0.164.0 acrescenta presets e controles inline; corrige retomada/compactação e espera de permissões. Em 0.165.0 há agrupamento por diretório no command center, filtro por repositório, forks experimentais e tratamento terminal de modelo ausente. Esses pontos justificam verificar integração e diagnóstico, sem adotar APIs experimentais implicitamente. [Changelog oficial](https://learn.chatgpt.com/docs/changelog).

Claude 2.1.311 corrige hooks de término repetidos, worktrees removidos enquanto descendentes ainda trabalham, MCP disponível tardiamente e alguns cortes de pensamento ativo. São relevantes para atribuir sintomas ao host ou ao Forge. [Release 2.1.311](https://github.com/anthropics/claude-code/releases/tag/v2.1.311).

Claude 2.1.312 corrige indicação prematura do esforço, falso estado de espera e casos de comandos sem saída; também muda comportamento para modelos de nomes não reconhecidos em alguns provedores. Manter modelo solicitado e observado separados e conferir a invocação real. [Release 2.1.312](https://github.com/anthropics/claude-code/releases/tag/v2.1.312).

## Ordem recomendada e verificação

| Prioridade | Entrega | Prova necessária |
| --- | --- | --- |
| 1 | Compatibilidade: pin, freshness dos relatórios e contrato de permissões | Diff revisado, guard local, fixtures negativas, versão e capabilities coerentes |
| 2 | Comunicação e resumo dos agentes | Cenários equivalentes nos dois hosts, feedback humano e ligação com executor/eventos reais |
| 3 | Perguntas e retomada | UAT com pergunta respondida, parcial, fechada, reinício e ferramenta indisponível; nenhum aceite implícito |
| 4 | Painel Forge por plugin | Prova no cliente alvo, dados pessoais corretos e links úteis; depois avaliar ações mutantes |

As entregas são separáveis, com dependências entre contratos, eventos e interface; uma implementação conjunta justificaria um milestone, com verificação por camada e UAT visual, porque alterações de permissões e decisões têm risco maior que ajustes de redação.

## Evidência e próxima análise

Passaram oito suítes focadas: `forge-schema-pin`, `forge-evidence-admit`, `forge-appserver-client`, `forge-codex-renderer`, `forge-codex-statusline`, `forge-codex-questions`, `forge-interaction` e `forge-statusline-resources`. A checagem live do schema saiu com 1 pelo drift descrito. Não foi executado smoke completo, inferência real de worker ou teste visual do cliente. As suítes usam fixtures e mocks; não demonstram sozinhas qualidade de resposta, navegação ou duração de formulários.

O registro pessoal conserva fontes oficiais completas com hashes, schema gerado, diff sem truncamento, fingerprints de código e logs com exit codes. O índice JSON contém fingerprints e os resultados portáveis. A preferência pessoal referencia esse índice para a retomada futura.

Na próxima análise, revisar releases **posteriores a Codex 0.165.0 e Claude Code 2.1.312**, revalidar hashes das fontes relevantes e retomar os achados ainda abertos. Mudança de documentação, adapter, configuração ou UI pode exigir revalidação mesmo sem nova versão. Para o aplicativo gráfico, primeiro obter a build real: a data desta auditoria não fecha um intervalo de versões que não foi identificado.
