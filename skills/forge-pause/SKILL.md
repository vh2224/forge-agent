---
name: forge-pause
description: "Pausa ou retoma forge-auto no proximo intervalo. Multi-run: aceita ID."
disable-model-invocation: true
allowed-tools: Bash, Read
---

## Resolve scripts dir

```bash
if [ -f "scripts/forge-runs.js" ]; then
  FORGE_SCRIPTS_DIR="scripts"
else
  FORGE_SCRIPTS_DIR="$HOME/.claude/scripts"
fi
```

## Listar runs ativas

```bash
ACTIVE_RUNS=$(node "$FORGE_SCRIPTS_DIR/forge-runs.js" --list-active 2>/dev/null)
ACTIVE_COUNT=$(node -e "process.stdout.write(String(JSON.parse(process.argv[1] || '[]').length))" "$ACTIVE_RUNS")
```

## Branch por argumento + count

### Sem argumento + 0 ativas

Informar o usuário:
> Sem runs ativas. Nada a pausar.
> Use `/forge-auto <M###>` ou `/forge-task <descrição>` pra iniciar.

### Sem argumento + 1 ativa → toggle daquela única

```bash
TARGET_ID=$(node -e "process.stdout.write(JSON.parse(process.argv[1])[0].id)" "$ACTIVE_RUNS")
```

Prosseguir pro bloco de toggle abaixo com `TARGET_ID`.

### Sem argumento + 2+ ativas → refuse + listar

Informar o usuário:
> Múltiplas runs ativas neste workspace:
> - M065 — milestone (forge-executor T03)
> - M066 — milestone (forge-planner S04)
>
> Especifique: `/forge-pause M065`

(Listar IDs reais do `$ACTIVE_RUNS` — id + kind + worker se houver.)

Parar aqui.

### Com argumento `$ARGUMENTS` = `status`

Mostrar estado completo de TODAS as runs ativas + arquivos pause existentes:

```bash
node "$FORGE_SCRIPTS_DIR/forge-runs.js" --list-active
ls .gsd/forge/pause-* 2>/dev/null || echo "(nenhum pause solicitado)"
```

### Com argumento `$ARGUMENTS` = um ID (ex.: `M065`, `task-fix-typo-a3f2`)

```bash
TARGET_ID="$ARGUMENTS"
```

Validar que essa run existe e está ativa:

```bash
RUN_INFO=$(node "$FORGE_SCRIPTS_DIR/forge-runs.js" --get "$TARGET_ID" 2>/dev/null)
if [ "$RUN_INFO" = "null" ] || [ -z "$RUN_INFO" ]; then
  echo "Run $TARGET_ID não existe no registry."
  exit 1
fi
IS_ACTIVE=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).active ? '1' : '0')" "$RUN_INFO")
if [ "$IS_ACTIVE" != "1" ]; then
  echo "Run $TARGET_ID existe mas não está ativa. Nada a pausar."
  exit 0
fi
```

Prosseguir pro bloco de toggle abaixo.

## Bloco de toggle (usado pelos branches acima com `TARGET_ID` setado)

```bash
PAUSE_FILE=".gsd/forge/pause-$TARGET_ID"
if [ -f "$PAUSE_FILE" ]; then
  rm "$PAUSE_FILE"
  OUTCOME="cancel"
else
  mkdir -p .gsd/forge && touch "$PAUSE_FILE"
  OUTCOME="set"
fi
echo "outcome=$OUTCOME target=$TARGET_ID"
```

Reportar conforme outcome:

- Se `set`:
  > ⏸ Pause solicitado para `$TARGET_ID`. O forge-auto irá parar essa run após completar a unidade atual.
  > Para cancelar: `/forge-pause $TARGET_ID`
  > Para retomar depois: `/forge-auto $TARGET_ID`

- Se `cancel`:
  > ▶ Pause de `$TARGET_ID` cancelado. A run continuará normalmente após a unidade atual.

## Notas

- O pause é **scoped por run** desde M004. Pausar uma run não afeta outras concorrentes.
- Arquivo legado `.gsd/forge/pause` (sem suffix) ainda é respeitado por orquestradores pré-M004 — não criamos mais nem checamos neste skill.
- O arquivo de pause é um sentinela vazio; conteúdo é ignorado.
