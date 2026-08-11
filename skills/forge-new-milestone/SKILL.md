---
name: forge-new-milestone
description: "Cria um novo milestone GSD. Fluxo: brainstorm, discuss, plan."
allowed-tools: Read, Write, Bash, Agent, Skill, AskUserQuestion, WebSearch, WebFetch
---

## Bootstrap guard

```bash
ls CLAUDE.md 2>/dev/null && echo "ok" || echo "missing"
ls .gsd/STATE.md 2>/dev/null && echo "ok" || echo "missing"
pwd
```

**Se CLAUDE.md não existe:** Stop. Tell the user:
> Projeto não inicializado. Execute `/forge-init` primeiro.

**Se .gsd/STATE.md não existe:** Stop. Tell the user:
> Nenhum projeto GSD encontrado. Execute `/forge-init` para começar.

---

## Parse flags

From `$ARGUMENTS`:
- If starts with `-fast` → `FAST_MODE=true`, strip `-fast` from description
- If contains `-session {id}` → `SESSION_ID={id}`, strip `-session {id}` from description
- Remaining text → `MILESTONE_DESC`

---

## Step 1 — Minimal context read + generate milestone ID

Read ONLY these small files:
- `.gsd/PROJECT.md` → project description and stack
- `.gsd/REQUIREMENTS.md` → constraints (or skip if missing)
- Last 10 rows of `.gsd/DECISIONS.md` → locked decisions

If `SESSION_ID` is set: Read `.gsd/sessions/{SESSION_ID}.md` → store as `SESSION_FILE`.

Do NOT read anything else. Do NOT read source code.

**Resolve scripts dir** for forge-ids.js:
```bash
if [ -f "scripts/forge-ids.js" ]; then
  FORGE_SCRIPTS_DIR="scripts"
else
  FORGE_SCRIPTS_DIR="${FORGE_HOME:-$HOME/.forge-agent}/scripts"
fi
```

**Generate `MILESTONE_ID`** by shelling out to the central ID module:
```bash
MILESTONE_ID=$(node "$FORGE_SCRIPTS_DIR/forge-ids.js" --new-milestone "{MILESTONE_DESC}")
```

`MILESTONE_ID` format depends on the `ids.format` pref (resolved by forge-ids.js itself — user → repo → local cascade, default `timestamp`): `timestamp` → `M-<YYYYMMDDHHMMSS>-<slug>` (e.g. `M-20260522143201-sistema-notificacoes`; slug derived from `MILESTONE_DESC`, omitted if too vague); `sequential` → legacy `M00N` (max existing + 1, scanning `.gsd/milestones/` + `.gsd/archive/`). Reading/resolving accepts BOTH formats always, regardless of the pref.

Create the milestone directory:
```bash
mkdir -p .gsd/milestones/{MILESTONE_ID}/slices
```

---

## Step 1.5 — Itens abertos do backlog (insumo)

Lista os itens abertos do backlog (`.gsd/items/`) antes do brainstorm, deixa o operador escolher quais alimentam este milestone, e promove os escolhidos para `{MILESTONE_ID}`. Regras completas (filtro, formato de listagem, promoção, postura de falha) em `shared/forge-items-readback.md § Listagem de itens abertos` e `§ Promoção` — este step só referencia, não restate.

**Resolve scripts dir:**
```bash
if [ -f "scripts/forge-items.js" ]; then
  FORGE_SCRIPTS_DIR="scripts"
else
  FORGE_SCRIPTS_DIR="${FORGE_HOME:-$HOME/.forge-agent}/scripts"
fi
```

**Listar:**
```bash
OPEN_ITEMS_JSON=$(node "$FORGE_SCRIPTS_DIR/forge-items.js" --list --json --cwd "$(pwd)" 2>/dev/null)
LIST_EXIT=$?
if [ "$LIST_EXIT" -ne 0 ]; then
  echo "⚠ Falha ao listar itens do backlog — seguindo sem insumo de backlog."
  OPEN_ITEMS_JSON="[]"
fi
```

