---
name: forge-risk-radar
description: "Avaliacao de riscos por slice antes da execucao."
allowed-tools: Read, Write, Bash, Glob, Grep, Skill, WebSearch, WebFetch
---

<objective>
Analyze a slice plan and surface risks that would cause the executor to get stuck, produce wrong output, or need to replan mid-execution. Output a risk card that the executor reads before starting.
</objective>

<web_research>
Riscos externos (versão bugada de dependência, breaking change recente, CVE, limite de API) só são detectáveis pesquisando. Use `WebSearch` / `WebFetch` (ou MCPs `brave-search` / `context7` / `fetch`) livremente — zero-config via WebSearch nativo. Budget: até 3 buscas focadas nas dependências de alto impacto do slice. Registre achados como risco concreto com link na mitigação.
</web_research>

<probe_autonomy>
Para riscos onde WebSearch não dá evidência definitiva (comportamento específico sob carga, compatibilidade entre versões exatas usadas no projeto, performance real vs docs otimistas), invoque `Skill({ skill: "forge-probe", args: "<risco como Given/When/Then>" })` para validar/invalidar o risco com experimento.

Casos ideais:
- Risco `high` do tipo "API X pode não suportar Y no volume esperado" — probe mede e downgrade pra `medium` se validar, ou confirma mitigação obrigatória
- Risco de compatibilidade entre dois componentes internos — probe toca o ponto de contato

**Budget: máximo 1 probe por avaliação de slice.** Use apenas para riscos `high` cuja decisão de mitigação depende de evidência real. Riscos óbvios (documentados em AUTO-MEMORY, CVEs conhecidos) não precisam de probe — só documentação.

O probe pode transformar um risco `high` em `low` com mitigação inline, ou confirmar que precisa de estratégia de mitigação mais forte (ex: circuit breaker, cache, fallback).
</probe_autonomy>

<essential_principles>
- Focus on risks that affect THIS slice, not the whole project.
- A risk without a mitigation is noise. Always pair risk + response.
- Distinguish: known unknowns (we know we don't know) vs unknown unknowns (find them).
- The executor has a fixed context window. Any risk that requires reading >5 large files is a planning risk.
</essential_principles>

<process>

## Input
Read the slice's `S##-PLAN.md`, `S##-CONTEXT.md` (if exists), and the parent `M###-ROADMAP.md` boundary map section for this slice.

## Risk categories to check

### Technical risks
- Are there libraries/APIs used that have known breaking changes or poor docs?
- Does any task assume a pattern that contradicts `.gsd/AUTO-MEMORY.md` gotchas?
- Is the verification strategy clear? (If must-haves say "tests pass" but no test file exists, that's a risk)

### Context window risks
- Do any tasks require reading >3 large files simultaneously?
- Is the task decomposition fine enough? (a task titled "implement entire auth system" is a red flag)
- Are there tasks with vague steps like "implement as needed"?

### Dependency risks
- Does this slice consume outputs from prior slices? Are those outputs actually there?
- Check the boundary map: does the "consumes from" match what was actually built?

### Scope creep signals
- Are there tasks that say "also fix X" or "while we're at it"?
- Are there must-haves that belong to a different slice?

## Output — Risk card

```markdown
# Risk Radar: S## — [Slice Title]

**Assessed:** YYYY-MM-DD
**Overall risk:** HIGH / MEDIUM / LOW

## Blockers (fix before executing)
- [Risk] → [Required action]

## Warnings (monitor during execution)
- [Risk] → [Mitigation]

## Executor notes
- [Specific guidance for the executor agent]
```

Save as `.gsd/milestones/M###/slices/S##/S##-RISK.md`.

</process>

<success_criteria>
- Every identified risk has a concrete response
- Blockers require the planner to revise before execution starts
- Warnings are actionable by the executor without replanning
</success_criteria>
