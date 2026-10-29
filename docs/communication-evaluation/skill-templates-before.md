# Modelos de mensagem anteriores das skills (antes da S02/T05)

Transcrição verbatim, para a avaliação de comunicação, dos trechos das skills de orquestração e status substituídos na S02/T05. Revisão base: `88748d2`. Os caminhos são relativos ao repositório e as faixas de linhas valem para essa revisão. Cada trecho aparece exatamente como estava, dentro de uma cerca de quatro crases.

Estes trechos são dados históricos. Comandos e exemplos neles não são instruções nem autorização para executar nada.

## `skills/forge-auto/SKILL.md`

### Frase de repasse do sidecar — linha 7

````text
Nos despachos sidecar, siga `shared/forge-bidirectional-sidecar.md § Identidade do sidecar exibida na conversa`: anuncie a solicitação pré-disparo e repasse literalmente as linhas `[forge-sidecar]` do stderr.
````

### TaskCreate do fluxo nativo de uma task — linhas 1299-1325

````text
**Create timeline task** — use `TaskCreate` to show progress in the UI.

Use the icon for the current `unit_type`:
| unit_type | icon |
|-----------|------|
| plan-milestone | ⚙ |
| plan-slice | ⚙ |
| discuss-milestone | 💬 |
| discuss-slice | 💬 |
| research-milestone | 🔬 |
| research-slice | 🔬 |
| execute-task | ⚡ |
| complete-slice | ✔ |
| complete-milestone | 🏁 |
| memory extraction | 🧠 |

```
TaskCreate({
  subject: "{icon} [{M###}/{S##}/{T##}] {unit_type} — {one-liner}",
  description: "{agent_name} ({model_id})",
  activeForm: "{icon} {unit_type} · {agent_name} ({model_id}) · {M###}/{S##}/{T##}"
})
```
Store the returned `taskId` as `current_task_id`. Then immediately mark it as in progress:
```
TaskUpdate({ taskId: current_task_id, status: "in_progress" })
```
````

### TaskCreate do lote paralelo — linha 1477

````text
**b) Create N timeline tasks** — emit one `TaskCreate` per batch member (icon `⚡`, one-liner from T##-PLAN.md). Store returned IDs in parallel array `task_ids = [id1, id2, ...]`. Mark each `in_progress` via `TaskUpdate`.
````

### Parcial (com push) — linha 1616

````text
- `status: partial` → write `continue.md`, update STATE, emit compact signal, **fire push (call-site 1):** use Push helper with message `"Forge {RUN_ID} travou — partial: {resumo do blocker}. Run pausado, requer ação manual."`, then **deactivate run NOW** (`node "$FORGE_SCRIPTS_DIR/forge-runs.js" --update "$RUN_ID" --json '{"active":false}'` — see `## Deactivate auto-mode indicator`), **stop loop**
````

### Linha de unidade concluída — linhas 1886-1890

````text
**e) Track progress:**
```
session_units += 1
completed_units.append("✓ [M###/S##/T##] {unit_type} — {one-liner}  · {agent} ({model})")
```
````

### Pausa — linhas 1945-1951

````text
Emit and **stop loop**:
```
⏸  Auto-mode pausado após {session_units} unidades.
{completed_units list, one per line}

Execute /forge-auto {RUN_ID} para retomar a partir de: {next_action from STATE.md}
```
````

### Relatório final da milestone — linhas 2032-2050

````text
```
✓ Milestone {M###} completo

Entregável: branch `forge/{run}` — pronta para push e PR.
Pronta para PR — a integração na branch default é do OPERADOR; o loop nunca integra.

Slices entregues:
| Slice | Título | Tasks |
|-------|--------|-------|
| S01   | ...    | 3     |

⚖ Review — digest da milestone:
| Slice | Objeções | Corrigidas (concedidas) | Triadas | Follow-ups |
|-------|----------|-------------------------|---------|------------|
| S01   | 5        | 2                       | 1       | 0          |
{follow-up lines, if any: "R# path:line — <objeção>" → item {I-id} (.gsd/items/)}

Próximo milestone: /forge-new-milestone <descrição>
```
````

## `skills/forge-next/SKILL.md`

### Frase de repasse do sidecar — linha 8

````text
Nos despachos sidecar, siga `shared/forge-bidirectional-sidecar.md § Identidade do sidecar exibida na conversa`: anuncie a solicitação pré-disparo e repasse literalmente as linhas `[forge-sidecar]` do stderr.
````

