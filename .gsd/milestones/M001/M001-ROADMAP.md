# M001 — Forge v1.0: Autonomous, Shell-first, Context-aware

**Versão alvo:** v1.0.0  
**Objetivo:** Forge auto roda até a milestone terminar sem intervenção. `/forge` é o novo entry point unificado. O sistema coordena context management por arquitetura, não por comportamento do Claude.

---

## Problema central que esta milestone resolve

O `forge-auto` "desaparecia" silenciosamente após ~11 unidades porque:
1. O orquestrador injetava o conteúdo completo de arquivos de artefato em cada unidade → contexto crescia ~10-50K tokens/unidade
2. Com 128k tokens acumulados, o Claude Code auto-compactava → o estado in-memory do orquestrador (PREFS, STATE, session_units) sumia
3. Sem mecanismo de recovery, o loop simplesmente morria

---

## Decisões de arquitetura

| Decisão | Escolha | Alternativa descartada |
|---------|---------|----------------------|
| Context management | Lean orchestrator (workers lêem seus próprios artefatos) | Unit-orchestrators via Agent() — descartado pois subagents não podem spawnar subagents |
| Recovery pós-compact | PostCompact hook → compact-signal.json | Compaction resilience inline — frágil |
| Entry point | `/forge` REPL thin router (<5K tokens) | Manter 20 comandos separados |
| Sobrevivência à compactação | `/forge` < 5K tokens (budget de skill por compactação) | dispatch table em CLAUDE.md |
| Migração de comandos | `skills/` com `disable-model-invocation: true` + shims em `commands/` | Migração completa big-bang |

---

## Slices

```
S01 ← independente          PostCompact Recovery           [x]
S02 ← independente          Lean Orchestrator (no artifact injection)     [x]
S03 ← depende S01           /forge REPL Shell              [x]
S04 ← depende S01+S02+S03   Release v1.0.0          [x]
```

---

## S01 — PostCompact Recovery

**Objetivo:** Após auto-compactação, forge-auto detecta o sinal e retoma o loop sem intervenção do usuário.

**Critérios de aceite:**
- Quando forge-auto está ativo e o Claude Code auto-compacta, o PostCompact hook escreve `.gsd/forge/compact-signal.json`
- Na próxima iteração do loop, forge-auto detecta o arquivo, re-inicializa estado do disco, deleta o sinal e continua
- O indicador `▶ AUTO` permanece ativo durante o processo

**Arquivos afetados:**
- `scripts/forge-hook.js` — novo handler `post-compact`
- `scripts/merge-settings.js` — registrar PostCompact no settings.json
- `commands/forge-auto.md` — detecção de compact-signal.json no início de cada iteração
- `shared/forge-dispatch.md` — não afetado neste slice

### T01 — forge-hook.js: handler PostCompact

**Arquivo:** `scripts/forge-hook.js`

Adicionar ao cabeçalho (comment + phase list):
```
//   PostCompact     → node ~/.claude/forge-hook.js post-compact
```

Adicionar handler após o bloco `pre-compact` existente:

```javascript
// ── PostCompact: escreve sinal de recovery se forge-auto estava ativo ──────
if (phase === 'post-compact') {
  const cwd      = data.cwd || process.cwd();
  const autoFile = path.join(cwd, '.gsd', 'forge', 'auto-mode.json');
  let autoMode   = {};
  try { autoMode = JSON.parse(fs.readFileSync(autoFile, 'utf8')); } catch {}

  if (autoMode.active === true) {
    const signalFile = path.join(cwd, '.gsd', 'forge', 'compact-signal.json');
    fs.writeFileSync(signalFile, JSON.stringify({
      recovered_at : Date.now(),
      milestone    : autoMode.milestone || null,
      worker       : autoMode.worker    || null,
    }), 'utf8');
  }
  return;
}
```

**Must-haves:**
- Só escreve compact-signal.json se `active === true` — não interfere fora do forge-auto
- Falhas de I/O silenciosas (try/catch) — hook não deve bloquear o Claude Code

---

