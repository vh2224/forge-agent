---
name: forge-ask
description: "Modo conversa — discute ideias, captura decisoes, salva sessao."
disable-model-invocation: true
allowed-tools: Read, Write, Bash, Glob, Skill
---

## CONVERSATION-ONLY MODE — CRITICAL

This is a **read-only brainstorming and discussion mode**. The following rules are absolute and apply for the ENTIRE session:

1. **Do NOT modify, create, or fix source files** — not even obvious typos, not even one line
2. **Do NOT run Bash commands that change state** — no git, no installs, no file edits outside `.gsd/sessions/`
3. **Do NOT implement anything** — if you see a bug, a risk, or an improvement, MENTION it in conversation only
4. **The ONLY Write operations permitted** are to `.gsd/sessions/*.md` (session log) and `.gsd/DECISIONS.md` when user explicitly says "salvar decisão"
5. **If the user asks you to fix or build something** — respond with: "No modo /forge-ask eu só discuto. Para implementar, use `/forge-next` ou `/forge-auto`."

The purpose of this mode is thinking, not doing. Stay in conversation.

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
💬 Modo conversa ativo — {session-id}

Contexto carregado:
  Milestone ativo: {from STATE.md}
  Próxima ação: {next action from STATE.md}
  Memórias ativas: {count}

Este é um modo de discussão e brainstorming.
Não vou modificar arquivos nem implementar nada sem você pedir explicitamente.
Se quiser executar algo, use /forge-next ou /forge-auto.

Arquivo da sessão: .gsd/sessions/{session-id}.md

Comandos durante a conversa:
  "brainstorm: X"       → explora abordagens, riscos e escopo de X
  "salvar decisão: X"   → registra X no DECISIONS.md
  "criar milestone: X"  → instrução para /forge-new-milestone
  "criar task: X"       → instrução para /forge-add-task
  "encerrar sessão"     → fecha e arquiva esta sessão
  /forge-ask resume       → retoma esta sessão se o chat cair
```

---

## Active session behavior (follow these rules for the ENTIRE conversation after this command)

**REMINDER — CONVERSATION-ONLY:** Do NOT fix code, do NOT create files, do NOT run git or build commands. If you notice something worth fixing, say it — don't do it.

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

If user said **"brainstorm: [topic]"** or **"brainstorming: [topic]"**:
- Invoke: `Skill({ skill: "forge-brainstorm", args: "[topic]" })`
- The skill explores approaches, risks, and scope boundaries and writes a BRAINSTORM.md
- After the skill completes, summarize the key findings in the conversation (Recommended approach + Top 3 risks + Open questions)
- This is the ONLY skill invocation allowed in forge-ask — it produces a planning artifact, not source code
- Append to `## Queued Actions`: `- [ ] [{timestamp}] Brainstorm produzido para: [topic]`

**Auto-suggest brainstorm:** If the user describes a new feature, milestone idea, or architectural change and NO brainstorm exists for it yet, suggest: "Quer que eu rode o brainstorm para explorar abordagens e riscos antes de continuarmos?"

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

You do NOT need to read more files unless the user asks about something specific. If you need to look something up, read it and summarize — do not edit it.

**If you spot a bug, an inconsistency, or an improvement while reading:** mention it conversationally ("Notei que X pode ser um problema — quer que eu investigue mais?"). Do NOT fix it silently. Do NOT fix it even if asked mid-conversation — that's for `/forge-next`.
