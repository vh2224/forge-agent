# Arquitetura

## Como funciona

```
você digita /forge-auto
        │
        ▼
forge (orquestrador)
  1. lê ~/.claude/forge-agent-prefs.md  ← modelo por fase
  2. lê .gsd/claude-agent-prefs.md    ← overrides do projeto
  3. lê .gsd/STATE.md                 ← próxima unidade
  4. lê .gsd/AUTO-MEMORY.md           ← top memórias rankeadas
  5. monta prompt com arquivos inlined
        │
        ├── research? → forge-researcher (opus,   contexto fresco)
        ├── plan?     → forge-planner    (opus,   contexto fresco)
        ├── execute?  → forge-executor   (sonnet, contexto fresco)
        └── complete? → forge-completer  (sonnet, contexto fresco)
        │
        ▼
  após cada unidade:
    forge-memory (haiku) extrai memórias do transcript
    memórias rankeadas → injetadas na próxima unidade
    loop → próxima unidade
        │
        ▼
  milestone completo → relatório final
```

## Agentes e modelos

Cada fase tem um agente dedicado com modelo configurável:

| Agente | Modelo padrão | Fase | Por que este modelo |
|--------|--------------|------|---------------------|
| `forge-discusser` | **Opus** | discuss | Precisa entender nuance de requisitos e trade-offs |
| `forge-researcher` | **Opus** | research | Análise profunda de codebase e identificação de riscos |
| `forge-planner` | **Opus** | plan | Decomposição arquitetural, boundary maps, task sizing |
| `forge-executor` | **Sonnet** | execute | Implementação eficiente, boa relação custo/qualidade |
| `forge-completer` | **Sonnet** | complete | Síntese de summaries, UAT scripts, squash merge |
| `forge-worker` | **Sonnet** | step mode | Worker genérico para execução manual |
| `forge-memory` | **Haiku** | pós-unidade | Extração barata de memórias do transcript (fire-and-forget) |

Cada agente roda com **contexto isolado** — equivalente ao `ctx.newSession()` do gsd-pi. O orquestrador (`forge`) nunca acumula tokens de execução.

### Mudar modelos

```
/forge-prefs set research haiku    ← pesquisa mais barata
/forge-prefs set execute opus      ← execução com modelo pesado
```

Ou edite diretamente `~/.claude/forge-agent-prefs.md` e o frontmatter do agente correspondente em `~/.claude/agents/`.

## Memória emergente

Após cada unidade, o `forge-memory` (Haiku) lê o transcript e extrai conhecimento durável:

```
[MEM001] (gotcha)       conf:0.95  hits:3  — watchEffect com flush:post necessário para watchers de rota no Vue 3
[MEM004] (convention)   conf:0.85  hits:2  — widgets React ficam em packages/components/react/src/widgets/
[MEM008] (architecture) conf:0.90  hits:3  — BOLT roda em WebWorker; nunca manipular WebSocket no main thread
```

Memórias são rankeadas por `confidence × (1 + hits × 0.1)`, decaem se não confirmadas, e são injetadas no prompt de cada nova unidade. O agente nunca redescobre o que já aprendeu.

## Perfil de engenharia

O que este agente otimiza:

- **Bytes e tokens**: contexto enxuto, arquivos de prompt pequenos, evitar inflação de tokens.
- **Performance e previsibilidade**: builds e lint consistentes (um lockfile, scripts padrão).
- **Código limpo**: responsabilidade única por arquivo, convenções de nome claras.
- **Segurança de mudanças**: correções automáticas apenas quando mecanicamente seguras.
- **Evidência**: diagnósticos que geram plano ao invés de refactors silenciosos.
