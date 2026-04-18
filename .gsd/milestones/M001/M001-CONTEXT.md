# M001: Forge v1.0 — Context
**Gathered:** 2026-04-15
**Clarity scores:** scope:90 acceptance:85 tech:85 dependencies:80 risk:75

## Objective

Tornar o forge-auto capaz de rodar milestones inteiros sem morrer silenciosamente apos compactacao de contexto. Tres pilares: (1) PostCompact recovery automatico, (2) lean orchestrator que nao acumula tokens, (3) /forge como entry point unificado que sobrevive a compactacao. Release como v1.0.0.

## Decisions

- PostCompact hook (nao PreCompact) escreve compact-signal.json quando auto-mode esta ativo; forge-auto detecta o sinal no inicio de cada iteracao, re-inicializa estado do disco, deleta o sinal e continua
- Lean orchestrator: workers recebem caminhos de arquivo (nao conteudo inlado) e leem seus proprios artefatos via Read tool em contexto isolado; TOP_MEMORIES e CS_LINT permanecem inlados por serem pequenos e pre-processados
- /forge e um thin REPL router com budget < 5K tokens (< 300 linhas), sobrevive a compactacao por caber no budget de re-attachment
- Migracao gradual: forge-auto, forge-task e forge-new-milestone movidos para skills/ com disable-model-invocation: true; commands/ vira shims de compatibilidade de uma linha
- Subagents nao podem spawnar subagents -- descartada alternativa de unit-orchestrators via Agent()
- dispatch table permanece em shared/forge-dispatch.md, compartilhado entre /forge-auto e /forge-next
- Paths passados a workers devem ser absolutos ou relativos ao WORKING_DIR; arquivos opcionais usam "Read if exists"
- Compact recovery no /forge loop: cada iteracao verifica compact-signal.json antes do AskUserQuestion

## Constraints

- Budget de 5K tokens para /forge.md (cabe no budget de compactacao do Claude Code)
- Subagents nao podem spawnar subagents (limitacao da tool Agent)
- Workers ja possuem acesso a tool Read -- premissa validada na pesquisa
- install.ps1 nao pode conter strings com \f literal (interpretado como form feed)
- Skills devem ter disable-model-invocation: true para evitar bug #26251

## Out of Scope

- Refatorar todos os 20+ comandos para skills (apenas forge-auto, forge-task, forge-new-milestone migrados em v1.0)
- Dispatch table em CLAUDE.md (permanece em forge-dispatch.md)
- Auto-compaction proativa (apenas recovery reativa via PostCompact hook)
- Mudanca de modelos por fase (mantém configuracao atual)
- Novo sistema de memória ou mudanca no quality gate de 3 perguntas

## Agent's Discretion

- Nenhuma area delegada -- todas as decisoes foram tomadas explicitamente no ROADMAP

## Open Questions

- Nenhuma -- ROADMAP resolve todas as questoes arquiteturais

## Deferred Ideas

- Migracao completa de todos os comandos para skills (apos v1.0, baseado em feedback)
- Auto-compaction proativa antes de atingir limite de contexto
