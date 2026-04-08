---
description: "Modo conversa com o agente GSD — discute ideias, resolve dúvidas, planeja, captura decisões. Salva sessão automaticamente em .gsd/sessions/. Se o chat cair, /forge-ask resume retoma de onde parou."
allowed-tools: Read, Write, Bash, Glob
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

## Parse mode

From `$ARGUMENTS`:
- `resume` → load last open session and continue
- `close` → close and archive current session
- `list` → list all sessions
- (empty or text) → start new session OR continue today's open session

---

## Mode: list

```bash
ls .gsd/sessions/ 2>/dev/null | sort -r | head -20
```

Display the sessions with their topics (read first line of each file). Stop.

---

## Mode: close

Find the latest open session:
```bash
ls .gsd/sessions/ask-*.md 2>/dev/null | sort -r | head -1
```

If found: read it, write a 3-5 sentence summary into the `## Session Summary` section, set `status: closed` in frontmatter, update `updated` timestamp. Report closed. Stop.

If not found: tell user "No open session found." Stop.

---

## Mode: resume

Find the latest open session:
```bash
ls .gsd/sessions/ask-*.md 2>/dev/null | sort -r | head -3
```

Read the latest open session file (`status: open` in frontmatter).

If none open: tell user "No open sessions. Starting a new one..." and continue as new session below.

If found: display to user:
```
Retomando sessão: {session id}
Tópico: {topic from frontmatter}
Iniciada: {started date}
Última atualização: {updated date}

## Conversa anterior
{content of ## Conversation section}

## Decisões capturadas até agora
{content of ## Captured Decisions section}

## Ações pendentes
{content of ## Queued Actions section}
```

Then load project context (see below) and continue as active session.

---

## Mode: new session (default)

### Step 1 — Load project context (read these files only)

```bash
mkdir -p .gsd/sessions
```

Read:
- `.gsd/STATE.md` → current position
- `.gsd/PROJECT.md` → project description
- Last 15 rows of `.gsd/DECISIONS.md` → recent decisions
- First 60 lines of `.gsd/AUTO-MEMORY.md` → active memories (skip if missing)

### Step 2 — Check for today's open session

```bash
ls .gsd/sessions/ask-$(date +%Y-%m-%d)*.md 2>/dev/null | sort -r | head -1
```

If today's open session exists → load it and continue as resume mode.

### Step 3 — Create session file

Generate session ID: `ask-{YYYY-MM-DD}-{HHmm}` (use current date/time from `date +%Y-%m-%d-%H%M`).

Write `.gsd/sessions/{session-id}.md`:

```markdown
---
type: ask-session
id: {session-id}
started: {ISO8601 timestamp}
updated: {ISO8601 timestamp}
status: open
topic: (pending first message)
---

## Context Loaded
- STATE: {active milestone/slice/task from STATE.md, or "idle"}
- Recent decisions: {count of decision rows}
- Active memories: {count of MEM entries in AUTO-MEMORY.md}

## Conversation

## Captured Decisions

## Queued Actions

## Session Summary
```

### Step 4 — Present to user

Tell the user:

```
Sessão GSD iniciada: {session-id}

Contexto carregado:
  Milestone ativo: {from STATE.md}
  Próxima ação: {next action from STATE.md}
  Memórias ativas: {count}

Pode falar à vontade — vou anotar tudo no rascunho da sessão.
Arquivo da sessão: .gsd/sessions/{session-id}.md

Comandos especiais durante a conversa:
  "salvar decisão: X"   → adiciona X ao DECISIONS.md
  "criar milestone: X"  → planeja novo milestone
  "criar task: X"       → adiciona task ao slice ativo
  "encerrar sessão"     → fecha e arquiva esta sessão
  /forge-ask resume       → retoma esta sessão se o chat cair
```

---

## Active session behavior (follow these rules for the ENTIRE conversation after this command)

**CRITICAL: After EVERY response you give in this conversation, perform these two actions:**

### A. Update the session file

Read `.gsd/sessions/{session-id}.md`. Then:

1. Update `updated` in frontmatter to current timestamp
2. If topic is still "(pending first message)" → set it to a 3-5 word summary of what the user first asked
3. Append to `## Conversation`:
   ```
   ### [{HH:mm}] User
   {user's message — paraphrase if long, verbatim if short}

   ### [{HH:mm}] Agent
   {your response — paraphrase to 2-4 sentences capturing the key points}
   ```
4. If you or the user captured a decision → append to `## Captured Decisions`:
   ```
   - [{timestamp}] {decision text}
   ```
5. If an action was agreed (create milestone, add task, run something) → append to `## Queued Actions`:
   ```
   - [ ] [{timestamp}] {action description}
   ```

Write the updated file.

### B. Check for special commands

If user said **"salvar decisão: [text]"**:
- Append to `.gsd/DECISIONS.md` with a new row
- Confirm: "✓ Decisão salva no DECISIONS.md"

If user said **"criar milestone: [description]"**:
- Tell the user: "Execute `/forge-new-milestone {description}` para criar o milestone completo com brainstorm e planejamento."
- Append to `## Queued Actions` in session file

If user said **"criar task: [description]"**:
- Tell the user: "Execute `/forge-add-task {active slice} {description}` para adicionar a task."
- Append to `## Queued Actions`

If user said **"encerrar sessão"** or **"close session"**:
- Write 3-5 sentence summary to `## Session Summary`
- Set `status: closed` in frontmatter
- Update `updated` timestamp
- Tell user: "✓ Sessão encerrada. Arquivo: .gsd/sessions/{session-id}.md"
- Stop updating the file in subsequent turns

---

## Context reference

During this conversation, use the loaded project context to give relevant, grounded answers:

- Refer to STATE.md for current position ("you're on M002/S03/T01")
- Refer to DECISIONS.md to avoid re-debating locked decisions  
- Refer to AUTO-MEMORY memories to warn about known gotchas
- When asked about architecture, refer to what's in CONTEXT files (not speculation)

You do NOT need to read more files unless the user asks about something specific. If you need to look something up, do so and add what you found to the session log.
