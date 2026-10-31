# Compatibilidade do schema Codex 0.165.0

O schema oficial foi gerado pelo `codex-cli 0.165.0` instalado, usando
`codex app-server generate-json-schema --out <temporário>` com argv e sem shell.
Após revisão completa, o pin foi regenerado exclusivamente pelo helper
`node scripts/forge-schema-pin.js --generate-pin --json`, que exige
`assertVariantCoverage` antes de gravar. O guard final compara cinco roots e
54 tipos referenciados (`definitions_compared: 5`, `referenced_compared: 54`).
São 19 variantes de ThreadItem, referenciados de 53 para 54 e nenhuma ref não
resolvida. Os cinco roots continuam ThreadItem, TurnStartParams,
ItemCompletedNotification, TurnCompletedNotification e JSONRPCError.

## Drift completo antes do repin

O próprio helper, com `--check --full --json`, encontrou **18 caminhos**:
`fields_total: 18`, `fields_truncated: false`. Não houve truncamento.
O guard anterior saiu 1 com `drift`; a captura completa ocorreu antes de
`--generate-pin`. Não foi usado comparador paralelo para substituir o guard.
O default mantém no máximo 20 caminhos; `--full` lista todos, em JSON ou texto.
`fields_truncated` informa se o default truncaria (total maior que 20), mesmo
quando a opção completa está ativa. `--full` sem `--check` sai 2.

| Grupo | Quantidade | Efeito no Forge |
|---|---:|---|
| imageGeneration | 7 | Aceita resultado inline ou identidade `fileId`, adiciona entradas observadas e descrição; continua `tool-result-unverified`, sem evidência admissível. |
| Enum CodexErrorInfo | 10 | Insere `modelNotFound` no índice 6; desloca nove valores existentes, sem removê-los. A classificação tipada é trabalho da S01/T04. |
| Tipo referenciado novo | 1 | `ImageGenerationInputImage` descreve path e sha256 de entradas locais; não atesta execução de código. |
| Total | 18 | Nenhuma variante ThreadItem adicionada, removida ou renomeada. |

Cada caminho abaixo é exatamente o emitido pelo helper (índices de arrays
permanecem significativos; só a ordenação de `required` é normalizada):

| Grupo | Caminho | Mudança |
|---|---|---|
| imageGeneration | `definitions.ThreadItem.oneOf[15].anyOf` | adicionado |
| imageGeneration | `definitions.ThreadItem.oneOf[15].description` | adicionada |
| imageGeneration | `definitions.ThreadItem.oneOf[15].properties.inputImages` | adicionado |
| imageGeneration | `definitions.ThreadItem.oneOf[15].properties.result` | removido do objeto externo; presente no ramo inline de anyOf |
| imageGeneration | `definitions.ThreadItem.oneOf[15].required[1]` | result → status |
| imageGeneration | `definitions.ThreadItem.oneOf[15].required[2]` | status → type |
| imageGeneration | `definitions.ThreadItem.oneOf[15].required[3]` | type removido dessa posição |
| Enum CodexErrorInfo | `referenced.CodexErrorInfo.anyOf[0].enum[6]` | cyberPolicy → modelNotFound |
| Enum CodexErrorInfo | `referenced.CodexErrorInfo.anyOf[0].enum[7]` | misalignmentPolicyViolation → cyberPolicy |
| Enum CodexErrorInfo | `referenced.CodexErrorInfo.anyOf[0].enum[8]` | tooManyDenials → misalignmentPolicyViolation |
| Enum CodexErrorInfo | `referenced.CodexErrorInfo.anyOf[0].enum[9]` | internalServerError → tooManyDenials |
| Enum CodexErrorInfo | `referenced.CodexErrorInfo.anyOf[0].enum[10]` | unauthorized → internalServerError |
| Enum CodexErrorInfo | `referenced.CodexErrorInfo.anyOf[0].enum[11]` | badRequest → unauthorized |
| Enum CodexErrorInfo | `referenced.CodexErrorInfo.anyOf[0].enum[12]` | threadRollbackFailed → badRequest |
| Enum CodexErrorInfo | `referenced.CodexErrorInfo.anyOf[0].enum[13]` | sandboxError → threadRollbackFailed |
| Enum CodexErrorInfo | `referenced.CodexErrorInfo.anyOf[0].enum[14]` | other → sandboxError |
| Enum CodexErrorInfo | `referenced.CodexErrorInfo.anyOf[0].enum[15]` | other adicionado na posição final |
| Tipo novo | `referenced.ImageGenerationInputImage` | adicionado |

