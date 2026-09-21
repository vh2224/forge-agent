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

## Próximas etapas

- Medir várias execuções do CI antes de alterar o balanceamento dos shards.
- Migrar cenários de instalação para fixtures menores, mantendo integrações com
  o pacote real e os contratos de projeção e update.
- Consolidar outras repetições do smoke somente após identificar o responsável
  principal por cada comportamento.
- Concluir a centralização dos fluxos nos controladores existentes, removendo
  procedimentos equivalentes dos prompts. O fluxo standalone de task precisa
  de tratamento explícito; não é selecionado pelo controlador de milestones.

Essas frentes posteriores ainda não estão implementadas.
