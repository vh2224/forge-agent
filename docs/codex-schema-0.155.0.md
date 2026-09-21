# Compatibilidade do schema Codex 0.155.0

A investigação local comparou a projeção de 0.149.1 com o schema gerado por
`codex-cli 0.155.0`, antes de substituir o pin. O conjunto passou de 18 para 19
variantes de ThreadItem e de 45 para 51 tipos referenciados, sem refs não resolvidas.

| Mudança | Efeito no Forge |
| --- | --- |
| Nova variante `functionCallOutput` | Classificada explicitamente como `tool-result-unverified`; não produz evidência. |
| `agentMessage.questions` opcional | O adapter continua lendo `text`; perguntas não atestam execução. |
| `TurnStartParams.serviceTierForTurn`, `toolOutput`, `turnTrigger` opcionais | O Forge não envia esses campos; os campos obrigatórios continuam `input` e `threadId`. |
| Valores novos em `CodexErrorInfo`, `CollabAgentTool`, `CollabAgentToolCallStatus`, `SubAgentActivityKind` | Não ampliam a admissibilidade de evidências nem a condição de sucesso do turno. |
| `TurnError.misalignment` opcional | O cliente continua exigindo status `completed`; detalhes adicionais não transformam falha em sucesso. |

As variantes `commandExecution` e `fileChange`, únicas admitidas como evidência,
mantiveram seus schemas. Nenhuma variante anterior foi removida. Os seis novos
tipos referenciados são `AsyncUserInputQuestion`, `FunctionCallOutputBody`,
`FunctionCallOutputContentItem`, `MisalignmentErrorDetails`, `MisalignmentSteer`
e `TurnToolOutput`.

A [documentação do app-server](https://learn.chatgpt.com/docs/app-server)
descreve `toolOutput` como saída fornecida pelo cliente, exposta como
`functionCallOutput`. Essa origem justifica sua exclusão de evidências de execução.
O teste do adapter injeta uma saída dizendo que os testes passaram e verifica
que ela foi recebida, mas não admitida.

`--generate-pin` agora confronta os nomes com a política de admissibilidade,
em vez de aceitar uma contagem fixa. Uma variante desconhecida, mesmo trocando
outra sem alterar a contagem, impede a escrita. Isso não substitui a revisão
dos campos: `--check` continua detectando alterações nos schemas e referências.

Os cenários determinísticos da seção 92 do smoke passaram para
`forge-schema-pin.test.js`, com os casos de CLI que ainda não estavam nessa suíte:
ordenação, rename, drift em referências, nova variante, pin ilegível e gerador
ausente. A seção mantém a checagem do CLI instalado, com skip explícito quando
ausente. As integrações de transporte e evidência das seções 93–95 permanecem.

A validação usa geração real de schema e transporte simulado; não executa uma
sessão paga de inferência e não garante compatibilidade com versões futuras do CLI.
