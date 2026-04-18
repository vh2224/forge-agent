# M002: Context engineering upgrades portados do GSD-2 — Context
**Gathered:** 2026-04-16
**Status:** Ready for planning

## Implementation Decisions

- **Token counting:** usar apenas heurística `Math.ceil(chars/4)` — zero dependência nova. Precisão suficiente para routing por tier e budget coarse-grained. Revisitar se telemetria mostrar erro > 20% em algum modelo.
- **Retry de erros transitórios:** `max_transient_retries: 3`, backoff exponencial 2s/4s/8s. Aplica-se às classes `rate_limit`, `network`, `server`, `stream`. Classes `permanent`, `model_refusal`, `context_overflow`, `tooling_failure` não re-tentam (ou usam estratégia própria já existente).
- **Tier defaults:** mapping `unit_type → tier` fica fixo em `shared/forge-tiers.md`. Usuário só sobrescreve `tier → model` via `tier_models:` nas prefs (ex: `tier_models.light: claude-haiku-4-5-20251001`). Manual override por task via `tier: heavy` no frontmatter de T##-PLAN.
- **Verify discovery chain:** `plan.verify` → `prefs.verification.preference_commands` → auto-detect (package.json scripts / pyproject / go.mod) → skip gracefully com `{skipped: "no-stack"}`. Docs-only repo não bloqueia.
- **Context budget:** seções mandatórias (plan, scope, slice-context) erram se excederem; opcionais (auto-memory, ledger, coding-standards) truncam em H2 boundary.
- **Abordagem:** Hybrid C — scripts Node em `scripts/forge-*.js` para tudo que precisa determinismo/execução (error classifier regex, verify runner, token counter). Instruções inline em Markdown para lógica pura (classificação de complexidade, routing por tier).
- **Ordem das slices:** S01 error-classifier → S02 verification-gate → S03 token-counter → S04 complexity/model-router. Menor risco primeiro, cada slice valida a próxima.

## Agent's Discretion

- Nome exato dos scripts Node (`forge-classify-error.js` vs `forge-errors.js` etc.) — planner decide.
- Formato exato das entradas em `events.jsonl` para telemetria de retry/tier/tokens — planner decide, mantendo compatível com parser existente.
- Estrutura interna de `shared/forge-tiers.md` — planner decide.

## Deferred Ideas

- Capability scoring 7-dim (over-engineering pra Claude-only).
- Cross-provider routing (GPT/Gemini/Deepseek) — sem adapter layer.
- Reactive graph + worktree orchestrator (paralelismo) — milestone próprio.
- Adaptive learning via `routing-history.js` — sem baseline de telemetria ainda.
- Budget pressure downgrade (>75%) — Forge não tem per-milestone budget ainda.
- Migração para tiktoken real se a heurística se mostrar imprecisa demais.
