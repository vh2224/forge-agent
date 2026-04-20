---
name: forge-probe
description: "Experimentos descartaveis para validar viabilidade antes de comprometer um milestone."
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, WebSearch, WebFetch
---

<objective>
Validação rápida de viabilidade através de experimentos descartáveis e focados. Cada probe responde UMA pergunta específica com evidência observável. Artefatos vivem em `.gsd/probes/` e integram com o fluxo GSD — findings alimentam `plan-milestone` / `plan-slice` e podem virar entradas em `AUTO-MEMORY.md`.

Não requer `/forge-init` — cria `.gsd/probes/` sob demanda.
</objective>

<essential_principles>
- **Uma pergunta por probe.** Se não couber em Given/When/Then, não é um probe — é um milestone.
- **Descartável por design.** Código mínimo que responde à pergunta. Se auth não é a pergunta, hardcode o token. Se DB não é a pergunta, use JSON.
- **Evidência observável.** Verdict precisa sair de algo que você consegue ver: exit code, output, HTTP response, benchmark number.
- **Ordenado por risco.** O probe com maior chance de matar a ideia vai primeiro. Se invalida, pare — economizou o resto.
- **Isolado.** Cada probe dir tem seu próprio `package.json` se precisar de deps. Zero toque em `src/`, `package.json` raiz ou qualquer código de produção.
</essential_principles>

<context>
Idea: $ARGUMENTS

**Flags:**
- `--quick` — pula decomposição/alinhamento, vai direto pro build. Use quando já sabe exatamente o que testar.
</context>

<process>

## Step 1 — Parse args e setup

Parse `$ARGUMENTS`:
- `--quick` → `QUICK_MODE=true`
- Resto do texto → a ideia a probar

```bash
mkdir -p .gsd/probes
# Descobre próximo número sequencial
LAST=$(ls -d .gsd/probes/[0-9][0-9][0-9]-* 2>/dev/null | sort | tail -1 | sed 's|.*/\([0-9]*\)-.*|\1|')
NEXT=$(printf "%03d" $((${LAST:-0} + 1)))
```

## Step 2 — Carregar contexto (read-only)

Lê para dar contexto às decisões do probe:
- `.gsd/PROJECT.md` — stack do projeto
- `.gsd/AUTO-MEMORY.md` (primeiras 60 linhas) — gotchas conhecidos
- `.gsd/STATE.md` — posição atual
- Últimas 15 linhas de `.gsd/DECISIONS.md` — decisões travadas
- `.gsd/probes/MANIFEST.md` (se existe) — probes anteriores

## Step 3 — Detectar stack

```bash
ls package.json pyproject.toml Cargo.toml go.mod requirements.txt 2>/dev/null
```

Use a linguagem/framework do projeto por padrão. Para greenfield, escolha o que chega a resultado executável mais rápido (Python, Node, Bash, HTML único).

**Evite no probe a menos que seja a pergunta central:**
- Build tools, bundlers, transpilers
- Docker, containers, infra
- Configuração via `.env` — hardcode tudo
- Package management além de `npm install` / `pip install` local ao probe dir

## Step 4 — Decompor (skip se `--quick`)

**Se `QUICK_MODE` é true:** pule decomposição e alinhamento. Trata a ideia do usuário como probe único. Jump pro Step 6.

**Caso contrário:** quebra a ideia em 2-5 perguntas independentes, cada uma prova algo específico. Framing Given/When/Then:

```
| # | Probe | Pergunta (Given/When/Then) | Risco |
|---|-------|----------------------------|-------|
| 001 | redis-pubsub-latency | Given 10k msgs/s em Redis pub/sub, when cliente consome, then latência p95 < 50ms | Alto |
| 002 | kafka-pubsub-setup | Given um Kafka single-node via docker, when publisher envia 10k msgs, then consumer recebe sem perda | Médio |
```

**Probes bons respondem UMA pergunta específica:**
- "Consegue parsear X e extrair Y?" — script que faz isso num arquivo de exemplo
- "Quão rápido é a abordagem X?" — benchmark com dado real-ish
- "Consigo fazer X e Y se comunicarem?" — integração mais fina possível
- "Como X se comporta sob carga Z?" — load test mínimo
- "A API X suporta mesmo Y?" — script que chama e mostra response

**Probes ruins** (rejeite e reformule):
- "Configurar o projeto" — não é pergunta, é trabalho
- "Desenhar arquitetura" — planejamento, não probe
- "Construir o backend" — amplo demais

**Ordene por risco.** O probe mais provável de matar a ideia roda primeiro.

## Step 5 — Alinhar (skip se `--quick`)

Use `AskUserQuestion` apresentando a lista:

Pergunta: "Build all probes in this order, or adjust?"

Opções:
- "Build all in order"
- "Reorder — I'll specify"
- "Drop some — I'll specify"
- "Merge two — I'll specify"

Aguarde alinhamento antes de seguir.

## Step 6 — Criar/atualizar MANIFEST

Escreve (ou atualiza) `.gsd/probes/MANIFEST.md`:

```markdown
# Probes Manifest

## Idea
{descrição da ideia geral sendo explorada}

## Probes

| # | Name | Question | Verdict | Tags |
|---|------|----------|---------|------|
```

Anexa linhas novas se `MANIFEST.md` já existe.

## Step 7 — Build cada probe sequencialmente

Para cada probe na ordem de risco:

### a. Criar diretório

`.gsd/probes/NNN-descriptive-name/` — três dígitos zero-padded + nome kebab-case descritivo.

### b. Escrever código mínimo

Todo arquivo serve à pergunta. Nada incidental. Tipicamente:
- `probe.js` / `probe.py` / `probe.sh` — o experimento em si
- `package.json` — se precisar de deps, isolado desse dir
- `.gitignore` — `node_modules/`, `*.log`, dados temporários
- Dados de sample inline ou em `fixtures/`

