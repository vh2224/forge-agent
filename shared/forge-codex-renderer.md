# Codex renderer

## Interação nativa por host

O renderer inclui o contrato canônico `shared/forge-interaction.md` em
`AGENTS.md`, agentes, skills, comandos e templates dispatch. Exemplos Claude
de `AskUserQuestion` representam intenção: no Codex, o contrato exige adaptar
schema, lotes, opções e multiSelect para uma ferramenta realmente exposta e
permitida. Restrições de finalidade e modo do host prevalecem. A ferramenta
assíncrona não resolve uma decisão ao devolver apenas um identificador pendente.

`write` consulta localmente `codex features list`, com execução sem shell e
timeout limitado, antes de acrescentar o default experimental
`features.default_mode_request_user_input = true`. O mesmo editor conservador
do statusline preserva configuração explícita, comentários e EOL; ambiguidades
são reportadas como `questions-manual-merge`. `render` apenas descreve os
artefatos base e não executa probes. Dry-run deixa a capacidade pendente com
`questions-probe-dry-run`, sem consultar o CLI ou alterar arquivos. Veja também
`shared/forge-install.md`. Testes de projeção e instalação validam estes
contratos; não validam abas ou bloqueio de entrada na interface do cliente.

`scripts/forge-codex-renderer.js` é a projeção nativa Codex do mesmo
`forge-source-manifest.json` usado pelo renderer Claude. Ele gera `AGENTS.md`,
custom agents em `CODEX_HOME/agents`, `config.toml` e um relatório de
capabilities no Forge home, sem ler ou escrever `~/.claude`.

Superfícies sem tradução oficial 1:1 permanecem explicitamente condicionais ou
indisponíveis no relatório; o renderer não usa o CLI Claude como fallback.

`AGENTS.md` carrega o contrato de comunicação de `shared/forge-communication.md`
por meio do projetor único `forge-instructions.renderCommunicationContract`,
incorporado em `standing.renderBlock` junto dos contratos de roteamento, pessoal
e de entrada. O renderer usa esse mesmo bloco gerenciado, que a sincronização
posterior substitui sem acrescentar cópia independente ou reter texto obsoleto.
A fonte `communication` aparece como `distributed` no relatório, sem artefato
separado; isso não comprova funcionamento na interface ou aceite humano.

Medição local S02/T03: o bloco gerenciado passou de 9 764 para 14 138 bytes
UTF-8 (acréscimo de 4 374 bytes). A suíte declara um orçamento local de
16 384 bytes para detectar crescimento; esse teto não é um limite verificado do host.
O contrato canônico tem 37 linhas. Esses números medem a distribuição textual,
sem comprovar consumo pelo cliente ou compreensão humana.

## Relatório de capabilities (schema 2)

`adapters/codex/capabilities.json`, no Forge home, informa qual core gerou o
relatório, a partir de qual fonte e com qual classificação. A saída é
determinística: não tem timestamp nem caminho absoluto, e duas escritas
seguidas produzem os mesmos bytes. Campos:

- `report_schema_version: 2`, `forge_source: "codex-capabilities"`,
  `generated: true`, `runtime: "codex"` e `generator: "forge-codex-renderer"`
  identificam o relatório.
- `core_version` traz o `VERSION` do core que renderizou. `version` repete o
  mesmo valor como espelho legado, para leitores anteriores ao schema 2.
- `source.catalog` vale `available` ou `unavailable`. Quando disponível,
  `source.catalog_sha256` é o digest (`forge-projection-ownership.digest`) do
  `forge-capabilities.json` do repositório e `source.catalog_schema_version` é
  a versão do schema dele. O catálogo é lido de forma tolerante, sem
  `loadCatalog`, porque fontes só de configuração não trazem `schemas/`.
  Catálogo ausente, grande demais, malformado ou recusado por `validateCatalog`
  gera `unavailable`, com
  digest e versão `null`. `source.source_manifest_sha256` é o digest do
  inventário normalizado por `forge-source-manifest.normalize`.
- `capabilities` lista `capability_id`, `kind`, `required` e a coluna `codex`
  de `forge-capabilities.matrix()`, a mesma de
  `node scripts/forge-capabilities.js --matrix --json`. O valor é `null`
  quando o catálogo está indisponível.
- `surfaces` lista o status Codex de cada fonte do inventário.
- `permissions` resume o contrato de permissões: `native_custom_agents` com
  `sandbox: inherited-from-parent-session` e
  `toml_sandbox_mode: declared-not-isolation-proof`;
  `app_server_sidecar.sandbox: per-turn-sandbox-policy`;
  `headless_exec.sandbox: explicit-cli-flags`; e `contract` com o caminho
  relativo `docs/codex-agent-permissions.md`.

## Freshness e inspeção somente leitura

`inspectCapabilitiesReport({ forgeHome, version })` lê o relatório com limite
de 1 MiB e nunca escreve. A versão instalada é `version`, quando informada;
senão o `VERSION` do Forge home; senão a do módulo. O resultado tem
`state`, `reasons` e campos relativos, sem caminhos pessoais:

