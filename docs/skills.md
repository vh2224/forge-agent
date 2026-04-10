# Skills

Skills são módulos de conhecimento especializado que o agente carrega sob demanda. São arquivos `SKILL.md` instalados em `~/.agents/skills/` (ecossistema [skills.sh](https://skills.sh), compatível com gsd-pi) e `~/.claude/skills/`.

## Skills incluídas

| Skill | O que faz | Quando é usada |
|-------|-----------|----------------|
| `forge-brainstorm` | Explora alternativas, riscos e limites de escopo antes de planejar | `/forge-new-milestone` (automático) |
| `forge-scope-clarity` | Gera contrato de escopo com critérios observáveis e testáveis | `/forge-new-milestone` (automático) |
| `forge-risk-radar` | Analisa riscos por slice antes da execução, para slices `risk:high` | `/forge-new-milestone`, `/forge-auto` |
| `forge-responsive` | Audit de design responsivo — Core Web Vitals, fluid layout, WCAG 2.2 | Manual ou via `/forge-codebase` |
| `forge-ui-review` | Review de componentes UI — WCAG 2.2 AA, performance, WAI-ARIA, React 19 | Manual ou via `/forge-codebase` |

## Descobrir skills disponíveis

```
/forge-skills              ← lista todas as skills instaladas + integrações GSD
/forge-skills brainstorm   ← detalhes e exemplos de uma skill específica
/forge-skills --all        ← mapa completo: skill × fase × comando × flag
/forge-skills install      ← como instalar novas skills
```

## Flag `-fast` — pular skills

```bash
/forge-new-milestone autenticação OAuth         # brainstorm + scope + discuss + plan
/forge-new-milestone -fast autenticação OAuth   # só discuss + plan
/forge-discuss M003                              # com brainstorm (se disponível)
/forge-discuss -fast M003                        # discuss direto
```

## Instalar skills de outros repositórios

```bash
npx skills add odra/superpowers --skill brainstorm -y
npx skills add <repositório> --skill <nome> -y
# Detectado automaticamente pelo /forge-skills
```

## Contribuir uma skill

Coloque em `skills/<nome>/SKILL.md` seguindo o formato das skills existentes e abra um PR.
