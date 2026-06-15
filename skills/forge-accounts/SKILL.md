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

- `list` (ou vazio)       → mostrar contas
- `add <nome>`            → registrar conta nova (fluxo guiado)
- `use <nome>`            → trocar para a conta (imprime comando de relançamento)
- `rename <velho> <novo>` → renomear uma conta (mantém o token)
- `current`               → conta ativa (registro + sessão atual)
- `remove <nome>`         → remover conta + token

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

Registrar é **um comando só**: o engine roda o `claude setup-token`, captura o token
automaticamente da saída e salva no Keychain — sem copiar/colar. **Mas precisa rodar
no terminal do próprio usuário**, não aqui no chat: o login exige um TTY real, e isso
mantém o token fora do transcript. Nunca rode esse comando você mesmo (via `!` ou
Bash) — sem TTY ele falha/trava e rotearia o segredo pra conversa.

Valide o nome primeiro (`letras/dígitos/._-`, máx 32). Então apresente exatamente:

> Para registrar a conta **`<nome>`**, rode **no seu terminal** (não aqui no chat):
>
> ```bash
> forge-accounts add <nome>
> ```
>
> Ele abre o `claude setup-token` (login no browser), captura o token sozinho e salva.
> Quando terminar, me chame com `/forge-accounts list` que eu confirmo.

Notas para mencionar quando fizer sentido:
- A primeira conta adicionada vira a ativa por padrão.
- Para registrar uma **segunda** conta, deslogue/troque a conta no browser durante o
  `setup-token` — cada execução pega o token da conta logada naquele momento.
- Se o comando `forge-accounts` não for encontrado, o `~/.local/bin` não está no PATH:
  rode `export PATH="$HOME/.local/bin:$PATH"` (ou use a forma longa
  `node ~/.claude/scripts/forge-accounts.js --add <nome>`).
- Alternativas (raramente necessárias): `forge-accounts add <nome> --token <sk-ant-oat01-…>`
  para um token já gerado, ou paste via stdin.

---

### `use <nome>`

`use` resolve sozinho conforme o contexto (uma sessão rodando não troca a si mesma — então sempre é uma sessão NOVA):

- **Terminal de verdade (TTY):** `forge-accounts use <nome>` troca **abrindo o claude ali** na conta.
- **Chamado da skill / chat (sem TTY) no macOS:** abre uma **nova janela do Terminal** já na conta, e **num projeto forge retoma o `/forge-auto`** (via `osascript`). É o caso desta skill — então pode rodar direto:

```bash
node "$FA" --use <nome>   # macOS sem TTY → abre nova janela do Terminal na conta
```

Apresente ao usuário: uma nova janela do Terminal vai abrir na conta `<nome>` (retomando o milestone se for projeto forge). **Aviso uma vez só:** o macOS pode pedir permissão de Automação ("controlar Terminal") na primeira vez — é só permitir. Se ele preferir trocar na janela atual, deve sair desta sessão (`/exit`) e rodar `forge-accounts use <nome>` no terminal liberado.

Flags úteis: `--new-window` força a janela nova mesmo num TTY; `--print` só imprime o comando (sem abrir nada). Fora do macOS, sem TTY, cai pro `--print`.

Se o engine errar (conta inexistente / sem token), repasse a mensagem e sugira `add`.

---

### `rename <velho> <novo>`

```bash
node "$FA" --rename <velho> --to <novo>
```

Renomeia mantendo o token (não precisa refazer `setup-token`). Pode rodar in-session —
não envolve TTY nem imprime o token. Se a conta ativa era a renomeada, o registro
passa a apontar para o novo nome. Repasse erros do engine (conta inexistente, nome
novo já em uso) ao usuário. Lembre que, se houver uma sessão aberta com
`FORGE_ACCOUNT=<velho>`, ela continua válida (o token é o mesmo) — só o rótulo mudou.

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
