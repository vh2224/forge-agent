# Simplificação do Forge

## Primeira etapa: distribuição e validação

A instalação e o pacote usam a mesma seleção de arquivos operacionais. As suítes
`scripts/*.test.js` e o smoke permanecem no checkout de desenvolvimento e no CI,
mas deixam de ser copiadas para instalações novas. Fixtures e ferramentas de
diagnóstico continuam disponíveis nesta etapa.

O update retira cópias antigas apenas quando seus bytes, normalizados para LF,
coincidem com a fonte conhecida. Faz backup antes da remoção e preserva arquivos
customizados, desconhecidos e links simbólicos. Isso é uma migração conservadora:
instalações antigas podem manter testes cujo conteúdo mudou entre versões.

O CI offline executa as mesmas 11 suítes uma vez por sistema operacional. Cada
suíte continua cobrindo os hosts aplicáveis; os nomes anteriores de checks são
preservados por jobs de compatibilidade que dependem do resultado real.

## Cobertura permanente e evidência histórica

| Verificação retirada | Motivo | Cobertura que permanece |
|---|---|---|
| Execução de `forge-hook-stop.test.js` dentro do smoke | A mesma suíte já é descoberta por `run-tests.js` | Todos os cenários do arquivo continuam no runner completo |
| Gate histórico de escopo S07 no smoke | Classificava commits desde a introdução de `forge-touch.js` para provar que aquela entrega não alterou `app/` | Cenários atuais de touch, overlap, isolamento dos registries e controle positivo de escrita permanecem |
| Inspeção de `.gsd/KNOWLEDGE.md` pessoal por `forge-capture.test.js` | O estado local ignorado pelo Git não é uma fixture nem um contrato do produto; o resultado variava por checkout | Contratos das fontes de captura e criação/validação de itens por CLI continuam testados |

A evidência histórica pode ser consultada em `scripts/forge-smoke.js` no commit
`24d2219f1c5e7f51c7fad6da2262a424b982d785`, bloco `(e) SCOPE` da seção S07.
Não é mais uma condição repetida a cada mudança futura do produto.

O checkout completo permanece necessário para a resolução da versão prospectiva
a partir de tags e commits convencionais. A retirada do gate S07 não elimina
essa dependência.

## Segunda etapa: autoridade de seleção

As tabelas de seleção de fase de `forge-auto` e `forge-next` foram substituídas
pelo contrato compartilhado em `shared/forge-lifecycle.md`. Auto mantém a unidade
e o snapshot do controlador; next usa o seletor read-only existente quando não
há unidade com lease. Nenhum dos prompts avança STATE manualmente para aplicar skip.

O seletor lê os nomes canônicos `skip_discuss`, `skip_research` e
`skip_slice_research`, mantendo os aliases antigos. As preferências de research
de milestone e slice são independentes. Slices marcadas como concluídas não são
selecionadas por um STATE atrasado; a próxima slice passa pelas mesmas regras de
plan/research/execute/complete. A transação de início persiste a slice selecionada.

Testes cobrem ordenação das fases, preferências, passagem entre slices e seleção
sem escrita de STATE ou aquisição de lease. As projeções dos hosts continuam
validadas; apenas o golden da superfície de skills mudou.

O módulo de paralelismo continua responsável por dependências e lotes, e o
resolver de dispatch continua responsável por engine/modelo/esforço. Esta etapa
não migra o ciclo inteiro nem cria suporte a task standalone no controlador.

## Terceira etapa: schema e smoke

A terceira etapa concentra os cenários determinísticos de schema em
`forge-schema-pin.test.js` e mantém no smoke a comparação com o CLI instalado.
A seção 92 perde 156 linhas líquidas; os casos de CLI exclusivos foram
preservados na suíte específica. Transporte e coleta de evidências continuam
cobertos por integrações. A atualização do schema para Codex 0.155.0 foi
[analisada separadamente](codex-schema-0.155.0.md), incluindo a política para
a nova variante. O pin gerado cresce por refletir o protocolo, portanto esta
etapa reduz código de testes, mas não o total de linhas do repositório.

## Quarta etapa: fixtures de instalação

Sete cenários de configuração e propriedade em `forge-installer.test.js` usam
uma fonte de quatro arquivos: manifest, capabilities, schema de preferências e
template de settings. Os três conteúdos de configuração vêm das fontes reais;
o manifest mantém somente as entradas necessárias, com diretórios vazios para
as superfícies públicas. O instalador e os renderizadores não são simulados.

