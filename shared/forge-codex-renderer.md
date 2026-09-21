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
