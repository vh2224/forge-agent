# Instalação multi-runtime

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
reservado para o app opcional.
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
