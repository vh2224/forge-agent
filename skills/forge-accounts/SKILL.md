---
name: forge-accounts
description: "Gerencia múltiplas contas Claude e troca entre elas (setup-token). Use ao esgotar a sessão de uma conta."
allowed-tools: Bash, AskUserQuestion, Read
---

# /forge-accounts — múltiplas contas Claude

Gerencia um registro de contas Claude (cada uma = um token longo do `claude setup-token`)
e ajuda a **trocar de conta** — principalmente quando a sessão de 5h ou o limite
semanal de uma conta esgota.

## Restrição que molda tudo (leia antes de prometer qualquer coisa)

Uma sessão do Claude Code **NÃO troca a própria conta no meio** (`/login` no meio
da sessão fica preso em 401). Trocar de conta = **relançar** o `claude` com outra
conta. O forge guarda o estado em disco, então o `/forge-auto` retoma de onde parou
ao relançar — mas é um restart de processo, não um hot-swap. Nunca diga ao usuário
que ele pode trocar sem relançar.

## Localizar o engine

```bash
FA="$HOME/.claude/scripts/forge-accounts.js"
if [ ! -f "$FA" ]; then
  REPO=$(grep 'repo_path:' ~/.claude/forge-agent-prefs.md 2>/dev/null | cut -d: -f2 | tr -d ' ')
  [ -n "$REPO" ] && FA="$REPO/scripts/forge-accounts.js"
fi
test -f "$FA" && echo "FA=$FA" || echo "ENGINE_MISSING"
```

Se `ENGINE_MISSING`: diga ao usuário para rodar `/forge-update` e pare.

## Dispatch por argumento

Parse `$ARGUMENTS`. Primeira palavra = subcomando (default `list` se vazio):

- `list` (ou vazio) → mostrar contas
- `add <nome>`      → registrar conta nova (fluxo guiado)
- `use <nome>`      → trocar para a conta (imprime comando de relançamento)
- `current`         → conta ativa (registro + sessão atual)
- `remove <nome>`   → remover conta + token

---

### `list` (default)

```bash
node "$FA" --list
```

Apresente em pt-BR, amigável. Para cada conta mostre: nome, nota, se é a **ativa no
registro**, se é a **conta desta sessão** (`this-session` = `FORGE_ACCOUNT` casou),
dias até o token expirar, e se está sem token (`NO-TOKEN` → precisa re-`add`).

Se não houver contas, explique como adicionar a primeira (veja `add`).

---

### `add <nome>`

Registrar exige um token do `claude setup-token`. **O token é segredo — não deve
entrar no chat.** Por isso o fluxo roda no terminal do próprio usuário (paste via
stdin), nunca via o `!` da sessão (que imprimiria o token aqui).

Valide o nome primeiro (`letras/dígitos/._-`, máx 32). Então apresente exatamente:

> Para registrar a conta **`<nome>`**, rode estes dois comandos **no seu terminal**
> (não aqui no chat — o token é sensível):
>
> ```bash
> claude setup-token        # 1) faz login dessa conta no browser e mostra o token (sk-ant-oat01-…)
> node ~/.claude/scripts/forge-accounts.js --add <nome>
>                           # 2) cole o token quando o cursor ficar esperando, Enter, depois Ctrl-D
> ```
>
> Quando terminar, me chame com `/forge-accounts list` que eu confirmo.

Não tente capturar o token você mesmo. Se o usuário **insistir** em colar o token no
chat, avise que ficará no histórico da conversa e, se ele confirmar, aí sim rode
`node "$FA" --add <nome> --token "<token>"`.

Dica útil para mencionar: a primeira conta adicionada vira a ativa por padrão.

---

### `use <nome>`

```bash
node "$FA" --use <nome>
```

Isso marca a conta como ativa e imprime o **comando de relançamento**. Apresente assim:

> Para usar a conta **`<nome>`**, **saia desta sessão** e rode no seu terminal:
>
> ```bash
> <comando impresso pelo engine>
> ```
>
> Se você estava no meio de um milestone, é só rodar `/forge-auto` depois — ele
> retoma do checkpoint automaticamente.

Se o engine errar (conta inexistente / sem token), repasse a mensagem e sugira `add`.

---

### `current`

```bash
node "$FA" --current
```

Mostre a conta ativa no registro e a conta desta sessão (`FORGE_ACCOUNT`, ou
"login padrão do Keychain" se vazio). Explique a diferença em uma linha se forem
diferentes.

---

### `remove <nome>`

Confirme com `AskUserQuestion` antes (remover apaga o token do Keychain). Se confirmado:

```bash
node "$FA" --remove <nome>
```

Avise que, para voltar a usar essa conta, será preciso `add` de novo (novo
`setup-token`).

---

## Notas

- Tokens ficam no **Keychain do macOS** (`forge-account-<nome>`) ou, em Linux/Windows,
  num arquivo `~/.claude/forge-accounts-tokens.json` com permissão `0600`. O registro
  não-secreto (`~/.claude/forge-accounts.json`) guarda só nomes/metadados.
- O token do `setup-token` vale ~1 ano; o `list` mostra os dias restantes.
- A statusline mostra a conta ativa (`👤 <nome>`) quando a sessão foi lançada com
  `FORGE_ACCOUNT=<nome>`, ao lado do uso de 5h/semana.