Filtra em `inbox`/`triaged` com `node -e` (nunca grep em JSON):
```bash
OPEN_ITEMS=$(echo "$OPEN_ITEMS_JSON" | node -e '
  let d = "";
  process.stdin.on("data", c => d += c).on("end", () => {
    try {
      const items = JSON.parse(d || "[]");
      const open = items.filter(i => i.status === "inbox" || i.status === "triaged");
      process.stdout.write(JSON.stringify(open));
    } catch (e) {
      process.stdout.write("[]");
    }
  });
')
OPEN_COUNT=$(echo "$OPEN_ITEMS" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).length))}catch(e){process.stdout.write("0")}})')
```

**Zero itens abertos ⇒ pular o step inteiro, silenciosamente** — sem heading, sem prompt, sem linha de output. Um projeto com backlog vazio vê exatamente o fluxo de hoje. Só continue com o restante deste step se `OPEN_COUNT` > 0.

**Renderizar a listagem** (`{I-id} · {status} · {title}`, mais `source` quando presente):
```bash
echo "Itens abertos do backlog:"
echo "$OPEN_ITEMS" | node -e '
  let d = "";
  process.stdin.on("data", c => d += c).on("end", () => {
    const items = JSON.parse(d);
    for (const i of items) {
      const src = i.source ? ` · ${i.source}` : "";
      console.log(`${i.id} · ${i.status} · ${i.title}${src}`);
    }
  });
'
```

**Se `FAST_MODE=true`:** pare aqui — a listagem é informativa; sem `AskUserQuestion`, sem promoção, sem `promoted_to`. Continue para o Step 2.

**Caso contrário**, chame `AskUserQuestion` multi-select sobre os itens listados, sempre incluindo a opção explícita "Nenhum — começar do zero":

```
AskUserQuestion({
  questions: [{
    question: "Quais itens do backlog este milestone deve absorver?",
    header: "Backlog",
    multiSelect: true,
    options: [
      { label: "{I-id curto}", description: "{title} — {status}{ · source, se presente}" },
      ...
      { label: "Nenhum — começar do zero", description: "Não promover nenhum item; seguir com o fluxo normal" }
    ]
  }]
})
```

Guarde as escolhas (excluindo "Nenhum") como `SELECTED_ITEMS` (lista de `{id, title, source, body}`, derivada do `OPEN_ITEMS` original). Derive `PICKED_IDS` (lista de IDs) diretamente de `SELECTED_ITEMS` no mesmo passo — nunca deixe a variável iterada abaixo implícita:
```bash
PICKED_IDS=$(echo "$SELECTED_ITEMS" | node -e '
  let d = "";
  process.stdin.on("data", c => d += c).on("end", () => {
    const items = JSON.parse(d);
    console.log(items.map(i => i.id).join(" "));
  });
')
```

**Promover cada escolha e transicionar para `doing`** (uma por uma; falha é advisory — uma linha `⚠` nomeando o item, segue com o resto):
```bash
for id in $PICKED_IDS; do
  node "$FORGE_SCRIPTS_DIR/forge-items.js" --promote "$id" "$MILESTONE_ID" --cwd "$(pwd)" \
    || echo "⚠ Falha ao promover item $id — seguindo sem bloquear a criação do milestone."
  node "$FORGE_SCRIPTS_DIR/forge-items.js" --set-status "$id" doing --cwd "$(pwd)" \
    || echo "⚠ Falha ao marcar item $id como doing — seguindo sem bloquear a criação do milestone."
done
```

Se `SELECTED_ITEMS` estiver vazio (operador escolheu "Nenhum" ou não há itens), não há bloco de contexto a propagar nos Steps 2 e 4 — os prompts ficam byte-idênticos ao fluxo de hoje.

---

## Step 2 — Brainstorm (skip if FAST_MODE)

**If FAST_MODE=true:** Skip to Step 3.

**If SESSION_ID is set (session-backed milestone):**

