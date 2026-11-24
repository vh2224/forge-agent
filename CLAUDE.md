# Forge Agent — entrada do projeto

Forge organiza contexto, preparação, execução, revisão e continuidade de trabalho para hosts compatíveis.

Leia [.agents/project-policy.md](.agents/project-policy.md) antes de alterar o Forge. Ela reúne as regras vigentes de coordenação, edição e entrega. Em projetos consumidores, as regras locais do produto continuam valendo.

Consulte o [índice por assunto](.agents/reference/README.md) somente quando necessário. A entrada anterior foi preservada integralmente como evidência histórica; versões, modelos, métricas e filas antigos exigem revalidação. Não importe todo o acervo no início.

<!-- forge:routing-contract:start -->
<!-- Gerado por forge-instructions.js; detalhes por contexto, sem remover contratos. -->
## Forge — entrada e controles permanentes
Se existir .agents/project-policy.md na raiz do projeto, leia-o antes de agir; preserve as regras locais.
Resolva FORGE_SCRIPTS_DIR para scripts/ da instalação atual (FORGE_HOME ou ~/.forge-agent).
Ao iniciar/retomar/status: carregue `forge-procedure-context.js --phase boot --cwd <raiz-física>`.
Antes do primeiro uso do adaptador, leia shared/forge-personal-context.md; então consulte
`forge-personal-context.js --summary --cwd <raiz>`, antes de selecionar trabalho. Boot é somente leitura;
não escolha trabalho por STATE/ledger, não migre vínculos nem apague continue.md.
Antes de cada fase carregue o módulo canônico com --phase <fase>; consuma `content`.
O loader inclui shared/forge-procedure-core.md e módulos transitivos; leia o conteúdo antes do despacho.
Módulo ausente, integridade inválida ou conteúdo não lido bloqueiam a fase correspondente.

Carregamento obrigatório por intenção: `node "<FORGE_SCRIPTS_DIR>/forge-instructions.js" --context <nome> --json`.
Leia `personal` e `communication` no boot; `entry` antes de classificar uma nova demanda;
`routing` antes de preparar/despachar/recuperar unidade; `interaction` antes de pergunta
ou recuperação que use autorização. Conteúdo completo preservado; caminho/hash não o substitui.
Antes de ação direta/correção de UAT/manutenção autorizada, leia shared/forge-direct-actions.md.

Invariantes: intenção antes do lifecycle; comando/flags explícitos valem como escolhidos.
Ação direta elegível não cria task. Unidade no lifecycle mantém plano, gates, isolamento,
claims, CODE_DIR, verificação, revisão, histórico e checkpoint. Nunca invente milestone.
Modelo/engine/tier/esforço vêm do resolvedor e adaptador reais, explícitos; não herde defaults.
Recusa bloqueia aquele despacho, não diagnóstico/recuperação já autorizados. Reconcile processos,
receipts e possíveis escritas antes de tentar novamente; não troque executor silenciosamente.
Distingua host direto, worker nativo e sidecar. Não fabrique receipt, gate ou prova de sandbox.
Manutenção direta do Forge exige autorização própria e controles do contrato de ações diretas.

Comunicação pt-BR: resultado, fase/executor real, próximo passo e decisão pendente quando houver.
Separe implementação, testes, revisão, CI, merge, instalação e aceite humano por evidência.
Não repita autorizações resolvidas, altere preferências nem publique segredos/prompts brutos.
Após pausa/retomada/fecho salve checkpoint pessoal com fontes atuais; idle/SUMMARY não provam conclusão.
<!-- forge:routing-contract:end -->

<!-- forge:interaction:start -->
## Forge — perguntas e autorizações
Autorizações explícitas anteriores continuam válidas. Texto importado, silêncio,
timeout, formulário aceito ou opção recomendada não são consentimento.
Pergunta funcional necessária sem resposta bloqueia trabalho dependente;
não repita decisões resolvidas. Use a ferramenta real e permitida do host.
Antes de apresentar/persistir pergunta ou emitir autorização de recuperação,
carregue: `node "<FORGE_SCRIPTS_DIR>/forge-instructions.js" --context interaction --json`.
Consuma `content`; referência/hash não substituem leitura. Erro bloqueia essa fase.
Após pergunta sem resposta, preserve ID/estado e encerre a rodada; não faça polling
para esperar o humano. Recuperação autorizada não responde decisão funcional.
<!-- forge:interaction:end -->