### T02 — merge-settings.js: registrar PostCompact

**Arquivo:** `scripts/merge-settings.js`

Localizar o array de eventos (onde PreCompact está registrado) e adicionar PostCompact:

```javascript
{ event: 'PostCompact', phase: 'post-compact' },
```

**Must-haves:**
- Seguir exatamente o mesmo padrão dos outros 5 eventos já registrados
- `merge-settings.js` é idempotente — rodar múltiplas vezes não duplica entradas

---

### T03 — forge-auto.md: detecção de compact-signal.json

**Arquivo:** `commands/forge-auto.md`

Na seção **Dispatch Loop → Step 1 (Derive next unit)**, adicionar como PRIMEIRA ação antes de ler STATE.md:

```
**Compact recovery check** — antes de qualquer outra coisa, verifique:
```bash
cat .gsd/forge/compact-signal.json 2>/dev/null
```
Se o arquivo existir:
1. Re-leia todos os arquivos de contexto (STATE.md, prefs layers, AUTO-MEMORY.md, CODING-STANDARDS.md)
2. Re-inicialize PREFS, EFFORT_MAP, THINKING_OPUS, session_units = 0
3. Delete o sinal: `rm -f .gsd/forge/compact-signal.json`
4. Emita: `↺ Recovery pós-compactação — retomando de: {next_action do STATE.md}`
5. Continue o loop normalmente
```

**Must-haves:**
- Recovery é transparente: emite uma linha e continua sem perguntar ao usuário
- Remover compact-signal.json após recovery para não re-triggar

---

## S02 — Lean Orchestrator

**Objetivo:** Reduzir o contexto acumulado no orquestrador de ~10-50K tokens/unidade para ~500 tokens/unidade. Workers recebem caminhos de arquivo em vez de conteúdo inlado.

**Critérios de aceite:**
- Após 11 unidades, contexto do orquestrador < 50K tokens (vs 128K atual)
- Workers funcionam identicamente — lêem seus próprios artefatos via Read
- forge-dispatch.md é o único local de mudança de templates

**Por que funciona:** Workers (forge-planner, forge-executor, etc.) já têm acesso à tool `Read`. Receber um path e ler o arquivo produz o mesmo resultado que receber o conteúdo inlado, mas o READ acontece no contexto isolado do worker — não polui o orquestrador.

**Arquivos afetados:**
- `shared/forge-dispatch.md` — reescrever templates de worker prompt
- `commands/forge-auto.md` — remover bloco "Read artifacts" do Step 3
- `commands/forge-next.md` — mesma remoção

### T01 — forge-dispatch.md: templates lean

**Arquivo:** `shared/forge-dispatch.md`

Reescrever cada template substituindo `{content of X}` por `Read: {path}`.

**Padrão de transformação:**

```
# ANTES (inlina conteúdo — ocupa tokens no orquestrador):
## Task Plan
{content of T##-PLAN.md}

# DEPOIS (passa caminho — worker lê em contexto isolado):
## Task Plan
Read and follow: .gsd/milestones/{M###}/slices/{S##}/tasks/{T##}/{T##}-PLAN.md
```

**Templates a transformar:**

`execute-task`:
- `{content of T##-PLAN.md}` → `Read: .../{T##}-PLAN.md`
- `{content of S##-PLAN.md}` → `Read: .../{S##}-PLAN.md` (seção tasks apenas)
- `{content of M###-SUMMARY.md ...}` → `Read if exists: .../{M###}-SUMMARY.md` (last 30 lines)
- `{content of T##-SECURITY.md ...}` → `Read if exists: .../{T##}-SECURITY.md`
- `{## Decisions section of S##-CONTEXT.md}` → `Read ## Decisions from: .../{S##}-CONTEXT.md`

`plan-slice`:
- `{content of M###-ROADMAP.md}` → `Read: .../{M###}-ROADMAP.md`
- `{content of M###-CONTEXT.md}` → `Read: .../{M###}-CONTEXT.md`
- `{content of M###-RESEARCH.md}` → `Read if exists: .../{M###}-RESEARCH.md`