Synthesize `SESSION_FILE` into a BRAINSTORM.md directly (no subagent needed — the session IS the brainstorm). Write `.gsd/milestones/{MILESTONE_ID}/{MILESTONE_ID}-BRAINSTORM.md` with this structure:

```markdown
# {MILESTONE_ID}: {MILESTONE_DESC} — Brainstorm
**Source:** forge-ask session {SESSION_ID}
**Date:** {today}

## Context
{Summarize the session topic and motivation in 2-3 sentences, drawn from ## Conversation}

## Recommended Approach
{Derive from the session conversation — what approach emerged as preferred?}

## Alternatives Considered
{List alternatives discussed in the session, or "(none discussed)" if absent}

## Risks
{Extract risks mentioned in the session. If none: derive top 3 from the context.}

## Open Questions
{Copy from session ## Queued Actions or derive from unresolved threads in ## Conversation}

## Key Decisions from Session
{Copy all entries from ## Captured Decisions verbatim}

## Session Conversation Summary
{Paraphrase ## Conversation in 5-8 bullet points capturing the key ideas discussed}
```

Show the user:
```
✓ Brainstorm sintetizado da sessão {SESSION_ID}
  Abordagem recomendada: {1-line summary}
  Riscos identificados: {count}
  Decisões capturadas: {count from ## Captured Decisions}
```

Then proceed to Step 3.

**If SESSION_ID is NOT set (standard flow):**

Delegate to an isolated subagent to keep brainstorm output out of main context:

> Antes de despachar o brainstorm, exiba o **Spawn Liveness Banner** (ver `shared/forge-dispatch.md § Spawn Liveness Banner`) com duração estimada apropriada para esta subagent (consulte a tabela de duração).

**Se `SELECTED_ITEMS` (Step 1.5) não estiver vazio**, monte um bloco `## Itens do backlog selecionados` (título + source + um resumo de uma linha do body, por item) e anexe ao prompt do subagente abaixo — quando `SELECTED_ITEMS` estiver vazio, omita o bloco inteiramente (o prompt fica byte-idêntico ao de hoje).

```
Agent({
  description: "Brainstorm {MILESTONE_ID}",
  prompt: "You are running the forge-brainstorm skill for milestone {MILESTONE_ID}: {MILESTONE_DESC}.\nWorking directory: {pwd}\n\nInvoke: Skill({ skill: \"forge-brainstorm\", args: \"{MILESTONE_ID}: {MILESTONE_DESC}\" })\n\nAfter the skill writes the BRAINSTORM.md file, return ONLY:\n- Path of file written\n- Recommended approach (1 paragraph)\n- Top 3 risks (bullet list)\n- Open questions (bullet list)\n\nDo NOT return the full file content.[SE SELECTED_ITEMS NÃO VAZIO, ANEXAR:]\n\n## Itens do backlog selecionados\n- {I-id}: {title} ({source}) — {resumo de uma linha do body}\n..."
})
```

After the agent returns, confirm `.gsd/milestones/{MILESTONE_ID}/{MILESTONE_ID}-BRAINSTORM.md` exists and show the user the compact summary returned by the agent (Recommended approach + Top 3 risks + Open questions).

---

## Step 3 — Scope clarity (skip if FAST_MODE)

**If FAST_MODE=true:** Skip to Step 4.

Delegate to an isolated subagent to keep scope clarity output out of main context:

> Antes de despachar o scope-clarity, exiba o **Spawn Liveness Banner** (ver `shared/forge-dispatch.md § Spawn Liveness Banner`) com duração estimada apropriada para esta subagent (consulte a tabela de duração).

```
Agent({
  description: "Scope clarity {MILESTONE_ID}",
  prompt: "You are running the forge-scope-clarity skill for milestone {MILESTONE_ID}: {MILESTONE_DESC}.\nWorking directory: {pwd}\n\nInvoke: Skill({ skill: \"forge-scope-clarity\", args: \"{MILESTONE_ID}: {MILESTONE_DESC}\" })\n\nAfter the skill writes the SCOPE.md file, return ONLY:\n- Path of file written\n- The In Scope table (markdown)\n- The Out of Scope table (markdown)\n\nDo NOT return the full file content."
})
```

