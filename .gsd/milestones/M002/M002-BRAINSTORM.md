# Brainstorm: M002 — Context Engineering Upgrades (GSD-2 Port)

**Date:** 2026-04-16
**Prepared for:** discuss phase
**Source of inspiration:** `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/` (Node.js GSD-2 extension)

---

## Context snapshot

Forge Agent é um orchestrator em **Markdown + Claude Code slash commands** — não um runtime Node.js. GSD-2 é um extension host em TypeScript compilado com state engine, registries, event bus, cost telemetry. Portar "direto" não é possível — cada feature precisa ser reinterpretada no modelo Forge:

- **GSD-2:** código TS executa no processo do CLI, tem acesso a `tiktoken`, `spawnSync`, SDK de providers.
- **Forge:** cada fase é um prompt Markdown; "execução" acontece via `Agent()`/`Skill()`/`Bash()` tools do Claude Code. Não há processo persistente.

Isso força uma decisão arquitetural transversal antes de qualquer feature individual: **onde vive a lógica?** (ver Lens 2).

Decisões já locked em M001 que este milestone precisa respeitar:
- Lean orchestrator (workers leem próprios artefatos — não inlar conteúdo).
- `/forge` REPL < 5K tokens (compact-safe).
- Skills com `disable-model-invocation: true`.
- Workers retornam `---GSD-WORKER-RESULT---`.

---

## Lens 1 — User outcomes

O "usuário" aqui são dois: **(a)** o desenvolvedor que invoca Forge, **(b)** o orquestrador/worker que consome os novos sinais.

1. **Previsibilidade de custo por milestone.** Ao terminar um slice, saber quantos tokens foram gastos e estar confiante de que o orquestrador vai rebaixar de Opus→Sonnet→Haiku automaticamente quando o trabalho é trivial.
   - Simplest: registrar tokens no `events.jsonl` e expor no `/forge-status`. Riskiest assumption: `tiktoken` (ou substituto) funciona offline em Windows via Node.
2. **Corte objetivo de "task completo".** Não confiar no worker dizer "done" — rodar `npm run typecheck && lint && test` e só marcar done se exit 0.
   - Simplest: forge-executor já tem Bash tool; adicionar bloco "verification gate" ao prompt. Riskiest assumption: projetos heterogêneos (Python, Go, docs-only) exigem configuração por projeto.
3. **Retry inteligente após falha transiente.** Hoje um 503 da Anthropic mata o forge-auto. Com classifier: rate-limit → espera Retry-After; network → retry same-model; server → failover pro fallback.
   - Simplest: classificar a exceção no catch do `Agent()` call e aplicar estratégia. Riskiest assumption: Claude Code expõe a mensagem de erro completa ao handler.
4. **Rebaixamento dinâmico de modelo sem editar prefs.** Slice trivial (docs-only, typo) usa Haiku; plan-slice complexo usa Opus — sem o usuário mexer em `claude-agent-prefs.md`.
   - Simplest: tabela `unit_type → tier` + inspeção do T##-PLAN.md. Riskiest assumption: estimativas heurísticas batem com complexidade real o suficiente pra evitar retrabalho.
5. **Budget de contexto por seção.** Quando o orquestrador injeta TOP_MEMORIES / CS_LINT / SCOPE no prompt, respeitar cotas por categoria e truncar em fronteira de seção (não mid-paragraph).
   - Simplest: função `truncateAtSectionBoundary()` usada no `/forge.md` e shared templates. Riskiest assumption: os prompts atuais já são pequenos o bastante para que isto raramente dispare — valor real pode ser marginal no Forge (vs. GSD-2 onde prompts crescem).

---

## Lens 2 — Alternative approaches

### A — Node helper binário (`scripts/forge-engine.js`) invocado via Bash
Port quase 1:1 das quatro funções GSD-2 para um único Node script. Orquestrador chama via `Bash("node scripts/forge-engine.js classify <unit_id>")` e consome stdout JSON. Usa `tiktoken` real.
- **Tradeoff:** Máxima fidelidade ao GSD-2, testável em isolamento, determinístico. Custa uma dependência Node opcional e latência de spawn (~100-300ms por chamada). Windows-friendly (já exigimos Node pros hooks/scripts existentes).

