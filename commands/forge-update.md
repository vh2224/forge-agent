---
description: "Atualiza a instalação Forge preservando prefs e configurações do runtime selecionado."
allowed-tools: Read, Bash
---

# Forge Update

Este comando é um adaptador fino para o updater **instalado** em
`FORGE_HOME/scripts/forge-update.js`. Não execute `scripts/forge-update.js` do
diretório de trabalho: ele pode ser um clone local antigo ou até outro projeto.

Execute:

```bash
node -e "const p=require('path'),o=require('os'),h=process.env.FORGE_HOME||p.join(o.homedir(),'.forge-agent');process.exitCode=require(p.join(h,'scripts','forge-update.js')).run(process.argv.slice(1))" -- --apply --json
```

O launcher acima usa somente APIs do Node e funciona sem alteração em Windows,
macOS e Linux.

O runtime é obtido do manifest neutro em `FORGE_HOME/manifest.json`. Encaminhe `--runtime claude|codex|both` somente quando o operador o informou explicitamente (incluindo migração de Claude 3.1.4).

Por padrão, o updater consulta o servidor canônico via HTTPS, resolve a release
semver estável mais recente, fixa seu SHA, clona essa revisão em um diretório
temporário e executa o updater daquela revisão. O clone local e a proveniência
`source_repo` antiga são ignorados. Falha de rede ou de integridade é terminal:
nunca reinstale silenciosamente um clone local.

Antes de qualquer escrita, confirme no JSON:

- `backup_required: true`;
- `runtime` igual à instalação detectada;
- `installer_args` contendo esse mesmo runtime.

Nunca transforme uma instalação `codex` em `both`, crie o home Claude, leia o home não selecionado ou tente login/keychain. Preferências no Forge home, configurações do usuário e `.gsd` são preservadas; o instalador faz backup dos arquivos gerenciados antes da troca.

## Fonte e canais

O canal padrão é `stable`. Para testar a ponta ainda não lançada do servidor,
o operador pode pedir explicitamente:

```bash
node -e "const p=require('path'),o=require('os'),h=process.env.FORGE_HOME||p.join(o.homedir(),'.forge-agent');process.exitCode=require(p.join(h,'scripts','forge-update.js')).run(process.argv.slice(1))" -- --channel master --apply --json
```

`--remote` aceita somente URL HTTPS sem credenciais embutidas. O JSON deve
reportar `remote_source.remote`, `channel`, `ref`, `sha`, `declared_version` e
`version_matches_ref`. O checkout temporário é removido ao final e seu caminho
nunca é persistido no manifest instalado.

Releases publicadas antes de `--source local` não entendem o flag. O updater
sonda a release baixada com `--help` e, quando ela é antiga, executa o
`forge-installer.js` **daquela mesma release** sobre o próprio checkout. Nesse
caso o JSON traz `bootstrap.mode: "installer-compat"` com a saída íntegra do
instalador remoto — reporte-a ao operador, porque nesse caminho não existe plano
estruturado nem lista de `retirements`. Os bytes continuam vindo da revisão
fixada do servidor.

O modo local existe apenas para desenvolvimento e recuperação offline, sempre
explícito; nunca o escolha automaticamente:

```bash
node -e "const p=require('path'),o=require('os'),h=process.env.FORGE_HOME||p.join(o.homedir(),'.forge-agent');process.exitCode=require(p.join(h,'scripts','forge-update.js')).run(process.argv.slice(1))" -- --source local --repo <clone> --apply --json
```

## Painel VS Code opcional

Encaminhe `--with-vscode-panel` somente com adesão explícita do operador.
A adesão é persistida em `FORGE_HOME/components.json`; atualizações posteriores
atualizam o painel sem repetir o flag. Encaminhe `--without-vscode-panel` somente
quando o operador pedir para interromper esse gerenciamento; isso não desinstala
a extensão. Os dois flags juntos são inválidos. Preserve as preferências existentes.

O único destino suportado é o perfil padrão do VS Code estável do usuário atual.
Não acrescente `--profile`, diretórios alternativos, variantes, ambientes remotos
ou publicação no Marketplace. Falha em comprovar o destino impede apenas o painel.

Use o mesmo launcher instalado acima, acrescentando o flag autorizado aos argumentos
`--apply --json`. Para uma instalação antiga que ainda não aceita esses flags,
primeiro atualize o núcleo com o launcher sem flags do painel. Depois execute novamente
o launcher já atualizado com `--with-vscode-panel --apply --json`. Ambas as chamadas
usam a release remota fixada e os backups canônicos; não substitua pela fonte local.

Apresente separadamente o resultado do núcleo e o resultado `vscode_panel`.
Saída zero do núcleo não comprova instalação do painel. Confirme o status, a versão,
o hash do VSIX e a verificação da extensão registrada no perfil autorizado. Falhas
do painel preservam o núcleo e a adesão para recuperação; não declare sucesso parcial
como entrega completa. A repetição verifica versão e hash antes de dispensar reinstalação.

Para simular, substitua `--apply` por `--dry-run`, preservando os flags autorizados.
O dry-run não grava adesão nem chama a CLI do VS Code; destino, disponibilidade e
instalação efetiva continuam não comprovados.