After the agent returns, confirm `.gsd/milestones/{MILESTONE_ID}/{MILESTONE_ID}-SCOPE.md` exists and show the user the In Scope and Out of Scope tables returned by the agent.

---

## Step 4 — Discuss (interactive, stays in main context)

**Se `SELECTED_ITEMS` (Step 1.5) não estiver vazio**, mostre o bloco `## Itens do backlog selecionados` (título + source + resumo de uma linha do body, por item) no contexto interativo antes de iniciar as perguntas — os itens ficam visíveis enquanto decisões são tomadas. Não re-pergunte ao operador para confirmar as escolhas já feitas no Step 1.5. Se `SELECTED_ITEMS` estiver vazio, omita este bloco inteiramente.

**If SESSION_ID is set:** Pre-populate CONTEXT.md with decisions already captured in the session (from `## Captured Decisions` in `SESSION_FILE`). These are locked — do NOT re-ask them.

Identify only the **remaining** gray areas not already resolved by the session. Focus on decisions that:
- Are NOT covered by `## Captured Decisions` in the session
- Materially affect implementation
- Are not already in DECISIONS.md

If the session thoroughly covered the scope, it may be that 0-2 questions remain. That is fine — do not manufacture questions.

**Ask questions one at a time using `AskUserQuestion`** — do NOT dump all questions in a text block.

For each question:
1. Generate 2-4 concrete options derived from the project context (not generic)
2. `AskUserQuestion` adds "Other" automatically — do not add it manually
3. Wait for the answer before moving to the next question
4. If user answers "you decide" → record as "Agent's Discretion" and move on

Write decisions to `.gsd/milestones/{MILESTONE_ID}/{MILESTONE_ID}-CONTEXT.md`:
```markdown
# {MILESTONE_ID}: {MILESTONE_DESC} — Context
**Gathered:** {date}
**Status:** Ready for planning
{If SESSION_ID: **Session source:** {SESSION_ID}}

## Decisions from Session
{If SESSION_ID: copy all entries from ## Captured Decisions in SESSION_FILE verbatim. Else: omit this section.}

## Implementation Decisions
- {decision from user answers in Step 4 AskUserQuestion}

## Agent's Discretion
- {areas where user said "you decide"}

## Deferred Ideas
- {ideas that belong in later milestones}
```

### Append significant decisions to the fragment store

<!-- pre-S03: this used to append directly to the decisions log file -->

For each significant decision made during this discuss unit, pipe a JSON fragment to `forge-decisions.js --write`:

```bash
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-decisions.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
echo '{
  "unit_id": "{MILESTONE_ID}",
  "decisions": [
    {
      "when": "YYYY-MM-DD",
      "scope": "milestone",
      "decision": "Short label for this decision",
      "choice": "What was chosen",
      "rationale": "Why this was chosen",
      "revisable": "yes|no"
    }
  ]
}' | node "$FORGE_SCRIPTS_DIR/forge-decisions.js" --write --cwd .
```

- Multiple decisions can be batched in a single `decisions` array invocation.
- The global `.gsd/DECISIONS.md` is rebuilt from fragments during `complete-milestone` (forge-completer, step 5) — never edit it directly.

---

## Step 5 — Plan (delegate to sub-agent)

Read:
- `.gsd/AUTO-MEMORY.md` first 80 lines (or skip if missing)

Emita o banner de liveness (ver `shared/forge-dispatch.md § Spawn Liveness Banner`):
`◆ Despachando forge-planner… (roda em subagente — sem output até retornar, ~2–5 min; esperado, não é travamento)`