`plan-milestone`:
- `{content of PROJECT.md}` → `Read: .gsd/PROJECT.md`
- `{content of REQUIREMENTS.md}` → `Read: .gsd/REQUIREMENTS.md`

`complete-slice`, `complete-milestone`, `research-*`, `discuss-*`:
- Mesma transformação para todos os `{content of X}` blocks

**Manter inlado (pequeno e processado):**
- `{TOP_MEMORIES}` — mantém inlado (já filtrado, ~500 tokens)
- `{CS_LINT}` — mantém inlado (pequeno)
- `{WORKING_DIR}`, `{M###}`, `{S##}`, `{T##}` — substituições simples, manter

**Must-haves:**
- Workers devem receber paths ABSOLUTOS ou relativos ao WORKING_DIR
- Para arquivos opcionais, usar "Read if exists" — worker ignora se não encontrar
- Manter a ESTRUTURA dos templates (seções ## com mesmo nome) — só muda o conteúdo

---

### T02 — forge-auto.md: remover Step 3 artifact reads

**Arquivo:** `commands/forge-auto.md`

Seção `#### 3. Build worker prompt` — remover toda a lógica de leitura de arquivos de artefato. A seção se torna:

```markdown
#### 3. Build worker prompt

Use the template from `~/.claude/forge-dispatch.md` for the current `unit_type`.
Substitute placeholders:
- `{WORKING_DIR}` ← current working directory
- `{M###}`, `{S##}`, `{T##}` ← from STATE
- `{unit_effort}`, `{THINKING_OPUS}` ← resolved effort/thinking
- `{TOP_MEMORIES}` ← RELEVANT_MEMORIES (already filtered)
- `{CS_LINT}` ← CS_LINT section (already extracted)
- `{auto_commit}` ← PREFS.auto_commit

Do NOT read artifact files here — templates now pass paths; workers read their own context.
```

**Must-haves:**
- Remover todos os `Read` calls de artefatos do orquestrador nesta seção
- Manter as substituições de variáveis simples (WORKING_DIR, M###, etc.)
- Manter a injeção de TOP_MEMORIES e CS_LINT (são processados, não file reads brutos)

---

### T03 — forge-next.md: mesma remoção

**Arquivo:** `commands/forge-next.md`

Aplicar a mesma mudança do T02. forge-next.md tem código de dispatch duplicado de forge-auto — localizar o equivalente ao Step 3 e simplificar da mesma forma.

---

## S03 — /forge REPL Shell

**Objetivo:** Único entry point interativo. Usuário digita `/forge` e entra em um loop shell com status e opções. Sobrevive à compactação por ser < 5K tokens.

**Critérios de aceite:**
- `/forge` mostra status do projeto e apresenta menu interativo
- Cada opção invoca a skill correspondente via `Skill()` tool
- Após a skill retornar, volta ao menu — sem reiniciar a sessão
- `commands/forge-auto.md` permanece funcional como compatibilidade reversa
- Skills principais migradas para `skills/` com `disable-model-invocation: true`

**Budget de tokens:**
- `commands/forge.md` deve ficar < 300 linhas / < 5K tokens (cabe no budget de compactação)
- Se ultrapassar, mover lógica para um skill auxiliar

### T01 — Criar commands/forge.md

**Arquivo:** `commands/forge.md` (novo)

Frontmatter:
```yaml
---
description: "Shell interativo do Forge — entry point principal para todos os comandos GSD"
allowed-tools: Read, Bash, Skill, AskUserQuestion, TaskCreate, TaskUpdate
---
```

Estrutura do comando:

```
## Bootstrap guard
[mesmo padrão dos outros comandos — verifica CLAUDE.md e .gsd/STATE.md]

## Inicialização
1. Leia .gsd/STATE.md
2. Verifique .gsd/forge/compact-signal.json — se existe, emita "↺ Retomando após compactação..." e delete
3. Exiba status de uma linha:
   > Forge v1.0 │ {projeto} │ {milestone ativo ou "sem milestone"} │ {progresso se disponível}

## Loop principal
Repita enquanto usuário não escolher "sair":

AskUserQuestion(
  prompt: "O que fazer?",
  options: ["auto", "task", "new-milestone", "status", "help", "sair"]
)

Baseado na resposta:
- "auto"          → Skill("forge-auto")
- "task"          → AskUserQuestion("Descreva a task:") → Skill("forge-task", <descrição>)
- "new-milestone" → AskUserQuestion("Descreva a milestone:") → Skill("forge-new-milestone", <descrição>)
- "status"        → Skill("forge-status")
- "help"          → Skill("forge-help")
- "sair"          → deactivate auto-mode se ativo, sair do loop

## Compact recovery no loop
No início de CADA iteração do loop (antes do AskUserQuestion):
- Verifique .gsd/forge/compact-signal.json — se existe, re-leia STATE.md, delete sinal, continue
- Verifique .gsd/forge/auto-mode.json — se active: true e não voltou do Skill("forge-auto"),
  chame Skill("forge-auto") diretamente (retomada automática)
```

**Must-haves:**
- Manter < 300 linhas — se crescer, extrair lógica para skill auxiliar
- AskUserQuestion funciona inline (não forked) — ✅ compatível
- Loop não termina por timeout de AskUserQuestion (60s) — isso é esperado se usuário demorar

---

### T02 — Migrar forge-auto → skills/forge-auto/SKILL.md

**Ação:** Mover conteúdo de `commands/forge-auto.md` para `skills/forge-auto/SKILL.md`

Frontmatter da skill:
```yaml
---
name: forge-auto
description: GSD auto mode — executa o milestone inteiro de forma autônoma até concluir
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Agent, Skill, TaskCreate, TaskUpdate, TaskList, TaskStop, WebSearch, WebFetch
---
```

`commands/forge-auto.md` vira shim de compatibilidade:
```yaml
---
description: "GSD auto mode — executa o milestone inteiro de forma autônoma"
allowed-tools: Read, Write, Edit, Bash, Agent, Skill, TaskCreate, TaskUpdate, TaskList, TaskStop, WebSearch, WebFetch
---

Invoke the forge-auto skill:
Skill("forge-auto")
```

**Must-have:** Testar que `/forge-auto` (via shim) e `Skill("forge-auto")` (via /forge) se comportam identicamente.

---

### T03 — Migrar forge-task → skills/forge-task/SKILL.md

Mesmo padrão do T02. Frontmatter:
```yaml
---
name: forge-task
description: Task autônoma sem milestone/slice. Fluxo: brainstorm → discuss → research → plan → execute
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Agent, Skill, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
---
```

---

### T04 — Migrar forge-new-milestone → skills/forge-new-milestone/SKILL.md

Mesmo padrão. Frontmatter:
```yaml
---
name: forge-new-milestone
description: Cria nova milestone GSD. Fluxo: brainstorm → discuss → plan
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Agent, Skill, AskUserQuestion, EnterPlanMode, ExitPlanMode
---
```

---

### T05 — install.sh + install.ps1: adicionar skills/

**Arquivo:** `install.sh`

Adicionar bloco de cópia de skills após o bloco de commands:
```bash
# Skills
mkdir -p "$TARGET_SKILLS"
for skill_dir in "$REPO/skills"/*/; do
  skill_name=$(basename "$skill_dir")
  mkdir -p "$TARGET_SKILLS/$skill_name"
  cp "$skill_dir/SKILL.md" "$TARGET_SKILLS/$skill_name/SKILL.md"
  echo "  ✓ skill: $skill_name"
done
```

Onde `TARGET_SKILLS="$HOME/.claude/skills"`.

**Arquivo:** `install.ps1`

Mesmo padrão adaptado para PowerShell. Atenção: não usar `\f` literal em strings (ver nota no CLAUDE.md).

**Must-haves:**
- Skills existentes em `~/.claude/skills/` (forge-brainstorm, etc.) continuam sendo copiadas
- Novos diretórios forge-auto, forge-task, forge-new-milestone adicionados

---

## S04 — Release v1.0.0

**Objetivo:** Documentar, versionar e validar a release.

### T01 — CHANGELOG.md: entrada v1.0.0

Adicionar no topo:
```markdown
## v1.0.0 (2026-04-XX) — Major Release

### Breaking changes
- `/forge` é agora o entry point principal. Comandos individuais continuam funcionando como aliases.

### Features
- feat: /forge REPL shell — entry point interativo unificado com loop AskUserQuestion
- feat: PostCompact hook — forge-auto retoma automaticamente após compactação de contexto
- feat: lean orchestrator — workers lêem seus próprios artefatos; contexto do orquestrador reduz ~80%
- feat: forge-auto, forge-task, forge-new-milestone migrados para skills/ com disable-model-invocation

### Architecture
- Context management coordenado pelo forge via PostCompact hook + compact-signal.json
- /forge sobrevive à compactação (<5K tokens, dentro do budget de re-attachment)
- dispatch table permanece em forge-dispatch.md (compartilhado entre /forge-auto e /forge-next)
```

---

### T02 — README.md: atualizar entry point e arquitetura

Seções a atualizar:
- **Getting started**: mudar exemplo de `/forge-auto` para `/forge`
- **Architecture**: adicionar diagrama do PostCompact recovery flow
- **Commands**: listar `/forge` como primário, demais como aliases

---

### T03 — forge-statusline.js: bump de versão

**Arquivo:** `scripts/forge-statusline.js`

Localizar onde a versão é lida (provavelmente de `package.json` ou hardcoded) e atualizar para `v1.0.0`.

---

### T04 — CLAUDE.md: registrar decisões de arquitetura v1

Adicionar seção na parte de "Decisões de arquitetura recentes":
- PostCompact hook + compact-signal.json recovery
- Lean orchestrator (workers lêem próprios artefatos)
- /forge como REPL shell thin router
- Skills: budget de 5K tokens/skill, 25K total pós-compactação
- commands/ → shims de compatibilidade, lógica vive em skills/

---

## Boundary map

| Arquivo | S01 | S02 | S03 | S04 |
|---------|-----|-----|-----|-----|
| `scripts/forge-hook.js` | ✏️ | — | — | — |
| `scripts/merge-settings.js` | ✏️ | — | — | — |
| `commands/forge-auto.md` | ✏️ | ✏️ | ✏️ shim | — |
| `commands/forge-next.md` | — | ✏️ | — | — |
| `commands/forge.md` | — | — | 🆕 | — |
| `shared/forge-dispatch.md` | — | ✏️ | — | — |
| `skills/forge-auto/SKILL.md` | — | — | 🆕 | — |
| `skills/forge-task/SKILL.md` | — | — | 🆕 | — |
| `skills/forge-new-milestone/SKILL.md` | — | — | 🆕 | — |
| `install.sh` | — | — | ✏️ | — |
| `install.ps1` | — | — | ✏️ | — |
| `CHANGELOG.md` | — | — | — | ✏️ |
| `README.md` | — | — | — | ✏️ |
| `scripts/forge-statusline.js` | — | — | — | ✏️ |
| `CLAUDE.md` | — | — | — | ✏️ |

Legend: ✏️ editar existente · 🆕 criar novo · — não afetado

---

## Riscos conhecidos

| Risco | Probabilidade | Mitigação |
|-------|--------------|-----------|
| Bug #26251: `disable-model-invocation: true` bloqueia usuário no slash command | Média | Testar em T02/T03/T04 de S03 antes de marcar done |
| Workers que não lêem seus próprios arquivos (assumem conteúdo inlado) | Média | Verificar cada agent file em S02-T01 antes de reescrever templates |
| `/forge` ultrapassa 5K tokens (cai fora do budget de compactação) | Baixa | Manter < 300 linhas; extrair para skill auxiliar se necessário |
| PostCompact hook não disponível na versão do Claude Code do usuário | Baixa | Verificar versão; PreCompact existe desde versões anteriores como fallback |
