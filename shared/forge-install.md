# Instalação multi-runtime

## Perguntas nativas

A instalação e o update distribuem `shared/forge-interaction.md`, incluindo
regras permanentes em `CLAUDE.md`/`AGENTS.md` e adaptação nas superfícies Codex.
O bloco `forge:interaction` é independente do bloco de routing; preserva os
bytes do operador e recusa marcadores ambíguos. Fontes projetadas sobre si
mesmas continuam excluídas da escrita.

Para Codex, uma consulta local `codex features list` (timeout de 3 segundos,
sem shell ou rede) verifica suporte antes de adicionar a configuração
experimental `features.default_mode_request_user_input = true`, somente se
ausente. Valores explícitos, inclusive `false`, são preservados. Falha, timeout,
recurso não listado ou TOML ambíguo deixam essa configuração intacta, com motivo
nomeado no relatório da projeção. A barra de status mantém sua política aditiva
independente. No dry-run a consulta não roda: `questions-probe-dry-run` significa
capacidade ainda não determinada, e o possível acréscimo fica para o apply.

O recurso configurado não garante uma ferramenta permitida na sessão atual.
Decisões obrigatórias aguardam resposta explícita; perguntas assíncronas só
permitem continuar trabalho independente. Sem ferramenta permitida, o Forge
apresenta a pergunta separadamente em texto e aguarda. Modos headless mantêm
suas políticas explícitas de deferimento. Não há promessa de abas idênticas ao
Claude nem bloqueio do campo de digitação.

`install.sh` e `install.ps1` são wrappers finos para
`scripts/forge-installer.js`. A lógica de cópia, backup e migração é a mesma
nos três sistemas suportados (Windows nativo, macOS e Linux); nenhum shell é
invocado pelo core.

## Interface

```text
# macOS/Linux/Git Bash
bash ./install.sh --runtime claude|codex|both [--project-root DIR] [--update] [--dry-run]

# Windows PowerShell
.\install.ps1 -Runtime claude|codex|both [-ProjectRoot DIR] [-Update] [-DryRun]
```

`claude` é o default legado quando `--runtime`/`-Runtime` é omitido. Um valor
desconhecido falha antes de qualquer escrita. `--no-model-probe` permanece
aceito por compatibilidade e desabilita a sonda local de capability do CLI;
use-o somente quando o operador já confirmou que o runtime está instalado.
A instalação não faz chamadas de rede ou probes de login; `--with-app` é
reservado para o app opcional. `--with-vscode-panel`/`-WithVscodePanel` e
`--without-vscode-panel`/`-WithoutVscodePanel` controlam a adesão ao painel
VS Code opcional (ver "Painel VS Code (opcional)"); os dois juntos falham antes
de qualquer escrita.
`--project-root`/`-ProjectRoot` define explicitamente onde `CLAUDE.md` e
`AGENTS.md` serão projetados; sem ele, o diretório de trabalho atual é usado.

## Árvore e isolamento

O core é copiado uma única vez para `FORGE_HOME` (ou `~/.forge-agent`):
`scripts/`, `schemas/`, `shared/`, `bin/`, `forge-capabilities.json`, `forge-prefs.schema.json`,
`VERSION`, preferências JSONC e `manifest.json`. Os homes Claude/Codex são
projeções selecionadas e recebem somente seus agentes, comandos, skills e
templates dispatch. Em `both`, o core e as preferências continuam únicos.

`FORGE_HOME`, `HOME`/`USERPROFILE`, `--forge-home`, `--claude-home` e
`--codex-home` são resolvidos com `node:path`; caminhos com espaços, Unicode,
CRLF e separadores Windows não são concatenados em shell. Um runtime não
selecionado não é criado, lido nem escrito.

## Atualização e rollback

`--update`/`-Update` copia os arquivos gerenciados atuais para
`<FORGE_HOME>/backups/backup-4.11.0-<timestamp>` antes de substituir. As
preferências existentes, `.gsd`, hooks e arquivos não gerenciados ficam fora
do conjunto gerenciado. Uma preferência legada em
`<claude-home>/forge-agent-prefs.jsonc` é lida como migração não destrutiva
para Forge home; a origem nunca é removida. Projeções Claude legadas sem
marcador são preservadas e reportadas como conflitos; `--migrate-legacy`
habilita a substituição explícita desses arquivos canônicos.

`--dry-run`/`-DryRun` produz o mesmo plano de operações sem criar diretórios,
copiar arquivos, escrever manifestos ou modificar homes. O manifesto registra
quais arquivos pertencem ao core e a cada adapter para permitir auditoria e
rollback manual.

## Painel VS Code (opcional)

O painel somente leitura de `extensions/forge-vscode` é instalado e atualizado
pelo próprio instalador/forge-update, nunca sem adesão explícita:

```text
forge-update --apply --with-vscode-panel      # adere e instala
forge-update --apply                          # mantém o painel atualizado
forge-update --apply --without-vscode-panel   # desliga as atualizações do painel
```

