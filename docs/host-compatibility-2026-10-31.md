# Compatibilidade e entrega do Forge nos hosts — 31/10/2026

Esta análise acrescenta a baseline da entrega sem reescrever a investigação de
28/10. Engenharia, execução real, instalação e aceite humano são fatos separados.
Os cinco resultados têm implementação e provas focadas; CI do candidato final,
revisão final, merge, release, instalação e UAT ainda dependem da entrega do owner.

## Proveniência e versões observadas

A [evidência desta análise](host-compatibility-2026-10-31.evidence.json) conserva
os hashes e horários das observações CP1/CP2 do owner, sem caminhos pessoais.
CP2 foi capturado em 2026-10-31T03:06:59.491Z; a montagem CP1 em
2026-10-31T03:45:05.843Z. Os registros privados completos ficam com o owner.
O SHA-256 do CP2 é `6f90cbce6873b3bcfff62ca9c31e76b94a230bde17be9cbe22ce3e0721a29148`.

| Camada | Versão observada | Alcance e fonte |
| --- | --- | --- |
| Forge candidato | 4.47.0; commit-base `30147f9a117b858d9de60cd13e8ed42a2c44a4f7` | CP2; versão derivada por `scripts/forge-version.js`; não é release publicada |
| Forge instalado | 4.46.8 | CP2; atualização final pendente |
| Codex CLI instalado | 0.166.0 | CP2 `codex --version`; não identifica a extensão IDE |
| Codex última estável encontrada | 0.166.0 | [Release oficial](https://github.com/openai/codex/releases/tag/rust-v0.166.0), metadados revalidados em CP2 |
| Claude Code terminal instalado | 2.1.312 | CP2 `claude --version`; independente da extensão |
| Claude última estável encontrada | 2.1.316 | [Release oficial](https://github.com/anthropics/claude-code/releases/tag/v2.1.316), metadados revalidados em CP2 |
| VS Code instalado e runtime CP1 | 1.144.0, x64, commit `2c33b50b16c472efe58357d1d2a8a5414bc23fbf` | CP2 identificação e CP1 montagem real isolada no build assinado atual |
| Extensão Codex | unknown | CP2 não a encontrou no inventário limitado do perfil padrão; outros perfis não foram inspecionados |
| Extensão Claude no perfil padrão | 2.1.314 | CP2; não confundir com o CLI 2.1.312 |
| Desktop Codex/ChatGPT | build não identificada (`null`) | Informativo, fora da entrega obrigatória; sem UAT |

## O que mudou desde 28/10

- A importação original permanece byte a byte intacta, com os três hashes
  registrados e o próprio registro de importação conferidos antes/depois.
- O pin foi revisado para Codex 0.165.0 na S01, conforme
  [análise do schema](codex-schema-0.165.0.md). Não houve novo repin para 0.166.0.
- O guard CP2 contra o CLI 0.166.0 saiu com 1 e `drift`, com 14 caminhos e sem
  truncamento. Essa contagem é de caminhos projetados, não de 14 novos recursos:
  inclui deslocamentos posicionais do enum. A reanálise do intervalo está pendente.
- O catálogo passou a distinguir distribuição e demonstração; a atualização do
  relatório instalado será verificada na instalação final, conforme issue 280.
- Há um [contrato comum de comunicação](../shared/forge-communication.md), modelo
  de agentes, persistência de perguntas e painel de leitura pessoal. Isso não
  prova que o usuário já percebeu melhora ou aceitou a aparência.
- A prova histórica [do painel](panel-feasibility.json) continua inalterada.
  Ela não é substituída pelo CP1 atual, com dados reais e VS Code 1.144.0.

## Matriz integrada: superfície × resultado × tipo de prova

As referências de suíte abaixo são provas offline focadas registradas nos
SUMMARY/DELIVERY de S01 a S05 pelo owner. Elas não equivalem à CI final.
Cada linha separa a demonstração real do aceite visual/de compreensão.
R1 = compatibilidade; R2 = comunicação; R3 = agentes; R4 = perguntas; R5 = painel.

| Superfície | Resultado | Offline e fonte | Runtime real e fonte | Aceite humano |
| --- | --- | --- | --- | --- |
| Codex no VS Code 1.144.0 / `2c33b50b16c472efe58357d1d2a8a5414bc23fbf` | R1 | S01: `forge-host-baseline.test.js`, `forge-schema-pin.test.js`, `forge-codex-renderer.test.js` | CP2 versões e drift; CP1 montagem do Forge; extensão Codex unknown | pending-final-round, autorização do owner |
| Codex no VS Code | R2 | [Avaliação](communication-evaluation/README.md): oito cenários, renderizados offline/modelos/redigidos | Pendente: corpus não contém execução observada do host | pending-final-round |
| Codex no VS Code | R3 | S03: `forge-agent-view.test.js`, `forge-native-invocation.test.js` | IDs nativos e receipts somente nas rotas exercitadas, S03-DELIVERY; navegação nativa pendente | pending-final-round |
| Codex no VS Code | R4 | S04: `forge-question-channel.test.js`, `forge-question-flow.test.js`, `forge-pending-questions.test.js` | Request real de entrada sidecar não observado; issue 306 com validação integrada pendente, S04-REVIEW | pending-final-round |
| Codex no VS Code | R5 | S05: `forge-panel-source.test.js`, `forge-vscode-panel.test.js`, `forge-panel-probe.test.js` | CP1: mounted, match, fontes inalteradas; perfil isolado, dados pessoais canônicos | pending-final-round; instalação no perfil do operador pendente |
| Claude Code terminal 2.1.312 | R1 | S01: `forge-capabilities.test.js`, `forge-subagent-statusline.test.js` | CP2 versão do CLI; não comprova renderização do terminal | pending-final-round |
| Claude Code terminal | R2 | [Avaliação](communication-evaluation/README.md): modelos e renderização offline com proveniência | Pendente: não há execução observada no corpus | pending-final-round |
| Claude Code terminal | R3 | S03/S05: `forge-subagent-statusline.test.js`, estados sintéticos de agentes | Execução nativa nos registros do owner; renderização de subagentStatusLine e navegação pendentes | pending-final-round |
| Claude Code terminal | R4 | S04: `forge-question-channel.test.js`, `forge-question-flow.test.js` | Sem afirmação de input real do sidecar; S04-DELIVERY preserva o desconhecido | pending-final-round |
| Claude Code terminal | R5 | Catálogo: `unavailable`; painel VS Code não é superfície do terminal | Não aplicável ao painel, [contrato da extensão](../extensions/forge-vscode/README.md) | Não aplicável ao painel |
| Codex CLI 0.166.0 | R1 | S01: fixtures do pin e baseline, [schema 0.165.0](codex-schema-0.165.0.md) | CP2 guard real: drift14, exit1; nenhum teste de provedor inferido | pending-final-round para experiência |
| Codex CLI | R2 | [Contrato compartilhado](../shared/forge-communication.md), cenários offline de S02 | Aplicação real no CLI pendente; corpus IDE não é trace CLI | pending-final-round |
| Codex CLI | R3 | S03: `forge-agent-view.test.js`, `forge-native-invocation.test.js` | Receipts não provam UI CLI; navegação não demonstrada, S03-DELIVERY | pending-final-round |
| Codex CLI | R4 | S04: fluxo, estados e retomada em fixtures | Input sidecar real pendente; probe de ferramenta não prova disponibilidade de sessão | pending-final-round |
| Codex CLI | R5 | Extensão depende de VS Code, [contrato](../extensions/forge-vscode/README.md) | Não aplicável ao terminal CLI | Não aplicável ao painel |
| Desktop, informativo | R1 | [Auditoria original](host-compatibility-2026-10-28.md), build ainda unknown | Pendente: build/runtime não identificados | Não realizado; fora da entrega obrigatória |
| Desktop, informativo | R2 | Contrato compartilhado; sem corpus próprio, [avaliação](communication-evaluation/README.md) | Não demonstrado | Não realizado |
| Desktop, informativo | R3 | Modelo compartilhado; sem prova de UI desktop, S03-DELIVERY | Não demonstrado | Não realizado |
| Desktop, informativo | R4 | Estados compartilhados; sem prova de formulário desktop, S04-DELIVERY | Não demonstrado | Não realizado |
| Desktop, informativo | R5 | Mecanismo escolhido é TreeView VS Code, [contrato](../extensions/forge-vscode/README.md) | Não demonstrado no desktop; CP1 não prova Plugin Extensions | Não realizado |

CP1 comparou o hash da projeção canônica com o painel usando o mesmo
`panel_generated_at: 2026-10-31T03:45:04.097Z`. Ambos registraram
`70f28c096b757ff95d2cba988cd6a2077d76913e2ea55fe7b3581d117144aff1`.
Sem aquele horário ou com fontes alteradas a conclusão seria unknown.
O registro histórico 1.143.1/`e646868227c3e3a9e3f24277c8c7220be42c0be7`
com dados sintéticos continua distinto desta observação real atual.

## Disposição dos achados

Todos os achados permanecem visíveis na [baseline nova](host-compatibility-baseline-2026-10-31.json).
Nenhum está closed/resolved: guard, suíte verde e commit não são fechamento pelo operador.

| Achado | Disposição atual | Evidência e limite |
| --- | --- | --- |
| schema-drift | Aberto; repin 0.165.0 implementado, drift novo 0.166.0 | CP2 e [schema](codex-schema-0.165.0.md); issue 279 aberta |
| compatibility-report-freshness | Correção implementada; atualização instalada pendente | [Contrato atual](runtime-compatibility.md), issue 280; causa histórica não presumida |
| custom-agent-permissions-contract | Limitação documentada | [Permissões](codex-agent-permissions.md); nenhum sandbox próprio por agente afirmado |
| communication-and-agent-progress | Implementado; UAT pendente | [Avaliação](communication-evaluation/README.md), S02/S03 |
| question-lifecycle-uat | Implementado; UAT pendente | S04-DELIVERY e suítes de perguntas |
| forge-plugin-sidebar | Implementado; instalação/UAT pendentes | CP1 atual e [extensão](../extensions/forge-vscode/README.md) |
| statusline-r6 | Correção implementada; revisão final pendente | `forge-subagent-statusline.js`, commit 8c543bb; inode original retido, nenhuma serialização de escrita tardia prometida |
| issue-294 | Documentação corrigida; revisão final pendente | `shared/forge-completer-slice.md` usa `--json`, commit 8c543bb; sem alteração da semântica advisory |
| issue-306 | Correção implementada; integração pendente | S04-REVIEW e `forge-question-flow.test.js`; input real não demonstrado |
| g2-1 | Limitação aberta: detecção não é sandbox por agente | `forge-native-readonly-guard.js`, [permissões](codex-agent-permissions.md) |
| g2-2 | Limitação win32 preexistente | `forge-xllm.js`; dangerFullAccess do sidecar não implica autorização adicional |
| issue-288 / issue-289 / issue-290 | Somente registradas; nenhuma correção/fechamento reivindicado aqui | [Issues 288](https://github.com/vh2224/forge-agent/issues/288), [289](https://github.com/vh2224/forge-agent/issues/289), [290](https://github.com/vh2224/forge-agent/issues/290) |
| windows-link-negatives | EPERM em negativos específicos segue limitação registrada | S01-DELIVERY; outros testes de contenção não substituem negativos pulados |
| panel-operator-installation | Pendente | CP1 perfil isolado; perfil do operador não modificado |
| native-navigation | Não demonstrada | S03-DELIVERY; ID não garante interface navegável |
| subagent-statusline-rendering | Não demonstrada | Suíte de setup não é renderização real |
| sidecar-real-input | Não observado | S04-DELIVERY; fixtures não são input real |
| final-human-uat | pending-final-round | Autorização do owner; rodada única final |
| release-review-codex | Pendente para (0.165.0, 0.166.0] | Metadados oficiais CP2 não equivalem à revisão das notas |
| release-review-claude | Pendente para releases após 2.1.312 até 2.1.316 encontrado | CLI instalado permanece 2.1.312; mesma versão não dispensa revalidação |

## Intervalo e próxima análise

Codex instalado avançou de 0.165.0 para 0.166.0. O intervalo observado é
**(0.165.0, 0.166.0]**, ainda com revisão pendente. O marco exclusivo revisto
continua **0.165.0**. A próxima análise começa depois dele e cobre até o instalado
então observado, sem lacuna ou sobreposição e sem repin automático.

Claude instalado continua 2.1.312: intervalo de instalado `null`, review
`not-applicable-same-version`, revalidação obrigatória. O marco exclusivo
continua **2.1.312**. As notas posteriores até a última estável 2.1.316 encontrada
continuam pendentes em achado próprio; não houve upgrade do CLI.

## Gates posteriores da entrega

CI obrigatória do candidato final: **pendente**; revisão final independente:
**pendente**; security gate final: **pendente**; merge: **pendente**; release:
**pendente**; atualização do Forge nos dois hosts: **pendente**; instalação local
no perfil VS Code do operador: **pendente**; aceite humano: **pending-final-round**.
O owner registrará cada fato com sua evidência; esta análise pré-commit não o aprova.

## Revalidação após revisão de S05

A montagem acima foi recapturada após R3/R4: a projeção agora compara valores semânticos exibidos, incluindo próximo passo, tarefa e texto de pergunta. A estabilidade inclui STATE/PLAN, registros de run e fontes dos checkpoints próprios, com limites e recusa de links. Incerteza produz unknown. A observação anterior de 2026-10-31T03:06:42.331Z continua histórica na evidência, com sua projeção mais restrita; não comprova os bytes corrigidos. O perfil do operador e o aceite humano continuam separados. A issue308 registra a dependência esquecida entre catálogo53 e matriz SVN; a linha nova declara a limitação de renderização SVN ainda não validada.
