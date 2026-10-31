# Viabilidade do painel Forge no VS Code

Registro da prova antecipada de S01, em 28/10/2026.
O alvo aceito é Codex no VS Code primeiro; Claude Code recebe as melhorias do terminal.
O registro consumível pela S05 é [panel-feasibility.json](panel-feasibility.json).

## Resultado e limite

A montagem ficou **unknown**: o CLI terminou com exit code 0, mas o runner não produziu um resultado observável.
Isso mantém C05 pendente; não demonstra ausência de suporte do cliente nem incompatibilidade de TreeView.
Não há pergunta funcional G1 aberta.
O aceite visual e de compreensão humana continua **pending-final-round**.

## Cliente identificado

- Produto: Visual Studio Code.
- Fonte de versão/build: `code --version`, reobservado nesta execução.
- Versão: **1.143.1**.
- Commit: `e646868227c3e3a9e3f24277c8c7220be42c0be7`.
- Arquitetura: `x64`.
- Ambiente do terminal: `TERM_PROGRAM=vscode`, `TERM_PROGRAM_VERSION=1.143.1`.
- Instância montada via `vscode.version`, `env.appName`, `env.appHost` e `env.uiKind`: **unknown**, sem resultado do runner.
- Consistência entre CLI e instância montada: **unknown**.
- A versão do CLI VS Code identifica o cliente instalado; não é uma versão da interface Codex.
- A versão de CLI ou daemon Codex nunca é usada como build da UI.

## Superfície Codex

`code --list-extensions --show-versions` e os metadados do diretório padrão foram inspecionados somente para publishers permitidos.
O registro conserva apenas ID e versão de extensões OpenAI/Anthropic.
Foi observado `anthropic.claude-code@2.1.312`.
Não foi encontrada extensão OpenAI nos perfis inspecionados: `not-found-in-inspected-profiles`.
Isso não comprova ausência do Codex em outro perfil, componente interno ou outra interface.
A versão/build da UI Codex permanece **unknown**; a declaração do operador preserva o alvo VS Code.

## Mecanismo escolhido

- TreeView nativa em View Container próprio, na activity bar.
- Pacote local de desenvolvimento: `extensions/forge-vscode`.
- Processo: extension host local do próprio VS Code.
- `webview: false`.
- `server_required: false`.
- `listener: none`.
- `hosting: none`.
- `network: false` para a extensão, conforme o fechamento de imports e as armadilhas da suíte offline.
- Não houve monitoramento da rede global do cliente; updates e telemetria foram desligados no perfil temporário.
- Não há instalação no perfil real, marketplace nem alteração da extensão Codex.

## Montagens reais, separadas dos testes offline

As três chamadas usaram user-data-dir, extensions-dir vazio e workspace próprios em uma raiz temporária exclusiva.
Usaram `--disable-extensions`, `--disable-workspace-trust`, `--skip-welcome`, `--skip-release-notes`, `--new-window` e `--wait`.
`--extensionDevelopmentPath` apontou para o pacote local e `--extensionTestsPath` para seu `test/mount-probe.js`.
O IPC herdado da sessão IDE foi removido do ambiente do novo processo para preservar a instância do operador.
O invocador canônico usa argv e `shell: false`, com teto de 120000 ms.

| Tentativa | Duração do comando | Exit | Canal do runner | Resultado | Limpeza |
|---|---:|---:|---|---|---|
| Inicial, gerada por `--record --out` | 31499 ms | 0 | ausente | unknown | removed |
| Corrigida, com diagnóstico limitado antes da remoção | 31692 ms | 0 | ausente | unknown | removed |
| Executável GUI instalado, chamado diretamente | 31391 ms | 1 | ausente | unknown | removed |

