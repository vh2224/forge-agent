# Compatibilidade do schema Codex 0.159.3

O pin foi regenerado com o `codex-cli 0.159.3` instalado, a partir do schema
oficial produzido por `codex app-server generate-json-schema`. Em seguida,
`forge-schema-pin.js --check --json` retornou `match`, com
`definitions_compared: 5` e `referenced_compared: 53`. O pin mantém cinco roots
e 19 variantes de ThreadItem; os tipos referenciados passam de 51 para 53, sem
refs não resolvidas.

## Drift completo: 26 caminhos, não 20

`diffValues` interrompe a lista em 20 campos. Por isso, um `--check` do pin
0.155.0 contra o CLI novo mostraria só uma amostra truncada. A comparação usada
aqui foi feita separadamente, root por root e tipo por tipo; nenhum tipo chegou
ao limite de 20. O total é de **26 caminhos**.

Os caminhos são relativos ao tipo. Os cinco roots ficam em `definitions` no pin
e os demais tipos ficam em `referenced`.

| Grupo | Caminhos | Qtd | Efeito no Forge |
| --- | --- | --- | --- |
| UI MCP em `mcpToolCall` | `ThreadItem.oneOf[8].properties.mcpAppUi` adicionado | 1 | Campo opcional de apresentação. `mcpToolCall` continua inadmissível como evidência. |
| Novos tipos referenciados | `McpAppDisplayMode`, `McpAppUi` adicionados | 2 | São alcançados apenas por `mcpAppUi` e não criam nova evidência admissível. |
| Plugins por turno | `TurnStartParams.properties.disabledPluginIds` adicionado | 1 | Opcional. O Forge não envia o campo, e `input` e `threadId` continuam obrigatórios. |
| Enum de erro | `CodexErrorInfo.oneOf[0].enum[4..14]` alterado | 11 | `flexUnavailable` e `tooManyDenials` foram inseridos. Nove valores existentes mudaram de índice e duas posições foram acrescentadas ao final. Nenhum valor existente foi removido. |
| Imagem em saída de função | `FunctionCallOutputContentItem.oneOf[1]`: `anyOf` adicionado, `properties.image_url` removido do formato externo, `required[0]` alterado, `required[1]` removido | 4 | A imagem passa a aceitar `image_url` **ou** `file_id` via `anyOf`. O suporte a imagem continua. A variante segue em `functionCallOutput`, que é `tool-result-unverified`. |
| Imagem em entrada do usuário | `UserInput.oneOf[1]`: `anyOf` adicionado, `properties.url` removido do formato externo, `required[1]` removido | 3 | URL e arquivo passam para `anyOf`. A entrada de texto usada pelo Forge mantém os mesmos campos obrigatórios. |
| Descrições | `ThreadItem.oneOf[8].properties.mcpAppResourceUri.description` alterada, `TurnStartParams.properties.personality.description` alterada, `Personality.description` adicionada, `Turn.properties.error.description` alterada | 4 | Apenas documentação, sem mudança de tipo ou obrigatoriedade. |
| **Total** | | **26** | |

Em nenhum dos 26 caminhos foi demonstrada incompatibilidade com os parâmetros
que o Forge usa.

## Variantes e evidência

Nenhuma das 19 variantes de ThreadItem foi adicionada, removida ou renomeada.
Duas continuam admissíveis como evidência (`commandExecution` e `fileChange`) e
17 continuam inadmissíveis, conforme `VARIANT_ADMISSIBILITY` em
`forge-evidence-admit.js`. As mudanças de UI MCP alteram apenas `mcpToolCall`
(`oneOf[8]`), que permanece `tool-result-unverified`. Itens com UI MCP não passam
a ser aceitos como evidência de execução.

Um turno só tem sucesso com status `completed`. Um erro, inclusive com os novos
valores `flexUnavailable` ou `tooManyDenials`, não conta como sucesso.

## ThreadStartParams

`ThreadStartParams` não está entre os cinco roots do pin, então o `--check` não
o cobre. Ele foi conferido à parte no schema oficial gerado: o tipo não tem
campos obrigatórios, e `model`, `approvalPolicy` e `ephemeral`, que o Forge
usa, continuam opcionais.

## Limites da verificação

- O pin registra a versão usada na geração, mas não define versão mínima nem
  garante compatibilidade com versões futuras.
- Com um CLI instalado mais antigo que 0.159.3, `--check` retorna `drift` e sai
  com código 1. Isso é esperado e não indica regressão.
- O smoke só pula a comparação com o CLI quando ele não está instalado. A CI
  atual não instala o Codex, portanto não executa essa comparação.
- Testes offline verdes usam schema fixo e transporte simulado. Eles não provam
  compatibilidade com uma sessão real de um CLI antigo e não executam inferência
  paga.

Esta nota descreve o escopo e os limites da comparação 0.155.0 → 0.159.3. Ela
não garante compatibilidade com todas as versões.

Fontes: [changelog do Codex](https://learn.chatgpt.com/docs/changelog), o schema
oficial gerado por `codex app-server generate-json-schema` e a comparação
independente descrita acima.
