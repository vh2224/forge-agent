# Operação do Forge Agent

Este runbook cobre instalação, upgrade e diagnóstico nos hosts Claude e Codex.
Execute os comandos a partir da raiz do repositório `forge-agent`, salvo quando
o texto disser para abrir o projeto de trabalho.

## Pré-requisitos

- Node.js 18 ou posterior.
- O CLI do host selecionado instalado para uso real: Claude Code para `claude`,
  Codex para `codex`, ambos para `both`.
- Autenticação pertence a cada CLI. O Forge não copia login, token, keychain ou
  configuração entre os hosts.

`FORGE_HOME` é a fonte neutra compartilhada (padrão: `~/.forge-agent`).
`~/.claude` e `~/.codex` são somente projeções seletivas. Uma operação
`--runtime codex` não deve criar nem ler o home Claude, e vice-versa.

## Instalação

### Windows — PowerShell

```powershell
# Planejar sem escrever nem sondar modelos
.\install.ps1 -Runtime claude -DryRun -NoModelProbe
.\install.ps1 -Runtime codex -DryRun -NoModelProbe
.\install.ps1 -Runtime both -DryRun -NoModelProbe

# Instalar uma das projeções (ou ambas explicitamente)
.\install.ps1 -Runtime claude
.\install.ps1 -Runtime codex
.\install.ps1 -Runtime both
```

Para um Forge home customizado:

```powershell
$env:FORGE_HOME = 'D:\Forge Home'
.\install.ps1 -Runtime codex -ProjectRoot 'D:\Meu Projeto'
```

Use PowerShell nativo; WSL, Git Bash e utilitários GNU não são necessários no
caminho Windows.

### macOS e Linux

```bash
# Planejar sem escrever nem sondar modelos
bash ./install.sh --runtime claude --dry-run --no-model-probe
bash ./install.sh --runtime codex --dry-run --no-model-probe
bash ./install.sh --runtime both --dry-run --no-model-probe

# Instalar uma das projeções (ou ambas explicitamente)
bash ./install.sh --runtime claude
bash ./install.sh --runtime codex
bash ./install.sh --runtime both
```

Com home e projeto customizados:

```bash
export FORGE_HOME='/opt/forge home'
bash ./install.sh --runtime codex --project-root '/work/meu projeto'
```

`both` significa “instalar as duas projeções a partir do mesmo core”. Não
significa executar a mesma unidade simultaneamente nos dois hosts.

## Upgrade seguro

Sempre faça o dry-run primeiro. O runtime explícito impede que uma instalação
Codex-only seja convertida para `both` ou crie um home Claude por acidente.
Sem `--source local`, o updater ignora qualquer clone existente, consulta a
release estável mais recente no servidor canônico via HTTPS, fixa o SHA remoto
e executa o updater daquela revisão em um checkout temporário.

```powershell
# Windows
node scripts/forge-update.js --runtime codex --dry-run --json
node scripts/forge-update.js --runtime codex --apply --json
# Equivalente pelo wrapper:
.\install.ps1 -Runtime codex -Update
```

```bash
# macOS/Linux
node scripts/forge-update.js --runtime codex --dry-run --json
node scripts/forge-update.js --runtime codex --apply --json
# Equivalente pelo wrapper:
bash ./install.sh --runtime codex --update
```

Antes de escrever, o updater exige backup dos arquivos gerenciados. Preferências
em `FORGE_HOME`, configuração do operador, `.gsd` do projeto e fontes legadas
Claude 3.1.4 permanecem byte-idênticas por padrão; a projeção legada sem
marcadores é reportada como conflito. Para migrá-la explicitamente, use
`--migrate-legacy`, que cria backup antes de substituir os arquivos canônicos.

Falha de rede, tag ausente, troca de SHA durante o clone ou manifesto remoto
incompatível abortam antes da instalação — não há fallback silencioso ao clone.
O canal `master` é opt-in (`--channel master`). Um clone local só pode ser usado
explicitamente com `--source local --repo <clone>`.

### Transição para o updater remoto

O checkout temporário é clonado com **histórico completo**, nunca `--depth 1`:
`forge-release-version.js` recusa um repositório raso por contrato
(`version-history-incomplete`), então um clone raso da release não consegue nem
declarar a própria versão. Custo medido: ~8 MB.

Nem toda tag publicada entende `--source local` — o flag é mais novo que elas.
O updater sonda a release baixada com `--help` e escolhe o caminho:

| Sonda `--help` | Bootstrap | Relatório |
|----------------|-----------|-----------|
| menciona `--source local` | `forge-update.js` da própria release, modo local | JSON estruturado |
| não menciona | `forge-installer.js` da própria release, sobre o próprio checkout | `bootstrap.mode: installer-compat`, com a saída íntegra do instalador remoto |

Nos dois caminhos os bytes instalados, o `VERSION` carimbado e o código que
renderiza vêm da revisão fixada do servidor — nunca de um clone local. No
caminho de compatibilidade o `--runtime` é resolvido do manifest instalado e
passado explicitamente: o instalador publicado tem `claude` como default, então
omiti-lo converteria uma instalação Codex-only em Claude.

Instalações antigas cujo `/forge-update` ainda executa `scripts/forge-update.js`
relativo ao diretório de trabalho precisam de **uma** atualização pelo caminho
antigo (ou de um `install.sh --update --source local --repo <clone>`) para
receber o comando projetado que resolve o updater em `FORGE_HOME`. Depois dessa
única vez, as atualizações seguintes não dependem de nenhum clone.

Enquanto o servidor não tiver uma tag contendo este updater, o canal `stable`
exercita o caminho `installer-compat` — verificado contra a `v4.21.0` publicada,
com clone, verificação de SHA, leitura de `VERSION` e limpeza do temporário. O
caminho de JSON estruturado só passa a ser exercido quando a primeira tag com
`--source local` existir.

