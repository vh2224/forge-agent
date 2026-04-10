# Configuração

## Global — `~/.claude/forge-agent-prefs.md`

Padrões aplicados a todos os projetos. Criado pelo instalador.

```yaml
# Modelos por fase
research:   opus    → forge-researcher
planning:   opus    → forge-planner
execution:  sonnet  → forge-executor
completion: sonnet  → forge-completer
memory:     haiku   → forge-memory

# Skip rules
skip_discuss:        false
skip_research:       false
skip_slice_research: false

# Git
merge_strategy: squash
auto_push:      false
main_branch:    master
```

## Por projeto — `.gsd/claude-agent-prefs.md`

Overrides específicos do projeto. Criado pelo `/forge-init`.

```yaml
# Overrides só para este projeto
# skip_research: true        ← codebase já bem conhecido
# execute: opus              ← tasks arquiteturalmente complexas
merge_strategy: squash
main_branch: main
```

## Status Line

O Forge instala uma status line customizada para o Claude Code que substitui a nativa. Ela não é ativada automaticamente — você escolhe quando habilitar.

```
Forge │ Claude Sonnet 4.6 │ meu-projeto │ M001/S02 │ █████░░░░░ 47% │ $0.0042 │ ↑12k ↓3k 💾8k
✓ forge-executor: implement auth middleware  2m ago (3 units)
```

| Campo | O que mostra |
|-------|-------------|
| `Claude Sonnet 4.6` | Modelo ativo na sessão |
| `meu-projeto` | Pasta atual |
| `M001/S02` | Milestone e slice ativos (lido de `.gsd/STATE.md`) |
| `█████░░░░░ 47%` | Uso da context window |
| `$0.0042` | Custo acumulado da sessão |
| `↑12k ↓3k 💾8k` | Tokens enviados / recebidos / cache |

### Ativar / Desativar

```
/forge-config statusline on     ← ativa (reinicie o Claude Code)
/forge-config statusline off    ← desativa e restaura a nativa
```

## Arquivos criados no projeto

```
CLAUDE.md                       ← carregado automaticamente pelo Claude Code em toda sessão
.gsd/
  STATE.md                      ← posição atual (milestone/slice/task ativos, próxima ação)
  DECISIONS.md                  ← registro append-only de decisões arquiteturais
  PROJECT.md                    ← descrição do projeto e stack
  REQUIREMENTS.md               ← contrato de capacidades
  KNOWLEDGE.md                  ← conhecimento manual do projeto
  AUTO-MEMORY.md                ← memórias auto-aprendidas (cresce com o uso)
  claude-agent-prefs.md         ← overrides de modelo e git para este projeto
  milestones/
    M001/
      M001-ROADMAP.md           ← slices com checkboxes + boundary map
      M001-CONTEXT.md           ← decisões capturadas no discuss
      M001-RESEARCH.md          ← pesquisa de codebase
      M001-SUMMARY.md           ← resumo acumulado do milestone
      slices/
        S01/
          S01-PLAN.md           ← tasks com checkboxes
          S01-CONTEXT.md        ← decisões do slice
          S01-SUMMARY.md        ← resumo ao completar
          S01-UAT.md            ← script de teste manual (não-bloqueante)
          tasks/
            T01-PLAN.md         ← steps + must-haves
            T01-SUMMARY.md      ← o que foi feito + evidência de verificação
```