O confronto com [a evidência de 28/10](host-compatibility-2026-10-28.evidence.json),
`schema.unlimited_diff_paths` e `schema.diffs`, confirma as mesmas **18 diferenças**,
nos mesmos grupos 7 + 10 + 1. Divergência de contagem: **zero**.
A evidência usa índices com pontos; o helper usa colchetes. Essa diferença de
notação não é diferença de schema. A evidência datada permanece inalterada.

## Admissibilidade das 19 variantes de ThreadItem

| Variante | Veredito | Razão |
|---|---|---|
| `userMessage` | inadmissível | model-authored — entrada textual, sem observação de execução. |
| `hookPrompt` | inadmissível | model-authored — fragmento de prompt. |
| `agentMessage` | inadmissível | model-authored — narração do modelo. |
| `functionCallOutput` | inadmissível | tool-result-unverified — saída fornecida pelo cliente. |
| `plan` | inadmissível | model-authored — intenção, sem execução observada. |
| `reasoning` | inadmissível | model-authored — raciocínio do modelo. |
| `commandExecution` | admissível | runtime-observed — exitCode, status, duração e cwd observados pelo runtime. |
| `fileChange` | admissível | runtime-observed — paths, tipos de mudança e status do patch observados. |
| `mcpToolCall` | inadmissível | tool-result-unverified — resultado retransmitido de ferramenta. |
| `dynamicToolCall` | inadmissível | tool-result-unverified — sucesso autodeclarado. |
| `collabAgentToolCall` | inadmissível | tool-result-unverified — prompt ou estado de outro agente. |
| `subAgentActivity` | inadmissível | tool-result-unverified — atividade não comprova o trabalho realizado. |
| `webSearch` | inadmissível | tool-result-unverified — consulta não executa código do repositório. |
| `imageView` | inadmissível | tool-result-unverified — leitura de imagem. |
| `sleep` | inadmissível | session-lifecycle — tempo decorrido. |
| `imageGeneration` | inadmissível | tool-result-unverified — inputImages e fileId não atestam execução de código. |
| `enteredReviewMode` | inadmissível | session-lifecycle — mudança de modo. |
| `exitedReviewMode` | inadmissível | session-lifecycle — mudança de modo. |
| `contextCompaction` | inadmissível | session-lifecycle — contabilidade do contexto. |

Tabela validada por `node scripts/forge-evidence-admit.js --check-doc
docs/codex-schema-0.165.0.md --json`. VARIANT_ADMISSIBILITY permanece inalterado:
duas variantes admissíveis e 17 inadmissíveis. O teste novo exercita
`buildRuntimeEvidence` com inputImages e fileId: conta o item como inadmissível
e não produz entry. `assertVariantCoverage` confronta os 19 nomes do pin novo.

## Classificação de modelNotFound

A política é falha terminal da rota pedida, código fechado `model-not-found`.
Não é timeout nem indisponibilidade presumida, e não autoriza troca silenciosa
de modelo, novo retry ou retirada do model explícito. O texto do provider não
deve ser anexado ao diagnóstico ou result file.
A implementação pertence à **S01/T04** (posterior a este repin): preservar o tipo
no cliente, classificar no adapter e diagnóstico e provar o ramo genérico
`unknown` do recovery, alterando somente lacunas demonstradas por fixture.
Este documento registra a política; o repin sozinho não comprova sua execução.

## ThreadStartParams e TurnStartParams

`v2/ThreadStartParams.json` foi revalidado separadamente dos cinco roots.
Não tem campos obrigatórios (`required: []`); `model` é string ou null,
`approvalPolicy` aceita AskForApproval ou null e `ephemeral` é boolean ou null.
Isso preserva os parâmetros explícitos usados pelo Forge; não muda aprovações.
`v2/TurnStartParams.json` exige `input` e `threadId`; model e approvalPolicy
continuam opcionais. Nenhum desses fatos adota novas capabilities implicitamente.

## Requests de entrada do app-server

Inventário documental extraído de `ServerRequest.json` gerado pelo CLI local,
fora dos roots pinados, para decisão da S04. A marcação abaixo vem da descrição
do request; ausência de marca experimental não garante estabilidade de toda a API.