O JSON preserva as duas primeiras observações em `previous_mount_attempts`, sem preencher campos históricos ausentes.
A segunda tentativa corrigiu uma lacuna de observabilidade do probe candidato: retenção privada limitada de stdout/stderr e logs locais antes da limpeza.
Não foi uma mudança de modelo, cliente ou superfície.
A segunda captura observou zero arquivos de log no perfil e stdout/stderr vazios.
O SHA-256 dos fluxos vazios é `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
Não há SHA-256 de resultado do runner: nenhum arquivo válido foi observado.
Não há evidência de rejeição de flags, extensão desativada ou falha de ativação nas duas primeiras chamadas; a causa do canal ausente não foi demonstrada.

A terceira chamada foi tecnicamente diferente: o launcher Windows reconhecido aponta para `Code.exe` instalado, invocado diretamente com argv e `shell: false`.
`ELECTRON_RUN_AS_NODE` foi removido somente do ambiente dessa montagem GUI, além do IPC e modo CLI herdados.
A [fonte oficial do runner de testes](https://github.com/microsoft/vscode-test/blob/main/lib/runTest.ts) passa os caminhos de desenvolvimento/teste ao executável do cliente.
A [documentação oficial de testes](https://code.visualstudio.com/api/working-with-extensions/testing-extension) distingue executável e CLI e registra restrições quando a mesma edição já está aberta.
Isso sustenta a mudança de launcher; não demonstra a causa das duas observações anteriores.
Nenhuma flag de enfraquecimento de sandbox foi incorporada.
Essa chamada terminou com exit 1, sem resultado do runner nem logs no perfil; stdout teve 121 bytes e stderr 680 bytes.
O diagnóstico público registra somente classes permitidas, hashes e contagens; o material limitado ficou em captura privada do owner.
SHA-256 combinado dessa captura: `e80aefdef1e6a484444cb3e797ec372fb178424a8da76bb5a1a6a75842011fa7`.
O owner classificou posteriormente a mensagem explícita de mutex de atualização retido: **vscode-update-in-progress**, camada **host-environment**.
Essa classificação está vinculada por hash à captura privada existente e possui horário próprio no JSON; não é uma nova montagem.
O executável recusou iniciar enquanto o VS Code estava sendo atualizado, antes do perfil e do runner.
A causa das duas primeiras chamadas continua desconhecida; sua proximidade temporal não demonstra a mesma causa.
Não foi atribuído defeito à superfície TreeView, a preferências ou ao provedor, nem foi interrompido o instalador do operador.
Não houve chamada idêntica adicional nem variação especulativa sem `--disable-extensions`.

Nas tentativas com diagnóstico, a atribuição usa argumentos de caminho exatos da raiz exclusiva, identidade de criação do processo e relações de descendência observadas.
Prefixos de raízes irmãs e PID reutilizado são recusados nos testes.
O probe confirmou a saída dos processos atribuídos antes de remover o próprio temporário.
Se a saída, a identidade física, um link ou a remoção não puderem ser confirmados, o resultado registra `cleanup: pending` com marcador sanitizado.
A janela existente do operador não foi fechada nem reiniciada.

## Claude Code no terminal

- Versão observada no executável nativo instalado: **2.1.312**.
- `subagentStatusLine`: documentado na [documentação oficial de statusline](https://code.claude.com/docs/en/statusline.md).
- SHA-256 da documentação capturada na análise datada: `a2391a0f4b8892bd32c0ea95d3d3d25f319c6891c963895ea0f2dd4c74150aa4`.
- A captura datada identifica a fonte; esta task não refaz o fetch da documentação.
- Referência estática na build local: **found**, por leitura streaming local limitada a 512 MiB.
- Exibição real de `subagentStatusLine`: **unknown**, a verificar na S03.
- Nenhum painel Claude Desktop/IDE é exigido.

## Superfícies de subagentes: documentado e observado

| Host | Documentado | Observado nesta task |
|---|---|---|
| Codex CLI | `/subagents` e navegação entre threads | unknown |
| Codex VS Code | sidebar IDE e UI de agentes em background condicionada ao cliente | unknown |
| Claude terminal | subagentes e `subagentStatusLine` | versão e literal estático; renderização unknown |

Uma descrição de navegação documentada não prova que o cliente desta sessão mostrou a superfície.
Sidecars não são apresentados como threads nativas.

## G1, reexecução e aceitação

G1 só é necessário com `not-mounted` após diagnóstico ou exigência de servidor, listener ou hosting.
Nesse caso, o probe devolve a pergunta `g1_panel_surface` para o owner persistir, com uma decisão e consequências.
`unknown` não abre G1 e não reduz silenciosamente o escopo.
O comando a reexecutar no host, quando houver nova evidência de lançamento/ambiente, é:

```text
node scripts/forge-panel-probe.js --mount --json
```

O runner só escreve resultado novo, em caminho absoluto dentro da raiz temporária própria, sem links nem sobrescrita.
`mounted` exige ativação, container revelado, `treeView.visible` e ao menos um nó sintético; exit 0 sozinho não basta.
As suítes offline usam fake de `code` via `process.execPath`, sem abrir a GUI.
Validação do registro: `node scripts/forge-panel-probe.js --validate-record docs/panel-feasibility.json`.
Suítes automatizadas, montagem observada e aceite humano são fatos independentes.
O UAT visual e de compreensão permanece pendente para a rodada final autorizada.
