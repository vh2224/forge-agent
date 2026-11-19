# Histórico preservado — parte 4

Evidência da entrada anterior, não é política vigente nem fila atual. Consulte ../project-policy.md e contratos atuais antes de agir. Leia somente quando necessário.

---

`````text
- **Novos agentes Opus:** Adicionar `thinking: adaptive` e `effort: medium` ao frontmatter
- **Novos agentes Sonnet:** Adicionar `effort: low` ao frontmatter
- **Nova skill:** Criar `skills/forge-<name>/SKILL.md`, invocar via `Skill("forge-<name>")` — nunca via Agent intermediário
- **Skills são auto-suficientes:** Não injetar contexto no prompt — skill lê o que precisa do disco
- **Decisões de arquitetura novas vão para `docs/DECISIONS-LOG.md`**, nunca como seção nova aqui — este arquivo entra no contexto de toda sessão e de todo subagente e é projetado em projetos consumidores; ele carrega só invariantes vigentes (ver `§ Decisões de arquitetura`). Foi exatamente o acúmulo de changelog aqui que o levou a 131 KB (diagnóstico 2026-08-23)

## Anti-Hallucination Layer (M003)

Conjunto de 5 componentes que substituem "self-reported done" por verificação com evidência. Shipped ao longo de M003 (S01–S04). Quatro componentes são **advisory por padrão** (documentam flags em SUMMARY, não bloqueiam). Apenas o schema check do executor é enforcing desde o dia 1 — um schema que ninguém escreve é inútil.

### Componentes

1. **Structured `must_haves` schema + executor validation (S01)** — todo `T##-PLAN.md` novo carrega um bloco YAML `must_haves: {truths, artifacts, key_links}` + `expected_output: [paths]` no frontmatter. Parser/validator: [`scripts/forge-must-haves.js`](scripts/forge-must-haves.js). Executor lê no step 1a; `valid: false` → block, `legacy: true` → warn. **Enforcing** — bloqueia tasks sem schema. Planner emite incondicionalmente.

2. **Evidence log via PostToolUse hook (S02)** — cada chamada Bash/Write/Edit grava uma linha JSONL (≤512 bytes) em `.gsd/forge/evidence-{unitId}.jsonl`. Hook: [`scripts/forge-hook.js`](scripts/forge-hook.js) PostToolUse branch. `unitId` vem de `auto-mode.json`. Silent-fail (MEM008) — um erro no hook nunca aborta a tool call. Pref: `evidence.mode: lenient | strict | disabled` (default `lenient`).

3. **File-audit em complete-slice (S02)** — `forge-completer` faz `git diff --name-only --diff-filter=AM` contra a união de `expected_output` de todas as tasks. Escreve `## File Audit` em `S##-SUMMARY.md` listando `unexpected` e `missing`. AM-only (D4) — deletions não são auditadas. Pref: `file_audit.ignore_list` (default: lockfiles + dist/build/.next/.gsd/**).

4. **Goal-backward verifier 3-level (S03)** — [`scripts/forge-verifier.js`](scripts/forge-verifier.js) audita cada artefato declarado em `must_haves.artifacts[]` em três níveis: **Exists** (arquivo presente), **Substantive** (≥ `min_lines` linhas + nenhum `stub_patterns` regex casa), **Wired** (≥ 1 import/call em outro JS/TS do slice, depth-2 walker). Artefato: `S##-VERIFICATION.md` (advisory). `forge-completer` invoca no sub-step 1.8. Heurístico — regex + static import-chain scan. JS/TS only; non-JS artifacts emitem `wired: skipped`.

5. **Plan-checker agent (S04)** — [`agents/forge-plan-checker.md`](agents/forge-plan-checker.md) é um agente Sonnet advisory que roda entre `plan-slice` e o primeiro `execute-task`. Pontua 10 dimensões estruturais (completeness, must_haves_wellformed, ordering, dependencies, risk_coverage, acceptance_observable, scope_alignment, decisions_honored, expected_output_realistic, legacy_schema_detect) com pass/warn/fail + justificativa de uma linha. Artefato: `S##-PLAN-CHECK.md`. Nunca bloqueia em modo `advisory`. Idempotente — se `S##-PLAN-CHECK.md` existe, skip.

### Artefatos gerados

| Arquivo | Origem | Advisory | Cleanup |
|---------|--------|----------|---------|
| `.gsd/forge/evidence-{unitId}.jsonl` | S02 PostToolUse hook | sim (cross-ref em completer) | via `milestone_cleanup` (C12) |
| `.gsd/milestones/{M###}/slices/{S##}/{S##}-VERIFICATION.md` | S03 verifier (escrito no complete-slice) | sim (never blocks) | junto com a milestone |
| `.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-CHECK.md` | S04 plan-checker (escrito no gate) | sim em `advisory` (default) | junto com a milestone |

### Prefs keys

```
evidence:
  mode: lenient           # lenient | strict | disabled   (default lenient)
file_audit:
  ignore_list: [package-lock.json, yarn.lock, pnpm-lock.yaml, dist/**, build/**, .next/**, .gsd/**, node_modules/**]
plan_check:
  mode: disabled          # advisory | blocking | disabled   (default disabled desde 2026-08-23)
```

Todos scaffoldados em `forge-agent-prefs.md` e cascateados pela precedência padrão (user → repo → local, last wins).

### Postura por componente (revisada 2026-08-23)

Somente o check de schema do executor (S01, componente #1) é enforcing desde M003. A postura
"advisory por padrão enquanto as heurísticas amadurecem" era deliberada e **a medição que ela
pedia foi feita** (4 milestones, 22 dias): o plan-check rodou 21× em advisory e **nunca alterou
o fluxo** (5 `fail` ignorados) — custava 1 chamada de LLM por slice sem decidir nada. Por isso
o default de `plan_check.mode` virou **`disabled`**; `advisory` (documentação) e `blocking`
(revision-loop, max 3 rodadas, já instalado nas skills) são opt-in. `symbol_check` permanece
advisory (é script, custo de segundos, sem LLM). O verification gate (forge-verify) deixou de
ser no-op na mesma data: discovery com fallback `stack-probe` e `no-stack` nunca mais narrável
como pass.

### Como ativar modos stricter

- `evidence.mode: strict` — reservado para M004+. Em M003 `strict` e `lenient` se comportam de forma idêntica no hook; a diferença no completer é futura.
- `plan_check.mode: advisory | blocking` — opt-in; `blocking` ativa o revision-loop (max 3 rodadas, decremento monotônico em `fail`).
- `file_audit.ignore_list` — customize adicionando/removendo globs. Não muda a postura advisory — só o que é flagged.

## Estado histórico — medições de agosto de 2026, não usar como fila atual

- **Milestone registrado naquele momento:** `M-20260825215030-paridade-host-worker` — paridade host/worker no dispatch
  multi-LLM. S01–S03 fechadas; a próxima é S04 (dialeto Codex no renderer), ainda **não planejada**.
- **Master:** verde — 39 dos últimos 40 runs de CI passando nas três plataformas (medido
  2026-08-23); o vermelho herdado dos merges #91/#94/#98 foi fechado nas semanas seguintes.
- **Suíte local:** 235/237 (medido 2026-08-27 no worktree da run, `node scripts/run-tests.js`,
  704s). Duas falhas, ambas confirmadas **pré-existentes no master** rodando as suítes no
  checkout limpo: `forge-claim-recovery.test.js` e `forge-resources-bench.test.js` — esta última

`````
