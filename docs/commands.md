# Comandos

## Inicialização

| Comando | O que faz |
|---------|-----------|
| `/forge-init` | Inicializa o projeto. Detecta `.gsd/` existente (gsd-pi) ou cria estrutura nova. Gera `CLAUDE.md`, `AUTO-MEMORY.md` e `claude-agent-prefs.md`. |
| `/forge-init <descrição>` | Mesmo que acima, passando a descrição do projeto direto para pular a pergunta inicial. |

## Execução

| Comando | O que faz |
|---------|-----------|
| `/forge-next` | **Step mode** — executa uma unidade (task, slice ou fase) e para. Ideal para revisar antes de continuar. |
| `/forge-auto` | **Auto mode** — executa o milestone inteiro de forma autônoma, sem parar entre unidades. Para em blocker ou milestone completo. |

## Planejamento

| Comando | Exemplo | O que faz |
|---------|---------|-----------|
| `/forge-new-milestone` | `/forge-new-milestone sistema de pagamentos com Stripe` | Cria milestone completo: discuss → plan → ROADMAP com slices e boundary map. |
| `/forge-discuss` | `/forge-discuss M002` ou `/forge-discuss S03` | Fase de discuss para milestone ou slice específico. Pergunta sobre gray areas e registra decisões. |
| `/forge-add-slice` | `/forge-add-slice M002 webhook de pagamentos` | Adiciona slice ao milestone com tasks planejadas e T##-PLAN.md. |
| `/forge-add-task` | `/forge-add-task S03 validar assinatura do webhook` | Planeja task específica com steps e must-haves. |

## Visibilidade

| Comando | Exemplo | O que faz |
|---------|---------|-----------|
| `/forge-status` | `/forge-status` | Dashboard: milestone ativo, progresso de slices/tasks, próxima ação. |
| `/forge-codebase` | `/forge-codebase` | Qualidade do codebase — estrutura, nomenclatura e responsabilidade. Use `--paths a,b` para escopo e `--fix` para correções seguras. |
| `/forge-explain` | `/forge-explain M002` · `/forge-explain S03` · `/forge-explain decisions` | Explica qualquer artefato sem modificar nada. Aceita: `M###`, `S##`, `T##`, `decisions`, `state`, `all`. |
| `/forge-memories` | `/forge-memories` · `/forge-memories stats` | Gerencia memórias auto-aprendidas. Sub-comandos: `show`, `stats`, `clean`, `export`, `inject`. |
| `/forge-help` | `/forge-help` | Ajuda completa com todos os comandos, agentes e arquivos. |

## Configuração

| Comando | Exemplo | O que faz |
|---------|---------|-----------|
| `/forge-config` | `/forge-config` | Mostra todas as opções de configuração do Forge e seu estado atual. |
| `/forge-config statusline on` | `/forge-config statusline on` | Ativa a status line do Forge no Claude Code (substitui a nativa). |
| `/forge-prefs` | `/forge-prefs` | Mostra configuração atual de modelos, skip rules e git. |
| `/forge-prefs set` | `/forge-prefs set research haiku` | Muda o modelo de uma fase. |
| `/forge-prefs reset` | `/forge-prefs reset` | Restaura todos os padrões. |
