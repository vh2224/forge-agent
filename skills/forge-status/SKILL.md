---
name: forge-status
description: "Dashboard do projeto — milestone ativo, slices, proxima acao."
allowed-tools: Read, Glob, Bash
---

## Personal status (read-only)

Follow `shared/forge-personal-context.md` from the repository or FORGE_HOME.
No initialization writes, instruction sync, auto-memory creation, global STATE
fallback, run adoption or continue.md deletion are part of status.
Pergunta simples em linguagem natural fora deste comando (como “onde paramos?”) usa o resumo limitado de `forge-personal-context.js --summary` (ver `shared/forge-personal-context.md`); `/forge-status` explícito mantém a vista pessoal abaixo.

```bash
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-status.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
node "$FORGE_SCRIPTS_DIR/forge-status.js" $ARGUMENTS
node "$FORGE_SCRIPTS_DIR/forge-agent-view.js" --personal
```

Repasse a saída verbatim.
Não reescreva nem resuma a saída; ao comentar, siga `shared/forge-communication.md` (no repositório ou em `${FORGE_HOME:-~/.forge-agent}/shared`), sem despejo técnico.
A segunda linha mostra só os agentes do seu próprio trabalho, pelo seletor pessoal
canônico. Quando ela diz que não há agente no escopo, mostre o motivo em uma frase
lendo só `empty_reason` de `node "$FORGE_SCRIPTS_DIR/forge-agent-view.js" --personal --json`
(por exemplo `no-bindings`); nunca liste agentes de outro trabalho, do ledger da
equipe ou de `--scope workspace` no lugar da vista pessoal.
O bloco de tempo da milestone vem do `forge-status.js` (contrato em `shared/forge-milestone-time.md`, no repositório ou em `${FORGE_HOME:-~/.forge-agent}/shared`), é repassado verbatim e nenhuma decisão de extensão, redução ou continuação é inferida dele.
<!-- forge:linked-task:status:start -->
Task ligada (S03; `shared/forge-milestone-time.md § Task ligada e endpoint (S03)`): o bloco `linked` de cada task ligada (`lifecycle`, `task`, `milestone`, `chain`, `decision_pending` e `unknown`) e os horizontes `task` e `chain` do bloco de tempo da milestone ligada vêm do `forge-status.js` e são repassados verbatim.
O teto da task governa as operações da task, o da milestone governa as da milestone e o teto da cadeia é soma derivada que não governa nada (`governs: false`); previsão nunca vira teto. Valor sem fonte continua desconhecido, nunca zero.
Nenhuma decisão de início, de encerramento da cadeia ou de extensão do horizonte é inferida desse bloco, e task sem vínculo não ganha campo novo.
<!-- forge:linked-task:status:end -->
Default is personal; ID is explicit inspection without
binding; `--scope workspace` is an explicitly requested global diagnostic.
Do not append team ledger/activities to personal output or infer completion from
inactivity. Shared technical knowledge uses canonical memory/decision projections.