### B — Lógica inline no Markdown + pequenos helpers Bash
Classificação, token count e discovery de comandos ficam como instruções no `/forge.md` e templates de dispatch — o modelo faz a classificação olhando para o T##-PLAN.md. Token counting vira `wc -c / 4` no Bash. Error classification vira regex Bash/PowerShell.
- **Tradeoff:** Zero dependências novas. Perde precisão de `tiktoken` (~5-10% erro), classificação sujeita a drift entre chamadas. Mais barato de manter mas menos auditável — não dá pra testar separadamente.

### C — Híbrido: Node helper só para o que exige estado/precisão; resto inline
Node helper cobre apenas (1) token counting com tiktoken e (2) verification-gate runner. Complexity classifier e error classifier ficam inline no Markdown porque são regex puras sem estado e o modelo pode aplicá-las com baixo erro.
- **Tradeoff:** Balanceia precisão onde importa (tokens, gate) com simplicidade onde não importa (regex). Divide a superfície em dois paradigmas — potencial inconsistência mental para quem mantém.

**Recomendação preliminar:** **C híbrido**. Tiktoken e gate runner realmente precisam determinismo/execução. Classifiers são regex que cabem em 30 linhas de instrução markdown e o Opus aplica consistentemente. Error classifier já pode ser um único `scripts/forge-classify-error.js` de 40 linhas reutilizando regex literal do GSD-2.

---

## Lens 3 — Inversion: o que mata esse milestone