Se ficar maior que ~200 linhas, provavelmente o probe está largo demais — reduza.

### c. Escrever `README.md` com frontmatter

```markdown
---
probe: NNN
name: descriptive-name
validates: "Given X, when Y, then Z"
verdict: PENDING
related: []
tags: [tag1, tag2]
---

# Probe NNN: {Descriptive Name}

## What This Validates
{Pergunta específica de viabilidade, Given/When/Then}

## How to Run
```bash
cd .gsd/probes/NNN-descriptive-name
{single command ou sequência curta}
```

## What to Expect
{Outcomes observáveis: "quando você rodar X, deve ver Y em Z segundos"}

## Results
_{Preenchido após rodar — verdict, evidência, surpresas}_
```

### d. Auto-linkar probes relacionados

Lê READMEs de probes existentes; infere relações por tags/nomes/descrições. Escreve campo `related` silenciosamente.

### e. Rodar e verificar

**Auto-verificável** (probe produz output definitivo como exit code 0 + benchmark numbers):
- Rode
- Capture output/metrics
- Atualize verdict e seção Results do README

**Precisa julgamento humano** (UI, aproximações qualitativas):
- Rode
- Apresente via `AskUserQuestion`:

Pergunta: "Probe NNN ({name}) — does this match what you expected?"

Opções:
- "Yes, validates the hypothesis"
- "No, invalidates it"
- "Partial — works but with caveats"
- "Need to dig deeper — describe why"

### f. Atualizar verdict

- `VALIDATED` — hipótese confirmada com evidência
- `INVALIDATED` — hipótese falhou; preservar o motivo na seção Results
- `PARTIAL` — funciona com caveats; anotar boundaries

### g. Atualizar MANIFEST.md

Adicionar/atualizar a linha deste probe com verdict + tags.

### h. Commit (se `auto_commit: true` nas prefs)

```bash
# Ler auto_commit das prefs
AUTO_COMMIT=$(node -e "const fs=require('fs'),path=require('path'),os=require('os');const files=[path.join(os.homedir(),'.claude','forge-agent-prefs.md'),path.join('.gsd','claude-agent-prefs.md'),path.join('.gsd','prefs.local.md')];let v='false';for(const f of files){try{const r=fs.readFileSync(f,'utf8');const m=r.match(/^auto_commit:\s*(\w+)/m);if(m)v=m[1].toLowerCase();}catch{}}process.stdout.write(v);")

if [ "$AUTO_COMMIT" = "true" ]; then
  git add .gsd/probes/NNN-descriptive-name/ .gsd/probes/MANIFEST.md
  git commit -m "probe(NNN): [{VERDICT}] — {key finding in one sentence}"
fi
```

### i. Reportar antes do próximo probe

```
◆ Probe NNN: {name}
  Verdict: {VALIDATED ✓ / INVALIDATED ✗ / PARTIAL ⚠}
  Finding: {uma frase}
  Impact: {efeito nos probes restantes, se houver}
```

### j. Short-circuit em invalidação crítica

Se um probe **INVALIDATED** derruba premissa central dos próximos probes, pare. Apresente via `AskUserQuestion`:

Pergunta: "Probe NNN invalidates core assumption. Continue with remaining probes or stop?"

Opções:
- "Stop — enough evidence to abandon this approach"
- "Continue — remaining probes still independent"
- "Pivot — I have a new question to probe instead"

## Step 8 — Report final

Depois de todos os probes (ou short-circuit):

```markdown
## Probes Complete — Summary

**Idea:** {idea original}
**Probes run:** N — {X validated, Y invalidated, Z partial}

### Findings

- **001 {name}** ({VERDICT}): {key finding}
- **002 {name}** ({VERDICT}): {key finding}

### Recommendations

{Based nos verdicts:}
- **Se majority VALIDATED:** "Viabilidade confirmada. Próximo passo: `/forge-new-milestone {refined description}` — o planner vai ler `.gsd/probes/MANIFEST.md` como contexto."
- **Se majority INVALIDATED:** "Abordagem não é viável como especificada. Sugestão: {pivot alternatives baseadas nos findings} ou volte ao `/forge-ask` para brainstorm."
- **Se PARTIAL:** "Viabilidade condicional. Restrições identificadas: {list}. Pode prosseguir com milestone se aceitar essas constraints."

### Artifacts
- `.gsd/probes/MANIFEST.md` — índice
- `.gsd/probes/NNN-*/README.md` — evidência por probe
- Código descartável — deletar com `rm -rf .gsd/probes/NNN-*` quando quiser, ou arquivar commitando
```

## Step 9 — Promoção opcional para AUTO-MEMORY

Se algum finding for **project-specific + non-obvious + durable** (gate do forge-memory), sugira ao usuário:

> Finding do probe 001 se qualifica pra AUTO-MEMORY: "{finding}". Salvar? (s/n)

Se sim, adiciona entrada em `.gsd/AUTO-MEMORY.md` com categoria `gotcha` ou `pattern` conforme apropriado. Usa `Edit` (append-only).

</process>

<success_criteria>
- Cada probe responde UMA pergunta com Given/When/Then
- Verdict sempre ancorado em evidência observável (não opinião)
- Código de probe não toca `src/`, `package.json` raiz, ou qualquer arquivo de produção
- MANIFEST.md sempre reflete estado atual
- Usuário sai com clareza: seguir com milestone, pivotar, ou abandonar
</success_criteria>

<fast_mode>
Com `--quick`: pula decomposição E alinhamento. Trata input como probe único, número 001 (ou próximo disponível). Build direto, verdict direto. Use quando usuário já formulou a pergunta exata.
</fast_mode>