Derive the valid domain list for the header below:
```bash
FORGE_SCRIPTS_DIR=$([ -f scripts/forge-routing.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")
routing_domains=$(node "$FORGE_SCRIPTS_DIR/forge-routing.js" --list-domains --cwd "$(pwd)" \
  | node -e 'const a=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(a.length?a.join(", "):"(none — omit domain:)")')
```

Then delegate to `forge-planner` agent:

```
Plan milestone {MILESTONE_ID}: {MILESTONE_DESC}
WORKING_DIR: {pwd}
ROUTING_DOMAINS: {routing_domains}

PROJECT:
{content of .gsd/PROJECT.md}

REQUIREMENTS:
{content of .gsd/REQUIREMENTS.md}

CONTEXT (discuss decisions):
{content of {MILESTONE_ID}-CONTEXT.md}

BRAINSTORM:
{content of {MILESTONE_ID}-BRAINSTORM.md, or "(none — fast mode)"}

SCOPE:
{content of {MILESTONE_ID}-SCOPE.md, or "(none — fast mode)"}

{If SESSION_ID:
SESSION_CONVERSATION:
{content of ## Conversation section from SESSION_FILE — provides rich context about what was discussed, considered, and rejected}
}

DECISIONS:
{full .gsd/DECISIONS.md}

TOP_MEMORIES:
{first 80 lines of AUTO-MEMORY.md}

Write {MILESTONE_ID}-ROADMAP.md with:
- 4-10 slices ordered by risk (high first)
- Each slice: title, description, risk tag, depends tag, demo sentence
- A Boundary Map section showing what each slice produces/consumes
Return ---GSD-WORKER-RESULT--- with list of slices created.
```

---

## Step 6 — Risk radar on high-risk slices (skip if FAST_MODE)

**If FAST_MODE=true:** Skip to Step 7.

Read the ROADMAP and collect ALL slices tagged `risk:high` into a list. Then process each one **to completion before moving to the next**. Do NOT stop, summarize, or report to the user between slices — the loop must complete entirely before proceeding to Step 7.

For EACH `risk:high` slice, in order:

1. Create the slice directory:
```bash
mkdir -p .gsd/milestones/{MILESTONE_ID}/slices/{S##}
```

2. Invoke risk radar for this slice:
```
Skill({ skill: "forge-risk-radar", args: "{MILESTONE_ID} {S##}" })
```

3. Confirm `S##-RISK.md` was written. Then **immediately** continue to the next `risk:high` slice without pausing.

After ALL slices have been processed (or if no `risk:high` slices exist), proceed to Step 7.

---

## Step 7 — Update state and report

Write `.gsd/milestones/{MILESTONE_ID}/{MILESTONE_ID}-STATE.md` (per-run state, via `scripts/forge-state.js` — never hand-edit or overwrite the root `.gsd/STATE.md`, which is a generated dashboard):
```markdown
---
milestone: {MILESTONE_ID}
kind: milestone
created: {ISO8601}
last_updated: {ISO8601}
isolation_mode: {isolation_mode from prefs}
---

# {MILESTONE_ID} State

**Active Slice:** none
**Active Task:** none
**Phase:** plan-slice (ready to plan first slice)
**Auto-mode:** off
**Next Action:** Plan first slice: run /forge-next or /forge-auto
```
Then run `node scripts/forge-dashboard.js --cwd .` to regenerate the root dashboard.

Report to user:
```
✓ Milestone {MILESTONE_ID} criado

Título: {MILESTONE_DESC}
Slices: {N} slices no roadmap
Slices high-risk: {list or "none"}

Arquivos criados:
  .gsd/milestones/{MILESTONE_ID}/{MILESTONE_ID}-ROADMAP.md
  .gsd/milestones/{MILESTONE_ID}/{MILESTONE_ID}-CONTEXT.md
  [{MILESTONE_ID}-BRAINSTORM.md]  (se não for fast mode)
  [{MILESTONE_ID}-SCOPE.md]       (se skill disponível)

Próximo: /gsd para planejar primeiro slice, ou /forge-auto para executar tudo.
```
