# Compatibilidade do schema Codex 0.166.0

Em 31/10/2026, o gerador do `codex-cli 0.166.0` instalado produziu o
schema oficial de app-server. O helper canônico `forge-schema-pin.js`
validou a cobertura das variantes antes de gravar a projeção. Este registro
atualiza a compatibilidade do protocolo da issue #279; os relatórios anteriores
continuam como evidência histórica.

## Diferenças examinadas

Comparação integral da projeção anterior, 0.165.0, com a nova:

| Superfície | Alteração | Efeito no Forge |
| --- | --- | --- |
| `ThreadItem.description` | Descrição do payload plano e dos tempos de ciclo | Documental |
| Variante de geração de imagem | `generationId` opcional, string ou null | Não acrescenta uma variante nem torna o campo obrigatório |
| `ThreadItem` | `type: object` explícito; propriedades opcionais `startedAtMs` e `completedAtMs`, integer ou null | Envelope continua plano; nenhum campo novo em `required` |
| `CodexErrorInfo` | Enum acrescenta `policyCapacityUnavailable` depois de `modelNotFound` | Um valor adicional; os deslocamentos dos índices seguintes não são renomeações |
| Metadados da projeção | Versão do CLI e instante da geração | Proveniência local |

A comparação recursiva do helper mostrou 14 caminhos de diferença na parte
funcional; dez deslocamentos/adição no enum representam a inserção de um valor.
A projeção continua contendo cinco definições principais, 54 tipos referenciados,
19 variantes e nenhuma referência não resolvida. O conjunto dos nomes das
variantes permaneceu idêntico e passou em `assertVariantCoverage`.

## Política preservada

Nenhuma política de admissibilidade de evidência foi alterada. Campos opcionais
novos não transformam texto do modelo, geração de imagem ou eventos de ciclo de
sessão em prova de execução. Variantes desconhecidas continuam recusadas. O
guard de drift continua ativo; atualizar o pin não autoriza ignorar diferenças
de uma versão futura. O valor novo de erro não significa que um timeout teve
essa causa, nem autoriza inferir indisponibilidade de um provedor.

## Verificação e limites

Comandos de validação do plano: `forge-schema-pin.test.js`,
`forge-schema-guard.test.js`, `forge-evidence-admit.test.js` e o check do schema
gerado pelo CLI realmente instalado. As saídas e a revisão independente ficam
nos artefatos da task e no CI da PR correspondente; a existência desta lista
não declara os comandos aprovados.

Esta análise cobre o protocolo gerado localmente. Não houve inferência real
para demonstrar todos os eventos novos, nem aceite humano da interface.
Não atualiza os marcos de revisão geral das notas de release de Codex ou Claude,
não muda o CLI instalado e não altera configurações pessoais.