Para conferir o pacote de release:

```powershell
node scripts/forge-package.js --output '.\forge-release' --json
node scripts/forge-package.js --verify '.\forge-release' --json
```

```bash
node scripts/forge-package.js --output './forge-release' --json
node scripts/forge-package.js --verify './forge-release' --json
```

O pacote contém `core`, `adapter-claude` e `adapter-codex`, com
`manifest.json` e `CHECKSUMS.sha256`.

Para validar opcionalmente os CLIs instalados no host real, sem invocar
modelos, acrescente a sonda de capability ao gate:

```text
node scripts/forge-release-gate.js --real-capability-smoke --json
```

Essa sonda usa apenas `--version` e `--help`; a matriz offline continua sendo
o gate obrigatório para ambientes sem os CLIs.

## Execução: Claude, Codex e handoff

- No Claude Code, abra o projeto e invoque `/forge` ou o skill `forge-auto`;
  para uma tarefa isolada, use `forge-task <descrição>`.
- No Codex, abra o mesmo projeto e peça explicitamente para usar `forge-auto`
  ou `forge-task`. O adapter fixa `host_runtime: codex` no snapshot.
- Use `forge-next` quando quiser exatamente uma unidade e uma pausa auditável.
  O comando não expõe `--dry-run`; para um ensaio sem risco, use um projeto
  temporário e remova-o ao final, ou execute o release gate offline.

O host permanece fixo durante uma unidade. Para trocar de host:

1. peça `forge-pause` e aguarde o boundary durável `needs_input`;
2. confirme que não há worker/lease ainda executando;
3. abra o mesmo workspace no host destino;
4. retome o workflow existente, fornecendo a resposta solicitada pelo boundary.

Nunca copie transcript, prompt ou credencial entre homes, nunca edite o snapshot
manualmente e nunca simule handoff iniciando uma segunda unidade. Repetir `next`
antes do handoff retorna a mesma decisão idempotente; retry não cria outra lease.

## Diagnóstico de capabilities

```powershell
node scripts/forge-doctor.js --check capabilities --runtime claude --json
node scripts/forge-doctor.js --check capabilities --runtime codex --json
```

```bash
node scripts/forge-doctor.js --check capabilities --runtime claude --json
node scripts/forge-doctor.js --check capabilities --runtime codex --json
```

Interprete `reason_code`:

| Reason | Ação |
|---|---|
| `core-incompatible` | Atualize Node/core antes de continuar. |
| `adapter-missing` | Reinstale explicitamente o runtime ausente. |
| `required-capability-missing` | Falha fatal; instale/corrija a capability. |
| `conditional-capability-unavailable` | Aviso; a operação principal pode continuar. |

Trust de hooks, login, credenciais, keychain e auth MCP são diagnósticos, não
reparos automáticos. `forge-doctor --fix` não deve habilitá-los.

## Headless e retries

O runner comum usa Claude stream JSON ou `codex exec --json`, sempre com
executável resolvido, argv array, `shell:false`, sandbox e approval explícitos.
JSONL é não confiável; malformed/truncado vira `output-invalid`, timeout vira
`claude-timeout`/`codex-timeout`, orphan vira `claude-orphan`/`codex-orphan` e
`needs_input` nunca é promovido a sucesso.

Retries respeitam o controller e o boundary persistido. Timeout/orphan são
terminais; não reinicie o mesmo processo por fora do Forge. Falha transitória
só repete até o cap configurado e depois avança a cadeia/fallback documentado.

Verificação offline direta:

```text
node scripts/forge-headless.test.js
node scripts/forge-dispatch-security.test.js
```

## MCP stdio e HTTP

Use `forge-mcps` no host para listar/adicionar/remover servidores. O contrato
canônico aceita:

- stdio: executável absoluto + argv, `shell:false`;
- HTTP: URL `http://` ou `https://` e headers não sensíveis;
- auth: somente referência para injeção em runtime, nunca token literal.

Auth obrigatória ausente retorna `auth-conditional-unavailable` e não gera uma
configuração de host presumidamente autenticada. Cada host mantém auth separada.

```text
node scripts/forge-mcp.test.js
```

## Gate obrigatório offline

O entrypoint determinístico roda parity, security, headless, MCP, install,
upgrade e verificação do pacote. Não usa rede, login ou CLIs pagos.

```powershell
node scripts/forge-offline-ci.js --host claude --platform win32
node scripts/forge-offline-ci.js --host codex --platform win32
```

```bash
# macOS
node scripts/forge-offline-ci.js --host claude --platform darwin
node scripts/forge-offline-ci.js --host codex --platform darwin

# Linux
node scripts/forge-offline-ci.js --host claude --platform linux
node scripts/forge-offline-ci.js --host codex --platform linux
```

A matriz semântica interna completa continua disponível em:

```text
node scripts/forge-operational-parity.test.js
```

## Smoke real — manual e separado

Smoke com providers reais é opt-in, tem custo/rede e **não pertence ao CI nem ao
gate offline**. Não existe comando automático de paid smoke para evitar consumo
acidental. Quando autorizado pelo operador:

1. confirme login separadamente em Claude e/ou Codex;
2. use um repositório descartável, sem segredos, com sandbox mínima;
3. rode uma task curta via `forge-next` em um host por vez;
4. valide estado/evento/resultado e, se necessário, faça um handoff durável;
5. teste MCP real somente com uma referência de credencial temporária;
6. registre custo, runtime/versão e apague o workspace descartável.

Falha de smoke real não deve ser “corrigida” desabilitando o gate offline. Guarde
stdout/stderr redigidos e rode primeiro os diagnósticos de capability acima.