1. **Tiktoken não roda no Windows sem Visual Studio Build Tools.** `tiktoken` tem binding nativo — usuários sem build tools teriam install quebrado. *Detectável:* CI test em Windows fresh. *Mitigação:* fallback `Math.ceil(chars/4)` se import falhar (GSD-2 já faz isso).
2. **Verification gate sem config de projeto = falso negativo ou falso positivo massivo.** Forge é multi-stack (Node, Python, Go, docs-only). Rodar `npm run typecheck` em repo Python faz todo slice falhar. *Detectável:* dry-run em 3-4 projetos variados. *Mitigação:* discovery chain (pref → T##-PLAN verify field → auto-detect package.json/pyproject/go.mod → skip gracefully se "none").
3. **Rebaixamento de modelo via capability scoring reintroduz o problema que forge-agent resolveu.** Forge simplificou o modelo mental para 3 fases (Opus/Sonnet/Haiku). Portar o sistema de capability scoring de GSD-2 (7 dimensões × N modelos) pode virar over-engineering que ninguém configura. *Detectável:* teste se usuários leem a nova seção de prefs. *Mitigação:* começar com tier-only routing (sem capability scoring), deixar scoring pra M003 se a dor aparecer.
4. **Error classifier não tem acesso à exceção real.** Claude Code pode embrulhar erros do SDK antes de passar ao handler — o texto que o orquestrador vê pode não conter "429" ou "ECONNRESET". *Detectável:* forçar erro (rate-limit artificial) e inspecionar `events.jsonl`. *Mitigação:* abortar feature se texto da exceção for opaco, ou registrar em hook PreToolUse.
5. **Context budget truncation corrompe artefatos críticos.** Se o algoritmo de section-boundary cortar o meio de um T##-PLAN.md, o worker recebe instruções pela metade. *Detectável:* property-based test com artefatos reais. *Mitigação:* truncar apenas injeções *opcionais* (memórias, standards, ledger snapshots); artefatos mandatory (plan, scope, context) nunca são truncados — se não cabem, erro explícito.
6. **Classifier decisions não são auditáveis.** Haiku resolver um slice mal e o usuário não entender por que. *Detectável:* feedback do usuário. *Mitigação:* toda decisão de routing grava linha em `events.jsonl` com `{unit, tier, model, reason}` — `/forge-status` expõe.
7. **Port paralelo de 4 features grandes num só milestone explode o contexto.** Cada feature toca orchestrator, prompt templates, prefs, docs. Risco de merge conflicts internos entre slices. *Mitigação:* sequenciar slices (não paralelo), cada um termina com todos artefatos commitados antes do próximo.

---

## Lens 4 — Scope razor

**Explicitamente OUT:**
- Reactive graph / worktree orchestrator (adiado para M003 conforme user brief).
- Cross-provider routing (GPT/Gemini/Deepseek). Forge hoje só roda em Claude Code — não há adapter para outros providers.
- `auto-model-selection.js` completo do GSD-2 (capability profiles, 7-dim scoring). Começar com tier routing simples.
- Adaptive learning (`routing-history.js` — bumpar tier baseado em failure rate histórica). Depende de telemetria madura que ainda não existe.
- Budget pressure (downgrade porque gastou >75% do budget). Forge não expõe budget por milestone ainda.
- Runtime error capture (bg-shell + browser console scan do verification-gate.js GSD-2). Não aplicável ao modelo Forge onde worker roda em sandbox do Claude Code.
- Dependency audit (`npm audit` no post-task). Útil mas é feature isolada — pode ser skill `forge-audit` futura.

**Assumptions to validate in discuss:**
- A1: Quando `Agent()` lança exceção, o catch no orquestrador Markdown recebe texto legível suficiente para aplicar regex de classificação.
- A2: Haiku consegue executar `complete-slice` e `run-uat` sem regredir qualidade de summary.
- A3: Usuário aceita overhead de ~200ms por unidade caso escolhamos approach A/C (Node helper).
- A4: `spawnSync` via Bash tool do Claude Code é confiável o suficiente para rodar gate commands sem flakes.

**Dependencies que podem bloquear:**
- `tiktoken` npm package em Windows (approach A/C). Alternativa: `gpt-tokenizer` (pure JS, sem native binding).
- Acesso a texto de erro pelo orchestrator (A1 acima).

---

## Lens 5 — Slice candidates

Ordem sequencial proposta (não paralela). Cada slice termina com commit + STATE update antes do próximo.

- **S01 — Error classifier + retry integration** *(risk: medium)*
  User pode demo: forçar mock de 503/429/ECONNRESET no `Agent()` e ver orquestrador recuperar automaticamente com backoff correto. Ganho imediato, superfície pequena, prova o canal de exceção (valida A1). Começa aqui porque destrava confiança nos outros três.
  - Entregáveis: `scripts/forge-classify-error.js` (port 1:1 das regex GSD-2), instruções de retry no `/forge.md` e `skills/forge-auto`, linha `events.jsonl` com classe/retry, doc em prefs.

- **S02 — Verification gate executável** *(risk: high)*
  User pode demo: task com `verify:` no plan roda comandos reais, falha do typecheck bloqueia o done, failure context vai pro next worker retry. Maior risco técnico (discovery chain + multi-stack). Isola a descoberta de comandos + execução + formatação de falha.
  - Entregáveis: `scripts/forge-verify.js` (spawnSync + truncate), bloco de instruções no `forge-executor.md` e `forge-completer.md`, config em `claude-agent-prefs.md` (`verification.preference_commands`), fallback gracioso para projetos sem stack detectada.

- **S03 — Token counter + context budget** *(risk: low)*
  User pode demo: `/forge-status` mostra tokens consumidos na sessão; injeções opcionais (memórias, ledger) são truncadas em fronteira de seção quando excedem budget. Slice menor, isolável. Rodar *depois* de S01/S02 pra não bloquear valor real.
  - Entregáveis: `scripts/forge-tokens.js` (tiktoken + fallback), função `truncateAtSectionBoundary` usada em `shared/forge-dispatch.md`, campo `tokens` no `events.jsonl`, seção "Token usage" no `/forge-status`.

- **S04 — Complexity classifier + tier-only model router** *(risk: medium)*
  User pode demo: `execute-task` com tag `docs` roda em Haiku; `plan-slice` sempre em Opus configurado; decisão logada. Tier-only deliberadamente — sem capability scoring nesta iteração. Vai por último porque precisa de S01 (error retry ao escalar tier) e S03 (token telemetry para validar economia).
  - Entregáveis: bloco de instruções de classification no `/forge.md` + `shared/forge-dispatch.md`, tabela `UNIT_TYPE_TIERS` em `shared/forge-tiers.md`, `tier_models` em prefs, docs atualizadas, linha `events.jsonl` com tier/downgraded flag.

---

## Recommended approach

**Abordagem C híbrida, 4 slices sequenciais começando por error classifier.** Port direto das regex do GSD-2 `error-classifier.js` como primeiro slice — entrega valor imediato (forge-auto sobrevive a 503 transiente), valida o canal de exceção do Claude Code, e cria o padrão "helper Node + instrução Markdown" que os próximos slices seguem. Verification gate depois porque é o maior risco técnico (multi-stack discovery) e merece isolamento. Token counter no meio — feature pequena que destrava telemetria para validar o rebaixamento do slice final. Complexity/model routing por último, em modo tier-only (sem capability scoring de 7 dimensões), evitando over-engineering de GSD-2 que nunca foi exercitado. Scoring fica como carta para M003 se houver dor.

---

## Top 3 risks (ranked for discuss)

1. **Canal de exceção opaco** — Se `Agent()` não expõe texto de erro legível, S01 morre e cascateia. Mitigação: smoke test forçado no kickoff de S01 antes de escrever código.
2. **Verification gate em projeto multi-stack** — Discovery chain errado = slice marca "done" com código quebrado ou trava em projeto sem stack detectada. Mitigação: test em 3 repos heterogêneos (Node, Python, docs-only) antes de commitar default behavior.
3. **Complexity router downgrading errado** — Haiku em task marcada "docs" que na verdade toca 8 arquivos. Mitigação: logar decisão + reason em `events.jsonl`; adicionar override manual em `T##-PLAN.md` frontmatter (`tier: heavy`) como escape hatch.

---

## Open questions for discuss

- **Q1 — Node dependency:** Aceitamos dependência opcional em `tiktoken` (native binding) ou forçamos `gpt-tokenizer` (pure JS, ~10% menos preciso)? Se Windows user sem build tools é cenário real, pure JS ganha.
- **Q2 — Verification gate default:** Quando não há config e não há `package.json`/`pyproject.toml` detectáveis, gate passa (skip gracefully) ou falha (forçar config)? Proponho **skip gracefully** para não quebrar repos docs-only.
- **Q3 — Tier ceiling per unit type:** Mantemos a tabela de GSD-2 (planner=heavy, discusser=standard, memory=light) ou usuário redefine em prefs desde o início? Proponho tabela default fixa + override em prefs.
- **Q4 — Retry budget:** Quantos retries por exceção transiente antes de abortar o slice? GSD-2 usa `networkRetryCount` sem teto explícito no arquivo lido. Proponho `max_transient_retries: 3` com backoff exponencial.
- **Q5 — Capability scoring:** Confirmamos que fica OUT desta milestone? Se usuário quer rodar com GPT-5 ou Gemini no futuro, scoring vira necessidade — mas hoje é over-engineering.
- **Q6 — Artefato mandatory vs optional:** Qual a lista exata de seções injetadas no prompt do worker que podem ser truncadas (opcional) vs quais nunca devem ser (mandatory)? Proponho: plan, scope, slice-context = mandatory; auto-memory, ledger snapshot, coding-standards = opcional.

---

## Slice draft (for planner context)

- S01: Error classifier + retry integration — risk: medium
- S02: Verification gate executável — risk: high
- S03: Token counter + context budget — risk: low
- S04: Complexity classifier + tier-only model router — risk: medium