| state | reasons | quando |
|---|---|---|
| `current` | nenhum | schema 2, `core_version` igual à versão instalada e `catalog_sha256` igual ao digest do `forge-capabilities.json` instalado |
| `stale` | `legacy-shape`, `core-version-mismatch`, `catalog-digest-mismatch`, `catalog-unavailable`, `installed-catalog-unavailable` | relatório reconhecido, mas desatualizado ou sem prova de catálogo |
| `absent` | `report-absent` | arquivo ausente |
| `invalid` | `unreadable-json`, `wrong-runtime`, `not-generated`, `unrecognized-shape`, `oversize` | conteúdo que não é um relatório gerado pelo Forge |

Catálogo indisponível em qualquer dos lados nunca prova freshness. A CLI
`node scripts/forge-codex-renderer.js --inspect-report --forge-home DIR [--json]`
expõe a mesma função: sai com 0 só para `current` e com 1 nos demais estados,
sem renderizar nem gravar.

## Ownership do relatório e causa medida do 4.8.0

JSON não comporta marker de origem. Para o tipo `capabilities`, o papel do
marker passa a ser do conteúdo reconhecido como relatório gerado: JSON de até
1 MiB com `runtime: "codex"` e `generated: true`, na forma legada (exatamente
as chaves `generated`, `runtime`, `surfaces` e `version`) ou na forma atual
(schema exatamente 2, campos conhecidos completos, tipos válidos e `forge_source`
e `generator` próprios). Campos extras, shape incompleto e schemas futuros não
ganham marker; só um digest previamente registrado e correspondente pode
reconhecer esses bytes como gerenciados. Esse relatório reconhecido é adotado
e reescrito por `write` e pelo instalador, com `reason:
generated-report-adopted` no relatório do renderer. Qualquer outro conteúdo
nesse caminho, incluindo JSON desconhecido, inválido ou grande demais, continua
preservado com conflict `user_owned`. Os demais artefatos seguem as regras de
`forge-projection-ownership.decide` sem mudança.

**Causa medida (issue 280).** Uma leitura somente leitura da instalação, com o
Forge home representado como `<forge-home>`, mostrou:

- core 4.46.8;
- manifest do adapter Codex em 4.46.8, registrando
  `adapters/codex/capabilities.json` como `user_owned`;
- relatório na forma legada (`generated`, `runtime`, `surfaces`, `version`)
  com `version` 4.8.0;
- nenhuma chave para esse destino em `ownership` do `manifest.json`.

O adapter foi reinstalado em 4.46.8, o que descarta a hipótese de "não
reinstalado desde 4.8.0". A causa é o congelamento por ownership. O relatório
não tem marker, o registro não tem digest dele (`recordOf` só registra o que
uma execução escreveu, e um destino `user_owned` não é escrito), e o `source`
sintético não tem histórico de release. A reprodução em raiz temporária de
`scripts/forge-codex-renderer.test.js` falhava antes da correção: `write`
preservava o relatório legado como `user_owned`. A sequência histórica exata
de cada atualização continua desconhecida.

## Significado de `sandbox_mode` nos agentes

Todo TOML de agente mantém `sandbox_mode = "workspace-write"`, nunca um valor
mais amplo. Uma linha de comentário acima do campo explica que sandbox e
aprovações efetivos vêm da sessão pai, que o campo não prova isolamento por
agente e onde está o contrato. O contrato auditado por transporte, com
garantias, limites e achados G2, está em
[`docs/codex-agent-permissions.md`](../docs/codex-agent-permissions.md).

## Barra de status do terminal

A projeção Codex configura por padrão os grupos modelo, contexto, tokens,
limites, projeto, sessão, permissões e interface:

```toml
[tui]
status_line = [
  "model-with-reasoning", "fast-mode",
  "context-used", "context-remaining", "context-window-size",
  "used-tokens", "total-input-tokens", "total-output-tokens",
  "usage-limit", "secondary-usage-limit",
  "project-name", "current-dir", "hostname",
  "thread-title", "thread-id", "task-progress",
  "permissions", "approval-mode",
  "codex-version", "raw-output",
]
```

`usage-limit` e `secondary-usage-limit` acompanham as janelas de uso primária e
secundária informadas pela conta, sem fixar períodos nem duplicar o mesmo saldo.
Os indicadores dependem dos dados disponíveis no Codex; por exemplo, progresso
de tarefas só aparece quando informado. A seleção pode ser reduzida ou
reordenada em `/statusline` conforme o espaço disponível no terminal.

Em um `config.toml` existente, o renderer só acrescenta a opção ausente,
preservando as demais configurações, comentários e finais de linha. Uma
`status_line` já definida, inclusive `[]`, permanece intacta em atualizações,
mesmo quando o arquivo tem um marcador antigo do Forge. O merge é conservador:
sintaxe ambígua, como strings multilinha ou tabelas TUI inline/dotted, é
preservada e sinalizada como `status-line-manual-merge` no relatório.

O padrão vale para novas sessões do Codex CLI. Em uma sessão aberta, use
`/statusline` para selecionar e ordenar os indicadores imediatamente. A opção
é específica do terminal, não da interface gráfica do Codex.