- **Estado:** `<FORGE_HOME>/components.json`, `schema_version` 1, com
  `vscode_panel {opted_in, target, since_version, installed}`; `target` é sempre
  `vscode-stable-default-profile` e `installed` é `null` ou `{version,
  vsix_sha256}`. O arquivo não guarda caminho, usuário, host, horário nem dado
  pessoal; é gravado só em apply, por arquivo temporário e rename. Link, JSON
  inválido ou campo fora do contrato viram `state-invalid` sem tocar no painel;
  um flag explícito substitui esse estado.
- **Destino:** só o perfil padrão do VS Code estável do usuário atual, pela CLI
  `code` do PATH (no Windows, `bin\code.cmd` ao lado de `Code.exe`, executado por
  `cmd.exe /d /s /c` dentro de um Job próprio, com prova de AutoRun desabilitado
  apenas nessa chamada). Nenhuma chamada usa `--profile`,
  `--user-data-dir` ou `--extensions-dir`. Insiders, VSCodium, Cursor, Windsurf,
  Remote, WSL, snap e modo portátil dão diagnóstico explícito (`incompatible`).
- **Integridade:** o VSIX `forge-vscode-<VERSION>.vsix` é determinístico (zip
  stored com os seis arquivos do pacote) e é o mesmo componente `vscode-panel` do
  pacote da release. Antes de instalar, os bytes são relidos do diretório
  temporário e conferidos por sha256 e estrutura; depois de instalar,
  `code --list-extensions --show-versions` precisa listar
  `forge-agent.forge-vscode@<VERSION>`. Exit 0 sozinho não basta.
- **Dry-run:** `--dry-run` e o preview do forge-update relatam `planned` com
  versão e sha256 do VSIX gerado em memória, sem chamar a CLI e sem criar ou
  alterar `components.json`.
- **Backup:** no update, um `components.json` existente é copiado para o
  backup da execução antes de qualquer escrita. Se somente esse backup opcional
  falhar, o estado original fica intacto, o painel não executa nem altera sua
  adesão e retorna `state-invalid/backup-failed`; o núcleo continua. Falha no
  backup obrigatório do núcleo continua interrompendo a atualização.
- **Status:** `not-requested`, `opted-out`, `deferred` (instalação completa sem
  `--update`), `planned`, `installed`, `unchanged` e as falhas `cli-missing`,
  `incompatible`, `cli-failed`, `verify-failed`, `package-invalid`,
  `state-invalid` e `source-unsupported`. O JSON traz `components.core` e
  `components.vscode_panel` separados; só `installed` e `unchanged` têm
  `verified: true`.
- **Exit code:** o código do núcleo é preservado. Uma falha do painel nunca muda
  `ok` nem o exit code; aparece no JSON e no texto como
  `⚠ Painel VS Code NÃO verificado: <status> (<reason>) — núcleo aplicado`.
- **Saída:** `--without-vscode-panel` grava `opted_in: false` e não desinstala.
  A remoção é manual: `code --uninstall-extension forge-agent.forge-vscode`.
- **Primeira adesão a partir de um updater instalado anterior:** versões
  antigas recusam a opção nova. Rode primeiro `forge-update --apply` (instala o
  updater novo) e depois `forge-update --apply --with-vscode-panel`. Como
  alternativa, use `--source local --repo <clone novo>`. Um checkout remoto que
  não lista a opção, ou o bootstrap de compatibilidade, relata
  `source-unsupported`, nunca sucesso.
- **Modo local:** `--source local` instala o painel a partir do clone indicado,
  com as mesmas verificações.
- **Diagnóstico somente leitura:** `node scripts/forge-vscode-install.js --detect
  --json` relata layout, versão da CLI e versão instalada, sem instalar e sem
  caminhos.

## Diagnóstico e matriz offline

Instalações com `--runtime codex` ou `both` também configuram a barra de status
do Codex CLI com modelo, contexto, tokens, limites, projeto, sessão, permissões
e interface. Para
instalações existentes, execute `--update`/`-Update`. Preferências de barra já
definidas pelo operador são preservadas. Veja os detalhes e os casos de merge
manual em [Codex renderer](forge-codex-renderer.md#barra-de-status-do-terminal).

Uma instalação real valida fail-closed a capability obrigatória do host
selecionado antes da primeira escrita. O `--dry-run` não bloqueia por ausência
do CLI: apenas inclui o diagnóstico no plano, sem escrever nada. O diagnóstico
explícito também pode ser executado sem rede ou login:

```text
node scripts/forge-capabilities.js --detect --runtime claude --json
node scripts/forge-doctor.js --check capabilities --runtime codex --json
```

`--runtime claude`, `codex` e `both` são vetores independentes. A suíte
`forge-installer.test.js` usa homes temporários com sentinelas, fake CLIs Node,
CRLF/Unicode e uma fixture Claude 3.1.4; `forge-install-templates.test.js`
valida o inventário de dispatch e os wrappers Bash/PowerShell. Os testes
marcam explicitamente PowerShell ou Bash como skip somente quando o shell não
está disponível. Nenhum caso depende de WSL, GNU, conta paga ou rede.