Dois cenários de resolução de origem em `forge-update.test.js` preparam apenas
o manifest instalado que leem, em vez de executar uma instalação para criá-lo.
Os 55 cenários e suas verificações de comportamento permanecem: duas instalações
completas são removidas e outras 15 passam à fonte pequena por execução.

Continuam usando a fonte completa os testes de instalação dos hosts, contratos
nos consumidores, backups, migração legada, atualização real e resolução da
origem durante apply. Os testes do pacote e dos renderizadores não foram reduzidos.
O código de produção permanece intacto. O saldo nos dois arquivos de teste é
de **duas linhas adicionais**; o ganho desta etapa é no custo das preparações.

Medição: três pares antes/depois, alternando a ordem, no mesmo worktree limpo,
Windows e Node 24.14.1, com HOME isolado pelo runner. Comando:
`node scripts/run-tests.js --match forge-installer.test --match forge-update.test`.
Os tempos são observações locais, não uma promessa de ganho igual na CI.

| Execução | Antes | Depois |
| --- | ---: | ---: |
| 1 | 43,736 s | 27,348 s |
| 2 | 42,640 s | 27,231 s |
| 3 | 43,099 s | 28,563 s |
| Mediana | 43,099 s | 27,348 s |

A mediana caiu **36,5%** nas duas suítes juntas. Todas as seis execuções
passaram. A medição inicial, concorrente com o update, foi descartada;
a tabela usa somente os pares alternados posteriores.

## Quinta etapa: gate de plano standalone

A quinta etapa consolida o gate de plano de `forge-task` no contrato existente
`shared/forge-plan-gate.md`. O consumidor mantém apenas bindings e retorno;
retomada por marker, falha de prefs, legado sem contagens, edição/releitura,
aprovação, captura de itens e eventos ficam no contrato compartilhado.

O parser dos exemplos compartilhados e de `forge-next` agora recebe JSON por
`process.argv[1]`. Antes, `R=...` era passado depois de `node -e`, como argumento,
mas o código lia `process.env.R`: JSON válido falhava quando a variável não existia.
O novo teste reproduziu essa falha antes da correção e executa as expressões
extraídas das fontes, além do guard shell completo quando Bash está disponível.
Cobertura: legado, plano estruturado válido/inválido, JSON malformado e erro de IO.

Redução líquida nas três fontes distribuídas: **195 linhas e 11.304 bytes**
(normalização LF). Nenhum controlador novo foi criado. A instalação real dos
dois hosts confirma o binding e a disponibilidade do contrato; apenas o golden
de skills foi atualizado. Os testes de contrato não simulam uma interação humana
na UI e não demonstram comportamento de abas ou campos do cliente.

## Publicação das correções: v4.33.4

As cinco etapas acima entraram na `master` com commits `refactor:`. Esse tipo
não incrementa a versão: o workflow de release valida o código, mas pula a
publicação quando não há `fix:`, `feat:` ou mudança incompatível desde a última
tag. Assim, as alterações ainda não estavam disponíveis no canal `stable`.

A v4.33.4 publica esse conjunto, incluindo duas correções de comportamento:
isolamento das transações pela slice selecionada (#174) e transporte correto
do JSON na revalidação do gate de plano (#177). O commit de publicação usa
`fix:` para que o resolvedor derive o próximo patch a partir de v4.33.3.

Para concluir uma entrega destinada ao canal estável, é necessário verificar
não só o CI e o merge, mas também a criação da release, a tag apontando para o
commit integrado e a resolução dessa versão pelo updater no canal `stable`.
Correções de comportamento devem usar `fix:`, mesmo quando acompanhadas de
refatoração; refatorações puras continuam sem publicação automática.

## Próximas etapas

- Medir várias execuções do CI antes de alterar o balanceamento dos shards.
- Migrar outros cenários de instalação para fixtures menores, mantendo integrações com
  o pacote real e os contratos de projeção e update.
- Consolidar outras repetições do smoke somente após identificar o responsável
  principal por cada comportamento.
- Concluir a centralização dos fluxos nos controladores existentes, removendo
  procedimentos equivalentes dos prompts. O fluxo standalone de task precisa
  de tratamento explícito; não é selecionado pelo controlador de milestones.

Essas frentes posteriores ainda não estão implementadas.