| Método | Tipo de params | Marcação no schema |
|---|---|---|
| `item/commandExecution/requestApproval` | `CommandExecutionRequestApprovalParams` | sem EXPERIMENTAL; NEW APIs |
| `item/fileChange/requestApproval` | `FileChangeRequestApprovalParams` | sem EXPERIMENTAL; grantRoot é UNSTABLE |
| `item/tool/requestUserInput` | `ToolRequestUserInputParams` | EXPERIMENTAL (também no tipo de params) |
| `mcpServer/elicitation/request` | `McpServerElicitationRequestParams` | sem EXPERIMENTAL |
| `item/permissions/requestApproval` | `PermissionsRequestApprovalParams` | sem EXPERIMENTAL |
| `item/tool/call` | `DynamicToolCallParams` | sem EXPERIMENTAL |
| `account/chatgptAuthTokens/refresh` | `ChatgptAuthTokensRefreshParams` | sem EXPERIMENTAL |
| `attestation/generate` | `AttestationGenerateParams` | sem EXPERIMENTAL |
| `applyPatchApproval` | `ApplyPatchApprovalParams` | DEPRECATED APIs |
| `execCommandApproval` | `ExecCommandApprovalParams` | legado; descrição remete às APIs legadas |

São dez métodos. O cliente atual (`scripts/forge-appserver-client.js`) recusa
todos com `-32601` e retém até 500 requests. Este inventário não implementa
brokering, resposta ou consentimento; esse comportamento é decidido na S04.

### Decisão da S04 (T02)

O cliente classifica cada request de entrada por esta tabela em
`INBOUND_REQUEST_CLASSES`: classe `input` para `item/tool/requestUserInput` e
`mcpServer/elicitation/request`; `approval` para os cinco pedidos de aprovação;
`other` para `item/tool/call`, `account/chatgptAuthTokens/refresh` e
`attestation/generate`; qualquer outro método é `unknown`. Todos continuam
recusados com `-32601`, sem teto na resposta.

- **Classe input:** recusa seguida de parada do turno pelo caminho único de kill
  (`turn/interrupt` e depois a árvore do processo), com código fechado
  `appserver-input-required` e mensagem fixa. No recovery state cada pedido vira
  pendência rastreável do owner, com ID estável `inbound-` e texto pt-BR fixo,
  sem texto do provider. Depois de respostas explícitas a recuperação para com
  `answered-continuation-required`: a autorização permanente, candidatos, retry
  ou troca de modelo nunca respondem a pergunta funcional.
- **`item/tool/requestUserInput`** é EXPERIMENTAL e não foi adotado (G3).
- **`mcpServer/elicitation/request`** não recebe brokering no turno: a thread é
  efêmera e a espera econômica não dá identidade, persistência, resposta,
  cancelamento e retomada comprovados.
- **Aprovações** seguem `approvalPolicy` (`never`) e os gates: são recusadas, o
  turno segue e nunca viram pergunta funcional. As classes `other` e `unknown`
  mantêm o mesmo comportamento.
- **Params nunca são retidos:** o cliente guarda até 500 registros fechados
  `{id, method, class, thread_id, turn_id}`, com thread e turno da própria
  sessão; params não são retidos, devolvidos nem reportados.

## Limites da verificação e ambiente observado

- Versão medida: `codex --version` → `codex-cli 0.165.0`.
- SO observado: Node win32, Windows `10.0.26300`, Node `v24.14.1`.
- Guard inicial em 2026-10-28 UTC: drift, exit 1; horário exato desse comando
  não capturado. Contexto/hash original medidos às `2026-10-28T17:13:46.401Z`.
- Captura completa e inspeção local: 2026-10-28 UTC, antes do repin.
- Repin: `2026-10-28T17:17:41.059Z`, outcome match, exit 0.
- Guard final: `2026-10-28T17:17:41.446Z`, outcome match, exit 0,
  fields_total 0, fields_truncated false, cinco roots e 54 referenciados.
- Temporários gerados fora do checkout, removidos somente após conferir contenção
  física sob o diretório temporário do SO. Nenhuma inferência paga foi executada.
- A CI não instala Codex. O teste live é explicitamente pulado quando o CLI
  revisado não está disponível; isso nunca comprova compatibilidade live.
- Fixtures offline provam o guard e a política, não o comportamento de um provider.
- O pin não define versão mínima nem garante versões futuras ou sessões antigas.
- Os negativos preservam hash do pin histórico, enum reordenado, campo renomeado,
  drift em referenced, pin ilegível, gerador ausente e variante substituída recusada.
- UAT humano visual/de compreensão e revisão independente S01 permanecem pendentes.

## Fontes e continuidade

Fontes locais: schema oficial gerado pelo CLI, pin histórico e
[evidência datada](host-compatibility-2026-10-28.evidence.json).
[Changelog do Codex](https://learn.chatgpt.com/docs/changelog), referência da
pesquisa do owner, não revalidada na rede nesta task.
A [issue 279](https://github.com/vh2224/forge-agent/issues/279) é referenciada
sem fechamento; esta nota não a declara resolvida.
Sugestão de commit: `fix(schema): repin Codex app-server 0.165.0 after full diff review`,
com a linha `Refs #279`.
