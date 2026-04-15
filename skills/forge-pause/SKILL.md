---
name: forge-pause
description: "Pausa ou retoma o forge-auto no proximo intervalo."
disable-model-invocation: true
allowed-tools: Bash, Read
---

## Verificar estado atual

```bash
ls .gsd/forge/pause 2>/dev/null && echo "paused" || echo "running"
cat .gsd/forge/auto-mode.json 2>/dev/null || echo "{}"
```

## Ação baseada no argumento

**Se `$ARGUMENTS` contém `status`:** apenas mostrar estado e parar.

```
Estado: {paused ou running}
Auto-mode: {active/inactive, elapsed se ativo}
```

**Se sem argumento (toggle):**

```bash
if [ -f ".gsd/forge/pause" ]; then
  rm .gsd/forge/pause
  echo "cancel"
else
  mkdir -p .gsd/forge && touch .gsd/forge/pause
  echo "set"
fi
```

- Se `cancel`: informar o usuário:
  > ▶ Pause cancelado. O forge-auto continuará normalmente após a unidade atual.

- Se `set`: informar o usuário:
  > ⏸ Pause solicitado. O forge-auto irá parar após completar a unidade atual.
  > Para cancelar: execute /forge-pause novamente.
  > Para retomar depois de pausado: execute /forge-auto.
