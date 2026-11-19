# Histórico preservado — parte 2

Evidência da entrada anterior, não é política vigente nem fila atual. Consulte ../project-policy.md e contratos atuais antes de agir. Leia somente quando necessário.

---

`````text
**Regra:** Skills são auto-suficientes (lêem seus próprios arquivos de disco). Não injetar contexto via args — passar apenas IDs (`M-<ts>-<slug>` para milestones, `S##` para slices).

## Estrutura de arquivos do projeto

```
forge-agent/
├── agents/                      # Definições de agentes (.md com frontmatter YAML)
│   ├── forge-discusser.md       # Opus — decisões de arquitetura
│   ├── forge-researcher.md      # Opus — exploração de codebase
│   ├── forge-planner.md         # Opus — decomposição em tasks
│   ├── forge-executor.md        # Sonnet — implementação de código
│   ├── forge-completer.md       # Sonnet — fechamento e merge
│   ├── forge-memory.md          # Haiku — extração de memórias
│   ├── forge-reviewer.md        # Sonnet — challenger do review dialético (+ rebuttal mode)
│   ├── forge-advocate.md        # Sonnet — defender (autor) do review dialético
│   ├── forge-plan-checker.md    # Sonnet — plan-checker advisory (10 dimensões)
│   └── forge-worker.md          # Template genérico (legado)
├── commands/                    # Slash commands para CLI (/forge-*)
│   ├── forge-auto.md            # Modo autônomo — milestone inteiro
│   ├── forge-next.md            # Step mode — uma unidade
│   ├── forge-init.md            # Bootstrap do projeto
│   ├── forge-new-milestone.md   # Criação de milestone (brainstorm → discuss → plan)
│   ├── forge-discuss.md         # Fase de discussão com ambiguity scoring
│   ├── forge-add-slice.md       # Adicionar slice a milestone
│   ├── forge-add-task.md        # Adicionar task a slice
│   ├── forge-task.md            # Task autônoma sem milestone/slice
│   ├── forge-status.md          # Dashboard do projeto
│   ├── forge-explain.md         # Explicar qualquer artefato
│   ├── forge-doctor.md          # Diagnóstico + correção (--fix)
│   ├── forge-codebase.md        # Qualidade do codebase (lint, review, fix)
│   ├── forge-memories.md        # Gestão de memórias
│   ├── forge-ask.md             # Modo conversa com sessões
│   ├── forge-skills.md          # Listar skills
│   ├── forge-prefs.md           # Ver/editar preferências
│   ├── forge-config.md          # Status line, hooks e MCPs
│   ├── forge-mcps.md            # Gerenciar MCPs (catálogo, add, remove)
│   ├── forge-pause.md           # Pausar/retomar forge-auto
│   ├── forge-update.md          # Atualização do forge-agent
│   └── forge-help.md            # Ajuda completa
├── skills/                      # Skills reutilizáveis
│   ├── forge-brainstorm/        # Brainstorm estruturado antes de planejar
│   ├── forge-scope-clarity/     # Contrato de escopo com critérios observáveis
│   ├── forge-risk-radar/        # Avaliação de riscos antes de executar
│   ├── forge-security/          # Análise de segurança por task/slice
│   ├── forge-ui-review/         # Review de qualidade frontend (WCAG, CWV, WAI-ARIA)
│   └── forge-responsive/        # Audit e implementação de design responsivo
├── scripts/                     # Utilitários JS
│   ├── forge-statusline.js      # Status line customizada para Claude Code
│   ├── forge-hook.js            # Hooks: PreToolUse/PostToolUse/SubagentStart/SubagentStop/PreCompact
│   └── merge-settings.js        # Merge idempotente de settings.json (registra 5 hook events)
├── forge-agent-prefs.md         # Template de preferências globais
├── install.sh                   # Instalador Bash (macOS/Linux/Git Bash)
├── install.ps1                  # Instalador PowerShell (Windows)
├── CHANGELOG.md                 # Release notes (auto-gerado)
├── README.md                    # Documentação completa
└── LICENSE                      # MIT
```

## Artefatos GSD gerados nos projetos do usuário

```
.gsd/
├── STATE.md                     # Estado atual (milestone, slice, task, phase, next_action)
├── PROJECT.md                   # Descrição do projeto e stack
├── REQUIREMENTS.md              # Requisitos de capacidade
├── DECISIONS.md                 # Registro append-only de decisões
├── KNOWLEDGE.md                 # Conhecimento manual
├── AUTO-MEMORY.md               # Memórias emergentes (max 50, ranked)
├── CODING-STANDARDS.md          # Padrões detectados + Asset Map + Pattern Catalog
├── LEDGER.md                    # Resumo compacto de milestones concluídos (append-only, sobrevive cleanup)
├── claude-agent-prefs.md        # Prefs repo-level (commitável)
├── prefs.local.md               # Prefs locais (gitignored)
├── forge/
│   ├── events.jsonl             # Event log do orquestrador
│   ├── auto-mode.json           # Estado do auto-mode (active, started_at, worker)
│   ├── auto-mode-started.txt    # Timestamp de início persistido (sobrevive entre tool calls)
│   └── pause                    # Arquivo-sinal: se existe, forge-auto pausa no próximo intervalo
├── archive/                     # Milestones arquivados (milestone_cleanup: archive)
│   └── M-<ts>-<slug>/           # Cópia movida do diretório de milestone completo
└── milestones/
    └── M-<ts>-<slug>/           # M-<ts>-<slug> = ID timestamp (M### legado lido normalmente)
        ├── M-<ts>-<slug>-ROADMAP.md      # Slices, dependências, boundary map
        ├── M-<ts>-<slug>-CONTEXT.md      # Decisões de arquitetura (discuss)
        ├── M-<ts>-<slug>-RESEARCH.md     # Pesquisa de codebase
        ├── M-<ts>-<slug>-BRAINSTORM.md   # Brainstorm estruturado
        ├── M-<ts>-<slug>-SCOPE.md        # Contrato de escopo
        ├── M-<ts>-<slug>-SUMMARY.md      # Summary acumulativo
        └── slices/
            └── S##/
                ├── S##-PLAN.md      # Tasks, dependências, acceptance criteria
                ├── S##-CONTEXT.md   # Decisões do slice
                ├── S##-RESEARCH.md  # Pesquisa do slice
                ├── S##-RISK.md      # Avaliação de riscos
                ├── S##-REVIEW.md    # Diálogo do review dialético (challenger × advocate)
                ├── S##-SUMMARY.md   # Summary do slice
                ├── S##-UAT.md       # Script de teste manual
                ├── continue.md      # Checkpoint para retomada
                └── tasks/
                    └── T##/
                        ├── T##-PLAN.md    # Steps, must-haves, standards
                        └── T##-SUMMARY.md # Resultado da execução
```

## Agentes — campos de frontmatter suportados

```yaml
name: forge-planner
description: ...
model: "claude-opus-5"    # modelo base (fallback: claude-opus-4-8[1m] via install-time probe)

`````
