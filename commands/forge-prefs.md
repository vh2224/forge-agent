---
description: "Visualiza ou edita as preferências do agente GSD. Use: /forge-prefs | /forge-prefs models | /forge-prefs set research opus | /forge-prefs set execute claude-opus-4-6"
allowed-tools: Read, Write, Edit
---

## Input
$ARGUMENTS

---

## Mapa de aliases → model IDs

Quando o usuário usar um alias, converta para o model ID completo:

| Alias | Model ID completo |
|-------|------------------|
| `opus` | `claude-opus-4-6` |
| `sonnet` | `claude-sonnet-4-6` |
| `haiku` | `claude-haiku-4-5-20251001` |

O usuário pode passar tanto o alias quanto o model ID completo — ambos são aceitos.

---

## Operações

### Sem argumento ou "show"

Read `~/.claude/forge-agent-prefs.md`. Display:

```
GSD Agent — Configuração atual

MODELOS DISPONÍVEIS
  opus   → claude-opus-4-6           (análise profunda, planejamento)
  sonnet → claude-sonnet-4-6         (execução, tarefas padrão)
  haiku  → claude-haiku-4-5-20251001 (tarefas leves, memórias)

ROTEAMENTO POR FASE
  discuss    → forge-discusser   [claude-opus-4-6]
  research   → forge-researcher  [claude-opus-4-6]
  plan       → forge-planner     [claude-opus-4-6]
  execute    → forge-executor    [claude-sonnet-4-6]
  complete   → forge-completer   [claude-sonnet-4-6]
  memory     → gsd-memory      [claude-haiku-4-5-20251001]

SKIP RULES
  skip_discuss:  false
  skip_research: false

GIT
  merge_strategy: squash
  auto_push:      false
  main_branch:    master
```

(Read actual values from the prefs file — do not hardcode the above.)

---

### "models"

Display the full model list with descriptions:

```
MODELOS DISPONÍVEIS NO CLAUDE CODE

  opus    claude-opus-4-6
          Modelo mais capaz. Ideal para: discuss, research, plan.
          Use quando precisar de raciocínio profundo e decisões arquiteturais.

  sonnet  claude-sonnet-4-6
          Modelo balanceado (padrão para execução). Ideal para: execute, complete.
          Boa relação entre qualidade e custo.

  haiku   claude-haiku-4-5-20251001
          Modelo mais rápido e barato. Ideal para: memory extraction.
          Use para tarefas leves que não precisam de raciocínio pesado.

Para mudar o modelo de uma fase:
  /forge-prefs set <fase> <alias ou model ID>

Exemplos:
  /forge-prefs set execute opus
  /forge-prefs set execute claude-opus-4-6
  /forge-prefs set research haiku
  /forge-prefs set research claude-haiku-4-5-20251001
```

---

### "set \<phase\> \<model\>"

Exemplos válidos:
- `/forge-prefs set research haiku`
- `/forge-prefs set execute opus`
- `/forge-prefs set execute claude-opus-4-6`
- `/forge-prefs set plan claude-sonnet-4-6`

Fases válidas: `discuss`, `research`, `plan`, `execute`, `complete`, `memory`

Mapa fase → arquivo de agente:
- `discuss` → `~/.claude/agents/forge-discusser.md`
- `research` → `~/.claude/agents/forge-researcher.md`
- `plan` → `~/.claude/agents/forge-planner.md`
- `execute` → `~/.claude/agents/forge-executor.md`
- `complete` → `~/.claude/agents/forge-completer.md`
- `memory` → `~/.claude/agents/gsd-memory.md`

Steps:
1. Resolve o model ID completo (converta alias se necessário)
2. Atualize a coluna "Model ID" na tabela de Phase → Agent Routing no `~/.claude/forge-agent-prefs.md`
3. Atualize o campo `model:` no frontmatter do arquivo de agente correspondente
4. Confirme:

```
✓ Fase 'execute' atualizada

  Antes: claude-sonnet-4-6
  Agora: claude-opus-4-6

  Arquivo do agente atualizado: ~/.claude/agents/forge-executor.md
```

Se o modelo passado não for reconhecido (nem alias nem model ID válido):
```
Modelo desconhecido: '{input}'

Modelos disponíveis:
  opus    → claude-opus-4-6
  sonnet  → claude-sonnet-4-6
  haiku   → claude-haiku-4-5-20251001
```

---

### "skip-research \<true|false\>"

Toggle research phase skip. Update `skip_research` in `~/.claude/forge-agent-prefs.md`.
Confirm the new value.

---

### "skip-discuss \<true|false\>"

Toggle discuss phase skip. Update `skip_discuss`.
Confirm the new value.

---

### "git \<setting\> \<value\>"

Exemplos: `git auto_push true`, `git merge_strategy merge`, `git main_branch main`

Update the git setting in `~/.claude/forge-agent-prefs.md`. Confirm.

---

### "reset"

Restore all defaults:
- discuss/research/plan → `claude-opus-4-6`
- execute/complete → `claude-sonnet-4-6`
- memory → `claude-haiku-4-5-20251001`
- skip rules → all false
- git → squash, auto_push false, main_branch master

Update both `~/.claude/forge-agent-prefs.md` AND all agent frontmatter files.
Confirm with the restored routing table.

---

After any change, show the updated routing table.