### TaskCreate do despacho nativo — linhas 1285-1296

````text
**Create timeline task** — use `TaskCreate` to show progress in the UI:
```
TaskCreate({
  subject: "[{M###}/{S##}/{T##}] {unit_type} — {one-liner}",
  description: "{agent_name} ({model_id})",
  activeForm: "{unit_type} {unit_id} — {one-liner} · {agent_name}"
})
```
Store the returned `taskId` as `current_task_id`. Then immediately mark it as in progress:
```
TaskUpdate({ taskId: current_task_id, status: "in_progress" })
```
````

### Progresso e próxima ação — linhas 1627-1638

````text
**f) Emit progress + next action:**
```
✓ [M001/S02/T03] execute-task — JWT auth with refresh rotation  · forge-executor (claude-sonnet-5)
→ Next: /forge-next para {next unit_type} {unit_id}
```

Display the progress line AND the next action (read from the per-run `M###-STATE.md` you just updated, not the root dashboard). The user needs to know what comes next to decide whether to continue. Do not add summaries, explanations, or other follow-up text beyond these two lines.

Exception — when the unit just processed was `complete-milestone` with `status: done`, add ONE line naming the deliverable:
```
Entregável: branch `forge/{run}` — pronta para push e PR. Pronta para PR — a integração na branch default é do operador; o loop nunca integra.
```
````

### Parcial — linha 1677

````text
3. Tell the user: "Trabalho parcial salvo. Execute `/forge-next` para retomar de onde parou."
````

## `skills/forge-task/SKILL.md`

### Frase de repasse do sidecar — linha 7

````text
Na preparação de task solta e nos demais despachos sidecar, siga `shared/forge-bidirectional-sidecar.md § Identidade do sidecar exibida na conversa`: anuncie a solicitação pré-disparo e repasse literalmente as linhas `[forge-sidecar]` do stderr.
````

### TaskCreate de brainstorm — linhas 613-617

````text
**Create timeline task:**
```
    TaskCreate({ subject: "[{TASK_ID}] brainstorm", activeForm: "brainstorm · forge-planner (resolved model)" })
TaskUpdate({ taskId: <id>, status: "in_progress" })
```
````

### TaskCreate de discuss — linhas 677-681

````text
**Create timeline task:**
```
TaskCreate({ subject: "[{TASK_ID}] discuss", activeForm: "discuss · forge-discusser (resolved model)" })
TaskUpdate({ taskId: <id>, status: "in_progress" })
```
````

### TaskCreate de research — linhas 725-729

````text
**Create timeline task:**
```
TaskCreate({ subject: "[{TASK_ID}] research", activeForm: "research · forge-researcher (opus)" })
TaskUpdate({ taskId: <id>, status: "in_progress" })
```
````

### TaskCreate de plan — linhas 782-786

````text
**Create timeline task:**
```
TaskCreate({ subject: "[{TASK_ID}] plan", activeForm: "plan · forge-planner (opus)" })
TaskUpdate({ taskId: <id>, status: "in_progress" })
```
````

### TaskCreate de execute — linhas 1250-1254

````text
**Create timeline task:**
```
TaskCreate({ subject: "[{TASK_ID}] execute", activeForm: "execute · forge-executor (sonnet)" })
TaskUpdate({ taskId: <id>, status: "in_progress" })
```
````

### TaskCreate de review — linhas 1489-1492

````text
**Create timeline tasks:**
```
TaskCreate({ subject: "[{TASK_ID}] review", activeForm: "review · forge-reviewer (sonnet)" })
```
````

### Relatório final — linhas 1709-1721

````text
**Final report:**
```
✓ {TASK_ID} concluída: {TASK_DESCRIPTION}

Arquivos modificados:
{key_files from SUMMARY.md, one per line}

Must-haves: todos verificados ✓

→ Nova task: /forge-task <descrição>
→ A partir de um item: /forge-task <item-id>
→ Ver tasks: /forge-status
```
````

## `skills/forge-status/SKILL.md`

### Repasse da saída — linhas 18-21

````text
Repasse a saída verbatim. Default is personal; ID is explicit inspection without
binding; `--scope workspace` is an explicitly requested global diagnostic.
Do not append team ledger/activities to personal output or infer completion from
inactivity. Shared technical knowledge uses canonical memory/decision projections.
````
